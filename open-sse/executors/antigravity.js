import crypto from "crypto";
import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { OAUTH_ENDPOINTS, ANTIGRAVITY_HEADERS, AG_DEFAULT_TOOLS, AG_TOOL_SUFFIX } from "../config/appConstants.js";
import { HTTP_STATUS } from "../config/runtimeConfig.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { DEFAULT_THINKING_AG_SIGNATURE } from "../config/defaultThinkingSignature.js";
import { normalizeAntigravityTools } from "../antigravity/tools.js";
import { classifyAntigravityError, AntigravityErrorCode } from "../antigravity/errors.js";
import { extractCooldownMs, getCooldown, setCooldown } from "../antigravity/quota.js";
import { getAntigravityTransport } from "../antigravity/transport.js";
import { AntigravityEndpointManager } from "../antigravity/endpoints.js";
import { SessionAffinityManager, resolveAntigravitySession } from "../antigravity/sessions.js";
import { ReasoningStateStore } from "../antigravity/reasoning.js";
import { antigravityAccountIdentity } from "../antigravity/identity.js";
import { classifyAntigravityCreditsFailure, withEnabledCreditTypes } from "../antigravity/credits.js";

const refreshFlights = new Map();

const MAX_RETRY_AFTER_MS = 10000;
const ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS = 15000;
const MAX_ANTIGRAVITY_OUTPUT_TOKENS = 64000;
const ANTIGRAVITY_IDE_REQUEST_ID_RE = /^agent\/[^/]+\/\d+\/[^/]+\/\d+$/;

const ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS = [
  /high\s+traffic/i,
  /agent\s+(execution\s+)?terminated\s+due\s+to\s+error/i,
  /capacity/i,
  /temporarily\s+unavailable/i,
  /timeout/i,
  /stream\s+(ended|closed|terminated|interrupted)/i,
  /empty\s+response/i,
];

const ANTIGRAVITY_TRANSIENT_STATUSES = new Set([
  HTTP_STATUS.SERVER_ERROR,
  HTTP_STATUS.BAD_GATEWAY,
  HTTP_STATUS.SERVICE_UNAVAILABLE,
  HTTP_STATUS.GATEWAY_TIMEOUT,
]);

// Fields Google generateContent rejects (Claude/OpenAI/Qwen thinking fields set at body root by thinkingUnified.js)
const ANTIGRAVITY_REQUEST_BLACKLIST = [
  "output_config",
  "thinking",
  "reasoning_effort",
  "reasoning",
  "enable_thinking",
  "thinking_budget",
  "thinkingConfig",
];

// Strip blacklisted fields from an object (used for both body.request and top-level body)
const stripBlacklisted = obj => {
  for (const key of ANTIGRAVITY_REQUEST_BLACKLIST) delete obj[key];
};

// Image generation model name patterns
const IMAGE_MODEL_PATTERNS = [
  /image/i,
  /imagen/i,
  /image-generation/i,
];

// Detect if a model is an image generation model
function isImageModel(model) {
  if (!model) return false;
  return IMAGE_MODEL_PATTERNS.some(p => p.test(model));
}

// Parse aspect ratio / resolution from model name suffixes
// e.g. "gemini-3.1-flash-image-16x9" -> { aspectRatio: "16:9" }
// e.g. "gemini-3.1-flash-image-1024x768" -> { aspectRatio: "4:3" }
function parseImageConfig(model) {
  const config = { aspectRatio: "1:1" };
  const resMatch = model.match(/(\d+)x(\d+)$/);
  if (resMatch) {
    const w = parseInt(resMatch[1]);
    const h = parseInt(resMatch[2]);
    if (w <= 16 && h <= 16) {
      config.aspectRatio = `${w}:${h}`;
    } else {
      // Resolution like 1024x768 — derive aspect ratio
      const gcd = (a, b) => b ? gcd(b, a % b) : a;
      const d = gcd(w, h);
      config.aspectRatio = `${w/d}:${h/d}`;
    }
  }
  return config;
}

