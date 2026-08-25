import { getProviderConnections, updateProviderConnection } from "@/lib/localDb";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { checkAndRefreshToken, updateProviderCredentials } from "./tokenRefresh.js";
import { getProjectIdForConnection, invalidateProjectId } from "open-sse/services/projectId.js";
import { resolveSessionId } from "open-sse/utils/sessionManager.js";
import { antigravityAccountIdentity } from "open-sse/antigravity/identity.js";
import { getCooldown } from "open-sse/antigravity/quota.js";
import { isModelLockActive } from "open-sse/services/accountFallback.js";
import { classifyAntigravityError, AntigravityErrorCode } from "open-sse/antigravity/errors.js";
import { getAntigravityCreditState, refreshAntigravityCreditState, setAntigravityCreditState, AntigravityCreditState } from "open-sse/antigravity/credits.js";

export const AntigravityFailureClass = Object.freeze({
  CLIENT_DETERMINISTIC: "CLIENT_DETERMINISTIC",
  AUTH_REFRESHABLE: "AUTH_REFRESHABLE",
  AUTH_FATAL: "AUTH_FATAL",
  PROJECT_RECOVERABLE: "PROJECT_RECOVERABLE",
  PROJECT_FATAL: "PROJECT_FATAL",
  SHORT_RATE_LIMIT: "SHORT_RATE_LIMIT",
  QUOTA_EXHAUSTED: "QUOTA_EXHAUSTED",
  CREDIT_EXHAUSTED: "CREDIT_EXHAUSTED",
  TRANSIENT_UPSTREAM: "TRANSIENT_UPSTREAM",
  ENDPOINT_FAILURE: "ENDPOINT_FAILURE",
  PROXY_FAILURE: "PROXY_FAILURE",
  NETWORK_FAILURE: "NETWORK_FAILURE",
  STREAM_INTERRUPTED: "STREAM_INTERRUPTED",
  CANCELLED: "CANCELLED",
  UNKNOWN: "UNKNOWN",
});

const MAX_STATE_ENTRIES = 1024;
const STATE_TTL_MS = 30 * 60 * 1000;
const MAX_TOTAL_DISPATCHES = 6;
const MAX_ACCOUNT_TRANSITIONS = 2;
const MAX_PROJECT_DISCOVERY = 1;

function now() {
  return Date.now();
}

function stableSessionIdentity({ body, headers, connectionId = "antigravity" }) {
  return resolveSessionId({ headers, body, connectionId, scope: "antigravity" });
}

function opaqueConnectionIdentity(connection) {
  return antigravityAccountIdentity({
    connectionId: connection?.id,
    accessToken: connection?.accessToken,
    refreshToken: connection?.refreshToken,
    email: connection?.email,
  });
}

function boundedSet(map, key, value, clock = now) {
  map.set(key, { ...value, touchedAt: clock() });
  if (map.size <= MAX_STATE_ENTRIES) return;
  const oldest = [...map.entries()].sort((a, b) => (a[1]?.touchedAt || 0) - (b[1]?.touchedAt || 0))[0];
  if (oldest) map.delete(oldest[0]);
}

function cleanupMap(map, clock = now) {
  const cutoff = clock() - STATE_TTL_MS;
  for (const [key, value] of map) {
    if (!value || (value.touchedAt || 0) < cutoff) map.delete(key);
  }
}

function normalizeCredentials(connection, proxyConfig) {
  return {
    authType: connection.authType,
    apiKey: connection.apiKey,
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt,
    expiresIn: connection.expiresIn,
    lastRefreshAt: connection.lastRefreshAt,
    projectId: connection.projectId,
    connectionName: connection.displayName || connection.name || connection.email || connection.id,
    connectionId: connection.id,
    email: connection.email,
    testStatus: connection.testStatus,
    lastError: connection.lastError,
    _connection: connection,
    providerSpecificData: {
      ...(connection.providerSpecificData || {}),
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      connectionProxyPoolId: proxyConfig.proxyPoolId || null,
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: proxyConfig.strictProxy === true,
    },
  };
}

