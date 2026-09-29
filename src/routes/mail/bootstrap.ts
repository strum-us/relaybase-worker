import { Hono } from "hono";
import type { Env } from "../../env";
import { requireMailSession } from "../../lib/auth/auth";
import { resolveAccountIdentity } from "../../lib/catalog/account-identity";
import { readAccountState } from "../../lib/catalog/account-state";
import { readMailbox } from "../../lib/catalog/catalog-store";
import { createAppDb } from "../../../db/app";
import { createMailDb } from "../../../db/mail";
import { mailboxAddressCounts, mailboxCounts } from "../../../db/mail/messages";

const mailBootstrap = new Hono<{ Bindings: Env }>();

/** Keys bundled into one mail-scoped bootstrap (sidebar + mailbox UI state). */
const UI_KEYS = [
  "enabled-accounts.json",
  "available-addresses.json",
  "ui-preferences.json",
  "read.json",
  "trash.json",
] as const;

/**
 * Single round-trip for Email mode shell: catalog, account_state UI blobs,
 * prefs, and inbox count aggregates (no message rows — use GET /mail/inbox).
 */
mailBootstrap.get("/", async (c) => {
  const denied = await requireMailSession(c);
  if (denied) return denied;

  const identity = await resolveAccountIdentity(c, "mail");
  if (identity instanceof Response) return identity;

  const appDb = createAppDb(c.env.RELAYBASE_DB);
  if (!appDb) {
    return c.json({ error: "Product database is not configured" }, 503);
  }

  const mailbox = await readMailbox(appDb);
  const mailDb = createMailDb(c.env.RELAYBASE_MAIL);

  const [uiState, emailPrefs, draftsState, domainStats] = await Promise.all([
    Promise.all(
      UI_KEYS.map(async (key) => {
        const record = await readAccountState(
          appDb,
          identity.identityKey,
          "ui",
          key,
        );
        return [key, record?.value ?? null] as const;
      }),
    ).then((entries) => Object.fromEntries(entries)),
    readAccountState(appDb, identity.identityKey, "prefs", "email.json").then(
      (r) => r?.value ?? null,
    ),
    readAccountState(appDb, identity.identityKey, "mail", "drafts.json").then(
      (r) => r?.value ?? null,
    ),
    Promise.all(
      mailbox.domains.map(async (domain) => {
        const key = domain.trim().toLowerCase();
        if (!key || !mailDb) {
          return {
            domain: key,
            total: 0,
            unread: 0,
            byAddress: {} as Record<string, { total: number; unread: number }>,
          };
        }
        const [totals, byAddress] = await Promise.all([
          mailboxCounts(mailDb, "inbound", key),
          mailboxAddressCounts(mailDb, "inbound", key),
        ]);
        return {
          domain: key,
          total: totals.total,
          unread: totals.unread,
          byAddress,
        };
      }),
    ),
  ]);

  const countsByDomain: Record<string, { total: number; unread: number }> = {};
  const countsByAddress: Record<string, { total: number; unread: number }> =
    {};
  for (const entry of domainStats) {
    if (!entry.domain) continue;
    countsByDomain[entry.domain] = {
      total: entry.total,
      unread: entry.unread,
    };
    for (const [address, value] of Object.entries(entry.byAddress)) {
      const needle = address.trim().toLowerCase();
      const prev = countsByAddress[needle] ?? { total: 0, unread: 0 };
      countsByAddress[needle] = {
        total: prev.total + value.total,
        unread: prev.unread + value.unread,
      };
    }
  }

  const domains = mailbox.domains;
  const emailDomain = domains[0] ?? "";

  return c.json({
    domains,
    addresses: mailbox.addresses,
    ui: uiState,
    prefs: { email: emailPrefs },
    drafts: draftsState,
    counts: {
      byDomain: countsByDomain,
      byAddress: countsByAddress,
    },
    config: {
      emailDomain,
      domain: emailDomain,
      domains,
      activeDomain: emailDomain || null,
      registeredAddresses: mailbox.addresses.map((a) => a.email),
      configured: domains.length > 0,
      relaybaseConfigured: true,
      relaybaseAuthConfigured: true,
      cloudflareConfigured: true,
      credentialSource: "integration",
      usesIntegrationCredentials: true,
      audienceContacts: [],
      broadcasts: [],
      relaybaseWorkerUrl: "",
    },
  });
});

export { mailBootstrap };
