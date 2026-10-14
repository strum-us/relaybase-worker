import { and, eq, inArray, or } from "drizzle-orm";
import type { AppDb } from "./index";
import { accountState, draftAttachments } from "./schema";

export type AccountStateValue = {
  value: unknown;
  updatedAt: string;
};

function rowId(identityKey: string, namespace: string, key: string): string {
  return `${identityKey}:${namespace}:${key}`;
}

/** UI keys bundled into GET /mail/bootstrap (keep in sync with bootstrap route). */
export const MAIL_BOOTSTRAP_UI_KEYS = [
  "enabled-accounts.json",
  "available-addresses.json",
  "ui-preferences.json",
  "read.json",
  "trash.json",
] as const;

export type MailBootstrapAccountState = {
  ui: Record<string, unknown | null>;
  emailPrefs: unknown | null;
  drafts: unknown | null;
};

/** One D1 round-trip for all mail-bootstrap account_state rows. */
export async function readMailBootstrapAccountState(
  db: AppDb,
  identityKey: string,
): Promise<MailBootstrapAccountState> {
  const ui: Record<string, unknown | null> = Object.fromEntries(
    MAIL_BOOTSTRAP_UI_KEYS.map((key) => [key, null]),
  );
  if (!db) {
    return { ui, emailPrefs: null, drafts: null };
  }

  const rows = await db
    .select({
      namespace: accountState.namespace,
      key: accountState.key,
      valueJson: accountState.valueJson,
    })
    .from(accountState)
    .where(
      and(
        eq(accountState.identityKey, identityKey),
        or(
          and(
            eq(accountState.namespace, "ui"),
            inArray(accountState.key, [...MAIL_BOOTSTRAP_UI_KEYS]),
          ),
          and(
            eq(accountState.namespace, "prefs"),
            eq(accountState.key, "email.json"),
          ),
          and(
            eq(accountState.namespace, "mail"),
            eq(accountState.key, "drafts.json"),
          ),
        ),
      ),
    )
    .all();

  let emailPrefs: unknown | null = null;
  let drafts: unknown | null = null;
  for (const row of rows) {
    let value: unknown = null;
    try {
      value = JSON.parse(row.valueJson);
    } catch {
      value = null;
    }
    if (row.namespace === "ui" && row.key in ui) {
      ui[row.key] = value;
    } else if (row.namespace === "prefs" && row.key === "email.json") {
      emailPrefs = value;
    } else if (row.namespace === "mail" && row.key === "drafts.json") {
      drafts = value;
    }
  }

  return { ui, emailPrefs, drafts };
}

export async function getAccountStateValue(
  db: AppDb,
  identityKey: string,
  namespace: string,
  key: string,
): Promise<AccountStateValue | null> {
  if (!db) return null;
  const row = await db
    .select()
    .from(accountState)
    .where(eq(accountState.id, rowId(identityKey, namespace, key)))
    .get();
  if (!row) return null;
  try {
    return { value: JSON.parse(row.valueJson), updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

export async function setAccountStateValue(
  db: AppDb,
  identityKey: string,
  namespace: string,
  key: string,
  value: unknown,
): Promise<AccountStateValue> {
  const updatedAt = new Date().toISOString();
  const valueJson = JSON.stringify(value ?? null);
  if (!db) return { value, updatedAt };
  await db
    .insert(accountState)
    .values({
      id: rowId(identityKey, namespace, key),
      identityKey,
      namespace,
      key,
      valueJson,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: accountState.id,
      set: { valueJson, updatedAt },
    })
    .run();
  return { value, updatedAt };
}

export async function deleteAccountStateValue(
  db: AppDb,
  identityKey: string,
  namespace: string,
  key: string,
): Promise<void> {
  if (!db) return;
  await db
    .delete(accountState)
    .where(eq(accountState.id, rowId(identityKey, namespace, key)))
    .run();
}

// ─── draft attachment metadata (bytes live in R2 — see worker/src/lib/catalog/account-state.ts) ───

export type DraftAttachmentMeta = {
  attachmentId: string;
  filename: string;
  contentType: string | null;
  size: number;
  r2Key: string;
  createdAt: string;
};

function draftAttachmentRowId(
  identityKey: string,
  draftId: string,
  attachmentId: string,
): string {
  return `${identityKey}:${draftId}:${attachmentId}`;
}

export async function putDraftAttachmentMeta(
  db: AppDb,
  identityKey: string,
  draftId: string,
  meta: DraftAttachmentMeta,
): Promise<void> {
  if (!db) return;
  await db
    .insert(draftAttachments)
    .values({
      id: draftAttachmentRowId(identityKey, draftId, meta.attachmentId),
      identityKey,
      draftId,
      attachmentId: meta.attachmentId,
      filename: meta.filename,
      contentType: meta.contentType,
      size: meta.size,
      r2Key: meta.r2Key,
      createdAt: meta.createdAt,
    })
    .onConflictDoUpdate({
      target: draftAttachments.id,
      set: {
        filename: meta.filename,
        contentType: meta.contentType,
        size: meta.size,
        r2Key: meta.r2Key,
      },
    })
    .run();
}

export async function getDraftAttachmentMeta(
  db: AppDb,
  identityKey: string,
  draftId: string,
  attachmentId: string,
): Promise<DraftAttachmentMeta | null> {
  if (!db) return null;
  const row = await db
    .select()
    .from(draftAttachments)
    .where(eq(draftAttachments.id, draftAttachmentRowId(identityKey, draftId, attachmentId)))
    .get();
  if (!row) return null;
  return {
    attachmentId: row.attachmentId,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    r2Key: row.r2Key,
    createdAt: row.createdAt,
  };
}

export async function listDraftAttachments(
  db: AppDb,
  identityKey: string,
  draftId: string,
): Promise<DraftAttachmentMeta[]> {
  if (!db) return [];
  const rows = await db
    .select()
    .from(draftAttachments)
    .where(
      and(
        eq(draftAttachments.identityKey, identityKey),
        eq(draftAttachments.draftId, draftId),
      ),
    )
    .all();
  return rows.map((row) => ({
    attachmentId: row.attachmentId,
    filename: row.filename,
    contentType: row.contentType,
    size: row.size,
    r2Key: row.r2Key,
    createdAt: row.createdAt,
  }));
}

export async function deleteDraftAttachmentMeta(
  db: AppDb,
  identityKey: string,
  draftId: string,
  attachmentId: string,
): Promise<void> {
  if (!db) return;
  await db
    .delete(draftAttachments)
    .where(eq(draftAttachments.id, draftAttachmentRowId(identityKey, draftId, attachmentId)))
    .run();
}

/** Delete every attachment row for a draft. Caller is responsible for deleting the R2 objects first (see `listDraftAttachments`). */
export async function deleteAllDraftAttachmentMeta(
  db: AppDb,
  identityKey: string,
  draftId: string,
): Promise<void> {
  if (!db) return;
  await db
    .delete(draftAttachments)
    .where(
      and(
        eq(draftAttachments.identityKey, identityKey),
        eq(draftAttachments.draftId, draftId),
      ),
    )
    .run();
}
