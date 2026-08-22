import { Agent, ProxyAgent } from "undici";
const entries = new Map();
const MAX = 64;
function fingerprint(proxyOptions) { if (!proxyOptions) return "direct"; return [proxyOptions.vercelRelayUrl, proxyOptions.url || proxyOptions.connectionProxyUrl, proxyOptions.noProxy].filter(Boolean).join("|") || "direct"; }
function keyOf(credentialId, proxyOptions, origin) { return `${credentialId || "anonymous"}|${fingerprint(proxyOptions)}|${new URL(origin).origin}`; }
export function getAntigravityTransport({ credentialId, proxyOptions, origin }) { const key = keyOf(credentialId, proxyOptions, origin); let item = entries.get(key); if (!item) { if (entries.size >= MAX) { const oldest = entries.keys().next().value; entries.get(oldest)?.dispatcher?.close?.(); entries.delete(oldest); } const proxy = proxyOptions?.url || proxyOptions?.connectionProxyUrl; const dispatcher = proxy ? new ProxyAgent({ uri: proxy }) : new Agent({ connections: 8, pipelining: 1, keepAliveTimeout: 30_000, keepAliveMaxTimeout: 120_000 }); item = { key, dispatcher, uses: 0, createdAt: Date.now(), lastUsedAt: Date.now() }; entries.set(key, item); } item.uses++; item.lastUsedAt = Date.now(); return item.dispatcher; }
export async function closeAntigravityTransports() { await Promise.all([...entries.values()].map(({ dispatcher }) => dispatcher.close?.())); entries.clear(); }
export function transportStats() { return [...entries.values()].map(({ key, uses, createdAt, lastUsedAt }) => ({ keyHash: key.length, uses, createdAt, lastUsedAt })); }
