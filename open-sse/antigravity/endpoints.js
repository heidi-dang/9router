const states = new Map();
export class AntigravityEndpointManager {
  constructor(endpoints = []) { this.endpoints = [...new Set(endpoints.filter(Boolean))]; for (const endpoint of this.endpoints) states.set(endpoint, states.get(endpoint) || { failures: 0, consecutiveFailures: 0, latencyEWMA: null, cooldownUntil: 0 }); }
  available(now = Date.now()) { return this.endpoints.filter(endpoint => (states.get(endpoint)?.cooldownUntil || 0) <= now); }
  select(now = Date.now()) { return this.available(now).sort((a,b) => (states.get(a)?.latencyEWMA || 0) - (states.get(b)?.latencyEWMA || 0))[0] || this.endpoints[0] || null; }
  record(endpoint, { ok, latencyMs, cooldownMs = 0 } = {}) { const state = states.get(endpoint) || { failures: 0, consecutiveFailures: 0, latencyEWMA: null, cooldownUntil: 0 }; if (ok) { state.consecutiveFailures = 0; state.latencyEWMA = state.latencyEWMA == null ? latencyMs : state.latencyEWMA * .8 + latencyMs * .2; } else { state.failures++; state.consecutiveFailures++; state.cooldownUntil = Date.now() + Math.max(cooldownMs, Math.min(60000, 1000 * 2 ** Math.min(state.consecutiveFailures, 6))); } states.set(endpoint, state); return { ...state }; }
  snapshot() { return Object.fromEntries(this.endpoints.map(e => [e, { ...states.get(e) }])); }
}
