/**
 * Broadcast drafts + send progress (D1 `relaybase-db`).
 * Table: broadcasts
 *
 *   Send history for each message is recorded in R2 sent/_sendlog/* via recordSendLog
 * and also in D1 RELAYBASE_LOGS via recordOpsLog.
 */

import type { Env } from "../env";
import type { AppDb } from "../../db/app";
import { createAppDb } from "../../db/app";
import {
  createBroadcastRow as dbCreateBroadcastRow,
  deleteBroadcastRow as dbDeleteBroadcastRow,
  finishBroadcastSend as dbFinishBroadcastSend,
  getBroadcast as dbGetBroadcast,
  listBroadcasts as dbListBroadcasts,
  updateBroadcastDraft as dbUpdateBroadcastDraft,
  updateBroadcastSendProgress as dbUpdateBroadcastSendProgress,
  updateBroadcastGroupIds as dbUpdateBroadcastGroupIds,
} from "../../db/app/broadcasts";
import {
  listContactsForGroupsFromDb,
  readAudienceCatalog,
  type AudienceCatalog,
} from "./catalog-audience";
import type {
  AudienceGroup,
  AudienceGroupSummary,
  Broadcast,
  BroadcastSendRun,
} from "./catalog-types";
import { sendOutboundEmail } from "./email-send";
import { isCloudflarePlanError } from "./cloudflare-api-hints";
import { readMailbox } from "./catalog-store";
import { recordOpsLog } from "./ops-logs";
import { recordSendLog } from "./send-logs";

function plainTextToEmailHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const withBreaks = escaped.replace(/\n/g, "<br>\n");
  return `<div style="font-family:sans-serif;white-space:pre-wrap">${withBreaks}</div>`;
}

export async function readBroadcasts(db: AppDb): Promise<Broadcast[]> {
  return dbListBroadcasts(db);
}

export async function writeBroadcasts(
  _db: AppDb,
  _broadcasts: Broadcast[],
): Promise<void> {
  // No-op: broadcasts are now managed per-row. Kept for API compatibility.
}

function normalizeFromAddress(from: string | null | undefined): string | null {
  const trimmed = from?.trim().toLowerCase();
  return trimmed && trimmed.includes("@") ? trimmed : null;
}

function resolveBroadcastGroups(
  catalog: AudienceCatalog,
  groupIds: string[],
): AudienceGroup[] {
  const wanted = new Set(groupIds);
  return catalog.groups.filter((g) => wanted.has(g.id));
}

function summarizeGroup(
  catalog: AudienceCatalog,
  group: AudienceGroup,
): AudienceGroupSummary {
  return {
    ...group,
    contactCount: catalog.contacts.filter((c) => c.groupId === group.id).length,
  };
}

function resolveDefaultFrom(
  mailboxAddresses: Array<{ email: string }>,
  groups: AudienceGroup[],
): string | null {
  for (const group of groups) {
    if (group.defaultFrom) {
      const match = mailboxAddresses.find(
        (a) => a.email.toLowerCase() === group.defaultFrom!.toLowerCase(),
      );
      if (match) return match.email.toLowerCase();
    }
  }
  const domain = groups[0]?.domain;
  if (!domain) return null;
  const onDomain = mailboxAddresses.find((a) =>
    a.email.toLowerCase().endsWith(`@${domain}`),
  );
  return onDomain?.email.toLowerCase() ?? null;
}

export type BroadcastDetail = {
  broadcast: Broadcast;
  groups: AudienceGroupSummary[];
  recipientCount: number;
};

export async function getBroadcastDetail(
  db: AppDb,
  broadcastId: string,
): Promise<BroadcastDetail | null> {
  const [broadcast, catalog] = await Promise.all([
    dbGetBroadcast(db, broadcastId),
    readAudienceCatalog(db),
  ]);
  if (!broadcast) return null;
  const groups = resolveBroadcastGroups(catalog, broadcast.groupIds).map((g) =>
    summarizeGroup(catalog, g),
  );
  const recipientCount = (await listContactsForGroupsFromDb(db, broadcast.groupIds)).length;
  return { broadcast, groups, recipientCount };
}

