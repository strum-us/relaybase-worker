import type { Env } from "../env";
import { createAppDb } from "../../db/app";
import { extractBearerToken } from "./auth";
import {
  constantTimeEqual,
  getAccountMobileConfig,
  hashMobilePassword,
  type StoredMobileConfig,
} from "./mobile-config";

/**
 * Minimal slice of a Hono context that `requireMobilePassword` needs.
 * Declared structurally so the middleware can be called from any Hono app
 * regardless of its `Variables` type (avoids `set`/`get` variance issues).
 */
type MobileAuthContext = {
  req: {
    header(name: string): string | undefined;
  };
  env: Env;
  json(body: unknown, status: number): Response;
};

export type MobileAuthResult = {
  email: string;
  config: StoredMobileConfig;
};

/**
 * Authenticate `/mobile/*` requests with a per-account mobile password.
 *
 * The desktop Other device tab writes a salted SHA-256 hash of the password
 * to D1 `mobile_passwords`. The Flutter app sends the account email
 * via the `X-Account-Email` header and the plain password as
 * `Authorization: Bearer {password}`; we re-hash with the stored salt and
 * compare in constant time. Returns the resolved email + config on success
 * so routes can scope operations to the authenticated account.
 */
export async function requireMobilePassword(
  c: MobileAuthContext,
): Promise<MobileAuthResult | Response> {
  const email = c.req.header("X-Account-Email")?.trim().toLowerCase();
  if (!email) {
    return c.json({ error: "Account email is required" }, 401);
  }

  const token = extractBearerToken(c.req.header("Authorization"));
  if (!token) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const config = await getAccountMobileConfig(createAppDb(c.env.RELAYBASE_DB), email);
  if (!config) {
    // Mobile access has not been configured for this account.
    return c.json({ error: "Mobile access is not configured for this account" }, 401);
  }

  const candidateHash = await hashMobilePassword(token, config.salt);
  if (!constantTimeEqual(candidateHash, config.passwordHash)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return { email, config };
}
