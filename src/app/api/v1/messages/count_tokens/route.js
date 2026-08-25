import { validateApiKey } from "@/lib/localDb";
import { getModelInfo } from "@/sse/services/model";
import { getAntigravityCoordinator } from "@/sse/services/antigravityCoordinator";
import { AntigravityExecutor } from "open-sse/executors/antigravity.js";
import { translateRequest } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";
import { classifyAntigravityError } from "open-sse/antigravity/errors.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};

const COUNT_TOKENS_PATH = "/v1internal:countTokens";

export async function OPTIONS() {
  return new Response(null, { headers: CORS_HEADERS });
}

export function extractRequestApiKey(request) {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7).trim();
  return request.headers.get("x-api-key") || request.headers.get("x-goog-api-key") || new URL(request.url).searchParams.get("key") || null;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS }
  });
}

function countValueChars(value) {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((total, item) => total + countValueChars(item), 0);
  if (typeof value === "object") return Object.entries(value).reduce((total, [key, item]) => total + key.length + countValueChars(item), 0);
  return 0;
}

function countContentBlockChars(block) {
  if (block == null) return 0;
  if (typeof block === "string") return block.length;
  if (typeof block !== "object") return countValueChars(block);
  switch (block.type) {
    case "text": return countValueChars(block.text);
    case "tool_use": return countValueChars(block.name) + countValueChars(block.input);
    case "tool_result": return countValueChars(block.content);
    case "thinking": return countValueChars(block.thinking);
    default: return countValueChars(block);
  }
}

function countMessageChars(message) {
  if (!message || typeof message !== "object") return 0;
  if (typeof message.content === "string") return message.content.length;
  if (Array.isArray(message.content)) return message.content.reduce((total, block) => total + countContentBlockChars(block), 0);
  return countValueChars(message.content);
}

export function estimateAnthropicInputTokens(body = {}) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let totalChars = countValueChars(body.system) + countValueChars(body.tools);
  for (const msg of messages) totalChars += countMessageChars(msg);
  return Math.ceil(totalChars / 4);
}

/**
 * Converts an Anthropic public countTokens request through the same translator and
 * provider request sanitizer used by Antigravity chat calls. This helper is pure
 * relative to upstream I/O and intentionally removes fields the official
 * countTokens endpoint does not accept.
 */
export function buildAntigravityCountTokensPayload(body, model, credentials) {
  const input = structuredClone(body || {});
  const translated = translateRequest(
    FORMATS.CLAUDE,
    FORMATS.ANTIGRAVITY,
    model,
    input,
    false,
    credentials,
    "antigravity",
    null,
    [],
    credentials.connectionId,
    null,
  );
  const executor = new AntigravityExecutor();
  const payload = executor.transformRequest(model, translated, false, credentials);
  delete payload.project;
  delete payload.model;
  if (payload.request) delete payload.request.safetySettings;
  return payload;
}

async function countTokensAttempt({ body, model, credentials, signal }) {
  const executor = new AntigravityExecutor();
  const payload = buildAntigravityCountTokensPayload(body, model, credentials);
  const proxyOptions = {
    connectionProxyEnabled: credentials.providerSpecificData?.connectionProxyEnabled === true,
    connectionProxyUrl: credentials.providerSpecificData?.connectionProxyUrl || "",
    connectionNoProxy: credentials.providerSpecificData?.connectionNoProxy || "",
    strictProxy: credentials.providerSpecificData?.strictProxy === true,
    vercelRelayUrl: credentials.providerSpecificData?.vercelRelayUrl || "",
  };
  const context = executor.createExecutionContext({ model, transformedBody: payload, credentials, proxyOptions });
  const baseUrls = executor.endpointManager.order({ preferred: context.affinity?.endpoint });
  let lastFailure = { success: false, status: 503, error: "Antigravity countTokens unavailable" };

  // CountTokens is idempotent. It may use the two bounded provider endpoints but
  // never introduces account rotations; the coordinator owns those transitions.
  for (const baseUrl of baseUrls.slice(0, 2)) {
    if (signal?.aborted) return { success: false, status: 499, error: "Request cancelled" };
    const url = `${String(baseUrl).replace(/\/$/, "")}${COUNT_TOKENS_PATH}`;
    const startedAt = Date.now();
    try {
      const response = await executor.fetchRequest(url, {
        method: "POST",
        headers: executor.buildHeaders(credentials, false),
        body: JSON.stringify(payload),
        signal,
      }, proxyOptions, context);
      const latencyMs = Date.now() - startedAt;
      if (response.ok) {
        const json = await response.json();
        const totalTokens = Number(json?.totalTokens);
        if (!Number.isFinite(totalTokens) || totalTokens < 0) {
          return { success: false, status: 502, error: "Antigravity countTokens returned an invalid count" };
        }
        await executor.onResponse({ response, url, model, credentials, context, latencyMs });
        return { success: true, response: { totalTokens } };
      }
      let text = "";
      try { text = await response.clone().text(); } catch { /* body is optional */ }
      await executor.onResponse({ response, url, model, credentials, context, latencyMs });
      const classified = classifyAntigravityError(response.status, text);
      lastFailure = {
        success: false,
        status: response.status || 502,
        error: `Antigravity countTokens failed (${classified.code})`,
        resetsAtMs: classified.retryAfterMs ? Date.now() + classified.retryAfterMs : null,
      };
      if (!classified.retryable) return lastFailure;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") return { success: false, status: 499, error: "Request cancelled" };
      await executor.onRequestError({ error, url });
      lastFailure = { success: false, status: 502, error: "Antigravity countTokens network failure" };
    }
  }
  return lastFailure;
}

export async function dispatchAntigravityCountTokens({ body, model, request, coordinator = getAntigravityCoordinator() }) {
  const outcome = await coordinator.execute({
    model,
    body,
    headers: Object.fromEntries(request.headers.entries()),
    signal: request.signal,
    invokeAttempt: ({ credentials }) => countTokensAttempt({ body, model, credentials, signal: request.signal }),
  });
  if (outcome?.success) return { ok: true, inputTokens: outcome.response.totalTokens };
  return {
    ok: false,
    status: outcome?.status || 503,
    error: outcome?.error || "Antigravity countTokens unavailable",
  };
}

/**
 * POST /v1/messages/count_tokens.
 *
 * The route requires a valid 9router API key. Antigravity-backed models receive
 * provider-native authenticated counting; other model families retain the clearly
 * local estimator rather than being represented as an upstream provider count.
 */
export async function POST(request) {
  const apiKey = extractRequestApiKey(request);
  if (!apiKey || !(await validateApiKey(apiKey))) {
    return jsonResponse({ error: { type: "authentication_error", message: "Invalid API key" } }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: { type: "invalid_request_error", message: "Invalid JSON body" } }, 400);
  }

  const requestedModel = typeof body?.model === "string" ? body.model : "";
  const modelInfo = requestedModel ? await getModelInfo(requestedModel) : null;
  if (modelInfo?.provider === "antigravity") {
    const result = await dispatchAntigravityCountTokens({ body, model: modelInfo.model, request });
    if (!result.ok) return jsonResponse({ error: { type: "api_error", message: result.error } }, result.status);
    return jsonResponse({ input_tokens: result.inputTokens });
  }

  return jsonResponse({ input_tokens: estimateAnthropicInputTokens(body) });
}
