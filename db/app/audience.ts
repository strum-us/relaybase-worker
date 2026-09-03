import { and, asc, count, desc, eq, inArray, sql } from "drizzle-orm";
import type { AppDb } from "./index";
import {
  audienceContacts,
  audienceGroups,
  type AudienceContactRow,
  type AudienceGroupRow,
} from "./schema";
import type {
  AudienceContact,
  AudienceDataSource,
  AudienceDataSourcePatch,
  AudienceGroup,
  AudienceGroupSummary,
  AudienceSyncRun,
} from "../../src/lib/catalog-types";

const SYNC_HISTORY_LIMIT = 20;

// ─── row → domain type ───────────────────────────────────────────────────

function rowToGroup(row: AudienceGroupRow): AudienceGroup {
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    createdAt: row.createdAt,
    ...(row.defaultFrom ? { defaultFrom: row.defaultFrom } : {}),
    ...(row.dataSourceJson
      ? { dataSource: JSON.parse(row.dataSourceJson) as AudienceDataSource }
      : {}),
    ...(row.cronEnabled
      ? { cronEnabled: true, cronIntervalMinutes: row.cronIntervalMinutes ?? undefined }
      : {}),
    ...(row.lastSyncAt ? { lastSyncAt: row.lastSyncAt } : {}),
    ...(row.lastSyncStatus
      ? { lastSyncStatus: row.lastSyncStatus as "success" | "error" }
      : {}),
    ...(row.lastSyncError ? { lastSyncError: row.lastSyncError } : {}),
    ...(row.lastSyncCount != null ? { lastSyncCount: row.lastSyncCount } : {}),
    ...(row.syncProgressJson
      ? { syncProgress: JSON.parse(row.syncProgressJson) as AudienceSyncRun }
      : {}),
    ...(row.syncHistoryJson
      ? { syncHistory: JSON.parse(row.syncHistoryJson) as AudienceSyncRun[] }
      : {}),
  };
}

function rowToContact(row: AudienceContactRow): AudienceContact {
  return {
    id: row.id,
    email: row.email,
    ...(row.name ? { name: row.name } : {}),
    domain: row.domain,
    groupId: row.groupId,
    source: row.source as "manual" | "synced",
    addedAt: row.addedAt,
  };
}

// ─── read ────────────────────────────────────────────────────────────────

export async function listGroups(db: AppDb): Promise<AudienceGroup[]> {
  if (!db) return [];
  const rows = await db.select().from(audienceGroups).orderBy(desc(audienceGroups.createdAt)).all();
  return rows.map(rowToGroup);
}

export async function getGroup(
  db: AppDb,
  groupId: string,
): Promise<AudienceGroup | null> {
  if (!db) return null;
  const row = await db
    .select()
    .from(audienceGroups)
    .where(eq(audienceGroups.id, groupId))
    .get();
  return row ? rowToGroup(row) : null;
}

export async function listContacts(db: AppDb): Promise<AudienceContact[]> {
  if (!db) return [];
  const rows = await db.select().from(audienceContacts).orderBy(desc(audienceContacts.addedAt)).all();
  return rows.map(rowToContact);
}

export async function listContactsForGroup(
  db: AppDb,
  groupId: string,
): Promise<AudienceContact[]> {
  if (!db) return [];
  const rows = await db
    .select()
    .from(audienceContacts)
    .where(eq(audienceContacts.groupId, groupId))
    .orderBy(desc(audienceContacts.addedAt))
    .all();
  return rows.map(rowToContact);
}

export async function listContactsForGroups(
  db: AppDb,
  groupIds: string[],
): Promise<AudienceContact[]> {
  if (!db || groupIds.length === 0) return [];
  const rows = await db
    .select()
    .from(audienceContacts)
    .where(inArray(audienceContacts.groupId, groupIds))
    .all();
  return rows.map(rowToContact);
}

export async function countContactsForGroup(
  db: AppDb,
  groupId: string,
): Promise<number> {
  if (!db) return 0;
  const row = await db
    .select({ total: count() })
    .from(audienceContacts)
    .where(eq(audienceContacts.groupId, groupId))
    .get();
  return row?.total ?? 0;
}