export function classifyCoordinatorFailure({ status, error, signal }) {
  if (signal?.aborted || status === 499) return AntigravityFailureClass.CANCELLED;
  const classified = classifyAntigravityError(Number(status || 0), error || "");
  switch (classified.code) {
    case AntigravityErrorCode.BAD_REQUEST:
    case AntigravityErrorCode.BAD_TOOL_SCHEMA:
    case AntigravityErrorCode.MODEL_UNSUPPORTED:
      return AntigravityFailureClass.CLIENT_DETERMINISTIC;
    case AntigravityErrorCode.AUTH_EXPIRED:
      return AntigravityFailureClass.AUTH_REFRESHABLE;
    case AntigravityErrorCode.AUTH_INVALID:
    case AntigravityErrorCode.AUTH_REVOKED:
      return AntigravityFailureClass.AUTH_FATAL;
    case AntigravityErrorCode.PROJECT_REQUIRED:
    case AntigravityErrorCode.PROJECT_INVALID:
      return AntigravityFailureClass.PROJECT_RECOVERABLE;
    case AntigravityErrorCode.PROJECT_ONBOARDING_FAILED:
      return AntigravityFailureClass.PROJECT_FATAL;
    case AntigravityErrorCode.QUOTA_EXHAUSTED:
      return AntigravityFailureClass.QUOTA_EXHAUSTED;
    case AntigravityErrorCode.CREDITS_EXHAUSTED:
      return AntigravityFailureClass.CREDIT_EXHAUSTED;
    case AntigravityErrorCode.RATE_LIMITED:
      return AntigravityFailureClass.SHORT_RATE_LIMIT;
    case AntigravityErrorCode.CAPACITY_LIMITED:
      return AntigravityFailureClass.TRANSIENT_UPSTREAM;
    case AntigravityErrorCode.UPSTREAM_TIMEOUT:
      return AntigravityFailureClass.ENDPOINT_FAILURE;
    case AntigravityErrorCode.NETWORK_ERROR:
      return AntigravityFailureClass.NETWORK_FAILURE;
    case AntigravityErrorCode.STREAM_INTERRUPTED:
      return AntigravityFailureClass.STREAM_INTERRUPTED;
    case AntigravityErrorCode.UPSTREAM_UNAVAILABLE:
      return AntigravityFailureClass.TRANSIENT_UPSTREAM;
    default:
      return AntigravityFailureClass.UNKNOWN;
  }
}

function isTerminalFailure(kind) {
  return [
    AntigravityFailureClass.CLIENT_DETERMINISTIC,
    AntigravityFailureClass.CANCELLED,
    AntigravityFailureClass.STREAM_INTERRUPTED,
    AntigravityFailureClass.UNKNOWN,
  ].includes(kind);
}

function persistentStatePatch(kind, model, resetsAtMs) {
  // Persist only a stable category. Raw upstream text may contain HTML, request
  // details, or account-specific diagnostics and belongs nowhere in connection state.
  const base = {
    lastError: `antigravity:${kind.toLowerCase()}`,
    lastErrorAt: new Date().toISOString(),
  };
  if (kind === AntigravityFailureClass.AUTH_FATAL) {
    return { ...base, testStatus: "unavailable", errorCode: 401 };
  }
  if ([AntigravityFailureClass.QUOTA_EXHAUSTED, AntigravityFailureClass.SHORT_RATE_LIMIT].includes(kind) && resetsAtMs && resetsAtMs > now()) {
    return {
      ...base,
      [`modelLock_${model || "__all"}`]: new Date(resetsAtMs).toISOString(),
      testStatus: "unavailable",
      errorCode: 429,
    };
  }
  return base;
}

/**
 * Bounded, account-scoped Antigravity request coordinator. It is intentionally
 * provider-specific and accepts a single attempt callback so translation and
 * response adaptation remain in handleChatCore.
 */
export class AntigravityCoordinator {
  constructor(deps = {}) {
    this.deps = {
      getConnections: deps.getConnections || ((filter) => getProviderConnections(filter)),
      updateConnection: deps.updateConnection || ((id, patch) => updateProviderConnection(id, patch)),
      resolveProxy: deps.resolveProxy || resolveConnectionProxyConfig,
      refreshCredentials: deps.refreshCredentials || checkAndRefreshToken,
      persistCredentials: deps.persistCredentials || updateProviderCredentials,
      getProject: deps.getProject || getProjectIdForConnection,
      refreshCredits: deps.refreshCredits || refreshAntigravityCreditState,
      clock: deps.clock || now,
    };
    this.accountState = new Map();
    this.sessionAffinity = new Map();
  }

  cleanup() {
    cleanupMap(this.accountState, this.deps.clock);
    cleanupMap(this.sessionAffinity, this.deps.clock);
  }

