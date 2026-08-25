import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ proxyAwareFetch: vi.fn() }));
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: mocks.proxyAwareFetch }));
const proxyAwareFetch = mocks.proxyAwareFetch;

import { AntigravityExecutor } from "../../open-sse/executors/antigravity.js";
import { AntigravityEndpointManager } from "../../open-sse/antigravity/endpoints.js";
import { antigravityAccountIdentity } from "../../open-sse/antigravity/identity.js";
import { clearCooldowns, getCooldown } from "../../open-sse/antigravity/quota.js";
import { clearAntigravityTransportsForTest, transportStats } from "../../open-sse/antigravity/transport.js";

const DAILY = "https://daily-cloudcode-pa.googleapis.com";
const PROD = "https://cloudcode-pa.googleapis.com";
const MODEL = "gemini-3-flash-agent";

function credentials(connectionId = "connection-a") {
  return {
    connectionId,
    projectId: `project-${connectionId}`,
    accessToken: `access-${connectionId}-never-visible`,
    refreshToken: `refresh-${connectionId}-never-visible`,
  };
}

function request({ sessionId = "session-a", thoughtSignature = undefined } = {}) {
  const functionCall = { name: "read_file", args: { path: "README.md" } };
  const part = { functionCall };
  if (thoughtSignature) part.thoughtSignature = thoughtSignature;
  return {
    request: {
      sessionId,
      contents: [{ role: "model", parts: [part] }],
      generationConfig: { maxOutputTokens: 128 },
    },
  };
}

