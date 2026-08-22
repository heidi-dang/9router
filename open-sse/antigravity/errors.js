export const AntigravityErrorCode = Object.freeze({
  AUTH_EXPIRED: "AUTH_EXPIRED", AUTH_REVOKED: "AUTH_REVOKED", AUTH_INVALID: "AUTH_INVALID",
  PROJECT_REQUIRED: "PROJECT_REQUIRED", PROJECT_INVALID: "PROJECT_INVALID", PROJECT_ONBOARDING_FAILED: "PROJECT_ONBOARDING_FAILED",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE", MODEL_UNSUPPORTED: "MODEL_UNSUPPORTED",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED", RATE_LIMITED: "RATE_LIMITED", CAPACITY_LIMITED: "CAPACITY_LIMITED",
  BAD_TOOL_SCHEMA: "BAD_TOOL_SCHEMA", BAD_REQUEST: "BAD_REQUEST", BAD_THOUGHT_SIGNATURE: "BAD_THOUGHT_SIGNATURE",
  STREAM_INTERRUPTED: "STREAM_INTERRUPTED", UPSTREAM_TIMEOUT: "UPSTREAM_TIMEOUT", UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  NETWORK_ERROR: "NETWORK_ERROR", CLIENT_ABORTED: "CLIENT_ABORTED", INTERNAL_ERROR: "INTERNAL_ERROR",
});

export class AntigravityError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = "AntigravityError"; this.code = code; Object.assign(this, details); }
}

export function classifyAntigravityError(status, message = "", details = {}) {
  const text = typeof message === "string" ? message : JSON.stringify(message ?? "");
  const lower = text.toLowerCase();
  let code = AntigravityErrorCode.INTERNAL_ERROR;
  if (status === 401 || /token|unauth|credential|auth/.test(lower)) code = status === 401 ? AntigravityErrorCode.AUTH_EXPIRED : AntigravityErrorCode.AUTH_INVALID;
  else if (status === 403 && /project|consumer|permission/.test(lower)) code = AntigravityErrorCode.PROJECT_INVALID;
  else if (/thought.?signature|signature/.test(lower)) code = AntigravityErrorCode.BAD_THOUGHT_SIGNATURE;
  else if (/quota|resource_exhausted/.test(lower)) code = AntigravityErrorCode.QUOTA_EXHAUSTED;
  else if (status === 429 || /rate.?limit/.test(lower)) code = AntigravityErrorCode.RATE_LIMITED;
  else if (/capacity|high traffic|overloaded/.test(lower)) code = AntigravityErrorCode.CAPACITY_LIMITED;
  else if (/model.*(not found|unsupported|unavailable)/.test(lower)) code = AntigravityErrorCode.MODEL_UNAVAILABLE;
  else if (status === 408 || /timeout|timed out/.test(lower)) code = AntigravityErrorCode.UPSTREAM_TIMEOUT;
  else if (status >= 500 || /unavailable|network|fetch failed/.test(lower)) code = AntigravityErrorCode.UPSTREAM_UNAVAILABLE;
  else if (status >= 400) code = AntigravityErrorCode.BAD_REQUEST;
  return new AntigravityError(code, text || `Antigravity request failed (${status ?? "unknown"})`, { status, details, retryable: ["RATE_LIMITED", "CAPACITY_LIMITED", "UPSTREAM_TIMEOUT", "UPSTREAM_UNAVAILABLE", "NETWORK_ERROR"].includes(code) });
}