export async function getGroupSummaries(
  db: AppDb,
): Promise<AudienceGroupSummary[]> {
  if (!db) return [];
  const groups = await listGroups(db);
  const summaries: AudienceGroupSummary[] = [];
  for (const group of groups) {
    const contactCount = await countContactsForGroup(db, group.id);
    summaries.push({ ...group, contactCount });
  }
  return summaries;
}

export async function getGroupDetail(
  db: AppDb,
  groupId: string,
): Promise<{
  group: AudienceGroupSummary;
  contacts: AudienceContact[];
} | null> {
  if (!db) return null;
  const group = await getGroup(db, groupId);
  if (!group) return null;
  const contacts = await listContactsForGroup(db, groupId);
  const contactCount = contacts.length;
  return { group: { ...group, contactCount }, contacts };
}

// ─── write ───────────────────────────────────────────────────────────────

function normalizeDataSource(
  source: AudienceDataSourcePatch,
): AudienceDataSource {
  return {
    type: "generic_json",
    endpointUrl: source.endpointUrl.trim(),
    ...(source.credential?.trim()
      ? { credential: source.credential.trim() }
      : {}),
    ...(source.credentialHeader?.trim()
      ? { credentialHeader: source.credentialHeader.trim() }
      : {}),
  };
}

export function mergeDataSource(
  previous: AudienceDataSource | undefined,
  patch: AudienceDataSourcePatch,
): AudienceDataSource {
  return {
    type: "generic_json",
    endpointUrl: patch.endpointUrl.trim(),
    ...(patch.credential?.trim()
      ? { credential: patch.credential.trim() }
      : previous?.credential
        ? { credential: previous.credential }
        : {}),
    ...(patch.credentialHeader?.trim()
      ? { credentialHeader: patch.credentialHeader.trim() }
      : previous?.credentialHeader
        ? { credentialHeader: previous.credentialHeader }
        : {}),
  };
}

export async function createGroup(
  db: AppDb,
  input: {
    name: string;
    domain: string;
    dataSource?: AudienceDataSourcePatch;
    cronEnabled?: boolean;
    cronIntervalMinutes?: number;
  },
): Promise<AudienceGroup> {
  if (!db) throw new Error("D1 not configured");
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await db
    .insert(audienceGroups)
    .values({
      id,
      name: input.name.trim(),
      domain: input.domain.trim().toLowerCase(),
      createdAt,
      ...(input.dataSource
        ? {
            dataSourceJson: JSON.stringify(normalizeDataSource(input.dataSource)),
          }
        : {}),
      cronEnabled: input.cronEnabled ? 1 : 0,
      ...(input.cronIntervalMinutes
        ? { cronIntervalMinutes: input.cronIntervalMinutes }
        : {}),
    })
    .run();
  return (await getGroup(db, id))!;
}

export async function updateGroup(
  db: AppDb,
  groupId: string,
  patch: {
    name?: string;
    defaultFrom?: string | null;
    dataSource?: AudienceDataSourcePatch | null;
    cronEnabled?: boolean;
    cronIntervalMinutes?: number | null;
  },
): Promise<AudienceGroup> {
  if (!db) throw new Error("D1 not configured");
  const current = await getGroup(db, groupId);
  if (!current) throw new Error("Audience group not found");

  const updates: Partial<AudienceGroupRow> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("name is required");
    updates.name = name;
  }
  if (patch.defaultFrom !== undefined) {
    updates.defaultFrom =
      patch.defaultFrom === null || !patch.defaultFrom.trim()
        ? null
        : patch.defaultFrom.trim().toLowerCase();
  }
  if (patch.dataSource !== undefined) {
    updates.dataSourceJson =
      patch.dataSource === null
        ? null
        : JSON.stringify(
            mergeDataSource(current.dataSource, patch.dataSource),
          );
  }
  if (patch.cronEnabled !== undefined) {
    updates.cronEnabled = patch.cronEnabled ? 1 : 0;
  }
  if (patch.cronIntervalMinutes !== undefined) {
    updates.cronIntervalMinutes =
      patch.cronIntervalMinutes === null ? null : patch.cronIntervalMinutes;
  }

  await db
    .update(audienceGroups)
    .set(updates)
    .where(eq(audienceGroups.id, groupId))
    .run();
  return (await getGroup(db, groupId))!;
}

