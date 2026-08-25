import { opaqueAntigravityIdentity } from "./identity.js";

const cooldowns = new Map();
const MAX_COOLDOWNS = 4_000;
export const MAX_ANTIGRAVITY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function accountOf(input = {}) {
  return input.accountIdentity || input.credentialId || "anonymous";
}

function keyOf(accountIdentity, model) {
  return opaqueAntigravityIdentity("antigravity-cooldown-v1", accountIdentity || "anonymous", model || "*");
}

export function parseResetAt(value, now = Date.now()) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    const target = numeric < 1e11 ? now + numeric * 1000 : numeric;
    return Number.isFinite(target) && target > now ? target : null;
  }
  const duration = text.match(/^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/i);
  if (duration && (duration[1] || duration[2] || duration[3])) {
    return now + ((Number(duration[1]) || 0) * 3600 + (Number(duration[2]) || 0) * 60 + (Number(duration[3]) || 0)) * 1000;
  }
  const date = Date.parse(text);
  return Number.isFinite(date) && date > now ? date : null;
}

export function extractCooldownMs(headers, body = "", now = Date.now()) {
  const get = (name) => headers?.get?.(name) ?? headers?.[name] ?? headers?.[name.toLowerCase()];
  for (const name of ["retry-after", "x-ratelimit-reset-after", "x-quota-reset-after", "x-ratelimit-reset"]) {
    const at = parseResetAt(get(name), now);
    if (at != null) return Math.min(MAX_ANTIGRAVITY_COOLDOWN_MS, Math.max(0, at - now));
  }
  const match = String(body).match(/reset(?:s| after)?[^\d]*(\d+h)?\s*(\d+m)?\s*(\d+s)?/i);
  if (!match || !(match[1] || match[2] || match[3])) return null;
  const resetAt = parseResetAt(`${match[1] || ""}${match[2] || ""}${match[3] || ""}`, now);
  return resetAt == null ? null : Math.min(MAX_ANTIGRAVITY_COOLDOWN_MS, Math.max(0, resetAt - now));
}

function cleanup(now = Date.now()) {
  for (const [key, value] of cooldowns) {
    if (value.until <= now) cooldowns.delete(key);
  }
}

export function setCooldown({ accountIdentity, credentialId, model, until, reason = "quota", now = Date.now() }) {
  const account = accountIdentity || credentialId || "anonymous";
  const target = typeof until === "number" ? until : Date.parse(until);
  if (!Number.isFinite(target) || target <= now) return null;
  cleanup(now);
  const key = keyOf(account, model);
  if (!cooldowns.has(key) && cooldowns.size >= MAX_COOLDOWNS) cooldowns.delete(cooldowns.keys().next().value);
  const value = { until: target, reason, model: model || null, accountIdentity: opaqueAntigravityIdentity("antigravity-cooldown-account", account) };
  cooldowns.delete(key);
  cooldowns.set(key, value);
  return { ...value };
}

export function getCooldown(accountIdentity, model, now = Date.now()) {
  cleanup(now);
  const specific = cooldowns.get(keyOf(accountIdentity, model));
  const accountWide = cooldowns.get(keyOf(accountIdentity, null));
  const active = [specific, accountWide].filter(Boolean).sort((left, right) => right.until - left.until)[0];
  return active ? { ...active } : null;
}

export const isCoolingDown = (...args) => Boolean(getCooldown(...args));
export function clearCooldowns() { cooldowns.clear(); }
export function cooldownStats() { cleanup(); return { size: cooldowns.size }; }
export function cooldownKey(accountIdentity, model) { return keyOf(accountIdentity, model); }
