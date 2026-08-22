import crypto from "node:crypto";
const sessions = new Map();
const TTL = 6 * 60 * 60 * 1000;
function hash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 24); }
export function resolveAntigravitySession({ sessionId, headers, connectionId, body } = {}) { const explicit = sessionId || body?.sessionId || body?.request?.sessionId || headers?.["x-session-id"] || headers?.["x-client-session-id"]; return hash(explicit || connectionId || "anonymous"); }
export class SessionAffinityManager {
  constructor({ ttlMs = TTL, maxEntries = 10000 } = {}) { this.ttlMs = ttlMs; this.maxEntries = maxEntries; }
  get(sessionId) { const item = sessions.get(sessionId); if (!item || item.expiresAt <= Date.now()) { sessions.delete(sessionId); return null; } return { ...item }; }
  bind(sessionId, route) { if (!sessionId) return null; if (sessions.size >= this.maxEntries) sessions.delete(sessions.keys().next().value); const item = { ...route, sessionId, expiresAt: Date.now() + this.ttlMs }; sessions.set(sessionId, item); return { ...item }; }
  failover(sessionId, route) { return this.bind(sessionId, route); }
  remove(sessionId) { sessions.delete(sessionId); }
  clear() { sessions.clear(); }
}
export function clearSessions() { sessions.clear(); }
