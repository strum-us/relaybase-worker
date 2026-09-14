import type { Context } from "hono";
import type { Env } from "../../env";
import { createAppDb } from "../../../db/app";
import { getOwnerLoginConfig } from "../../../db/app/owner";
import { requireOwnerSession } from "../auth/auth";
import { requireMobilePassword } from "../auth/mobile-auth";
import type { OwnerScope } from "../auth/owner-auth";

export type AccountIdentity = {
  /** "owner" or "team:{email}". Scopes every `account_state` / draft-attachment row. */
  identityKey: string;
  /** Authenticated email when known (mobile-password path); null for an owner bearer session. */
  email: string | null;
};

/**
 * Resolve which identity a `/mail/account-state/*` or `/mobile/account-state/*`
 * request is acting as. Tries the owner bearer session first, then falls back
 * to per-account mobile-password auth (same two auth surfaces the rest of
 * `/mail/*` and `/mobile/*` already use).
 *
 * An owner who authenticates via mobile-password (the web "email" build can
 * land an owner there — see `mail-platform/types.ts`) is folded back to
 * `"owner"` by matching against `owner_config.ownerEmail`, so their UI state
 * doesn't split from their desktop/console session.
 */
export async function resolveAccountIdentity(
  c: Context<{ Bindings: Env }>,
  scope: OwnerScope,
): Promise<AccountIdentity | Response> {
  const ownerDenied = await requireOwnerSession(c, scope);
  if (ownerDenied === null) {
    return { identityKey: "owner", email: null };
  }

  const mobileAuth = await requireMobilePassword(c);
  if (mobileAuth instanceof Response) {
    // Neither auth path succeeded — surface the owner-session failure, which
    // matches the 401 shape every other `/mail/*` route already returns.
    return ownerDenied;
  }

  return foldMobileIdentity(c.env, mobileAuth.email);
}

/**
 * Fold an already-authenticated mobile-password email into an identityKey.
 * Used directly by `/mobile/account-state` routes, which run inside
 * `mobile.use("*", requireMobilePassword)` and already have the email —
 * calling this instead of `resolveAccountIdentity` avoids re-running auth.
 */
export async function foldMobileIdentity(
  env: Env,
  email: string,
): Promise<AccountIdentity> {
  const db = createAppDb(env.RELAYBASE_DB);
  const ownerConfig = db ? await getOwnerLoginConfig(db) : null;
  const ownerEmail = ownerConfig?.ownerEmail?.trim().toLowerCase();
  if (ownerEmail && ownerEmail === email) {
    return { identityKey: "owner", email };
  }
  return { identityKey: `team:${email}`, email };
}
