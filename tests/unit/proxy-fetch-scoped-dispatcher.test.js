import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadProxyFetch(originalFetch) {
  vi.stubGlobal("fetch", originalFetch);
  return import("../../open-sse/utils/proxyFetch.js");
}

describe("proxyAwareFetch scoped dispatcher and strict proxy behavior", () => {
  it("uses an executor-supplied scoped dispatcher instead of allocating a second proxy dispatcher", async () => {
    const originalFetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const { proxyAwareFetch } = await loadProxyFetch(originalFetch);
    const scopedDispatcher = { dispatch() {} };

    await proxyAwareFetch("https://example.test/v1", { method: "POST", dispatcher: scopedDispatcher }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:65535",
      strictProxy: true,
    });

    expect(originalFetch).toHaveBeenCalledTimes(1);
    expect(originalFetch).toHaveBeenCalledWith(
      "https://example.test/v1",
      expect.objectContaining({ dispatcher: scopedDispatcher }),
    );
  });

  it("does not silently retry directly when a strict proxy dispatcher fails", async () => {
    const originalFetch = vi.fn().mockRejectedValue(new Error("proxy tunnel unavailable"));
    const { proxyAwareFetch } = await loadProxyFetch(originalFetch);

    await expect(proxyAwareFetch("https://example.test/v1", { method: "POST", dispatcher: { dispatch() {} } }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "http://127.0.0.1:65535",
      strictProxy: true,
    })).rejects.toThrow(/Proxy required but failed/);

    expect(originalFetch).toHaveBeenCalledTimes(1);
  });
});