  getDiagnostics() {
    this.cleanup();
    return {
      accountStateEntries: this.accountState.size,
      sessionAffinityEntries: this.sessionAffinity.size,
      maxEntries: MAX_STATE_ENTRIES,
    };
  }

  _state(identity) {
    const current = this.accountState.get(identity) || { inFlight: 0, lastSelectedAt: 0, state: "HEALTHY" };
    current.touchedAt = this.deps.clock();
    this.accountState.set(identity, current);
    return current;
  }

  _exclude(connection, model, sessionIdentity) {
    const identity = opaqueConnectionIdentity(connection);
    const state = this._state(identity);
    if (!connection?.isActive) return "disabled";
    if (state.until && state.until <= this.deps.clock() && ["TEMP_UNHEALTHY", "MODEL_COOLDOWN"].includes(state.state)) {
      state.state = "HEALTHY";
      state.until = null;
      state.model = null;
      boundedSet(this.accountState, identity, state, this.deps.clock);
    }
    if (["AUTH_FAILED", "PROJECT_FAILED", "DISABLED", "CREDIT_EXHAUSTED", "QUOTA_EXHAUSTED"].includes(state.state)) return state.state.toLowerCase();
    const creditState = getAntigravityCreditState(identity, this.deps.clock());
    if (creditState.state === AntigravityCreditState.EXHAUSTED) return "credit_exhausted";
    if (state.state === "TEMP_UNHEALTHY" && state.until > this.deps.clock()) return "temporary_unhealthy";
    if (state.state === "MODEL_COOLDOWN" && state.until > this.deps.clock() && (!state.model || state.model === model)) return "model_cooldown";
    if (isModelLockActive(connection, model)) return "model_cooldown";
    const cooldown = getCooldown(identity, model);
    if (cooldown && cooldown.until > this.deps.clock()) return "cooldown";
    const sticky = this.sessionAffinity.get(sessionIdentity);
    if (sticky?.accountIdentity && sticky.accountIdentity !== identity && sticky.only === true) return "session_pinned";
    return null;
  }

  async _candidateList({ model, sessionIdentity }) {
    const connections = await this.deps.getConnections({ provider: "antigravity", isActive: true });
    const exclusions = [];
    const candidates = [];
    for (const connection of connections) {
      const identity = opaqueConnectionIdentity(connection);
      const reason = this._exclude(connection, model, sessionIdentity);
      if (reason) {
        exclusions.push({ accountId: identity, reason });
        continue;
      }
      const state = this._state(identity);
      candidates.push({ connection, identity, state });
    }
    const sticky = this.sessionAffinity.get(sessionIdentity)?.accountIdentity || null;
    candidates.sort((a, b) => {
      const stickyDiff = Number(b.identity === sticky) - Number(a.identity === sticky);
      if (stickyDiff) return stickyDiff;
      const pressure = (a.state.inFlight || 0) - (b.state.inFlight || 0);
      if (pressure) return pressure;
      const recency = (a.state.lastSelectedAt || 0) - (b.state.lastSelectedAt || 0);
      if (recency) return recency;
      const priority = (a.connection.priority || 999) - (b.connection.priority || 999);
      if (priority) return priority;
      return a.identity.localeCompare(b.identity);
    });
    return { candidates, exclusions };
  }

