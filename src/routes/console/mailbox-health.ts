import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createAppDb } from "../../../db/app";
import { createMailDb } from "../../../db/mail";
import { readMailbox } from "../../lib/catalog-store";
import { mailboxFreshness } from "../../../db/mail/messages";

const consoleMailboxHealth = new Hono<{ Bindings: Env }>();

/**
 * GET /console/mailbox-health
 *
 * Cheap D1-backed freshness snapshot for the Domains / Accounts pages:
 *   - per-domain last inbound `occurred_at` + retained count
 *   - per-domain last sent `occurred_at` + retained count
 *   - `staleDays` threshold flag (last inbound older than N days → the
 *     `wedesk.so` silent-receive case)
 *
 * Returns 503 when `RELAYBASE_MAIL` is not bound so the dashboard can show
 * "Mail index not configured" instead of an empty list.
 */
consoleMailboxHealth.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const mailDb = createMailDb(c.env.RELAYBASE_MAIL);
  if (!mailDb) {
    return c.json({ error: "Mail index (RELAYBASE_MAIL) is not configured" }, 503);
  }

  const staleDaysThreshold = Number(c.req.query("staleDays") ?? "1");
  const thresholdMs =
    Number.isFinite(staleDaysThreshold) && staleDaysThreshold > 0
      ? staleDaysThreshold * 24 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;

  const [freshness, mailbox] = await Promise.all([
    mailboxFreshness(mailDb),
    readMailbox(createAppDb(c.env.RELAYBASE_DB)),
  ]);

  const retainedDomains = new Set(
    mailbox.domains.map((d) => d.trim().toLowerCase()),
  );
  const now = Date.now();

  const byDomain: Record<
    string,
    {
      domain: string;
      inbound: { lastAt: string | null; count: number; stale: boolean };
      sent: { lastAt: string | null; count: number };
    }
  > = {};

  for (const domain of retainedDomains) {
    byDomain[domain] = {
      domain,
      inbound: { lastAt: null, count: 0, stale: true },
      sent: { lastAt: null, count: 0 },
    };
  }

  for (const row of freshness) {
    const domain = row.domain.trim().toLowerCase();
    if (!byDomain[domain]) {
      byDomain[domain] = {
        domain,
        inbound: { lastAt: null, count: 0, stale: true },
        sent: { lastAt: null, count: 0 },
      };
    }
    const bucket = byDomain[domain];
    if (row.kind === "inbound") {
      bucket.inbound = {
        lastAt: row.last_at,
        count: row.count,
        stale: row.last_at
          ? now - new Date(row.last_at).getTime() > thresholdMs
          : true,
      };
    } else if (row.kind === "sent") {
      bucket.sent = { lastAt: row.last_at, count: row.count };
    }
  }

  return c.json({
    staleDaysThreshold,
    domains: Object.values(byDomain).sort((a, b) => a.domain.localeCompare(b.domain)),
  d1Configured: true,
  r2Configured: Boolean(c.env.INBOUND),
  generatedAt: new Date().toISOString(),
  totalDomains: Object.keys(byDomain).length,
  staleDomains: Object.values(byDomain).filter((d) => d.inbound.stale).length,
  totalInbound: Object.values(byDomain).reduce(
    (sum, d) => sum + d.inbound.count,
    0,
  ),
    totalSent: Object.values(byDomain).reduce((sum, d) => sum + d.sent.count, 0),
  });
});

export { consoleMailboxHealth };
