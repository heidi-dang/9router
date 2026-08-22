const states = new Map();
const MAX = 2000;
const TTL = 30 * 60 * 1000;
function keyOf({ credentialId, sessionId, model, toolCallId }) { return [credentialId || "anonymous", sessionId || "anonymous", model || "", toolCallId || ""].join("|"); }
export class ReasoningStateStore {
  constructor({ maxEntries = MAX, ttlMs = TTL } = {}) { this.maxEntries = maxEntries; this.ttlMs = ttlMs; }
  put(scope, state) { const key = keyOf(scope); if (states.size >= this.maxEntries) states.delete(states.keys().next().value); states.set(key, { ...state, expiresAt: Date.now() + this.ttlMs }); return state; }
  get(scope) { const key = keyOf(scope); const value = states.get(key); if (!value || value.expiresAt <= Date.now()) { states.delete(key); return null; } return { ...value }; }
  invalidate(scope) { states.delete(keyOf(scope)); }
  clear() { states.clear(); }
}
export function clearReasoningState() { states.clear(); }
