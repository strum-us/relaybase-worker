import { eq } from "drizzle-orm";
import type { AppDb } from "./index.ts";
import { mobilePasswords } from "./schema.ts";
import type { MobileConfig } from "../../src/lib/mobile-config.ts";

export async function getAccountMobileConfig(
  db: AppDb,
  email: string,
): Promise<MobileConfig | null> {
  if (!db) return null;
  const row = await db
    .select()
    .from(mobilePasswords)
    .where(eq(mobilePasswords.email, email.trim().toLowerCase()))
    .get();
  if (!row) return null;
  return {
    passwordHash: row.passwordHash,
    salt: row.salt,
    updatedAt: row.updatedAt,
  };
}

export async function setAccountMobileConfig(
  db: AppDb,
  email: string,
  config: MobileConfig,
): Promise<void> {
  if (!db) return;
  await db
    .insert(mobilePasswords)
    .values({
      email: email.trim().toLowerCase(),
      passwordHash: config.passwordHash,
      salt: config.salt,
      updatedAt: config.updatedAt,
    })
    .onConflictDoUpdate({
      target: mobilePasswords.email,
      set: {
        passwordHash: config.passwordHash,
        salt: config.salt,
        updatedAt: config.updatedAt,
      },
    })
    .run();
}

export async function clearAccountMobileConfig(
  db: AppDb,
  email: string,
): Promise<void> {
  if (!db) return;
  await db
    .delete(mobilePasswords)
    .where(eq(mobilePasswords.email, email.trim().toLowerCase()))
    .run();
}
