import { describe, expect, it } from "vitest";
import {
  extractCooldownMs,
  MAX_ANTIGRAVITY_COOLDOWN_MS,
  parseResetAt,
} from "../../open-sse/antigravity/quota.js";

function headers(values) {
  return { get: (name) => values[String(name).toLowerCase()] ?? null };
}

describe("Antigravity quota reset parsing", () => {
  const now = Date.UTC(2026, 7, 25, 0, 0, 0);

  it("parses Retry-After seconds and RFC 7231 HTTP dates", () => {
    expect(extractCooldownMs(headers({ "retry-after": "7" }), "", now)).toBe(7_000);
    const httpDate = new Date(now + 12_000).toUTCString();
    expect(extractCooldownMs(headers({ "retry-after": httpDate }), "", now)).toBe(12_000);
  });

  it("rejects malformed and past reset metadata instead of creating stale cooldown", () => {
    expect(parseResetAt("not-a-date", now)).toBeNull();
    expect(parseResetAt(new Date(now - 1_000).toUTCString(), now)).toBeNull();
    expect(extractCooldownMs(headers({ "retry-after": "nonsense" }), "", now)).toBeNull();
  });

  it("clamps excessive future reset metadata to the documented maximum", () => {
    expect(extractCooldownMs(headers({ "retry-after": "9999999" }), "", now)).toBe(MAX_ANTIGRAVITY_COOLDOWN_MS);
    expect(extractCooldownMs(headers({}), "quota resets after 999h", now)).toBe(MAX_ANTIGRAVITY_COOLDOWN_MS);
  });

  it("accepts structured duration text only when the complete value is a duration", () => {
    expect(parseResetAt("1h 2m 3s", now)).toBe(now + 3_723_000);
    expect(parseResetAt("junk 1h", now)).toBeNull();
  });
});
