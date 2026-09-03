/**
 * Periodic mailbox index integrity check.
 *
 * `mailbox_messages` (D1) is derived from R2 thin `meta.json`. The ingest
 * path keeps it in sync, but D1 writes are best-effort: a transient D1
 * failure can leave D1 drifting from R2. This cron reconciles by listing
 * R2 `{kind}/{domain}/` folders, diffing the id set against D1, and
 * upserting only the missing thin metas — never GET `raw.eml` on this path.
 *
 * R2 stays the source of truth; a rebuild never deletes `meta.json`.
 */
import type { Env } from "../env";
import { createAppDb } from "../../db/app";
import { getAppSettings } from "../../db/app/settings";
import { createMailDb } from "../../db/mail";
import { readMailbox } from "./catalog-store";
import {
  listMessageFolderIds,
  loadThinMeta,
  pruneMail,
} from "./mailbox-store";
import {
  mailboxAddressCounts,
  mailboxCounts,
} from "../../db/mail/messages";
import { upsertMailboxMessage } from "../../db/mail/messages";

export async function runInboundIndexCron(env: Env): Promise<void> {
  if (!env.INBOUND) return;
  const mailDb = createMailDb(env.RELAYBASE_MAIL);
  if (!mailDb) return;

  const appDb = createAppDb(env.RELAYBASE_DB);
  const mailbox = await readMailbox(appDb);
  for (const domainEntry of mailbox.domains) {
    const domain = domainEntry.trim().toLowerCase();
    if (!domain) continue;
    for (const kind of ["inbound", "sent"] as const) {
      try {
        await reconcileDomain(env, mailDb, kind, domain);
      } catch (error) {
        console.error(
          `Mailbox index verify failed for ${kind}/${domain}`,
          error,
        );
      }
    }
  }

  const retain = (await getAppSettings(appDb)).inboundRetainPerDomain;
  if (retain == null) return;

  for (const domainEntry of mailbox.domains) {
    const domain = domainEntry.trim().toLowerCase();
    if (!domain) continue;
    try {
      await pruneMail(env.INBOUND, mailDb, "inbound", domain, retain);
    } catch (error) {
      console.error(`Mailbox inbound prune failed for ${domain}`, error);
    }
  }
}

async function reconcileDomain(
  env: Env,
  mailDb: ReturnType<typeof createMailDb>,
  kind: "inbound" | "sent",
  domain: string,
): Promise<void> {
  if (!mailDb) return;
  const folderIds = await listMessageFolderIds(env.INBOUND, kind, domain);
  if (folderIds.length === 0) return;

  // Diff against D1 ids for this (kind, domain).
  const d1Ids = await listD1IdsForDomain(mailDb, kind, domain);
  const d1Set = new Set(d1Ids);
  const missing = folderIds.filter((id) => !d1Set.has(id));
  const stale = d1Ids.filter((id) => !folderIds.includes(id));

  for (const id of missing) {
    const thin = await loadThinMeta(env.INBOUND, kind, domain, id);
    if (!thin) continue;
    try {
      await upsertMailboxMessage(mailDb, {
        id: thin.id,
        kind: thin.kind,
        domain: thin.domain,
        from_email: thin.fromEmail,
        from_name: thin.fromName ?? null,
        to_email: thin.toEmail,
        to_emails: (thin.toEmails ?? []).join(","),
        cc_emails: (thin.ccEmails ?? []).join(","),
        recipients: recipientsColumn(thin),
        subject: thin.subject,
        body_preview: thin.bodyPreview,
        occurred_at: thin.occurredAt,
        message_id: thin.messageId,
        in_reply_to: thin.inReplyTo,
        refs: thin.references,
        size: thin.size,
        attachment_count: thin.attachments?.length ?? 0,
        read_at: thin.readAt ?? null,
        r2_prefix: `${kind}/${domain}/${id}`,
      });
    } catch (error) {
      console.error(`Mailbox cron upsert failed ${kind}/${domain}/${id}`, error);
    }
  }

  if (stale.length > 0) {
    try {
      const { deleteMailboxMessages } = await import("../../db/mail/messages");
      await deleteMailboxMessages(mailDb, stale);
    } catch (error) {
      console.error(`Mailbox cron prune failed ${kind}/${domain}`, error);
    }
  }
}

function recipientsColumn(thin: {
  toEmail: string;
  toEmails?: string[];
  ccEmails?: string[];
}): string {
  const addresses = new Set<string>();
  const add = (value: string | null | undefined) => {
    const trimmed = value?.trim().toLowerCase();
    if (trimmed) addresses.add(trimmed);
  };
  add(thin.toEmail);
  for (const to of thin.toEmails ?? []) add(to);
  for (const cc of thin.ccEmails ?? []) add(cc);
  return [...addresses].join(",");
}

async function listD1IdsForDomain(
  mailDb: NonNullable<ReturnType<typeof createMailDb>>,
  kind: "inbound" | "sent",
  domain: string,
): Promise<string[]> {
  const raw: D1Database = mailDb.$client;
  const result = await raw
    .prepare(
      `SELECT id FROM mailbox_messages WHERE kind = ? AND domain = ?`,
    )
    .bind(kind, domain)
    .all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}

export { mailboxAddressCounts, mailboxCounts };
