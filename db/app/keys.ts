import { count, desc, eq } from "drizzle-orm";
import type { AppDb } from "./index";
import { apiKeys, type ApiKeyRow } from "./schema";
import type { KeyRecord } from "../../src/lib/keys";

function rowToRecord(row: ApiKeyRow): KeyRecord {
  return {
    id: row.id,
    domain: row.domain,
    label: row.label,
    keyPrefix: row.keyPrefix,
    createdAt: row.createdAt,
    active: row.active === 1,
  };
}

export async function createKeyRow(
  db: AppDb,
  input: { id: string; keyHash: string; domain: string; label: string | null; keyPrefix: string },
): Promise<void> {
  if (!db) return;
  await db
    .insert(apiKeys)
    .values({
      id: input.id,
      keyHash: input.keyHash,
      domain: input.domain,
      label: input.label,
      keyPrefix: input.keyPrefix,
      createdAt: new Date().toISOString(),
      active: 1,
    })
    .run();
}

export async function resolveKeyByHash(
  db: AppDb,
  keyHash: string,
): Promise<KeyRecord | null> {
  if (!db) return null;
  const row = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).get();
  if (!row || row.active !== 1) return null;
  return rowToRecord(row);
}

export async function listKeys(db: AppDb): Promise<KeyRecord[]> {
  if (!db) return [];
  const rows = await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt)).all();
  return rows.map(rowToRecord);
}

export async function deleteKeyRow(db: AppDb, id: string): Promise<boolean> {
  if (!db) return false;
  const result = await db.delete(apiKeys).where(eq(apiKeys.id, id)).run();
  return result.meta.changes > 0;
}

export async function setKeyActive(
  db: AppDb,
  id: string,
  active: boolean,
): Promise<KeyRecord | null> {
  if (!db) return null;
  await db.update(apiKeys).set({ active: active ? 1 : 0 }).where(eq(apiKeys.id, id)).run();
  const row = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).get();
  return row ? rowToRecord(row) : null;
}

export async function updateKeyHash(
  db: AppDb,
  id: string,
  keyHash: string,
  keyPrefix: string,
): Promise<void> {
  if (!db) return;
  await db
    .update(apiKeys)
    .set({ keyHash, keyPrefix, active: 1 })
    .where(eq(apiKeys.id, id))
    .run();
}
