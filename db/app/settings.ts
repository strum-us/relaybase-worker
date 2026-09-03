import { eq } from "drizzle-orm";
import type { AppDb } from "./index";
import { appSettings } from "./schema";

/** Floor for a numeric inbound retain cap — avoids accidental wipe to 1. */
export const MIN_INBOUND_RETAIN_PER_DOMAIN = 100;

export type AppSettings = {
  inboundRetainPerDomain: number | null;
};

function normalizeRetain(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < MIN_INBOUND_RETAIN_PER_DOMAIN) return null;
  return value;
}

export async function getAppSettings(db: AppDb): Promise<AppSettings> {
  if (!db) return { inboundRetainPerDomain: null };
  try {
    const row = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.id, 1))
      .get();
    return {
      inboundRetainPerDomain: normalizeRetain(row?.inboundRetainPerDomain),
    };
  } catch {
    // Pre-migrate-db: table missing. Treat as unlimited.
    return { inboundRetainPerDomain: null };
  }
}

export async function setInboundRetainPerDomain(
  db: AppDb,
  inboundRetainPerDomain: number | null,
): Promise<AppSettings> {
  if (!db) return { inboundRetainPerDomain: null };
  const value = normalizeRetain(inboundRetainPerDomain);
  const updatedAt = new Date().toISOString();
  await db
    .insert(appSettings)
    .values({
      id: 1,
      inboundRetainPerDomain: value,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { inboundRetainPerDomain: value, updatedAt },
    })
    .run();
  return { inboundRetainPerDomain: value };
}
