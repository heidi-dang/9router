import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AntigravityCreditState,
  clearAntigravityCreditStates,
  getAntigravityCreditState,
  refreshAntigravityCreditState,
} from "../../open-sse/antigravity/credits.js";

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

describe("Antigravity authenticated credit lifecycle", () => {
  beforeEach(() => clearAntigravityCreditStates());

  it("classifies positive, exact-minimum, and zero balances without fabricating values", async () => {
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.headers.Authorization).toBe("Bearer token");
      return response({ paidTier: { id: "tier", availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "5", minimumCreditAmountForUsage: "2" }] } });
    });
    const available = await refreshAntigravityCreditState({ accountIdentity: "account-a", accessToken: "token", fetchImpl, now: 1_000 });
    expect(available.state).toBe(AntigravityCreditState.AVAILABLE);
    expect(available.creditAmount).toBe(5);

    clearAntigravityCreditStates();
    const low = await refreshAntigravityCreditState({
      accountIdentity: "account-a", accessToken: "token", now: 1_000,
      fetchImpl: async () => response({ paidTier: { availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "2", minimumCreditAmountForUsage: "2" }] } }),
    });
    expect(low.state).toBe(AntigravityCreditState.LOW);

    clearAntigravityCreditStates();
    const exhausted = await refreshAntigravityCreditState({
      accountIdentity: "account-a", accessToken: "token", now: 1_000,
      fetchImpl: async () => response({ paidTier: { availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "0", minimumCreditAmountForUsage: "1" }] } }),
    });
    expect(exhausted.state).toBe(AntigravityCreditState.EXHAUSTED);
  });

  it("keeps malformed, forbidden, and absent metadata distinct from zero credits", async () => {
    const malformed = await refreshAntigravityCreditState({
      accountIdentity: "account-a", accessToken: "token", now: 1_000,
      fetchImpl: async () => response({ paidTier: { availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "bad", minimumCreditAmountForUsage: "1" }] } }),
    });
    expect(malformed.state).toBe(AntigravityCreditState.ERROR);

    clearAntigravityCreditStates();
    const forbidden = await refreshAntigravityCreditState({
      accountIdentity: "account-a", accessToken: "token", now: 1_000,
      fetchImpl: async () => response({}, 403),
    });
    expect(forbidden.state).toBe(AntigravityCreditState.ERROR);
    expect(getAntigravityCreditState("account-a", 1_001).state).not.toBe(AntigravityCreditState.EXHAUSTED);

    clearAntigravityCreditStates();
    const unsupported = await refreshAntigravityCreditState({
      accountIdentity: "account-a", accessToken: "token", now: 1_000,
      fetchImpl: async () => response({ paidTier: {} }),
    });
    expect(unsupported.state).toBe(AntigravityCreditState.UNSUPPORTED);
  });

  it("single-flights concurrent discovery per opaque account", async () => {
    let resolveFetch;
    const fetchImpl = vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const calls = Array.from({ length: 20 }, () => refreshAntigravityCreditState({
      accountIdentity: "account-a", accessToken: "token", fetchImpl, now: 1_000,
    }));
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    resolveFetch(response({ paidTier: { availableCredits: [{ creditType: "GOOGLE_ONE_AI", creditAmount: "3", minimumCreditAmountForUsage: "1" }] } }));
    const results = await Promise.all(calls);
    expect(results.every((value) => value.state === AntigravityCreditState.AVAILABLE)).toBe(true);
  });
});