function response(status = 200, body = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function executor({ endpoints = [DAILY, PROD], retry = { "429": { attempts: 0 }, "503": { attempts: 0 } } } = {}) {
  const instance = new AntigravityExecutor();
  instance.config = {
    ...instance.config,
    baseUrls: endpoints,
    retry: { ...instance.config.retry, ...retry },
  };
  instance.endpointManager = new AntigravityEndpointManager(endpoints);
  return instance;
}

async function execute(instance, body, account = credentials()) {
  return instance.execute({
    model: MODEL,
    body,
    stream: false,
    credentials: account,
    proxyOptions: { strictProxy: true },
  });
}

beforeEach(() => {
  proxyAwareFetch.mockReset();
  clearCooldowns();
  clearAntigravityTransportsForTest();
});

afterEach(() => clearAntigravityTransportsForTest());

describe("Antigravity executor active runtime wiring", () => {
  it("uses the bounded transport pool from the production execute path and isolates incompatible accounts", async () => {
    const instance = executor({ endpoints: [DAILY] });
    proxyAwareFetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(response()).mockResolvedValueOnce(response());

    await execute(instance, request(), credentials("account-a"));
    await execute(instance, request(), credentials("account-a"));
    await execute(instance, request(), credentials("account-b"));

    const firstDispatcher = proxyAwareFetch.mock.calls[0][1].dispatcher;
    const secondDispatcher = proxyAwareFetch.mock.calls[1][1].dispatcher;
    const thirdDispatcher = proxyAwareFetch.mock.calls[2][1].dispatcher;
    expect(firstDispatcher).toBe(secondDispatcher);
    expect(thirdDispatcher).not.toBe(firstDispatcher);
    expect(transportStats()).toEqual(expect.arrayContaining([
      expect.objectContaining({ uses: 2 }),
      expect.objectContaining({ uses: 1 }),
    ]));
    expect(JSON.stringify(transportStats())).not.toContain("access-account-a-never-visible");
    expect(JSON.stringify(transportStats())).not.toContain("refresh-account-a-never-visible");
  });

  it("uses the endpoint manager to select daily and does not cross-fallback after a transient failure", async () => {
    const instance = executor();
    proxyAwareFetch.mockResolvedValueOnce(response(503, { error: { message: "high traffic" } }));

    const result = await execute(instance, request({ sessionId: "sticky-session" }));

    expect(result.response.status).toBe(503);
    expect(proxyAwareFetch.mock.calls.map(([url]) => url)).toEqual([
      `${DAILY}/v1internal:generateContent`,
    ]);
    expect(instance.endpointManager.snapshot()[DAILY].consecutiveFailures).toBeGreaterThan(0);
  });

  it("records a model-scoped 429 cooldown through execute without poisoning another model or account", async () => {
    const instance = executor({ endpoints: [DAILY] });
    const accountA = credentials("account-a");
    proxyAwareFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "rate limited" } }), {
      status: 429,
      headers: { "retry-after": "4", "content-type": "application/json" },
    }));

    const result = await execute(instance, request(), accountA);
    const identityA = antigravityAccountIdentity(accountA);

    expect(result.response.status).toBe(429);
    expect(getCooldown(identityA, MODEL)).toEqual(expect.objectContaining({ reason: "RATE_LIMITED" }));
    expect(getCooldown(identityA, "claude-sonnet-4-6")).toBeNull();
    expect(getCooldown(antigravityAccountIdentity(credentials("account-b")), MODEL)).toBeNull();
  });

  it("does not create cooldown or endpoint rotation state for deterministic 400 failures", async () => {
    const instance = executor({ endpoints: [DAILY, PROD] });
    const account = credentials("account-a");
    proxyAwareFetch.mockResolvedValueOnce(response(400, { error: { message: "invalid tool schema" } }));

    const result = await execute(instance, request(), account);

    expect(result.response.status).toBe(400);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(getCooldown(antigravityAccountIdentity(account), MODEL)).toBeNull();
    expect(instance.endpointManager.snapshot()[DAILY].consecutiveFailures).toBe(0);
  });

  it("rejects unsupported tool schemas before dispatch without cooldown or endpoint rotation", async () => {
    const instance = executor({ endpoints: [DAILY, PROD] });
    const account = credentials("account-a");
    const malformed = request();
    malformed.request.tools = [{ functionDeclarations: [{
      name: "recursive_tool",
      parameters: { $ref: "#/components/schemas/Recursive" },
    }] }];

    await expect(execute(instance, malformed, account)).rejects.toMatchObject({ code: "BAD_TOOL_SCHEMA", status: 400 });

    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(getCooldown(antigravityAccountIdentity(account), MODEL)).toBeNull();
    expect(instance.endpointManager.snapshot()[DAILY].consecutiveFailures).toBe(0);
  });

  it("injects the official enabled credit type without inventing a credit balance", () => {
    const transformed = executor().transformRequest(MODEL, request(), false, credentials("account-a"));
    expect(transformed.enabledCreditTypes).toEqual(["GOOGLE_ONE_AI"]);
  });

  it("does not retry explicit Antigravity credit exhaustion as a generic rate limit", async () => {
    const instance = executor();
    const exhausted = response(429, {
      error: {
        status: "RESOURCE_EXHAUSTED",
        details: [{
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "INSUFFICIENT_G1_CREDITS_BALANCE",
        }],
      },
    });

    await expect(instance.computeRetryDelay(exhausted, 1)).resolves.toBe(false);
  });

  it("single-flights concurrent refreshes by opaque account identity and preserves an omitted replacement refresh token", async () => {
    const instance = executor();
    const account = credentials("account-a");
    proxyAwareFetch.mockResolvedValueOnce(response(200, { access_token: "new-access", expires_in: 3600 }));

    const [first, second] = await Promise.all([
      instance.refreshCredentials(account),
      instance.refreshCredentials(account),
    ]);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(expect.objectContaining({ accessToken: "new-access", refreshToken: account.refreshToken, expiresIn: 3600 }));
    expect(second).toEqual(first);
  });

  it("keeps refresh failures redacted from logger output", async () => {
    const instance = executor();
    const account = credentials("account-a");
    const logger = { error: vi.fn() };
    proxyAwareFetch.mockRejectedValueOnce(new Error(`refresh rejected for ${account.refreshToken}`));

    await expect(instance.refreshCredentials(account, logger)).resolves.toBeNull();

    expect(logger.error).toHaveBeenCalledWith("TOKEN", "Antigravity refresh failed");
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(account.refreshToken);
  });

  it("uses opaque session affinity and replays a thought signature only inside the same account/session/model scope", async () => {
    const instance = executor({ endpoints: [DAILY] });
    proxyAwareFetch.mockResolvedValueOnce(response()).mockResolvedValueOnce(response()).mockResolvedValueOnce(response());

    await execute(instance, request({ sessionId: "same-session", thoughtSignature: "signature-a" }), credentials("account-a"));
    await execute(instance, request({ sessionId: "same-session" }), credentials("account-a"));
    await execute(instance, request({ sessionId: "same-session" }), credentials("account-b"));

    const sameAccountBody = JSON.parse(proxyAwareFetch.mock.calls[1][1].body);
    const differentAccountBody = JSON.parse(proxyAwareFetch.mock.calls[2][1].body);
    expect(sameAccountBody.request.contents[0].parts[0].thoughtSignature).toBe("signature-a");
    expect(differentAccountBody.request.contents[0].parts[0].thoughtSignature).not.toBe("signature-a");
  });
});
