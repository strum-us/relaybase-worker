import { desc, eq, inArray } from "drizzle-orm";
import type { AppDb } from "./index";
import { broadcasts, type BroadcastRow } from "./schema";
import type {
  Broadcast,
  BroadcastSendRun,
} from "../../src/lib/catalog-types";

const BROADCAST_HISTORY_LIMIT = 20;

function rowToBroadcast(row: BroadcastRow): Broadcast {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    createdAt: row.createdAt,
    domain: row.domain,
    groupIds: JSON.parse(row.groupIdsJson) as string[],
    ...(row.fromAddr ? { from: row.fromAddr } : {}),
    ...(row.body ? { body: row.body } : {}),
    ...(row.recipientCount != null ? { recipientCount: row.recipientCount } : {}),
    ...(row.sentAt ? { sentAt: row.sentAt } : {}),
    ...(row.sendProgressJson
      ? { sendProgress: JSON.parse(row.sendProgressJson) as BroadcastSendRun }
      : {}),
    ...(row.sendHistoryJson
      ? { sendHistory: JSON.parse(row.sendHistoryJson) as BroadcastSendRun[] }
      : {}),
  };
}

export async function listBroadcasts(db: AppDb): Promise<Broadcast[]> {
  if (!db) return [];
  const rows = await db.select().from(broadcasts).orderBy(desc(broadcasts.createdAt)).all();
  return rows.map(rowToBroadcast);
}

export async function getBroadcast(
  db: AppDb,
  id: string,
): Promise<Broadcast | null> {
  if (!db) return null;
  const row = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).get();
  return row ? rowToBroadcast(row) : null;
}

export async function createBroadcastRow(
  db: AppDb,
  input: {
    id: string;
    subject: string;
    domain: string;
    groupIds: string[];
  },
): Promise<void> {
  if (!db) return;
  await db
    .insert(broadcasts)
    .values({
      id: input.id,
      subject: input.subject,
      status: "draft",
      createdAt: new Date().toISOString(),
      domain: input.domain,
      groupIdsJson: JSON.stringify(input.groupIds),
    })
    .run();
}

export async function updateBroadcastDraft(
  db: AppDb,
  id: string,
  patch: { subject?: string; body?: string; groupIds?: string[]; from?: string | null },
): Promise<void> {
  if (!db) return;
  const updates: Partial<BroadcastRow> = {};
  if (patch.subject !== undefined) updates.subject = patch.subject;
  if (patch.body !== undefined) updates.body = patch.body;
  if (patch.groupIds !== undefined) updates.groupIdsJson = JSON.stringify(patch.groupIds);
  if (patch.from !== undefined) updates.fromAddr = patch.from ?? null;
  await db.update(broadcasts).set(updates).where(eq(broadcasts.id, id)).run();
}

export async function updateBroadcastSendProgress(
  db: AppDb,
  id: string,
  progress: BroadcastSendRun,
): Promise<void> {
  if (!db) return;
  await db
    .update(broadcasts)
    .set({ sendProgressJson: JSON.stringify(progress) })
    .where(eq(broadcasts.id, id))
    .run();
}

export async function finishBroadcastSend(
  db: AppDb,
  id: string,
  result: {
    status: string;
    run: BroadcastSendRun;
    recipientCount?: number;
    from?: string;
  },
): Promise<void> {
  if (!db) return;
  const current = await getBroadcast(db, id);
  const history = current?.sendHistory ?? [];
  const nextHistory = [result.run, ...history].slice(0, BROADCAST_HISTORY_LIMIT);
  await db
    .update(broadcasts)
    .set({
      status: result.status,
      sendProgressJson: JSON.stringify(result.run),
      sendHistoryJson: JSON.stringify(nextHistory),
      ...(result.recipientCount != null ? { recipientCount: result.recipientCount } : {}),
      ...(result.from ? { fromAddr: result.from } : {}),
      ...(result.status === "sent" || result.status === "failed"
        ? { sentAt: new Date().toISOString() }
        : {}),
    })
    .where(eq(broadcasts.id, id))
    .run();
}

export async function deleteBroadcastRow(db: AppDb, id: string): Promise<boolean> {
  if (!db) return false;
  const result = await db.delete(broadcasts).where(eq(broadcasts.id, id)).run();
  return result.meta.changes > 0;
}

/** Update only the groupIds array (used by audience group delete cascade). */
export async function updateBroadcastGroupIds(
  db: AppDb,
  id: string,
  groupIds: string[],
): Promise<void> {
  if (!db) return;
  await db
    .update(broadcasts)
    .set({ groupIdsJson: JSON.stringify(groupIds) })
    .where(eq(broadcasts.id, id))
    .run();
}
