import crypto from "node:crypto";

/**
 * Produces an opaque, stable identifier for process-local Antigravity state.
 * Inputs may contain secrets, but the returned value never does.
 */
export function opaqueAntigravityIdentity(...parts) {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part ?? ""));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/**
 * Prefer durable connection/account identities. Token material is used only as
 * a last-resort hash input and is never returned, logged, or used as a map key.
 */
export function antigravityAccountIdentity(credentials = {}) {
  const durable = credentials.connectionId || credentials.id || credentials.email || credentials.accountId;
  if (durable) return opaqueAntigravityIdentity("antigravity-account", durable);
  return opaqueAntigravityIdentity(
    "antigravity-account-fallback",
    credentials.refreshToken,
    credentials.accessToken,
  );
}

export function antigravityProjectIdentity(credentials = {}) {
  return opaqueAntigravityIdentity(
    "antigravity-project",
    antigravityAccountIdentity(credentials),
    credentials.projectId,
  );
}
