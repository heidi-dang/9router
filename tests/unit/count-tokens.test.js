import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/localDb", () => ({
  validateApiKey: vi.fn(async (key) => key === "test-route-key"),
}));

import { POST, buildAntigravityCountTokensPayload } from "../../src/app/api/v1/messages/count_tokens/route.js";

async function countTokens(body) {
  const response = await POST(new Request("https://9router.local/v1/messages/count_tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "test-route-key" },
    body: JSON.stringify(body),
  }));

  expect(response.status).toBe(200);
  return response.json();
}

describe("Anthropic count_tokens estimator", () => {
  it("rejects unauthenticated public count-token requests", async () => {
    const response = await POST(new Request("https://9router.local/v1/messages/count_tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    }));
    expect(response.status).toBe(401);
    expect((await response.json()).error.type).toBe("authentication_error");
  });

  it("builds an Antigravity-native countTokens payload through the canonical translator", () => {
    const payload = buildAntigravityCountTokensPayload({
      model: "gemini-3.1-flash-lite",
      system: "You are concise.",
      messages: [{ role: "user", content: "count this" }],
      tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object", properties: {} } }],
    }, "gemini-3.1-flash-lite", {
      projectId: "project-test",
      connectionId: "connection-test",
      accessToken: "token-test",
      rawHeaders: {},
    });

    expect(payload).not.toHaveProperty("project");
    expect(payload).not.toHaveProperty("model");
    expect(payload.request).toBeTruthy();
    expect(payload.request).not.toHaveProperty("safetySettings");
    expect(Array.isArray(payload.request.contents)).toBe(true);
  });

  it("preserves the existing plain text estimate", async () => {
    const result = await countTokens({
      messages: [
        {
          role: "user",
          content: "hello world",
        },
      ],
    });

    expect(result.input_tokens).toBe(3);
  });

  it("counts tool and thinking content blocks that carry context", async () => {
    const result = await countTokens({
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01",
              name: "Read",
              input: { file_path: "/tmp/example.txt" },
            },
            {
              type: "thinking",
              thinking: "Need to inspect the file before answering.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: "line1 line2 line3 some file content here",
            },
          ],
        },
      ],
    });

    expect(result.input_tokens).toBeGreaterThan(0);
  });

  it("counts system prompts and tool definitions", async () => {
    const result = await countTokens({
      system: "You are a coding assistant.",
      tools: [
        {
          name: "Read",
          description: "Read a file",
          input_schema: {
            type: "object",
            properties: {
              file_path: { type: "string" },
            },
          },
        },
      ],
      messages: [],
    });

    expect(result.input_tokens).toBeGreaterThan(0);
  });
});
