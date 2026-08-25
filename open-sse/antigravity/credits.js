import { opaqueAntigravityIdentity } from "./identity.js";
import { CLOUD_CODE_API, ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS, LOAD_CODE_ASSIST_METADATA } from "../config/appConstants.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";

export const ANTIGRAVITY_ENABLED_CREDIT_TYPES = ["GOOGLE_ONE_AI"];
export const AntigravityCreditState = Object.freeze({
  UNKNOWN: "UNKNOWN",
  AVAILABLE: "AVAILABLE",
  LOW: "LOW",
  EXHAUSTED: "EXHAUSTED",
  UNSUPPORTED: "UNSUPPORTED",
  ERROR: "ERROR",
});

const creditStates = new Map();
const creditFlights = new Map();
const MAX_CREDIT_STATES = 1_024;
const DEFAULT_CREDIT_TTL_MS = 15 * 60 * 1000;
const CREDIT_DISCOVERY_TTL_MS = 30 * 60 * 1000;

function creditKey(accountIdentity) {
  return opaqueAntigravityIdentity("antigravity-credit-state-v1", accountIdentity || "anonymous");
}

function cleanupCreditStates(clock = Date.now()) {
  for (const [key, value] of creditStates) {
    if (!value || (value.expiresAt && value.expiresAt <= clock)) creditStates.delete(key);
  }
}

/** Adds the official optional credit type without mutating the caller’s object. */
export function withEnabledCreditTypes(payload = {}) {
  return {
    ...payload,
    enabledCreditTypes: [...ANTIGRAVITY_ENABLED_CREDIT_TYPES],
  };
}

/**
 * Records only evidence-backed credit state. Callers must not use this to infer a
 * balance from an unavailable endpoint: UNKNOWN and ERROR remain request-eligible.
 */
export function setAntigravityCreditState({ accountIdentity, state, reason = null, ttlMs = DEFAULT_CREDIT_TTL_MS, persistent = false, now = Date.now(), creditAmount = null, minimumCreditAmount = null, paidTierId = null }) {
  if (!Object.values(AntigravityCreditState).includes(state)) return null;
  cleanupCreditStates(now);
  const key = creditKey(accountIdentity);
  if (!creditStates.has(key) && creditStates.size >= MAX_CREDIT_STATES) {
    creditStates.delete(creditStates.keys().next().value);
  }
  const expiresAt = state === AntigravityCreditState.EXHAUSTED && persistent
    ? null
    : now + Math.max(1, ttlMs);
  const value = {
    state,
    reason: reason || null,
    observedAt: now,
    expiresAt,
    creditAmount: Number.isFinite(creditAmount) ? creditAmount : null,
    minimumCreditAmount: Number.isFinite(minimumCreditAmount) ? minimumCreditAmount : null,
    paidTierId: paidTierId || null,
    accountIdentity: opaqueAntigravityIdentity("antigravity-credit-account", accountIdentity || "anonymous"),
  };
  creditStates.set(key, value);
  return { ...value };
}

export function getAntigravityCreditState(accountIdentity, now = Date.now()) {
  cleanupCreditStates(now);
  const value = creditStates.get(creditKey(accountIdentity));
  return value ? { ...value } : { state: AntigravityCreditState.UNKNOWN, observedAt: null, expiresAt: null };
}

/**
 * Fetches authenticated credits only through the official loadCodeAssist response.
 * It is single-flight per opaque account and returns UNKNOWN/ERROR/UNSUPPORTED on
 * absent or malformed data; it never turns endpoint failure into zero credits.
 */