  async _prepareCandidate(candidate, { model, signal, projectDiscoveries }) {
    if (signal?.aborted) return { excluded: "cancelled" };
    const currentConnection = await this.deps.getConnections({ provider: "antigravity", isActive: true })
      .then((rows) => rows.find((row) => row.id === candidate.connection.id));
    if (!currentConnection) return { excluded: "connection_removed" };

    const proxyConfig = await this.deps.resolveProxy(currentConnection.providerSpecificData || {});
    let credentials = normalizeCredentials(currentConnection, proxyConfig);
    const hadProjectAtStart = Boolean(credentials.projectId);
    try {
      credentials = await this.deps.refreshCredentials("antigravity", credentials);
    } catch {
      return { excluded: "refresh_failed", failure: AntigravityFailureClass.AUTH_REFRESHABLE };
    }

    if (!credentials?.accessToken) return { excluded: "auth_invalid", failure: AntigravityFailureClass.AUTH_FATAL };
    if (!credentials.projectId) {
      if (projectDiscoveries.get(candidate.identity)) return { excluded: "project_missing", failure: AntigravityFailureClass.PROJECT_FATAL };
      projectDiscoveries.set(candidate.identity, true);
      let projectId = null;
      try {
        projectId = await this.deps.getProject(currentConnection.id, credentials.accessToken, "antigravity");
      } catch {
        return { excluded: "project_discovery_failed", failure: AntigravityFailureClass.PROJECT_RECOVERABLE };
      }
      if (!projectId) return { excluded: "project_missing", failure: AntigravityFailureClass.PROJECT_FATAL };
      credentials.projectId = projectId;
      await this.deps.persistCredentials(currentConnection.id, { projectId });
    }
    // Credit discovery is authenticated metadata polling, not a precondition for
    // unknown accounts. Avoid a second loadCodeAssist call on cold project setup;
    // later project-backed requests refresh metadata once per bounded TTL.
    if (hadProjectAtStart && getAntigravityCreditState(candidate.identity, this.deps.clock()).state === AntigravityCreditState.UNKNOWN) {
      const creditState = await this.deps.refreshCredits({
        accountIdentity: candidate.identity,
        accessToken: credentials.accessToken,
        proxyOptions: {
          connectionProxyEnabled: credentials.providerSpecificData?.connectionProxyEnabled === true,
          connectionProxyUrl: credentials.providerSpecificData?.connectionProxyUrl || "",
          connectionNoProxy: credentials.providerSpecificData?.connectionNoProxy || "",
          strictProxy: credentials.providerSpecificData?.strictProxy === true,
          vercelRelayUrl: credentials.providerSpecificData?.vercelRelayUrl || "",
        },
        signal,
        now: this.deps.clock(),
      });
      if (creditState?.state === AntigravityCreditState.EXHAUSTED) {
        return { excluded: "credit_exhausted", failure: AntigravityFailureClass.CREDIT_EXHAUSTED };
      }
    }
    return { credentials };
  }

  _recordState(identity, kind, { resetsAtMs, model } = {}) {
    const state = this._state(identity);
    state.failureClass = kind;
    state.changedAt = this.deps.clock();
    if (kind === AntigravityFailureClass.AUTH_FATAL) state.state = "AUTH_FAILED";
    if (kind === AntigravityFailureClass.PROJECT_FATAL) state.state = "PROJECT_FAILED";
    if (kind === AntigravityFailureClass.CREDIT_EXHAUSTED) {
      state.state = "CREDIT_EXHAUSTED";
      setAntigravityCreditState({
        accountIdentity: identity,
        state: AntigravityCreditState.EXHAUSTED,
        reason: "upstream_explicit_exhaustion",
        now: this.deps.clock(),
      });
    }
    if (kind === AntigravityFailureClass.QUOTA_EXHAUSTED) state.state = "QUOTA_EXHAUSTED";
    if (kind === AntigravityFailureClass.SHORT_RATE_LIMIT) {
      state.state = "MODEL_COOLDOWN";
      state.until = resetsAtMs || null;
      state.model = model;
    }
    if ([AntigravityFailureClass.ENDPOINT_FAILURE, AntigravityFailureClass.PROXY_FAILURE, AntigravityFailureClass.NETWORK_FAILURE, AntigravityFailureClass.TRANSIENT_UPSTREAM].includes(kind)) {
      state.state = "TEMP_UNHEALTHY";
      state.until = this.deps.clock() + 30_000;
    }
    boundedSet(this.accountState, identity, state, this.deps.clock);
  }

