import { and, eq, lt } from "drizzle-orm";
import type { AppDb } from "./index";
import { webhookFails, webhookSecrets, webhooks } from "./schema";
import type { StoredWebhook, WebhookRecord } from "../../src/lib/webhooks";

function rowToWebhookRecord(row: typeof webhooks.$inferSelect): WebhookRecord {
  const { secretHash: _secretHash, ...record } = row;
  return {
    id: record.id,
    domain: record.domain,
    url: record.url,
    createdAt: record.createdAt,
    active: record.active === 1,
  };
}

function rowToStoredWebhook(row: typeof webhooks.$inferSelect): StoredWebhook {
  return {
    id: row.id,
    domain: row.domain,
    url: row.url,
    secretHash: row.secretHash,
    createdAt: row.createdAt,
    active: row.active === 1,
  };
}

export async function listWebhooks(
  db: AppDb,
  domain: string,
): Promise<WebhookRecord[]> {
  if (!db) return [];
  const rows = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.domain, domain.trim().toLowerCase()), eq(webhooks.active, 1)))
    .all();
  return rows.map(rowToWebhookRecord);
}

export async function listStoredWebhooks(
  db: AppDb,
  domain: string,
): Promise<StoredWebhook[]> {
  if (!db) return [];
  const rows = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.domain, domain.trim().toLowerCase()))
    .all();
  return rows.map(rowToStoredWebhook);
}

export async function createWebhookRow(
  db: AppDb,
  input: { id: string; domain: string; url: string; secretHash: string },
): Promise<void> {
  if (!db) return;
  await db
    .insert(webhooks)
    .values({
      id: input.id,
      domain: input.domain.trim().toLowerCase(),
      url: input.url,
      secretHash: input.secretHash,
      createdAt: new Date().toISOString(),
      active: 1,
    })
    .run();
}

export async function deleteWebhookRow(
  db: AppDb,
  id: string,
): Promise<boolean> {
  if (!db) return false;
  const result = await db.delete(webhooks).where(eq(webhooks.id, id)).run();
  return result.meta.changes > 0;
}

export async function storeWebhookSecret(
  db: AppDb,
  webhookId: string,
  secret: string,
): Promise<void> {
  if (!db) return;
  await db
    .insert(webhookSecrets)
    .values({ webhookId, secret })
    .onConflictDoUpdate({
      target: webhookSecrets.webhookId,
      set: { secret },
    })
    .run();
}

export async function getWebhookSecret(
  db: AppDb,
  webhookId: string,
): Promise<string | null> {
  if (!db) return null;
  const row = await db
    .select()
    .from(webhookSecrets)
    .where(eq(webhookSecrets.webhookId, webhookId))
    .get();
  return row?.secret ?? null;
}

export async function removeWebhookSecret(
  db: AppDb,
  webhookId: string,
): Promise<void> {
  if (!db) return;
  await db.delete(webhookSecrets).where(eq(webhookSecrets.webhookId, webhookId)).run();
}

export async function recordWebhookFail(
  db: AppDb,
  input: { id: string; webhookId: string; eventId: string; url: string; failedAt: string; expiresAt: string },
): Promise<void> {
  if (!db) return;
  await db
    .insert(webhookFails)
    .values({
      id: input.id,
      webhookId: input.webhookId,
      eventId: input.eventId,
      url: input.url,
      failedAt: input.failedAt,
      expiresAt: input.expiresAt,
    })
    .run();
}

export async function deleteExpiredWebhookFails(db: AppDb, now: string): Promise<void> {
  if (!db) return;
  await db.delete(webhookFails).where(lt(webhookFails.expiresAt, now)).run();
}
