import { resolveAccountIdentity } from "../../lib/account-identity";
import { createAccountStateRouter } from "../account-state-router";

/**
 * `~/.relaybase/{scopeId}/*` replacement — durable per-account settings/UI
 * state and unsent compose drafts, now backed by D1 `account_state` (+ R2 for
 * draft attachment bytes) instead of the desktop-only filesystem. Mounted at
 * `/mail/account-state` (owner-session auth via `resolveAccountIdentity`);
 * the identical route set is mounted at `/mobile/account-state` for
 * teammates (see `worker/src/routes/mobile.ts`).
 */
const mailAccountState = createAccountStateRouter((c) =>
  resolveAccountIdentity(c, "mail"),
);

export { mailAccountState };
