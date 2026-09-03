import { eq } from "drizzle-orm";
import type { AppDb } from "./index";
import { ownerSessions } from "./schema";

export type OwnerSessionRow = typeof ownerSessions.$inferSelect;

export async function createOwnerSession(
  db: AppDb,
  input: {
    id: string;
    tokenHash: string;
    family: string;
    label: string | null;
    expiresAt: string;
  },
): Promise<void> {
  if (!db) return;
  await db
    .insert(ownerSessions)
    .values({
      id: input.id,
      tokenHash: input.tokenHash,
      family: input.family,
      label: input.label,
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
    })
    .run();
}

export async function findOwnerSessionByHash(
  db: AppDb,
  tokenHash: string,
): Promise<OwnerSessionRow | null> {
  if (!db) return null;
  const row = await db
    .select()
    .from(ownerSessions)
    .where(eq(ownerSessions.tokenHash, tokenHash))
    .get();
  return row ?? null;
}

export async function deleteOwnerSession(db: AppDb, id: string): Promise<void> {
  if (!db) return;
  await db.delete(ownerSessions).where(eq(ownerSessions.id, id)).run();
}

export async function deleteOwnerSessionByHash(
  db: AppDb,
  tokenHash: string,
): Promise<void> {
  if (!db) return;
  await db.delete(ownerSessions).where(eq(ownerSessions.tokenHash, tokenHash)).run();
}

/** Revoke every session in a family (refresh-reuse / passtoken rotation). */
export async function deleteOwnerSessionsByFamily(
  db: AppDb,
  family: string,
): Promise<void> {
  if (!db) return;
  await db.delete(ownerSessions).where(eq(ownerSessions.family, family)).run();
}

export async function deleteAllOwnerSessions(db: AppDb): Promise<void> {
  if (!db) return;
  await db.delete(ownerSessions).run();
}
