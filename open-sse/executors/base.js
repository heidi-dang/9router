import { HTTP_STATUS, RETRY_CONFIG, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { shouldRefreshCredentials } from "../services/oauthCredentialManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";
import { ANTHROPIC_API_VERSION, OPENAI_COMPAT_BASE, ANTHROPIC_COMPAT_BASE } from "../providers/shared.js";
import { resolveOpenAICompatibleApiType } from "../services/provider.js";

/**
 * BaseExecutor - shared provider execution flow. Providers can specialize
 * request transport and endpoint selection through the hooks below while the
 * timeout, retry, abort, and fallback lifecycle remains authoritative here.
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() { return this.provider; }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() { return this.getBaseUrls().length || 1; }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || OPENAI_COMPAT_BASE;
      const normalized = baseUrl.replace(/\/$/, "");
      const path = resolveOpenAICompatibleApiType(this.provider, credentials) === "responses" ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || ANTHROPIC_COMPAT_BASE;
      return `${baseUrl.replace(/\/$/, "")}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = { "Content-Type": "application/json", ...this.config.headers };
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      if (credentials.apiKey) headers["x-api-key"] = credentials.apiKey;
      else if (credentials.accessToken) headers.Authorization = `Bearer ${credentials.accessToken}`;
      if (!headers["anthropic-version"]) headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    } else if (credentials.accessToken) {
      headers.Authorization = `Bearer ${credentials.accessToken}`;
    } else if (credentials.apiKey) {
      headers.Authorization = `Bearer ${credentials.apiKey}`;
    }
    if (stream) headers.Accept = "text/event-stream";
    return headers;
  }

  transformRequest(model, body, stream, credentials) { return body; }

  shouldRetry(status, urlIndex, fallbackCount = this.getFallbackCount()) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < fallbackCount;
  }

  async refreshCredentials(credentials, log, proxyOptions = null) { return null; }
  needsRefresh(credentials) { return shouldRefreshCredentials(this.provider, credentials); }
  parseError(response, bodyText) { return { status: response.status, message: bodyText || `HTTP ${response.status}` }; }

  /** Provider hook: derive non-secret request context after transformation. */
  createExecutionContext() { return null; }

  /** Provider hook: order endpoint URLs; default follows configured base URLs. */
  getExecutionUrls({ model, stream, credentials }) {
    const count = this.getFallbackCount();
    return Array.from({ length: count }, (_, index) => this.buildUrl(model, stream, index, credentials));
  }

  /** Provider hook: use a specialized transport while preserving proxy options. */
  async fetchRequest(url, options, proxyOptions, _context) {
    return proxyAwareFetch(url, options, proxyOptions);
  }

  /** Provider hook: record response health/cooldown/affinity without consuming it. */
  async onResponse(_event) {}

  /** Provider hook: record non-abort network errors without changing error semantics. */
  async onRequestError(_event) {}

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };
    const transformedBody = this.transformRequest(model, body, stream, credentials);
    const context = this.createExecutionContext({ model, transformedBody, stream, credentials, proxyOptions }) || null;
    const urls = this.getExecutionUrls({ model, stream, credentials, context }).filter(Boolean);
    if (!urls.length) throw new Error(`No upstream URL configured for ${this.provider}`);

    const tryRetry = async (urlIndex, statusKey, reason, response = null) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      let waitMs = delayMs;
      if (response && this.computeRetryDelay) {
        const dynamic = await this.computeRetryDelay(response, retryAttemptsByUrl[urlIndex] + 1, delayMs);
        if (dynamic === false) return false;
        if (dynamic != null) waitMs = dynamic;
      }
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${waitMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < urls.length; urlIndex++) {
      const url = urls[urlIndex];
      const headers = this.buildHeaders(credentials, stream, url, model);
      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;
      const connectCtrl = new AbortController();
      const timeoutMs = this.config?.timeoutMs || FETCH_CONNECT_TIMEOUT_MS;
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), timeoutMs);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} → ${url} | body=${bodyStr.length}B | connectTimeout=${timeoutMs}ms`);
        const response = await this.fetchRequest(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal,
        }, proxyOptions, context);
        clearTimeout(connectTimer);
        const latencyMs = Date.now() - fetchT0;
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} ← ${response.status} | ttft=${latencyMs}ms | ct=${ct} | cl=${cl}`);
        await this.onResponse({ response, url, model, stream, credentials, proxyOptions, context, latencyMs });

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`, response)) {
          urlIndex--;
          continue;
        }
        if (this.shouldRetry(response.status, urlIndex, urls.length)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }
        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} ✖ ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        if (error.name === "AbortError" && !isConnectTimeout) throw error;
        await this.onRequestError({ error, url, model, stream, credentials, proxyOptions, context, isConnectTimeout });
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) {
          urlIndex--;
          continue;
        }
        if (urlIndex + 1 < urls.length) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }
    throw lastError || new Error(`All ${urls.length} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
