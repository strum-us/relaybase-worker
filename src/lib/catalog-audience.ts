/**
 * Audience contacts + groups catalog (D1 `relaybase-db`).
 * Tables: audience_groups, audience_contacts
 */

import type { AppDb } from "../../db/app";
import {
  addManualContact as dbAddManualContact,
  createGroup as dbCreateGroup,
  deleteGroup as dbDeleteGroup,
  finishSync as dbFinishSync,
  getGroup as dbGetGroup,
  getGroupDetail as dbGetGroupDetail,
  getGroupSummaries as dbGetGroupSummaries,
  listContacts as dbListContacts,
  listContactsForGroup as dbListContactsForGroup,
  listContactsForGroups as dbListContactsForGroups,
  listGroups as dbListGroups,
  listGroupsForCron as dbListGroupsForCron,
  mergeDataSource as dbMergeDataSource,
  removeContact as dbRemoveContact,
  removeContactsByGroup as dbRemoveContactsByGroup,
  replaceSyncedContacts as dbReplaceSyncedContacts,
  updateGroup as dbUpdateGroup,
  updateSyncProgress as dbUpdateSyncProgress,
} from "../../db/app/audience";
import type {
  AudienceContact,
  AudienceDataSource,
  AudienceDataSourcePatch,
  AudienceGroup,
  AudienceGroupSummary,
  AudienceSyncRun,
} from "./catalog-types";
import { normalizeDomain } from "./catalog-store";

const SYNC_WRITE_CHUNK = 50;
const DUE_GRACE_MS = 60_000;

export type AudienceCatalog = {
  contacts: AudienceContact[];
  groups: AudienceGroup[];
};

export async function readAudienceCatalog(
  db: AppDb,
): Promise<AudienceCatalog> {
  const [groups, contacts] = await Promise.all([
    dbListGroups(db),
    dbListContacts(db),
  ]);
  return { contacts, groups };
}

export async function writeAudienceContacts(
  _db: AppDb,
  _contacts: AudienceContact[],
): Promise<void> {
  // No-op: contacts are now managed per-row via addManualContact /
  // removeContact / replaceSyncedContacts. Kept for API compatibility.
}

export async function writeAudienceGroups(
  _db: AppDb,
  _groups: AudienceGroup[],
): Promise<void> {
  // No-op: groups are now managed per-row via createGroup / updateGroup /
  // deleteGroup. Kept for API compatibility.
}

export async function writeAudienceCatalog(
  db: AppDb,
  catalog: AudienceCatalog,
): Promise<void> {
  await Promise.all([
    writeAudienceContacts(db, catalog.contacts),
    writeAudienceGroups(db, catalog.groups),
  ]);
}

export function listGroupSummaries(
  catalog: AudienceCatalog,
): AudienceGroupSummary[] {
  return catalog.groups.map((group) => ({
    ...group,
    contactCount: catalog.contacts.filter((c) => c.groupId === group.id).length,
  }));
}

export async function listGroupSummariesFromDb(
  db: AppDb,
): Promise<AudienceGroupSummary[]> {
  return dbGetGroupSummaries(db);
}

export function getGroupDetail(
  catalog: AudienceCatalog,
  groupId: string,
): { group: AudienceGroupSummary; contacts: AudienceContact[] } | null {
  const group = catalog.groups.find((g) => g.id === groupId);
  if (!group) return null;
  return {
    group: {
      ...group,
      contactCount: catalog.contacts.filter((c) => c.groupId === group.id).length,
    },
    contacts: catalog.contacts.filter((c) => c.groupId === groupId),
  };
}

export async function getGroupDetailFromDb(
  db: AppDb,
  groupId: string,
): Promise<{ group: AudienceGroupSummary; contacts: AudienceContact[] } | null> {
  return dbGetGroupDetail(db, groupId);
}

export function mergeDataSource(
  previous: AudienceDataSource | undefined,
  patch: AudienceDataSourcePatch,
): AudienceDataSource {
  return dbMergeDataSource(previous, patch);
}

function parseCredentialHeaderValue(
  dataSource: AudienceDataSource,
): { header: string; value: string } | null {
  const credential = dataSource.credential?.trim();
  if (!credential) return null;
  const header = dataSource.credentialHeader?.trim() || "Authorization";
  if (header.toLowerCase() === "authorization") {
    const value = credential.toLowerCase().startsWith("bearer ")
      ? credential
      : `Bearer ${credential}`;
    return { header: "Authorization", value };
  }
  return { header, value: credential };
}

