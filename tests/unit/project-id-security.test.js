import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getProjectIdForConnection,
  invalidateProjectId,
  removeConnection,
} from "../../open-sse/services/projectId.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Antigravity project lifecycle safety", () => {
  it("single-flights concurrent discovery for one opaque connection scope", async () => {
    const connectionId = "connection-CANARY-IDENTIFIER";
    invalidateProjectId(connectionId);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ cloudaicompanionProject: { id: "project-1" } }),
    }));
    global.fetch = fetchMock;

    const results = await Promise.all(Array.from({ length: 20 }, () =>
      getProjectIdForConnection(connectionId, "access-token-CANARY", "antigravity")
    ));

    expect(results).toEqual(Array(20).fill("project-1"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    removeConnection(connectionId);
  });

  it("does not log upstream error-body or raw connection/token canaries", async () => {
    const connectionId = "connection-CANARY-IDENTIFIER-2";
    invalidateProjectId(connectionId);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 403,
      text: async () => "UPSTREAM-BODY-CANARY access-token-CANARY",
    }));

    const result = await getProjectIdForConnection(connectionId, "access-token-CANARY", "antigravity");
    expect(result).toBeNull();
    const serialized = warn.mock.calls.flat().map((value) => String(value)).join(" ");
    expect(serialized).not.toContain("UPSTREAM-BODY-CANARY");
    expect(serialized).not.toContain("access-token-CANARY");
    expect(serialized).not.toContain(connectionId);
    removeConnection(connectionId);
  });
});
