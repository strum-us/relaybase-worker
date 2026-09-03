import { and, asc, eq, lt, sql } from "drizzle-orm";
import type { AppDb } from "./index";
import { inboundEvents } from "./schema";
import type { InboundEmailEvent } from "../../src/lib/inbound-events";

const TTL_SECONDS = 7 * 24 * 60 * 60;

export async function enqueueInboundEventRow(
  db: AppDb,
  event: InboundEmailEvent,
): Promise<void> {
  if (!db) return;
  const createdAt = event.createdAt;
  const expiresAt = new Date(
    new Date(createdAt).getTime() + TTL_SECONDS * 1000,
  ).toISOString();
  await db
    .insert(inboundEvents)
    .values({
      id: event.id,
      domain: event.data.domain,
      eventType: event.type,
      createdAt,
      payloadJson: JSON.stringify(event.data),
      expiresAt,
    })
    .run();
}

export async function listPendingEventRows(
  db: AppDb,
  domain: string,
  limit = 25,
): Promise<InboundEmailEvent[]> {
  if (!db) return [];
  const now = new Date().toISOString();
  // Lazy-delete expired rows for this domain, then fetch active ones.
  await db
    .delete(inboundEvents)
    .where(and(eq(inboundEvents.domain, domain.trim().toLowerCase()), lt(inboundEvents.expiresAt, now)))
    .run();
  const rows = await db
    .select()
    .from(inboundEvents)
    .where(eq(inboundEvents.domain, domain.trim().toLowerCase()))
    .orderBy(asc(inboundEvents.createdAt))
    .limit(Math.min(Math.max(limit, 1), 100))
    .all();
  return rows.map((row) => ({
    id: row.id,
    type: row.eventType as "inbound.email.received",
    createdAt: row.createdAt,
    data: JSON.parse(row.payloadJson) as InboundEmailEvent["data"],
  }));
}

export async function ackPendingEventRows(
  db: AppDb,
  domain: string,
  ids: string[],
): Promise<number> {
  if (!db || ids.length === 0) return 0;
  let deleted = 0;
  for (const id of ids) {
    const result = await db
      .delete(inboundEvents)
      .where(and(eq(inboundEvents.id, id), eq(inboundEvents.domain, domain.trim().toLowerCase())))
      .run();
    deleted += result.meta.changes;
  }
  return deleted;
}

export async function deleteExpiredEvents(db: AppDb, now: string): Promise<void> {
  if (!db) return;
  await db.delete(inboundEvents).where(lt(inboundEvents.expiresAt, now)).run();
}
