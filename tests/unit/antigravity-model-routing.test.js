import { describe, expect, it } from "vitest";
import { getModelInfoCore, parseModel, resolveProviderAlias } from "../../open-sse/services/model.js";

describe("Antigravity model-prefix routing", () => {
  it("resolves both the canonical and short Antigravity prefixes", async () => {
    await expect(getModelInfoCore("antigravity/gemini-3.1-flash-lite", {})).resolves.toEqual({
      provider: "antigravity",
      model: "gemini-3.1-flash-lite",
    });
    await expect(getModelInfoCore("ag/gemini-3.1-flash-lite", {})).resolves.toEqual({
      provider: "antigravity",
      model: "gemini-3.1-flash-lite",
    });
    expect(resolveProviderAlias("ag")).toBe("antigravity");
  });

  it("does not infer Antigravity for unprefixed Gemini models", async () => {
    await expect(getModelInfoCore("gemini-3.1-flash-lite", {})).resolves.toEqual({
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
    });
  });

  it("keeps Gemini and Gemini CLI prefixes owned by their explicit providers", async () => {
    await expect(getModelInfoCore("gemini/gemini-3.1-flash-lite", {})).resolves.toEqual({
      provider: "gemini",
      model: "gemini-3.1-flash-lite",
    });
    await expect(getModelInfoCore("gc/gemini-3.1-flash-lite", {})).resolves.toEqual({
      provider: "gemini-cli",
      model: "gemini-3.1-flash-lite",
    });
  });

  it("preserves only the first slash as the provider boundary", () => {
    expect(parseModel("ag/family/model")).toEqual({
      provider: "antigravity",
      model: "family/model",
      isAlias: false,
      providerAlias: "ag",
    });
  });
});