export async function createBroadcastDraft(
  db: AppDb,
  input: {
    id?: string;
    groupIds: string[];
    from?: string;
    subject?: string;
    body?: string;
  },
): Promise<Broadcast> {
  const groupIds = Array.from(new Set(input.groupIds.filter(Boolean)));
  if (groupIds.length === 0) {
    throw new Error("Select at least one audience group");
  }

  const [catalog, mailbox] = await Promise.all([
    readAudienceCatalog(db),
    readMailbox(db),
  ]);
  const groups = resolveBroadcastGroups(catalog, groupIds);
  if (groups.length === 0) {
    throw new Error("Audience group(s) not found");
  }

  const from =
    normalizeFromAddress(input.from) ||
    resolveDefaultFrom(mailbox.addresses, groups);
  const domain = from?.split("@")[1]?.toLowerCase() || groups[0]!.domain;
  const subject = input.subject?.trim() || "";
  const body = input.body != null ? input.body : "";
  const recipientCount = (await listContactsForGroupsFromDb(db, groupIds)).length;
  const clientId = input.id?.trim();

  if (clientId) {
    const existing = await dbGetBroadcast(db, clientId);
    if (existing) {
      if (existing.status === "sending" || existing.status === "sent") {
        throw new Error("Broadcast was already sent");
      }
      await dbUpdateBroadcastDraft(db, clientId, {
        subject,
        body,
        groupIds,
        from: from ?? null,
      });
      // Re-read to get the updated row
      const updated = await dbGetBroadcast(db, clientId);
      return updated!;
    }
  }

  const id = clientId || crypto.randomUUID();
  await dbCreateBroadcastRow(db, { id, subject, domain, groupIds });
  if (from || body) {
    await dbUpdateBroadcastDraft(db, id, {
      ...(from ? { from } : {}),
      ...(body ? { body } : {}),
    });
  }
  const broadcast = await dbGetBroadcast(db, id);
  return broadcast!;
}

export async function updateBroadcastDraft(
  db: AppDb,
  broadcastId: string,
  patch: {
    groupIds?: string[];
    from?: string | null;
    subject?: string;
    body?: string;
  },
): Promise<Broadcast> {
  const [current, catalog] = await Promise.all([
    dbGetBroadcast(db, broadcastId),
    readAudienceCatalog(db),
  ]);
  if (!current) throw new Error("Broadcast not found");
  if (current.status === "sending") {
    throw new Error("Broadcast is sending and cannot be edited");
  }
  if (current.status === "sent") {
    throw new Error("Only draft broadcasts can be edited");
  }
  if (current.status !== "draft" && current.status !== "failed") {
    throw new Error("Only draft broadcasts can be edited");
  }

  let groupIds = current.groupIds;
  if (patch.groupIds !== undefined) {
    groupIds = Array.from(new Set(patch.groupIds.filter(Boolean)));
    if (groupIds.length === 0) {
      throw new Error("Select at least one audience group");
    }
    if (resolveBroadcastGroups(catalog, groupIds).length === 0) {
      throw new Error("Audience group(s) not found");
    }
  }

  const from =
    patch.from === undefined
      ? current.from
      : normalizeFromAddress(patch.from) ?? undefined;
  const subject = patch.subject !== undefined ? patch.subject : current.subject;
  const body = patch.body !== undefined ? patch.body : current.body;
  const domain =
    from?.split("@")[1]?.toLowerCase() ||
    resolveBroadcastGroups(catalog, groupIds)[0]?.domain ||
    current.domain;
  const recipientCount = (await listContactsForGroupsFromDb(db, groupIds)).length;

  await dbUpdateBroadcastDraft(db, broadcastId, {
    subject,
    body,
    groupIds,
    from: from ?? null,
  });

  const updated = await dbGetBroadcast(db, broadcastId);
  return {
    ...updated!,
    domain,
    recipientCount,
  };
}

