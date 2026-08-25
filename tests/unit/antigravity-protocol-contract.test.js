import { describe, expect, it } from "vitest";
import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const model = "gemini-3.1-flash-lite";

function credentials() {
  return {
    accessToken: "token-test",
    projectId: "project-test",
    connectionId: "connection-test",
    rawHeaders: {},
  };
}

function build(sourceFormat, body) {
  const creds = credentials();
  const translated = translateRequest(
    sourceFormat,
    FORMATS.ANTIGRAVITY,
    model,
    structuredClone(body),
    false,
    creds,
    "antigravity",
    null,
    [],
    creds.connectionId,
    null,
  );
  return new AntigravityExecutor().transformRequest(model, translated, false, creds);
}

function assertEnvelope(payload) {
  expect(payload.project).toBe("project-test");
  expect(payload.model).toBe(model);
  expect(payload.requestType).toBe("agent");
  expect(payload.request.sessionId).toBeTruthy();
  expect(Array.isArray(payload.request.contents)).toBe(true);
  expect(payload.request.contents.length).toBeGreaterThan(0);
}

describe("Antigravity four-protocol request contract", () => {
  it("converts OpenAI Chat content, tools, and tool results", () => {
    const payload = build(FORMATS.OPENAI, {
      model,
      messages: [
        { role: "user", content: "Call the tool." },
        { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }] },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
      tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } } }],
    });
    assertEnvelope(payload);
    expect(payload.request.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("lookup");
  });

  it("converts Anthropic Messages system, tool use, and tool result history", () => {
    const payload = build(FORMATS.CLAUDE, {
      model,
      system: "Be concise.",
      max_tokens: 128,
      tools: [{ name: "lookup", description: "Lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
      messages: [
        { role: "user", content: "Call lookup" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result" }] },
      ],
    });
    assertEnvelope(payload);
    expect(payload.request.systemInstruction?.parts?.[0]?.text).toContain("Be concise.");
  });

  it("preserves Gemini-native contents and generation configuration", () => {
    const payload = build(FORMATS.GEMINI, {
      contents: [{ role: "user", parts: [{ text: "Hello" }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
    });
    assertEnvelope(payload);
    expect(payload.request.generationConfig.temperature).toBe(0.2);
  });

  it("converts OpenAI Responses input and leaves provider request free of public transport fields", () => {
    const payload = build(FORMATS.OPENAI_RESPONSES, {
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: "Hello from responses" }] }],
      stream: false,
      store: false,
    });
    assertEnvelope(payload);
    expect(payload).not.toHaveProperty("stream_options");
    expect(payload.request.contents.flatMap((content) => content.parts).some((part) => part.text?.includes("Hello from responses"))).toBe(true);
  });
});