export async function deleteGroup(db: AppDb, groupId: string): Promise<boolean> {
  if (!db) return false;
  const result = await db
    .delete(audienceGroups)
    .where(eq(audienceGroups.id, groupId))
    .run();
  return result.meta.changes > 0;
}

// ─── contacts ────────────────────────────────────────────────────────────

export async function addManualContact(
  db: AppDb,
  input: { email: string; name?: string; groupId: string; domain: string },
): Promise<AudienceContact> {
  if (!db) throw new Error("D1 not configured");
  const id = crypto.randomUUID();
  const email = input.email.trim().toLowerCase();
  const addedAt = new Date().toISOString();
  await db
    .insert(audienceContacts)
    .values({
      id,
      email,
      ...(input.name?.trim() ? { name: input.name.trim() } : {}),
      domain: input.domain.trim().toLowerCase(),
      groupId: input.groupId,
      source: "manual",
      addedAt,
    })
    .run();
  const row = await db
    .select()
    .from(audienceContacts)
    .where(eq(audienceContacts.id, id))
    .get();
  return rowToContact(row!);
}

export async function removeContact(
  db: AppDb,
  contactId: string,
): Promise<boolean> {
  if (!db) return false;
  const result = await db
    .delete(audienceContacts)
    .where(eq(audienceContacts.id, contactId))
    .run();
  return result.meta.changes > 0;
}

export async function removeContactsByGroup(
  db: AppDb,
  groupId: string,
  source?: "manual" | "synced",
): Promise<number> {
  if (!db) return 0;
  const conditions = [eq(audienceContacts.groupId, groupId)];
  if (source) conditions.push(eq(audienceContacts.source, source));
  const result = await db
    .delete(audienceContacts)
    .where(and(...conditions))
    .run();
  return result.meta.changes;
}

/**
 * Replace all synced contacts for a group in a batch: delete existing synced,
 * then insert the new ones. Used by the audience sync flow.
 */
export async function replaceSyncedContacts(
  db: AppDb,
  groupId: string,
  domain: string,
  contacts: Array<{ email: string; name?: string }>,
): Promise<number> {
  if (!db) throw new Error("D1 not configured");
  await removeContactsByGroup(db, groupId, "synced");
  if (contacts.length === 0) return 0;
  const addedAt = new Date().toISOString();
  const values = contacts.map((c) => ({
    id: `synced:${groupId}:${c.email}`,
    email: c.email.trim().toLowerCase(),
    ...(c.name?.trim() ? { name: c.name.trim() } : {}),
    domain: domain.trim().toLowerCase(),
    groupId,
    source: "synced" as const,
    addedAt,
  }));
  await db.insert(audienceContacts).values(values).run();
  return values.length;
}

// ─── sync progress ───────────────────────────────────────────────────────

export async function updateSyncProgress(
  db: AppDb,
  groupId: string,
  progress: AudienceSyncRun,
): Promise<void> {
  if (!db) return;
  await db
    .update(audienceGroups)
    .set({ syncProgressJson: JSON.stringify(progress) })
    .where(eq(audienceGroups.id, groupId))
    .run();
}

export async function finishSync(
  db: AppDb,
  groupId: string,
  result: {
    run: AudienceSyncRun;
    lastSyncAt: string;
    lastSyncStatus: "success" | "error";
    lastSyncError?: string;
    lastSyncCount: number;
  },
): Promise<void> {
  if (!db) return;
  const current = await getGroup(db, groupId);
  const history = current?.syncHistory ?? [];
  const nextHistory = [result.run, ...history].slice(0, SYNC_HISTORY_LIMIT);
  await db
    .update(audienceGroups)
    .set({
      syncProgressJson: JSON.stringify(result.run),
      syncHistoryJson: JSON.stringify(nextHistory),
      lastSyncAt: result.lastSyncAt,
      lastSyncStatus: result.lastSyncStatus,
      lastSyncError: result.lastSyncError ?? null,
      lastSyncCount: result.lastSyncCount,
    })
    .where(eq(audienceGroups.id, groupId))
    .run();
}

export async function listGroupsForCron(
  db: AppDb,
): Promise<AudienceGroup[]> {
  if (!db) return [];
  const rows = await db
    .select()
    .from(audienceGroups)
    .where(eq(audienceGroups.cronEnabled, 1))
    .all();
  return rows.map(rowToGroup);
}
