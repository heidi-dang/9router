import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AntigravityCoordinator,
  AntigravityFailureClass,
  classifyCoordinatorFailure,
} from "../../src/sse/services/antigravityCoordinator.js";
import { clearAntigravityCreditStates } from "../../open-sse/antigravity/credits.js";

function connection(id, overrides = {}) {
  return {
    id,
    provider: "antigravity",
    authType: "oauth",
    name: `Account ${id}`,
    email: `${id}@example.test`,
    accessToken: `access-${id}-CANARY-SECRET`,
    refreshToken: `refresh-${id}-CANARY-SECRET`,
    projectId: `project-${id}`,
    priority: 1,
    isActive: true,
    providerSpecificData: {},
    ...overrides,
  };
}

function createCoordinator(connections, extra = {}) {
  const updates = [];
  const deps = {
    getConnections: async () => connections.map((item) => ({ ...item, providerSpecificData: { ...(item.providerSpecificData || {}) } })),
    updateConnection: async (id, patch) => {
      updates.push({ id, patch });
      const item = connections.find((entry) => entry.id === id);
      if (item) Object.assign(item, patch);
      return item || null;
    },
    resolveProxy: async () => ({ connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "", strictProxy: false }),
    refreshCredentials: async (_provider, credentials) => credentials,
    persistCredentials: async () => true,
    getProject: async () => "project-discovered",
    refreshCredits: async () => ({ state: "UNKNOWN" }),
    ...extra,
  };
  return { coordinator: new AntigravityCoordinator(deps), updates };
}

