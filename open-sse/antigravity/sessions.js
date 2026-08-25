import { opaqueAntigravityIdentity } from "./identity.js";

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10_000;

function explicitSession({ sessionId, headers, connectionId, body } = {}) {
  return sessionId
    || body?.request?.sessionId
    || body?.sessionId
    || headers?.["x-session-id"]
    || headers?.["x-client-session-id"]
    || connectionId
    || "anonymous";
}

/** Returns an opaque state key; raw session/account values never leave this module. */
export function resolveAntigravitySession(input = {}) {
  return opaqueAntigravityIdentity("antigravity-session", explicitSession(input));
}

export class SessionAffinityManager {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.sessions = new Map();
  }

  cleanup(now = Date.now()) {
    for (const [key, item] of this.sessions) {
      if (item.expiresAt <= now) this.sessions.delete(key);
    }
  }

  get(sessionKey, now = Date.now()) {
    const item = this.sessions.get(sessionKey);
    if (!item || item.expiresAt <= now) {
      this.sessions.delete(sessionKey);
      return null;
    }
    item.lastUsedAt = now;
    this.sessions.delete(sessionKey);
    this.sessions.set(sessionKey, item);
    return { ...item };
  }

  bind(sessionKey, route, now = Date.now()) {
    if (!sessionKey) return null;
    this.cleanup(now);
    if (!this.sessions.has(sessionKey) && this.sessions.size >= this.maxEntries) {
      this.sessions.delete(this.sessions.keys().next().value);
    }
    const item = {
      ...route,
      expiresAt: now + this.ttlMs,
      lastUsedAt: now,
    };
    this.sessions.delete(sessionKey);
    this.sessions.set(sessionKey, item);
    return { ...item };
  }

  failover(sessionKey, route, now = Date.now()) {
    return this.bind(sessionKey, route, now);
  }

  remove(sessionKey) { this.sessions.delete(sessionKey); }
  clear() { this.sessions.clear(); }
  size() { this.cleanup(); return this.sessions.size; }
}