function extractRawContactList(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  for (const key of ["contacts", "data", "items", "results"]) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

function emailLocalPart(email: string): string {
  return email.split("@")[0] || email;
}

export async function fetchDataSourceContacts(
  dataSource: AudienceDataSource,
): Promise<{
  contacts: Array<{ email: string; name?: string }>;
  skippedCount: number;
}> {
  const auth = parseCredentialHeaderValue(dataSource);
  const headers: Record<string, string> = auth
    ? { [auth.header]: auth.value }
    : {};

  const res = await fetch(dataSource.endpointUrl, { headers });
  if (!res.ok) {
    throw new Error(`Endpoint returned ${res.status} ${res.statusText}`);
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new Error("Endpoint did not return valid JSON");
  }

  const rawList = extractRawContactList(json);
  let skippedCount = 0;
  const contacts: Array<{ email: string; name?: string }> = [];
  for (const entry of rawList) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      skippedCount++;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const email =
      typeof record.email === "string" ? record.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@")) {
      skippedCount++;
      continue;
    }
    const explicitName =
      typeof record.name === "string" && record.name.trim()
        ? record.name.trim()
        : undefined;
    contacts.push({ email, name: explicitName || emailLocalPart(email) });
  }
  return { contacts, skippedCount };
}

function estimateRemainingMs(
  startedAt: string,
  processed: number,
  total: number,
): number | undefined {
  if (processed <= 0 || total <= 0 || processed >= total) return undefined;
  const elapsed = Date.now() - new Date(startedAt).getTime();
  if (elapsed <= 0) return undefined;
  const rate = processed / elapsed;
  if (rate <= 0) return undefined;
  return Math.round((total - processed) / rate);
}

export type SyncResult = {
  ok: boolean;
  count: number;
  skippedCount: number;
  error?: string;
};

export async function syncAudienceGroup(
  db: AppDb,
  groupId: string,
  options: { trigger?: "manual" | "cron" } = {},
): Promise<SyncResult> {
  const group = await dbGetGroup(db, groupId);
  if (!group) throw new Error("Audience group not found");
  if (!group.dataSource) throw new Error("Audience group has no data source");

  const trigger = options.trigger ?? "manual";
  const startedAt = new Date().toISOString();
  const run: AudienceSyncRun = {
    id: crypto.randomUUID(),
    trigger,
    status: "running",
    phase: "fetching",
    startedAt,
    processedCount: 0,
    totalCount: 0,
  };
  await dbUpdateSyncProgress(db, groupId, run);

  try {
    const { contacts, skippedCount } = await fetchDataSourceContacts(
      group.dataSource,
    );
    run.phase = "parsing";
    run.totalCount = contacts.length;
    run.skippedCount = skippedCount;
    run.failedCount = skippedCount;
    await dbUpdateSyncProgress(db, groupId, run);

    run.phase = "writing";
    run.processedCount = 0;
    await dbUpdateSyncProgress(db, groupId, run);

    for (let i = 0; i < contacts.length; i += SYNC_WRITE_CHUNK) {
      run.processedCount = Math.min(i + SYNC_WRITE_CHUNK, contacts.length);
      run.estimatedRemainingMs = estimateRemainingMs(
        startedAt,
        run.processedCount,
        contacts.length,
      );
      await dbUpdateSyncProgress(db, groupId, run);
    }

    const count = await dbReplaceSyncedContacts(
      db,
      groupId,
      group.domain,
      contacts,
    );

    const finishedAt = new Date().toISOString();
    run.phase = "done";
    run.status = "success";
    run.finishedAt = finishedAt;
    run.processedCount = count;
    run.successCount = count;
    run.estimatedRemainingMs = 0;
    await dbFinishSync(db, groupId, {
      run: { ...run },
      lastSyncAt: finishedAt,
      lastSyncStatus: "success",
      lastSyncCount: count,
    });
    return { ok: true, count, skippedCount };
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sync failed";
    const finishedAt = new Date().toISOString();
    run.phase = "done";
    run.status = "error";
    run.finishedAt = finishedAt;
    run.error = message;
    run.estimatedRemainingMs = 0;
    await dbFinishSync(db, groupId, {
      run: { ...run },
      lastSyncAt: finishedAt,
      lastSyncStatus: "error",
      lastSyncError: message,
      lastSyncCount: 0,
    });
    return { ok: false, count: 0, skippedCount: 0, error: message };
  }
}

export async function createAudienceGroup(
  db: AppDb,
  input: {
    name: string;
    domain: string;
    dataSource?: AudienceDataSourcePatch;
    cronEnabled?: boolean;
    cronIntervalMinutes?: number;
  },
): Promise<AudienceGroup> {
  const name = input.name.trim();
  const domain = normalizeDomain(input.domain);
  if (!name) throw new Error("name is required");
  if (!domain) throw new Error("domain is required");

  const group = await dbCreateGroup(db, {
    name,
    domain,
    dataSource: input.dataSource,
    cronEnabled: input.cronEnabled,
    cronIntervalMinutes: input.cronIntervalMinutes,
  });

  if (group.dataSource) {
    await syncAudienceGroup(db, group.id, { trigger: "manual" });
    return (await dbGetGroup(db, group.id)) ?? group;
  }
  return group;
}

export async function updateAudienceGroup(
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
  return dbUpdateGroup(db, groupId, patch);
}