  async execute({ model, body, headers, signal, invokeAttempt }) {
    this.cleanup();
    const sessionIdentity = stableSessionIdentity({ body, headers });
    const { candidates, exclusions } = await this._candidateList({ model, sessionIdentity });
    const attempts = [];
    const attemptedAccounts = new Set();
    const projectDiscoveries = new Map();
    const projectRediscoveries = new Map();
    let dispatches = 0;
    let accountTransitions = 0;
    let lastResult = null;

    const remainingCandidates = [...candidates];
    const stickyAccount = this.sessionAffinity.get(sessionIdentity)?.accountIdentity || null;
    while (remainingCandidates.length > 0) {
      if (signal?.aborted) break;
      if (dispatches >= MAX_TOTAL_DISPATCHES || (accountTransitions > MAX_ACCOUNT_TRANSITIONS && attemptedAccounts.size > 0)) break;
      // Re-rank at reservation time rather than trusting the earlier discovery
      // snapshot. This lets concurrent requests observe current in-flight pressure.
      remainingCandidates.sort((a, b) => {
        const stickyDiff = Number(b.identity === stickyAccount) - Number(a.identity === stickyAccount);
        if (stickyDiff) return stickyDiff;
        const aState = this._state(a.identity);
        const bState = this._state(b.identity);
        const pressure = (aState.inFlight || 0) - (bState.inFlight || 0);
        if (pressure) return pressure;
        const recency = (aState.lastSelectedAt || 0) - (bState.lastSelectedAt || 0);
        if (recency) return recency;
        const priority = (a.connection.priority || 999) - (b.connection.priority || 999);
        if (priority) return priority;
        return a.identity.localeCompare(b.identity);
      });
      const candidate = remainingCandidates.shift();
      const state = this._state(candidate.identity);
      state.inFlight += 1;
      state.lastSelectedAt = this.deps.clock();
      boundedSet(this.accountState, candidate.identity, state, this.deps.clock);
      attemptedAccounts.add(candidate.identity);

      try {
        const prepared = await this._prepareCandidate(candidate, { model, signal, projectDiscoveries });
        if (!prepared.credentials) {
          const kind = prepared.failure || AntigravityFailureClass.PROJECT_FATAL;
          exclusions.push({ accountId: candidate.identity, reason: prepared.excluded || "ineligible" });
          this._recordState(candidate.identity, kind, { model });
          accountTransitions += 1;
          continue;
        }

        dispatches += 1;
        const result = await invokeAttempt({
          credentials: prepared.credentials,
          connection: candidate.connection,
          accountIdentity: candidate.identity,
          sessionIdentity,
          attempt: dispatches,
          maxDispatches: MAX_TOTAL_DISPATCHES,
        });
        lastResult = result;
        const status = result?.status || (result?.success ? 200 : 502);
        const kind = result?.success ? null : classifyCoordinatorFailure({ status, error: result?.error, signal });
        attempts.push({ attempt: dispatches, accountId: candidate.identity, outcome: result?.success ? "success" : "failure", reason: kind || "success" });

        if (result?.success) {
          const successState = this._state(candidate.identity);
          successState.state = "HEALTHY";
          successState.until = null;
          boundedSet(this.accountState, candidate.identity, successState, this.deps.clock);
          boundedSet(this.sessionAffinity, sessionIdentity, { accountIdentity: candidate.identity, only: false }, this.deps.clock);
          await this.deps.updateConnection(candidate.connection.id, {
            lastUsedAt: new Date(this.deps.clock()).toISOString(),
            consecutiveUseCount: (candidate.connection.consecutiveUseCount || 0) + 1,
            testStatus: "active",
            lastError: null,
            errorCode: null,
          });
          return { ...result, attempts, exclusions, diagnostics: this.getDiagnostics() };
        }

        if (kind === AntigravityFailureClass.PROJECT_RECOVERABLE && !projectRediscoveries.get(candidate.identity)) {
          projectRediscoveries.set(candidate.identity, true);
          invalidateProjectId(candidate.connection.id);
          await this.deps.updateConnection(candidate.connection.id, { projectId: null, lastError: "antigravity:project_rediscovery" });
          // Reinsert only this account once. The project cache and persisted hint were
          // invalidated above, so the next preparation must perform real discovery.
          remainingCandidates.unshift(candidate);
          continue;
        }
        this._recordState(candidate.identity, kind, { resetsAtMs: result?.resetsAtMs, model });
        if (kind !== AntigravityFailureClass.CLIENT_DETERMINISTIC && kind !== AntigravityFailureClass.CANCELLED) {
          await this.deps.updateConnection(candidate.connection.id, persistentStatePatch(kind, model, result?.resetsAtMs));
        }
        if (isTerminalFailure(kind)) return { ...result, attempts, exclusions, diagnostics: this.getDiagnostics() };
        accountTransitions += 1;
      } finally {
        const current = this._state(candidate.identity);
        current.inFlight = Math.max(0, (current.inFlight || 1) - 1);
        boundedSet(this.accountState, candidate.identity, current, this.deps.clock);
      }
    }

    return {
      ...(lastResult || { success: false, status: 503, error: "No eligible Antigravity accounts" }),
      success: false,
      attempts,
      exclusions,
      diagnostics: this.getDiagnostics(),
    };
  }
}

let singleton = null;
export function getAntigravityCoordinator() {
  if (!singleton) singleton = new AntigravityCoordinator();
  return singleton;
}

export function resetAntigravityCoordinatorForTests() {
  singleton = null;
}
