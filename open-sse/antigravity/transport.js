import { Agent, ProxyAgent } from "undici";
import { opaqueAntigravityIdentity } from "./identity.js";

const entries = new Map();
const MAX_ENTRIES = 64;
const DEFAULT_CONNECTIONS = 8;
const KEEP_ALIVE_TIMEOUT_MS = 30_000;
const KEEP_ALIVE_MAX_TIMEOUT_MS = 120_000;

function normalizeOrigin(origin) {
  try { return new URL(origin).origin; } catch { return "invalid-origin"; }
}

function configuredProxy(proxyOptions = {}) {
  if (proxyOptions?.enabled !== true && proxyOptions?.connectionProxyEnabled !== true) return null;
  return proxyOptions?.url || proxyOptions?.connectionProxyUrl || null;
}

function keyOf({ accountIdentity, proxyOptions, origin }) {
  return opaqueAntigravityIdentity(
    "antigravity-transport-v1",
    accountIdentity || "anonymous",
    normalizeOrigin(origin),
    configuredProxy(proxyOptions) || "direct",
    proxyOptions?.vercelRelayUrl || "",
    proxyOptions?.strictProxy === true ? "strict" : "relaxed",
  );
}

function closeDispatcher(dispatcher) {
  try {
    const result = dispatcher?.close?.();
    if (result?.catch) result.catch(() => {});
  } catch {
    // Best-effort cleanup must never surface credentials or transport details.
  }
}

function evictOldestIfNeeded() {
  if (entries.size < MAX_ENTRIES) return;
  const oldestKey = entries.keys().next().value;
  const oldest = entries.get(oldestKey);
  closeDispatcher(oldest?.dispatcher);
  entries.delete(oldestKey);
}

/**
 * Returns a bounded dispatcher scoped to an opaque account, origin, and proxy
 * identity. Raw credentials and proxy URLs are never used as visible keys.
 */
export function getAntigravityTransport({ accountIdentity, proxyOptions, origin }) {
  const key = keyOf({ accountIdentity, proxyOptions, origin });
  let item = entries.get(key);
  if (!item) {
    evictOldestIfNeeded();
    const proxyUrl = configuredProxy(proxyOptions);
    const dispatcher = proxyUrl
      ? new ProxyAgent({ uri: proxyUrl })
      : new Agent({
          connections: DEFAULT_CONNECTIONS,
          pipelining: 1,
          keepAliveTimeout: KEEP_ALIVE_TIMEOUT_MS,
          keepAliveMaxTimeout: KEEP_ALIVE_MAX_TIMEOUT_MS,
        });
    item = { dispatcher, uses: 0, createdAt: Date.now(), lastUsedAt: Date.now() };
    entries.set(key, item);
  }
  item.uses += 1;
  item.lastUsedAt = Date.now();
  // Promote recently used entries, preserving simple LRU eviction semantics.
  entries.delete(key);
  entries.set(key, item);
  return item.dispatcher;
}

export async function closeAntigravityTransports() {
  const closeResults = [];
  for (const { dispatcher } of entries.values()) {
    try { closeResults.push(dispatcher?.close?.()); } catch { /* best effort */ }
  }
  entries.clear();
  await Promise.allSettled(closeResults);
}

/** Diagnostics intentionally expose no origin, account, proxy, or secret data. */
export function transportStats() {
  return [...entries.values()].map(({ uses, createdAt, lastUsedAt }) => ({ uses, createdAt, lastUsedAt }));
}

export function clearAntigravityTransportsForTest() {
  for (const { dispatcher } of entries.values()) closeDispatcher(dispatcher);
  entries.clear();
}
