export const ANTIGRAVITY_ENABLED_CREDIT_TYPES = ["GOOGLE_ONE_AI"];

/** Adds the official optional credit type without mutating the caller’s object. */
export function withEnabledCreditTypes(payload = {}) {
  return {
    ...payload,
    enabledCreditTypes: [...ANTIGRAVITY_ENABLED_CREDIT_TYPES],
  };
}

function errorInfoReasons(error = {}) {
  const details = Array.isArray(error?.details) ? error.details : [];
  return details
    .filter((detail) => detail?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo")
    .map((detail) => String(detail?.reason || "").toUpperCase());
}

/**
 * Classifies official Antigravity 429 payloads. Unknown data stays soft so the
 * generic bounded retry policy can decide; this helper never fabricates credit
 * values or marks a balance unavailable without an explicit upstream signal.
 */
export function classifyAntigravityCreditsFailure(body = "") {
  let parsed = body;
  if (typeof body === "string") {
    try { parsed = JSON.parse(body); } catch { parsed = { error: { message: body } }; }
  }
  const error = parsed?.error || parsed || {};
  const status = String(error?.status || "").toUpperCase();
  const reasons = errorInfoReasons(error);
  const text = JSON.stringify(error).toUpperCase();

  if (reasons.includes("INSUFFICIENT_G1_CREDITS_BALANCE")) {
    return { kind: "credits_exhausted", explicit: true };
  }
  if (reasons.includes("QUOTA_EXHAUSTED") || text.includes("QUOTA_EXHAUSTED")) {
    return { kind: "quota_exhausted", explicit: true };
  }
  if (reasons.includes("RATE_LIMIT_EXCEEDED")) {
    return { kind: "rate_limited", explicit: true };
  }
  if (status === "RESOURCE_EXHAUSTED") {
    return { kind: "resource_exhausted", explicit: false };
  }
  return { kind: "unknown", explicit: false };
}
