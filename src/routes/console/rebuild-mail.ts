import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createAppDb } from "../../../db/app";
import { createMailDb } from "../../../db/mail";
import { readMailbox } from "../../lib/catalog-store";
import {
  deleteSendLogIndex,
  rebuildDomain,
} from "../../lib/mailbox-store";

const consoleRebuildMail = new Hono<{ Bindings: Env }>();

/**
 * POST /console/rebuild-mail
 *
 * One-time backfill that converts the legacy mailbox layout into the new
 * folder-per-mail layout and fills `relaybase-mail`:
 *   - thins every inbound fat `meta.json` (drops bodyText/bodyHtml)
 *   - materializes `sent/{domain}/{id}/meta.json` from legacy `_list.json` /
 *     `_sent.json` arrays when no sent folders exist yet (no raw.eml —
 *     preview-only)
 *   - upserts `mailbox_messages` + `mailbox_fts` for every message
 *   - deletes `inbound/{domain}/_list.json`, `sent/{domain}/_list.json`,
 *     `inbound/{domain}/_sent.json`, and `sent/_sendlog/_index.json`
 *
 * Chunked per-domain so one isolate never scans thousands of fat metas at
 * once. Pass `?domain=` to rebuild a single domain; omit to rebuild every
 * retained domain. Returns counts and the deleted keys.
 */
consoleRebuildMail.post("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const mailDb = createMailDb(c.env.RELAYBASE_MAIL);
  if (!mailDb) {
    return c.json({ error: "Mail index (RELAYBASE_MAIL) is not configured" }, 503);
  }
  if (!c.env.INBOUND) {
    return c.json({ error: "Mailbox R2 bucket (INBOUND) is not configured" }, 503);
  }

  const requestedDomain = c.req.query("domain")?.trim().toLowerCase() || null;
  const mailbox = await readMailbox(createAppDb(c.env.RELAYBASE_DB));
  const domains = requestedDomain
    ? mailbox.domains.filter((d) => d.toLowerCase() === requestedDomain)
    : mailbox.domains;

  if (domains.length === 0) {
    return c.json({ error: "No matching domains found" }, 404);
  }

  const results = [];
  let totalInbound = 0;
  let totalSent = 0;
  const allDeletedKeys: string[] = [];

  for (const domain of domains) {
    const normalized = domain.trim().toLowerCase();
    if (!normalized) continue;
    const result = await rebuildDomain(c.env.INBOUND, mailDb, normalized);
    results.push(result);
    totalInbound += result.inbound;
    totalSent += result.sent;
    allDeletedKeys.push(...result.deletedKeys);
  }

  const sendLogIndexDeleted = await deleteSendLogIndex(c.env.INBOUND);
  if (sendLogIndexDeleted) {
    allDeletedKeys.push("sent/_sendlog/_index.json");
  }

  return c.json({
    domains: results,
    inbound: totalInbound,
    sent: totalSent,
    deletedKeys: allDeletedKeys,
  });
});

export { consoleRebuildMail };
