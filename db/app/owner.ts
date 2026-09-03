import { eq } from "drizzle-orm";
import type { AppDb } from "./index";
import { ownerConfig } from "./schema";

export type OwnerLoginConfig = {
  ownerEmail: string | null;
  workerUrl: string | null;
  passtokenSalt: string | null;
  passtokenHash: string | null;
  passtokenPrefix: string | null;
  passtokenUpdatedAt: string | null;
  cfAccountId: string | null;
};

export async function getOwnerLoginConfig(
  db: AppDb,
): Promise<OwnerLoginConfig | null> {
  if (!db) return null;
  try {
    const row = await db.select().from(ownerConfig).where(eq(ownerConfig.id, 1)).get();
    if (!row) return null;
    return {
      ownerEmail: row.ownerEmail ?? null,
      workerUrl: row.workerUrl ?? null,
      passtokenSalt: row.passtokenSalt ?? null,
      passtokenHash: row.passtokenHash ?? null,
      passtokenPrefix: row.passtokenPrefix ?? null,
      passtokenUpdatedAt: row.passtokenUpdatedAt ?? null,
      cfAccountId: row.cfAccountId ?? null,
    };
  } catch {
    // owner_config missing or unreadable (empty D1). Treat as unconfigured so
    // init-db / migrate-db can still run with AUTH_PEPPER bootstrap.
    return null;
  }
}

/** True when an owner passtoken has been issued (login is possible). */
export async function ownerIsConfigured(db: AppDb): Promise<boolean> {
  const cfg = await getOwnerLoginConfig(db);
  return Boolean(cfg?.passtokenHash);
}

export async function setOwnerLogin(
  db: AppDb,
  input: {
    passtokenSalt: string;
    passtokenHash: string;
    passtokenPrefix: string;
  },
): Promise<void> {
  if (!db) return;
  const now = new Date().toISOString();
  await db
    .insert(ownerConfig)
    .values({
      id: 1,
      passtokenSalt: input.passtokenSalt,
      passtokenHash: input.passtokenHash,
      passtokenPrefix: input.passtokenPrefix,
      passtokenUpdatedAt: now,
    })
    .onConflictDoUpdate({
      target: ownerConfig.id,
      set: {
        passtokenSalt: input.passtokenSalt,
        passtokenHash: input.passtokenHash,
        passtokenPrefix: input.passtokenPrefix,
        passtokenUpdatedAt: now,
      },
    })
    .run();
}

export async function setOwnerConfig(
  db: AppDb,
  input: { ownerEmail: string; workerUrl: string },
): Promise<void> {
  if (!db) return;
  await db
    .insert(ownerConfig)
    .values({
      id: 1,
      ownerEmail: input.ownerEmail,
      workerUrl: input.workerUrl,
    })
    .onConflictDoUpdate({
      target: ownerConfig.id,
      set: {
        ownerEmail: input.ownerEmail,
        workerUrl: input.workerUrl,
      },
    })
    .run();
}

export async function setOwnerCfAccountId(
  db: AppDb,
  cfAccountId: string,
): Promise<void> {
  if (!db) return;
  const id = cfAccountId.trim();
  if (!id) return;
  await db
    .insert(ownerConfig)
    .values({ id: 1, cfAccountId: id })
    .onConflictDoUpdate({
      target: ownerConfig.id,
      set: { cfAccountId: id },
    })
    .run();
}
