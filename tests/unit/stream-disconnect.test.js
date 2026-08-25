import { describe, expect, it, vi } from "vitest";
import { createStreamController, pipeWithDisconnect } from "../../open-sse/utils/streamHandler.js";

const encoder = new TextEncoder();

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("pipeWithDisconnect", () => {
  it("cancels the upstream body as soon as the client cancels the readable stream", async () => {
    const upstreamCancelled = vi.fn();
    let upstreamController;
    const upstream = new ReadableStream({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(encoder.encode("data: first\n\n"));
      },
      cancel(reason) {
        upstreamCancelled(reason);
      },
    });
    const response = new Response(upstream, { headers: { "content-type": "text/event-stream" } });
    const controller = createStreamController({ provider: "antigravity", model: "gemini-test", log: { line: vi.fn(), errorLine: vi.fn() } });
    const transform = new TransformStream();
    const piped = pipeWithDisconnect(response, transform, controller, null, 10_000);
    const reader = piped.getReader();

    await reader.read();
    await reader.cancel("client_closed");
    await flush();

    expect(upstreamCancelled).toHaveBeenCalledTimes(1);
    expect(controller.isConnected()).toBe(false);
    // Prevent an intentionally open test source from retaining its controller.
    upstreamController?.error?.(new Error("test complete"));
  });
});
