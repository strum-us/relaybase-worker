import type { R2Bucket } from "@cloudflare/workers-types";
import type { AppDb } from "../../../db/app";
import {
  deleteAccountStateValue,
  deleteAllDraftAttachmentMeta,
  deleteDraftAttachmentMeta,
  getAccountStateValue,
  getDraftAttachmentMeta,
  listDraftAttachments,
  putDraftAttachmentMeta,
  setAccountStateValue,
  type AccountStateValue,
  type DraftAttachmentMeta,
} from "../../../db/app/account-state";

/**
 * Allow-list of `(namespace, key)` pairs the SHARED `/mail/account-state` and
 * `/mobile/account-state` endpoints accept (see `routes/account-state-router.ts`).
 * Mirrors `UI_FILES` in `main/app/src/email/lib/disk/user-ui-disk.ts` plus the
 * other former `~/.relaybase/{scopeId}/*` files being moved to D1. Keep the
 * two lists in sync by hand — `main/app` and `worker` aren't in the same
 * build graph (see the plan's open-questions list).
 *
 * Deliberately does NOT include `broadcast` — broadcast drafts are
 * owner/console-only (`requireConsoleSession`) and served by the separate
 * `/console/broadcast-drafts` route, which calls `readAccountState`/
 * `writeAccountState` directly rather than through this allow-list. Adding
 * `broadcast` here would let a mail-scoped owner token or a teammate's
 * mobile password reach the same `identityKey="owner"` row through
 * `/mail/account-state` or `/mobile/account-state`, bypassing the intended
 * console-session gate — this was caught by live end-to-end testing, not
 * code review, so don't re-add it without re-checking that boundary.
 */
export const ACCOUNT_STATE_KEYS: Record<string, readonly string[]> = {
  ui: [
    "enabled-accounts.json",
    "available-addresses.json",
    "sidebar.json",
    "accounts.json",
    "read.json",
    "trash.json",
    "compose-contacts.json",
  ],
  prefs: ["email.json"],
  mail: ["drafts.json"],
};

export function isAllowedAccountStateKey(namespace: string, key: string): boolean {
  return ACCOUNT_STATE_KEYS[namespace]?.includes(key) ?? false;
}

export async function readAccountState(
  db: AppDb,
  identityKey: string,
  namespace: string,
  key: string,
): Promise<AccountStateValue | null> {
  return getAccountStateValue(db, identityKey, namespace, key);
}

export async function writeAccountState(
  db: AppDb,
  identityKey: string,
  namespace: string,
  key: string,
  value: unknown,
): Promise<AccountStateValue> {
  return setAccountStateValue(db, identityKey, namespace, key, value);
}

export async function removeAccountState(
  db: AppDb,
  identityKey: string,
  namespace: string,
  key: string,
): Promise<void> {
  await deleteAccountStateValue(db, identityKey, namespace, key);
}

// ─── draft attachment bytes (R2 `INBOUND` bucket, `drafts/` prefix) ────────
//
// Sibling to the `inbound/` and `sent/` prefixes documented in
// `mailbox-store.ts` — same bucket, no new binding. The inbound-retention
// cron only walks `inbound/{domain}`, so it never touches this prefix.

function draftAttachmentR2Key(
  identityKey: string,
  draftId: string,
  attachmentId: string,
): string {
  return `drafts/${encodeURIComponent(identityKey)}/${encodeURIComponent(draftId)}/${encodeURIComponent(attachmentId)}`;
}

export async function putDraftAttachment(
  bucket: R2Bucket,
  db: AppDb,
  identityKey: string,
  draftId: string,
  attachmentId: string,
  bytes: ArrayBuffer,
  meta: { filename: string; contentType?: string | null },
): Promise<DraftAttachmentMeta> {
  const r2Key = draftAttachmentR2Key(identityKey, draftId, attachmentId);
  await bucket.put(r2Key, bytes, {
    httpMetadata: {
      contentType: meta.contentType || "application/octet-stream",
    },
    customMetadata: { filename: meta.filename },
  });
  const record: DraftAttachmentMeta = {
    attachmentId,
    filename: meta.filename,
    contentType: meta.contentType ?? null,
    size: bytes.byteLength,
    r2Key,
    createdAt: new Date().toISOString(),
  };
  await putDraftAttachmentMeta(db, identityKey, draftId, record);
  return record;
}

export async function getDraftAttachment(
  bucket: R2Bucket,
  db: AppDb,
  identityKey: string,
  draftId: string,
  attachmentId: string,
): Promise<{ meta: DraftAttachmentMeta; body: ArrayBuffer } | null> {
  const meta = await getDraftAttachmentMeta(db, identityKey, draftId, attachmentId);
  if (!meta) return null;
  const object = await bucket.get(meta.r2Key);
  if (!object) return null;
  return { meta, body: await object.arrayBuffer() };
}

export async function deleteDraftAttachment(
  bucket: R2Bucket,
  db: AppDb,
  identityKey: string,
  draftId: string,
  attachmentId: string,
): Promise<void> {
  const meta = await getDraftAttachmentMeta(db, identityKey, draftId, attachmentId);
  if (meta) await bucket.delete(meta.r2Key);
  await deleteDraftAttachmentMeta(db, identityKey, draftId, attachmentId);
}

export async function deleteDraftAttachmentsDir(
  bucket: R2Bucket,
  db: AppDb,
  identityKey: string,
  draftId: string,
): Promise<void> {
  const items = await listDraftAttachments(db, identityKey, draftId);
  for (const item of items) {
    await bucket.delete(item.r2Key);
  }
  await deleteAllDraftAttachmentMeta(db, identityKey, draftId);
}

export { listDraftAttachments };