describe("AntigravityCoordinator", () => {
  beforeEach(() => clearAntigravityCreditStates());
  it("excludes disabled, cooled, and exhausted candidates before selecting the only eligible account", async () => {
    const entries = [
      connection("A", { isActive: false }),
      connection("B", { testStatus: "unavailable", modelLock_gemini: new Date(Date.now() + 60_000).toISOString() }),
      connection("C"),
    ];
    const { coordinator } = createCoordinator(entries);
    coordinator.accountState.set("invalid-unused-key", { state: "CREDIT_EXHAUSTED", touchedAt: Date.now() });
    let selected = null;

    const result = await coordinator.execute({
      model: "gemini",
      body: { messages: [{ role: "user", content: "hello" }] },
      headers: {},
      invokeAttempt: async ({ connection: selectedConnection }) => {
        selected = selectedConnection.id;
        return { success: true, response: new Response("ok") };
      },
    });

    expect(result.success).toBe(true);
    expect(selected).toBe("C");
    expect(result.exclusions.map((entry) => entry.reason)).toContain("model_cooldown");
  });

  it("preserves healthy session affinity without making it an ineligible hard pin", async () => {
    const entries = [connection("A", { priority: 2 }), connection("B", { priority: 1 })];
    const { coordinator } = createCoordinator(entries);
    const body = { messages: [{ role: "user", content: "same session" }] };
    const selections = [];

    await coordinator.execute({
      model: "gemini",
      body,
      headers: { "x-session-id": "sticky" },
      invokeAttempt: async ({ connection: selectedConnection }) => {
        selections.push(selectedConnection.id);
        return { success: true, response: new Response("ok") };
      },
    });
    await coordinator.execute({
      model: "gemini",
      body,
      headers: { "x-session-id": "sticky" },
      invokeAttempt: async ({ connection: selectedConnection }) => {
        selections.push(selectedConnection.id);
        return { success: true, response: new Response("ok") };
      },
    });

    expect(selections).toHaveLength(2);
    expect(selections[1]).toBe(selections[0]);
  });

  it("never rotates or persists a poison state for deterministic client input", async () => {
    const entries = [connection("A"), connection("B")];
    const { coordinator, updates } = createCoordinator(entries);
    const result = await coordinator.execute({
      model: "gemini",
      body: { messages: [] },
      headers: {},
      invokeAttempt: async () => ({ success: false, status: 400, error: "unsupported schema" }),
    });

    expect(result.success).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0].reason).toBe(AntigravityFailureClass.CLIENT_DETERMINISTIC);
    expect(updates).toHaveLength(0);
  });

  it("expires temporary account health without preserving raw upstream diagnostics", async () => {
    let currentTime = 1_000;
    const entries = [connection("A")];
    const { coordinator, updates } = createCoordinator(entries, { clock: () => currentTime });
    const first = await coordinator.execute({
      model: "gemini",
      body: { messages: [] },
      headers: {},
      invokeAttempt: async () => ({ success: false, status: 503, error: "raw-upstream-CANARY-DETAIL" }),
    });
    expect(first.success).toBe(false);
    expect(updates.at(-1).patch.lastError).toBe("antigravity:transient_upstream");

    const blocked = await coordinator.execute({
      model: "gemini",
      body: { messages: [] },
      headers: {},
      invokeAttempt: async () => ({ success: true, response: new Response("must not run") }),
    });
    expect(blocked.success).toBe(false);
    expect(blocked.exclusions.some((entry) => entry.reason === "temporary_unhealthy")).toBe(true);

    currentTime += 30_001;
    const recovered = await coordinator.execute({
      model: "gemini",
      body: { messages: [] },
      headers: {},
      invokeAttempt: async () => ({ success: true, response: new Response("ok") }),
    });
    expect(recovered.success).toBe(true);
  });

  it("rotates away from only the account with explicit credit exhaustion", async () => {
    const entries = [connection("A"), connection("B")];
    const { coordinator } = createCoordinator(entries);
    const selected = [];
    const first = await coordinator.execute({
      model: "gemini",
      body: { messages: [] },
      headers: {},
      invokeAttempt: async ({ connection: selectedConnection }) => {
        selected.push(selectedConnection.id);
        return selectedConnection.id === "A"
          ? { success: false, status: 429, error: "INSUFFICIENT_G1_CREDITS_BALANCE" }
          : { success: true, response: new Response("ok") };
      },
    });
    expect(first.success).toBe(true);
    expect(selected).toEqual(["A", "B"]);

    const second = await coordinator.execute({
      model: "gemini",
      body: { messages: [] },
      headers: { "x-session-id": "new-session" },
      invokeAttempt: async ({ connection: selectedConnection }) => ({
        success: true,
        response: new Response(selectedConnection.id),
      }),
    });
    expect(await second.response.text()).toBe("B");
  });

  it("invalidates and rediscovers a stale project once before retrying the same account", async () => {
    const entries = [connection("A", { projectId: "stale-project" })];
    const getProject = vi.fn(async () => "fresh-project");
    const { coordinator, updates } = createCoordinator(entries, { getProject });
    let calls = 0;
    const result = await coordinator.execute({
      model: "gemini",
      body: { messages: [] },
      headers: {},
      invokeAttempt: async ({ credentials }) => {
        calls += 1;
        return calls === 1
          ? { success: false, status: 403, error: "project permission denied" }
          : { success: credentials.projectId === "fresh-project", response: new Response("ok") };
      },
    });

    expect(result.success).toBe(true);
    expect(calls).toBe(2);
    expect(getProject).toHaveBeenCalledTimes(1);
    expect(updates.some((entry) => entry.patch.projectId === null)).toBe(true);
  });

  it("globally bounds account transitions to the initial account plus two alternatives", async () => {
    const entries = [connection("A"), connection("B"), connection("C"), connection("D")];
    const { coordinator } = createCoordinator(entries);
    const selected = [];
    const result = await coordinator.execute({
      model: "gemini",
      body: { messages: [{ role: "user", content: "retry" }] },
      headers: {},
      invokeAttempt: async ({ connection: selectedConnection }) => {
        selected.push(selectedConnection.id);
        return { success: false, status: 503, error: "temporarily unavailable" };
      },
    });

    expect(result.success).toBe(false);
    expect(selected).toHaveLength(3);
    expect(new Set(selected).size).toBe(3);
    expect(result.attempts).toHaveLength(3);
  });

  it("distributes concurrent requests using in-flight pressure and releases reservations", async () => {
    const entries = [connection("A", { priority: 1 }), connection("B", { priority: 1 }), connection("C", { priority: 1 })];
    const { coordinator } = createCoordinator(entries);
    const selected = [];

    await Promise.all(Array.from({ length: 30 }, (_, index) => coordinator.execute({
      model: "gemini",
      body: { messages: [{ role: "user", content: `request-${index}` }] },
      headers: { "x-session-id": `session-${index}` },
      invokeAttempt: async ({ connection: selectedConnection }) => {
        selected.push(selectedConnection.id);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return { success: true, response: new Response("ok") };
      },
    })));

    expect(new Set(selected)).toEqual(new Set(["A", "B", "C"]));
    expect(selected).toHaveLength(30);
    for (const state of coordinator.accountState.values()) {
      expect(state.inFlight).toBe(0);
    }
  });

  it("tolerates an account being removed between selection and preparation", async () => {
    const entries = [connection("A")];
    let calls = 0;
    const { coordinator } = createCoordinator(entries, {
      getConnections: async () => {
        calls += 1;
        return calls === 1 ? entries.map((entry) => ({ ...entry })) : [];
      },
    });
    const result = await coordinator.execute({
      model: "gemini",
      body: { messages: [] },
      headers: {},
      invokeAttempt: async () => {
        throw new Error("must not dispatch removed account");
      },
    });

    expect(result.success).toBe(false);
    expect(result.exclusions.some((entry) => entry.reason === "connection_removed")).toBe(true);
    expect(result.attempts).toHaveLength(0);
  });

  it("never puts raw credential canaries in attempts, exclusions, or diagnostics", async () => {
    const secret = "access-A-CANARY-SECRET";
    const entries = [connection("A")];
    const { coordinator } = createCoordinator(entries);
    const result = await coordinator.execute({
      model: "gemini",
      body: { messages: [] },
      headers: {},
      invokeAttempt: async () => ({ success: false, status: 503, error: "temporary failure" }),
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("refresh-A-CANARY-SECRET");
  });

  it("keeps explicit classification policy stable", () => {
    expect(classifyCoordinatorFailure({ status: 400, error: "bad payload" })).toBe(AntigravityFailureClass.CLIENT_DETERMINISTIC);
    expect(classifyCoordinatorFailure({ status: 429, error: "resource exhausted quota" })).toBe(AntigravityFailureClass.QUOTA_EXHAUSTED);
    expect(classifyCoordinatorFailure({ status: 503, error: "temporarily unavailable" })).toBe(AntigravityFailureClass.TRANSIENT_UPSTREAM);
    expect(classifyCoordinatorFailure({ status: 499, error: "cancelled" })).toBe(AntigravityFailureClass.CANCELLED);
  });
});
