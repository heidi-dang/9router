import { opaqueAntigravityIdentity } from "./identity.js";

const DEFAULT_MAX_ENTRIES = 2_000;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

function keyOf({ accountIdentity, sessionKey, model, toolCallId }) {
  return opaqueAntigravityIdentity(
    "antigravity-reasoning-v1",
    accountIdentity || "anonymous",
    sessionKey || "anonymous",
    model || "",
    toolCallId || "",
  );
}

/**
 * Stores only continuation metadata (for example a thought signature), never
 * prompt bodies, raw responses, tokens, or unscoped session identifiers.
 */
export class ReasoningStateStore {
  constructor({ maxEntries = DEFAULT_MAX_ENTRIES, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.states = new Map();
  }

  cleanup(now = Date.now()) {
    for (const [key, state] of this.states) {
      if (state.expiresAt <= now) this.states.delete(key);
    }
  }

  put(scope, state, now = Date.now()) {
    const key = keyOf(scope);
    this.cleanup(now);
    if (!this.states.has(key) && this.states.size >= this.maxEntries) {
      this.states.delete(this.states.keys().next().value);
    }
    const value = { ...state, expiresAt: now + this.ttlMs, lastUsedAt: now };
    this.states.delete(key);
    this.states.set(key, value);
    return { ...state };
  }

  get(scope, now = Date.now()) {
    const key = keyOf(scope);
    const value = this.states.get(key);
    if (!value || value.expiresAt <= now) {
      this.states.delete(key);
      return null;
    }
    value.lastUsedAt = now;
    this.states.delete(key);
    this.states.set(key, value);
    const { expiresAt, lastUsedAt, ...state } = value;
    return { ...state };
  }

  invalidate(scope) { this.states.delete(keyOf(scope)); }
  clear() { this.states.clear(); }
  size() { this.cleanup(); return this.states.size; }
}