export async function deleteAudienceGroup(
  db: AppDb,
  groupId: string,
): Promise<void> {
  await dbDeleteGroup(db, groupId);

  // Strip groupId from broadcasts (lazy import to avoid cycle).
  const { readBroadcasts, updateBroadcastGroupIds } = await import(
    "./catalog-broadcasts"
  );
  const broadcasts = await readBroadcasts(db);
  for (const b of broadcasts) {
    const next = b.groupIds.filter((id) => id !== groupId);
    if (next.length !== b.groupIds.length) {
      await updateBroadcastGroupIds(db, b.id, next);
    }
  }
}

export async function addManualContact(
  db: AppDb,
  groupId: string,
  input: { email: string; name?: string },
): Promise<AudienceContact> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new Error("A valid email is required");
  }
  const group = await dbGetGroup(db, groupId);
  if (!group) throw new Error("Audience group not found");
  return dbAddManualContact(db, {
    email,
    name: input.name,
    groupId,
    domain: group.domain,
  });
}

export async function removeContact(
  db: AppDb,
  groupId: string,
  contactId: string,
): Promise<void> {
  // groupId is used for scoping verification; the contact is deleted by id.
  await dbRemoveContact(db, contactId);
}

export async function listContactsForGroupFromDb(
  db: AppDb,
  groupId: string,
): Promise<AudienceContact[]> {
  return dbListContactsForGroup(db, groupId);
}

export function listContactsForGroups(
  catalog: AudienceCatalog,
  groupIds: string[],
): AudienceContact[] {
  const wanted = new Set(groupIds);
  const seen = new Set<string>();
  const result: AudienceContact[] = [];
  for (const contact of catalog.contacts) {
    if (!wanted.has(contact.groupId)) continue;
    if (seen.has(contact.email)) continue;
    seen.add(contact.email);
    result.push(contact);
  }
  return result;
}

export async function listContactsForGroupsFromDb(
  db: AppDb,
  groupIds: string[],
): Promise<AudienceContact[]> {
  const contacts = await dbListContactsForGroups(db, groupIds);
  const seen = new Set<string>();
  const result: AudienceContact[] = [];
  for (const contact of contacts) {
    if (seen.has(contact.email)) continue;
    seen.add(contact.email);
    result.push(contact);
  }
  return result;
}

export async function getGroupProgressFromDb(
  db: AppDb,
  groupId: string,
) {
  const group = await dbGetGroup(db, groupId);
  if (!group) return null;
  let nextDueAt: string | null = null;
  if (
    group.cronEnabled &&
    group.cronIntervalMinutes &&
    group.cronIntervalMinutes > 0
  ) {
    if (group.lastSyncAt) {
      nextDueAt = new Date(
        new Date(group.lastSyncAt).getTime() +
          group.cronIntervalMinutes * 60_000,
      ).toISOString();
    } else {
      nextDueAt = new Date().toISOString();
    }
  }
  return {
    groupId,
    cronEnabled: Boolean(group.cronEnabled),
    cronIntervalMinutes: group.cronIntervalMinutes,
    nextDueAt,
    lastSyncAt: group.lastSyncAt,
    progress: group.syncProgress ?? null,
    history: group.syncHistory ?? [],
  };
}

export function getGroupProgress(catalog: AudienceCatalog, groupId: string) {
  const group = catalog.groups.find((g) => g.id === groupId);
  if (!group) return null;
  let nextDueAt: string | null = null;
  if (
    group.cronEnabled &&
    group.cronIntervalMinutes &&
    group.cronIntervalMinutes > 0
  ) {
    if (group.lastSyncAt) {
      nextDueAt = new Date(
        new Date(group.lastSyncAt).getTime() +
          group.cronIntervalMinutes * 60_000,
      ).toISOString();
    } else {
      nextDueAt = new Date().toISOString();
    }
  }
  return {
    groupId,
    cronEnabled: Boolean(group.cronEnabled),
    cronIntervalMinutes: group.cronIntervalMinutes,
    nextDueAt,
    lastSyncAt: group.lastSyncAt,
    progress: group.syncProgress ?? null,
    history: group.syncHistory ?? [],
  };
}

function isDue(group: AudienceGroup, now: number): boolean {
  if (!group.cronEnabled || !group.dataSource) return false;
  const interval = group.cronIntervalMinutes ?? 0;
  if (interval <= 0) return false;
  if (!group.lastSyncAt) return true;
  const elapsed = now - new Date(group.lastSyncAt).getTime();
  return elapsed >= interval * 60_000 - DUE_GRACE_MS;
}

/** Cron entry: sync every due group. */
export async function runAudienceCron(
  db: AppDb,
): Promise<{ groupsSynced: number }> {
  const groups = await dbListGroupsForCron(db);
  const now = Date.now();
  const due = groups.filter((g) => isDue(g, now));
  let groupsSynced = 0;
  for (const group of due) {
    try {
      await syncAudienceGroup(db, group.id, { trigger: "cron" });
      groupsSynced++;
    } catch (error) {
      console.error("Audience cron sync failed", group.id, error);
    }
  }
  return { groupsSynced };
}
