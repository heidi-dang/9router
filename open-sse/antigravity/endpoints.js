const MAX_FAILURE_BACKOFF_MS = 60_000;

/**
 * Maintains per-executor endpoint health. Endpoints are selected deterministically
 * and unhealthy endpoints are skipped when another eligible endpoint exists.
 */
export class AntigravityEndpointManager {
  constructor(endpoints = []) {
    this.endpoints = [...new Set(endpoints.filter(Boolean))];
    this.states = new Map(this.endpoints.map((endpoint) => [endpoint, {
      failures: 0,
      consecutiveFailures: 0,
      latencyEWMA: null,
      cooldownUntil: 0,
    }]));
  }

  available(now = Date.now()) {
    return this.endpoints.filter((endpoint) => (this.states.get(endpoint)?.cooldownUntil || 0) <= now);
  }

  select({ preferred = null, now = Date.now() } = {}) {
    const available = this.available(now);
    if (preferred && available.includes(preferred)) return preferred;
    const candidates = available.length ? available : this.endpoints;
    return [...candidates].sort((left, right) => {
      const leftLatency = this.states.get(left)?.latencyEWMA ?? Number.MAX_SAFE_INTEGER;
      const rightLatency = this.states.get(right)?.latencyEWMA ?? Number.MAX_SAFE_INTEGER;
      return leftLatency - rightLatency || this.endpoints.indexOf(left) - this.endpoints.indexOf(right);
    })[0] || null;
  }

  order({ preferred = null, now = Date.now() } = {}) {
    const first = this.select({ preferred, now });
    if (!first) return [];
    const remaining = this.available(now).filter((endpoint) => endpoint !== first);
    const unhealthy = this.endpoints.filter((endpoint) => endpoint !== first && !remaining.includes(endpoint));
    return [first, ...remaining, ...unhealthy];
  }

  record(endpoint, { ok, latencyMs = null, cooldownMs = 0 } = {}) {
    if (!endpoint) return null;
    const state = this.states.get(endpoint) || {
      failures: 0,
      consecutiveFailures: 0,
      latencyEWMA: null,
      cooldownUntil: 0,
    };
    if (ok) {
      state.consecutiveFailures = 0;
      state.cooldownUntil = 0;
      if (Number.isFinite(latencyMs)) {
        state.latencyEWMA = state.latencyEWMA == null ? latencyMs : state.latencyEWMA * 0.8 + latencyMs * 0.2;
      }
    } else {
      state.failures += 1;
      state.consecutiveFailures += 1;
      const backoff = Math.min(MAX_FAILURE_BACKOFF_MS, 1000 * (2 ** Math.min(state.consecutiveFailures, 6)));
      state.cooldownUntil = Date.now() + Math.max(0, cooldownMs || backoff);
    }
    this.states.set(endpoint, state);
    return { ...state };
  }

  snapshot() {
    return Object.fromEntries(this.endpoints.map((endpoint) => [endpoint, { ...this.states.get(endpoint) }]));
  }
}
