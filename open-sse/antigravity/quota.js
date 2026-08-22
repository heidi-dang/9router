const cooldowns = new Map();
const keyOf = (credential, model) => `${credential || "anonymous"}:${model || "*"}`;
export function parseResetAt(value, now = Date.now()) {
  if (value == null) return null;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) { const n = Number(text); return n < 1e11 ? now + n * 1000 : n; }
  const match = text.match(/(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?/i);
  if (match && (match[1] || match[2] || match[3])) return now + ((+match[1] || 0) * 3600 + (+match[2] || 0) * 60 + (+match[3] || 0)) * 1000;
  const date = Date.parse(text); return Number.isFinite(date) && date > now ? date : null;
}
export function extractCooldownMs(headers, body = "", now = Date.now()) {
  const get = (name) => headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
  for (const name of ["retry-after", "x-ratelimit-reset-after", "x-quota-reset-after", "x-ratelimit-reset"]) { const at = parseResetAt(get(name), now); if (at) return Math.max(0, at - now); }
  const match = String(body).match(/reset(?:s| after)?[^\d]*(\d+h)?\s*(\d+m)?\s*(\d+s)?/i);
  if (!match || !(match[1] || match[2] || match[3])) return null;
  const resetAt = parseResetAt(`${match[1] || ""}${match[2] || ""}${match[3] || ""}`, now);
  return resetAt == null ? null : Math.max(0, resetAt - now);
}
export function setCooldown({ credentialId, model, until, reason = "quota" }) { const key = keyOf(credentialId, model); const value = typeof until === "number" ? until : Date.parse(until); cooldowns.set(key, { until: value, reason }); return cooldowns.get(key); }
export function getCooldown(credentialId, model, now = Date.now()) { const entries = [cooldowns.get(keyOf(credentialId, model)), cooldowns.get(keyOf(credentialId, null))].filter(Boolean); const active = entries.filter(x => x.until > now).sort((a,b) => b.until-a.until)[0]; if (!active) { cooldowns.delete(keyOf(credentialId, model)); return null; } return active; }
export const isCoolingDown = (...args) => Boolean(getCooldown(...args));
export function clearCooldowns() { cooldowns.clear(); }
export function cooldownKey(credentialId, model) { return keyOf(credentialId, model); }