export async function sendBroadcast(
  env: Env,
  broadcastId: string,
  options: { from?: string } = {},
): Promise<Broadcast> {
  const db = createAppDbFromEnv(env);
  const [current, catalog, mailbox] = await Promise.all([
    dbGetBroadcast(db, broadcastId),
    readAudienceCatalog(db),
    readMailbox(db),
  ]);
  if (!current) throw new Error("Broadcast not found");
  if (current.status === "sending") {
    throw new Error("Broadcast is already sending");
  }
  if (current.status === "sent") {
    throw new Error("Broadcast was already sent");
  }
  if (current.status !== "draft" && current.status !== "failed") {
    throw new Error("Only draft broadcasts can be sent");
  }
  if (!current.subject?.trim()) {
    throw new Error("Add a subject before broadcasting");
  }
  if (current.groupIds.length === 0) {
    throw new Error("Select at least one audience group");
  }

  const groups = resolveBroadcastGroups(catalog, current.groupIds);
  const from =
    normalizeFromAddress(options.from) ||
    normalizeFromAddress(current.from) ||
    resolveDefaultFrom(mailbox.addresses, groups);
  if (!from) {
    throw new Error("Choose a From address before broadcasting");
  }

  const knownAddress = mailbox.addresses.find(
    (a) => a.email.toLowerCase() === from,
  );
  if (!knownAddress) {
    throw new Error("From address is not a registered sender");
  }

  const domain =
    from.split("@")[1]?.toLowerCase() ||
    current.domain ||
    groups[0]?.domain ||
    "";
  const fromName = knownAddress.displayName?.trim() || undefined;
  const subject = current.subject.trim();
  const text = current.body?.trim() ?? "";
  const html = plainTextToEmailHtml(text);
  const recipients = await listContactsForGroupsFromDb(db, current.groupIds);
  const startedAt = new Date().toISOString();
  const run: BroadcastSendRun = {
    id: crypto.randomUUID(),
    status: "running",
    phase: "preparing",
    startedAt,
    totalCount: recipients.length,
    processedCount: 0,
    successCount: 0,
    failedCount: 0,
  };

  await dbUpdateBroadcastDraft(db, broadcastId, {
    from,
    subject,
    body: text,
  });
  await dbUpdateBroadcastSendProgress(db, broadcastId, run);

  try {
    if (recipients.length === 0) {
      throw new Error("No recipients in the selected audience groups");
    }

    run.phase = "sending";
    await dbUpdateBroadcastSendProgress(db, broadcastId, run);

    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i]!;
      try {
        const result = await sendOutboundEmail(env, {
          from,
          fromName,
          to: recipient.email,
          subject,
          text,
          html,
        });
        await recordSendLog(env.INBOUND, {
          ok: true,
          status: 200,
          domain,
          keyId: null,
          keyPrefix: null,
          keyLabel: "broadcast",
          from,
          to: recipient.email,
          subject,
          messageId: result.messageId,
        });
        await recordOpsLog(env.RELAYBASE_LOGS, {
          kind: "send",
          ok: true,
          status: 200,
          source: "broadcast",
          domain,
          fromAddr: from,
          toAddr: recipient.email,
          subject,
          messageId: result.messageId,
        });
        successCount++;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to send";
        await recordSendLog(env.INBOUND, {
          ok: false,
          status: 502,
          domain,
          keyId: null,
          keyPrefix: null,
          keyLabel: "broadcast",
          from,
          to: recipient.email,
          subject,
          error: message,
        });
        await recordOpsLog(env.RELAYBASE_LOGS, {
          kind: "send",
          ok: false,
          status: 502,
          source: "broadcast",
          domain,
          fromAddr: from,
          toAddr: recipient.email,
          subject,
          error: message,
        });
        if (isCloudflarePlanError(message)) {
          const finishedAt = new Date().toISOString();
          run.phase = "done";
          run.status = "error";
          run.finishedAt = finishedAt;
          run.error = message;
          run.estimatedRemainingMs = 0;
          run.processedCount = i + 1;
          run.failedCount = failedCount + 1;
          await dbFinishBroadcastSend(db, broadcastId, {
            status: "failed",
            run: { ...run },
            recipientCount: recipients.length,
            from,
          });
          throw error instanceof Error ? error : new Error(message);
        }
        failedCount++;
      }
      run.processedCount = i + 1;
      run.successCount = successCount;
      run.failedCount = failedCount;
      if ((i + 1) % 5 === 0 || i === recipients.length - 1) {
        await dbUpdateBroadcastSendProgress(db, broadcastId, run);
      }
    }

    const finishedAt = new Date().toISOString();
    run.phase = "done";
    run.finishedAt = finishedAt;
    run.estimatedRemainingMs = 0;
    let finalStatus: string;
    if (successCount === 0) {
      run.status = "error";
      run.error = "All recipients failed";
      finalStatus = "failed";
    } else {
      run.status = "success";
      finalStatus = "sent";
      if (failedCount > 0) {
        run.error = `${failedCount} of ${recipients.length} failed`;
      }
    }
    await dbFinishBroadcastSend(db, broadcastId, {
      status: finalStatus,
      run: { ...run },
      recipientCount: recipients.length,
      from,
    });
    return (await dbGetBroadcast(db, broadcastId))!;
  } catch (e) {
    const message = e instanceof Error ? e.message : "Broadcast failed";
    const finishedAt = new Date().toISOString();
    run.phase = "done";
    run.status = "error";
    run.finishedAt = finishedAt;
    run.error = message;
    run.estimatedRemainingMs = 0;
    await dbFinishBroadcastSend(db, broadcastId, {
      status: "failed",
      run: { ...run },
      recipientCount: recipients.length,
      from,
    });
    throw e;
  }
}

export function getBroadcastProgress(broadcast: Broadcast) {
  return {
    broadcastId: broadcast.id,
    status: broadcast.status,
    progress: broadcast.sendProgress ?? null,
    history: broadcast.sendHistory ?? [],
  };
}

export async function deleteBroadcast(db: AppDb, id: string): Promise<boolean> {
  return dbDeleteBroadcastRow(db, id);
}

export { updateBroadcastGroupIds } from "../../db/app/broadcasts";

function createAppDbFromEnv(env: Env): AppDb {
  return createAppDb(env.RELAYBASE_DB);
}