export async function refreshAntigravityCreditState({ accountIdentity, accessToken, proxyOptions = null, signal, fetchImpl = proxyAwareFetch, now = Date.now() }) {
  const key = creditKey(accountIdentity);
  const existing = getAntigravityCreditState(accountIdentity, now);
  if (existing.state !== AntigravityCreditState.UNKNOWN && existing.expiresAt && existing.expiresAt > now) return existing;
  if (!accessToken) return setAntigravityCreditState({ accountIdentity, state: AntigravityCreditState.UNKNOWN, reason: "missing_access_token", now });
  if (creditFlights.has(key)) return creditFlights.get(key);

  const flight = (async () => {
    const endpoint = CLOUD_CODE_API.antigravity?.loadCodeAssist;
    if (!endpoint) {
      return setAntigravityCreditState({ accountIdentity, state: AntigravityCreditState.UNSUPPORTED, reason: "no_discovery_endpoint", now });
    }
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          ...ANTIGRAVITY_LOAD_CODE_ASSIST_HEADERS,
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ metadata: LOAD_CODE_ASSIST_METADATA }),
        signal,
      }, proxyOptions);
      if (!response?.ok) {
        return setAntigravityCreditState({
          accountIdentity,
          state: response?.status === 404 ? AntigravityCreditState.UNSUPPORTED : AntigravityCreditState.ERROR,
          reason: `http_${Number(response?.status || 0)}`,
          now,
        });
      }
      let payload;
      try { payload = await response.json(); } catch {
        return setAntigravityCreditState({ accountIdentity, state: AntigravityCreditState.ERROR, reason: "malformed_payload", now });
      }
      const paidTierId = typeof payload?.paidTier?.id === "string" ? payload.paidTier.id : null;
      const credits = Array.isArray(payload?.paidTier?.availableCredits) ? payload.paidTier.availableCredits : null;
      if (!credits) {
        return setAntigravityCreditState({ accountIdentity, state: AntigravityCreditState.UNSUPPORTED, reason: "credit_metadata_absent", now });
      }
      const credit = credits.find((entry) => String(entry?.creditType || "").toUpperCase() === "GOOGLE_ONE_AI");
      if (!credit) {
        return setAntigravityCreditState({ accountIdentity, state: AntigravityCreditState.UNSUPPORTED, reason: "credit_type_absent", paidTierId, now });
      }
      const creditAmount = Number(credit.creditAmount);
      const minimumCreditAmount = Number(credit.minimumCreditAmountForUsage);
      if (!Number.isFinite(creditAmount) || !Number.isFinite(minimumCreditAmount)) {
        return setAntigravityCreditState({ accountIdentity, state: AntigravityCreditState.ERROR, reason: "malformed_credit_amount", paidTierId, now });
      }
      const state = creditAmount < minimumCreditAmount
        ? AntigravityCreditState.EXHAUSTED
        : creditAmount === minimumCreditAmount
          ? AntigravityCreditState.LOW
          : AntigravityCreditState.AVAILABLE;
      return setAntigravityCreditState({
        accountIdentity,
        state,
        reason: "load_code_assist",
        ttlMs: CREDIT_DISCOVERY_TTL_MS,
        persistent: false,
        creditAmount,
        minimumCreditAmount,
        paidTierId,
        now,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        return setAntigravityCreditState({ accountIdentity, state: AntigravityCreditState.ERROR, reason: "cancelled", now });
      }
      return setAntigravityCreditState({ accountIdentity, state: AntigravityCreditState.ERROR, reason: "network_error", now });
    }
  })();
  creditFlights.set(key, flight);
  try { return await flight; } finally { creditFlights.delete(key); }
}

export function clearAntigravityCreditStates() {
  creditStates.clear();
  creditFlights.clear();
}

export function antigravityCreditStats() {
  cleanupCreditStates();
  return { size: creditStates.size, inFlight: creditFlights.size, maxEntries: MAX_CREDIT_STATES };
}

function errorInfoReasons(error = {}) {
  const details = Array.isArray(error?.details) ? error.details : [];
  return details
    .filter((detail) => detail?.["@type"] === "type.googleapis.com/google.rpc.ErrorInfo")
    .map((detail) => String(detail?.reason || "").toUpperCase());
}

/**
 * Classifies official Antigravity 429 payloads. Unknown data stays soft so the
 * bounded policy can decide; this helper never fabricates credit values or marks
 * an unavailable balance as exhausted.
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
