import { Hono } from "hono";
import type { Env } from "../../env";
import { requireMailSession } from "../../lib/auth/auth";
import { resolveAccountIdentity } from "../../lib/catalog/account-identity";
import { readMailbox } from "../../lib/catalog/catalog-store";
import { readMailBootstrapAccountState } from "../../../db/app/account-state";
import { createAppDb } from "../../../db/app";
import { createMailDb } from "../../../db/mail";
import { mailboxInboundBootstrapCounts } from "../../../db/mail/messages";

const mailBootstrap = new Hono<{ Bindings: Env }>();

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

  const [accountState, counts] = await Promise.all([
    readMailBootstrapAccountState(appDb, identity.identityKey),
    mailboxInboundBootstrapCounts(mailDb, mailbox.domains),
  ]);

  const domains = mailbox.domains;
  const emailDomain = domains[0] ?? "";

  return c.json({
    domains,
    addresses: mailbox.addresses,
    ui: accountState.ui,
    prefs: { email: accountState.emailPrefs },
    drafts: accountState.drafts,
    counts: {
      byDomain: counts.byDomain,
      byAddress: counts.byAddress,
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