function uuidFromSeed(seed) {
  const bytes = crypto.createHash("sha256").update(String(seed || "antigravity")).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function buildIdeRequestId({ body, request, credentials, model, requestType }) {
  if (ANTIGRAVITY_IDE_REQUEST_ID_RE.test(body?.requestId || "")) {
    return body.requestId;
  }

  const sessionId = request?.sessionId || body?.request?.sessionId || credentials?._clientSessionId || credentials?.connectionId || credentials?.email || "anonymous";
  const conversationId = uuidFromSeed(`antigravity:conversation:${sessionId}`);
  const trajectoryId = uuidFromSeed(`antigravity:trajectory:${sessionId}:${model}:${requestType}`);
  const contentCount = Array.isArray(request?.contents) ? request.contents.length : 1;
  const step = Math.max(1, contentCount * 2 - 1);
  return `agent/${conversationId}/${Date.now()}/${trajectoryId}/${step}`;
}

export class AntigravityExecutor extends BaseExecutor {
  constructor() {
    super("antigravity", PROVIDERS.antigravity);
    this.endpointManager = new AntigravityEndpointManager(this.getBaseUrls());
    this.sessionAffinity = new SessionAffinityManager();
    this.reasoningState = new ReasoningStateStore();
  }

  buildUrlForBase(baseUrl, model, stream) {
    const normalized = String(baseUrl || "").replace(/\/$/, "");
    // Image generation MUST use non-streaming generateContent.
    const forceNonStream = isImageModel(model);
    const action = (stream && !forceNonStream) ? "streamGenerateContent?alt=sse" : "generateContent";
    return `${normalized}/v1internal:${action}`;
  }

  buildUrl(model, stream, urlIndex = 0) {
    const baseUrls = this.getBaseUrls();
    return this.buildUrlForBase(baseUrls[urlIndex] || baseUrls[0], model, stream);
  }

  // sessionId comes from transformRequest output; base.execute runs transformRequest before
  // buildHeaders, so we read it from instance state cached there (fallback: explicit arg).
  buildHeaders(credentials, stream = true, sessionId = null) {
    return {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${credentials.accessToken}`,
      "User-Agent": this.config.headers?.["User-Agent"] || ANTIGRAVITY_HEADERS["User-Agent"],
    };
  }

  // Retry policy is handled by computeRetryDelay on the selected endpoint.
  // The official runtime deliberately forbids switching a generation request to
  // another endpoint after dispatch, because endpoint changes can break session
  // continuity and make a partially accepted request unsafe to replay.
  shouldRetry() {
    return false;
  }

  createExecutionContext({ model, transformedBody, credentials, proxyOptions }) {
    const accountIdentity = antigravityAccountIdentity(credentials);
    const sessionKey = resolveAntigravitySession({
      sessionId: transformedBody?.request?.sessionId,
      headers: credentials?.rawHeaders,
      connectionId: accountIdentity,
      body: transformedBody,
    });
    const cooldown = getCooldown(accountIdentity, model);
    if (cooldown) {
      throw classifyAntigravityError(429, "Antigravity account is cooling down", {
        code: AntigravityErrorCode.RATE_LIMITED,
        retryAfterMs: Math.max(0, cooldown.until - Date.now()),
      });
    }

    const reasoningScopes = [];
    for (const content of transformedBody?.request?.contents || []) {
      for (const part of content?.parts || []) {
        if (!part?.functionCall) continue;
        const toolCallId = part.functionCall.id || part.functionCall.name || "call";
        const scope = { accountIdentity, sessionKey, model, toolCallId };
        const previous = this.reasoningState.get(scope);
        if (previous?.thoughtSignature && (!part.thoughtSignature || part.thoughtSignature === DEFAULT_THINKING_AG_SIGNATURE)) {
          part.thoughtSignature = previous.thoughtSignature;
        }
        if (part.thoughtSignature) this.reasoningState.put(scope, { thoughtSignature: part.thoughtSignature });
        reasoningScopes.push(scope);
      }
    }

    const affinity = this.sessionAffinity.get(sessionKey);
    return { accountIdentity, sessionKey, affinity, reasoningScopes, proxyOptions };
  }

  getExecutionUrls({ model, stream, context }) {
    const preferred = context?.affinity?.endpoint;
    const selectedBaseUrl = this.endpointManager.order({ preferred })[0];
    return selectedBaseUrl ? [this.buildUrlForBase(selectedBaseUrl, model, stream)] : [];
  }

  async fetchRequest(url, options, proxyOptions, context) {
    const dispatcher = getAntigravityTransport({
      accountIdentity: context?.accountIdentity,
      proxyOptions,
      origin: url,
    });
    return proxyAwareFetch(url, { ...options, dispatcher }, proxyOptions);
  }

  async onResponse({ response, url, model, credentials, context, latencyMs }) {
    const endpoint = new URL(url).origin;
    const ok = response?.ok ?? (response?.status >= 200 && response?.status < 400);
    if (ok) {
      this.endpointManager.record(endpoint, { ok: true, latencyMs });
      this.sessionAffinity.bind(context?.sessionKey, { endpoint, accountIdentity: context?.accountIdentity, model });
      return;
    }

    let bodyText = "";
    try { bodyText = await response.clone().text(); } catch { /* response body is optional */ }
    const classified = classifyAntigravityError(response?.status, bodyText);
    const creditsDecision = classifyAntigravityCreditsFailure(bodyText);
    const cooldownMs = extractCooldownMs(response?.headers, bodyText);
    const shouldCooldown = classified.code === AntigravityErrorCode.RATE_LIMITED || classified.code === AntigravityErrorCode.QUOTA_EXHAUSTED;
    // Only an upstream-provided reset establishes a cooldown duration. Explicit
    // credit exhaustion remains visible to callers rather than fabricating a balance or expiry.
    if (shouldCooldown && cooldownMs && context?.accountIdentity) {
      setCooldown({ accountIdentity: context.accountIdentity, model, until: Date.now() + cooldownMs, reason: creditsDecision.kind === "credits_exhausted" ? AntigravityErrorCode.CREDITS_EXHAUSTED : classified.code });
    }
    if (classified.retryable) {
      this.endpointManager.record(endpoint, { ok: false, latencyMs, cooldownMs: cooldownMs || 0 });
    }
    if (classified.code === AntigravityErrorCode.BAD_THOUGHT_SIGNATURE) {
      for (const scope of context?.reasoningScopes || []) this.reasoningState.invalidate(scope);
    }
  }

  async onRequestError({ error, url }) {
    const classified = classifyAntigravityError(0, error?.message || "network error");
    if (classified.retryable) this.endpointManager.record(new URL(url).origin, { ok: false });
  }

  transformRequest(model, body, stream, credentials) {
    const projectId = credentials?.projectId;
    if (!projectId) {
      throw classifyAntigravityError(400, "Antigravity requires a validated project ID", { code: "PROJECT_REQUIRED" });
    }

    // OpenAI clients may include stream_options even for non-streaming calls.
    // Google generateContent rejects that combination before processing the request.
    if (stream !== true) delete body.stream_options;

    // ─── Image generation: completely different request structure ───
    if (isImageModel(model)) {
      const imageConfig = parseImageConfig(model);
      // Strip model name suffixes for the actual API model name
      const cleanModel = model.replace(/-(\d+)x(\d+)$/, "");

      // Build simplified contents — text-only, merge all user messages
      const contents = [];
      const srcContents = body.request?.contents || body.contents || [];
      for (const c of srcContents) {
        const textParts = (c.parts || []).filter(p => p.text !== undefined).map(p => ({ text: p.text }));
        if (textParts.length > 0) {
          contents.push({ role: c.role || "user", parts: textParts });
        }
      }

      const sessionId = resolveSessionId({
        headers: credentials?.rawHeaders,
        body,
        connectionId: credentials?.email || credentials?.connectionId,
        scope: "antigravity",
      });

      this._lastSessionId = sessionId;
      const request = {
        contents,
        generationConfig: {
          temperature: 1.0,
          topP: 0.95,
          topK: 40,
          maxOutputTokens: 8192,
          imageConfig,
        },
        sessionId,
        // No tools, no systemInstruction, no safetySettings for image gen
      };

      return withEnabledCreditTypes({
        project: projectId,
        model: cleanModel,
        userAgent: "antigravity",
        requestType: "image_gen",
        requestId: buildIdeRequestId({ body, request, credentials, model: cleanModel, requestType: "image_gen" }),
        request,
      });
    }

    // ─── Standard (non-image) request ───
    // Fix contents for Claude models via Antigravity
    const contents = body.request?.contents?.map(c => {
      let role = c.role;
      // functionResponse must be role "user" for Claude models
      if (c.parts?.some(p => p.functionResponse)) {
        role = "user";
      }
      // Strip thought-only parts, keep thoughtSignature on functionCall parts (Gemini 3+ requires it)
      const parts = c.parts?.filter(p => {
        if (p.thought && !p.functionCall) return false;
        if (p.thoughtSignature && !p.functionCall && !p.text) return false;
        return true;
      });
      // Gemini 3+ rejects functionCall parts without thoughtSignature. Clients (Claude Code, IDE)
      // don't persist thoughtSignature in their history, so backfill the default signature on any
      // functionCall part that arrives without one.
      const needsBackfill = parts?.some(p => p.functionCall && !p.thoughtSignature) ?? false;
      if (role !== c.role || parts?.length !== c.parts?.length || needsBackfill) {
        return {
          ...c, role,
          parts: needsBackfill
            ? parts.map(p => (p.functionCall && !p.thoughtSignature)
                ? { ...p, thoughtSignature: DEFAULT_THINKING_AG_SIGNATURE }
                : p)
            : parts,
        };
      }
      return c;
    });

    // Sanitize tool schemas and function names before sending to Antigravity.
    let tools = body.request?.tools;

    if (tools && tools.length > 0) {
      tools = normalizeAntigravityTools(tools);
    }

    // Strip tools/toolConfig (handled separately) and blacklisted fields that Google rejects
    const { tools: _originalTools, toolConfig: _originalToolConfig, ...requestWithoutTools } = body.request || {};
    stripBlacklisted(requestWithoutTools);
    
    // Rewrite competitive system prompts (e.g. Zed IDE's Claude prompt) to prevent Antigravity from 
    // flagging the request and immediately blocking it with a 429 Quota Exhausted response.
    if (requestWithoutTools.systemInstruction?.parts) {
      const oldText = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
      for (const part of requestWithoutTools.systemInstruction.parts) {
        if (typeof part.text === "string" && part.text.includes(oldText)) {
          part.text = part.text.split(oldText).join("");
        }
      }
    }

    const generationConfig = { ...(requestWithoutTools.generationConfig || {}) };
    if (generationConfig.maxOutputTokens > MAX_ANTIGRAVITY_OUTPUT_TOKENS) {
      generationConfig.maxOutputTokens = MAX_ANTIGRAVITY_OUTPUT_TOKENS;
    }

    const transformedRequest = {
      ...requestWithoutTools,
      generationConfig,
      ...(contents && { contents }),
      ...(tools && { tools }),
      sessionId: body.request?.sessionId || resolveSessionId({ headers: credentials?.rawHeaders, body, connectionId: credentials?.email || credentials?.connectionId, scope: "antigravity" }),
      safetySettings: undefined,
      ...(tools?.length > 0 && { toolConfig: { functionCallingConfig: { mode: "VALIDATED" } } })
    };

    // Strip blacklisted thinking fields from top-level body (set by thinkingUnified.js at root, not body.request)
    stripBlacklisted(body);

    this._lastSessionId = transformedRequest.sessionId; // cached for buildHeaders (base.execute order)

    return withEnabledCreditTypes({
      ...body,
      project: projectId,
      model: body.model || model,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: buildIdeRequestId({ body, request: transformedRequest, credentials, model, requestType: "agent" }),
      request: transformedRequest
    });
  }

  async refreshCredentials(credentials, log, proxyOptions = null) {
    if (!credentials.refreshToken) return null;
    const identity = antigravityAccountIdentity(credentials);
    if (refreshFlights.has(identity)) return refreshFlights.get(identity);
    const refreshPromise = (async () => {
      try {
        const response = await proxyAwareFetch(OAUTH_ENDPOINTS.google.token, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refreshToken, client_id: this.config.clientId, client_secret: this.config.clientSecret })
        }, proxyOptions);
        if (!response.ok) return null;
        const tokens = await response.json();
        log?.info?.("TOKEN", "Antigravity refreshed");
        return { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || credentials.refreshToken, expiresIn: tokens.expires_in, projectId: credentials.projectId };
      } catch {
        // Refresh responses can contain provider diagnostics; do not expose them.
        log?.error?.("TOKEN", "Antigravity refresh failed");
        return null;
      }
    })();
    refreshFlights.set(identity, refreshPromise);
    try { return await refreshPromise; } finally { refreshFlights.delete(identity); }
  }

  extractErrorMessage(errorJson, bodyText = "") {
    return [
      errorJson?.error?.message,
      errorJson?.message,
      errorJson?.error,
      bodyText,
    ].filter(Boolean).map(v => typeof v === "string" ? v : JSON.stringify(v)).join("\n");
  }

  isTransientAntigravityError(status, message) {
    if (status === HTTP_STATUS.RATE_LIMITED) return true;
    if (ANTIGRAVITY_TRANSIENT_STATUSES.has(status)) return true;
    return ANTIGRAVITY_TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message || ""));
  }

  // Hook called by BaseExecutor.tryRetry: derive delay from Retry-After (header → body),
  // cap at MAX_RETRY_AFTER_MS, else retry transient Antigravity failures with backoff.
  // Return false to veto (fallback URL / final error).
  async computeRetryDelay(response, attempt) {
    let bodyText = "";
    let errorJson = null;

    try {
      bodyText = await response.clone().text();
      errorJson = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      // ignore parse errors → fall through to status/message based retry
    }

    const errorMessage = this.extractErrorMessage(errorJson, bodyText);
    const creditsDecision = classifyAntigravityCreditsFailure(bodyText);
    // Explicit quota/credits exhaustion is deterministic for this account and
    // must not be hammered as a generic transient 429.
    if (["credits_exhausted", "quota_exhausted"].includes(creditsDecision.kind)) return false;
    const retryMs = extractCooldownMs(response.headers, errorMessage);
    if (retryMs) return retryMs <= MAX_RETRY_AFTER_MS ? retryMs : false;

    if (!this.isTransientAntigravityError(response.status, errorMessage)) return false;

    const cap = response.status === HTTP_STATUS.RATE_LIMITED
      ? MAX_RETRY_AFTER_MS
      : ANTIGRAVITY_TRANSIENT_RETRY_MAX_MS;
    return Math.min(1000 * (2 ** attempt), cap); // exponential backoff
  }

  /**
   * Cloak tools before sending to Antigravity provider (anti-ban):
   * - Rename client tools with _ide suffix
   * - Inject AG default decoy tools after client tools
   * Returns { cloakedBody, toolNameMap } where toolNameMap maps suffixed → original
   */
  static cloakTools(body, clientTool = null) {
    const tools = body.request?.tools;
    if (!tools || tools.length === 0) {
      return { cloakedBody: body, toolNameMap: null };
    }

    const isCopilot = clientTool === "github-copilot";
    const toolNameMap = new Map();
    const clientDeclarations = [];
    const decoyNames = new Set(AG_DECOY_TOOLS.map(tool => tool.name));

    // First: collect renamed client tools
    for (const toolGroup of tools) {
      if (!toolGroup.functionDeclarations) continue;

      for (const func of toolGroup.functionDeclarations) {
        // For GitHub Copilot, avoid emitting duplicate native Antigravity tool names.
        // Keep the decoys only once in the final declaration list.
        if (isCopilot && AG_DEFAULT_TOOLS.has(func.name)) {
          continue;
        }

        // Skip if already covered by decoys for Copilot
        if (isCopilot && decoyNames.has(func.name)) {
          continue;
        }

        // Preserve native AG names for non-Copilot clients
        if (AG_DEFAULT_TOOLS.has(func.name)) {
          clientDeclarations.push(func);
          continue;
        }

        const suffixed = `${func.name}${AG_TOOL_SUFFIX}`;
        toolNameMap.set(suffixed, func.name);
        clientDeclarations.push({ ...func, name: suffixed });
      }
    }

    // Client tools first, then AG decoy tools
    const allDeclarations = [];
    const seenNames = new Set();
    for (const decl of [...clientDeclarations, ...AG_DECOY_TOOLS]) {
      if (!decl?.name || seenNames.has(decl.name)) continue;
      seenNames.add(decl.name);
      allDeclarations.push(decl);
    }

    // Rename tool names in conversation history (contents)
    const cloakedContents = body.request?.contents?.map(msg => {
      if (!msg.parts) return msg;
      
      const cloakedParts = msg.parts.map(part => {
        // Rename functionCall.name
        if (part.functionCall && !AG_DEFAULT_TOOLS.has(part.functionCall.name)) {
          return {
            ...part,
            functionCall: {
              ...part.functionCall,
              name: `${part.functionCall.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        // Rename functionResponse.name
        if (part.functionResponse && !AG_DEFAULT_TOOLS.has(part.functionResponse.name)) {
          return {
            ...part,
            functionResponse: {
              ...part.functionResponse,
              name: `${part.functionResponse.name}${AG_TOOL_SUFFIX}`
            }
          };
        }
        
        return part;
      });
      
      return { ...msg, parts: cloakedParts };
    });

    // Single functionDeclarations group: client tools first, then decoys
    return {
      cloakedBody: {
        ...body,
        request: {
          ...body.request,
          tools: [{ functionDeclarations: allDeclarations }],
          contents: cloakedContents || body.request.contents
        }
      },
      toolNameMap
    };
  }
}

// AG decoy tools — same names as AG native defaults, redirect to _ide suffixed tools
const AG_DECOY_TOOLS = [
  {
    name: "browser_subagent",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "command_status",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "find_by_name",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "generate_image",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "grep_search",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_dir",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "list_resources",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "mcp_sequential-thinking_sequentialthinking",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "multi_replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "notify_user",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_resource",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_terminal",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "read_url_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "replace_file_content",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "run_command",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "search_web",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "send_command_input",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "task_boundary",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_content_chunk",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "view_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  },
  {
    name: "write_to_file",
    description: "This tool is currently unavailable.",
    parameters: { type: "OBJECT", properties: {}, required: [] }
  }
];

export default AntigravityExecutor;
