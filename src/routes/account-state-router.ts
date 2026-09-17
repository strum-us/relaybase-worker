import { Hono } from "hono";
import type { Env } from "../env";
import type { AccountIdentity } from "../lib/catalog/account-identity";
import {
  ACCOUNT_STATE_KEYS,
  deleteDraftAttachment,
  deleteDraftAttachmentsDir,
  getDraftAttachment,
  isAllowedAccountStateKey,
  putDraftAttachment,
  readAccountState,
  removeAccountState,
  writeAccountState,
} from "../lib/catalog/account-state";
import { createAppDb } from "../../db/app";

/**
 * Shared route implementation for the `~/.relaybase/{scopeId}/*` → D1
 * migration: durable per-account settings/UI state + unsent compose drafts.
 * Mounted twice with different auth — `/mail/account-state` (owner-session,
 * via `resolveAccountIdentity`) and `/mobile/account-state` (mobile-password,
 * via `foldMobileIdentity` off the already-authenticated email) — so desktop
 * console, web console, and web/mobile "email" mode all read/write the same
 * D1 `account_state` table. See `worker/src/lib/catalog/account-state.ts` for the
 * `(namespace, key)` allow-list and `worker/src/lib/catalog/account-identity.ts` for
 * identity resolution.
 */
export function createAccountStateRouter(
  // `c`'s Variables differ by mount point (`/mail` has none; `/mobile` adds
  // `authEmail` from its own middleware) — left untyped rather than fighting
  // Hono's per-instance Context generics for this internal wiring helper.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveIdentity: (c: any) => Promise<AccountIdentity | Response>,
) {
  const router = new Hono<{ Bindings: Env }>();

  router.get("/:namespace/:key", async (c) => {
    const identity = await resolveIdentity(c);
    if (identity instanceof Response) return identity;

    const namespace = c.req.param("namespace");
    const key = c.req.param("key");
    if (!isAllowedAccountStateKey(namespace, key)) {
      return c.json({ error: "Unknown account-state key" }, 404);
    }

    const db = createAppDb(c.env.RELAYBASE_DB);
    if (!db) return c.json({ error: "Product database is not configured" }, 503);

    const record = await readAccountState(db, identity.identityKey, namespace, key);
    if (!record) return c.json({ value: null, updatedAt: null });
    return c.json(record);
  });

  router.put("/:namespace/:key", async (c) => {
    const identity = await resolveIdentity(c);
    if (identity instanceof Response) return identity;

    const namespace = c.req.param("namespace");
    const key = c.req.param("key");
    if (!isAllowedAccountStateKey(namespace, key)) {
      return c.json({ error: "Unknown account-state key" }, 404);
    }

    const db = createAppDb(c.env.RELAYBASE_DB);
    if (!db) return c.json({ error: "Product database is not configured" }, 503);

    let body: { value?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!("value" in body)) {
      return c.json({ error: "value is required" }, 400);
    }

    const record = await writeAccountState(
      db,
      identity.identityKey,
      namespace,
      key,
      body.value,
    );
    return c.json(record);
  });

  router.delete("/:namespace/:key", async (c) => {
    const identity = await resolveIdentity(c);
    if (identity instanceof Response) return identity;

    const namespace = c.req.param("namespace");
    const key = c.req.param("key");
    if (!isAllowedAccountStateKey(namespace, key)) {
      return c.json({ error: "Unknown account-state key" }, 404);
    }

    const db = createAppDb(c.env.RELAYBASE_DB);
    if (!db) return c.json({ error: "Product database is not configured" }, 503);

    await removeAccountState(db, identity.identityKey, namespace, key);
    return c.json({ ok: true });
  });

  router.get("/drafts/:draftId/attachments/:attachmentId", async (c) => {
    const identity = await resolveIdentity(c);
    if (identity instanceof Response) return identity;

    const db = createAppDb(c.env.RELAYBASE_DB);
    if (!db) return c.json({ error: "Product database is not configured" }, 503);

    const result = await getDraftAttachment(
      c.env.INBOUND,
      db,
      identity.identityKey,
      c.req.param("draftId"),
      c.req.param("attachmentId"),
    );
    if (!result) return c.json({ error: "Attachment not found" }, 404);
    return new Response(result.body, {
      headers: {
        "Content-Type": result.meta.contentType || "application/octet-stream",
        "X-Filename": encodeURIComponent(result.meta.filename),
        "Cache-Control": "private, max-age=3600",
      },
    });
  });

  // Body is JSON `{ filename, contentType, contentBase64 }` rather than a raw
  // binary request body — the desktop Tauri invoke bridge (`worker_request`)
  // only carries a string request body, so every write path that must work
  // from both the browser and the Tauri webview uses base64-in-JSON (same
  // convention as `resolveSendAttachments`'s `contentBase64` field).
  router.put("/drafts/:draftId/attachments/:attachmentId", async (c) => {
    const identity = await resolveIdentity(c);
    if (identity instanceof Response) return identity;

    const db = createAppDb(c.env.RELAYBASE_DB);
    if (!db) return c.json({ error: "Product database is not configured" }, 503);

    let body: { filename?: unknown; contentType?: unknown; contentBase64?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (typeof body.contentBase64 !== "string" || !body.contentBase64) {
      return c.json({ error: "contentBase64 is required" }, 400);
    }
    const filename = typeof body.filename === "string" && body.filename ? body.filename : "attachment";
    const contentType =
      typeof body.contentType === "string" && body.contentType
        ? body.contentType
        : "application/octet-stream";

    let bytes: ArrayBuffer;
    try {
      const binary = atob(body.contentBase64);
      const view = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
      bytes = view.buffer;
    } catch {
      return c.json({ error: "contentBase64 is not valid base64" }, 400);
    }

    const meta = await putDraftAttachment(
      c.env.INBOUND,
      db,
      identity.identityKey,
      c.req.param("draftId"),
      c.req.param("attachmentId"),
      bytes,
      { filename, contentType },
    );
    return c.json(meta);
  });

  router.delete("/drafts/:draftId/attachments/:attachmentId", async (c) => {
    const identity = await resolveIdentity(c);
    if (identity instanceof Response) return identity;

    const db = createAppDb(c.env.RELAYBASE_DB);
    if (!db) return c.json({ error: "Product database is not configured" }, 503);

    await deleteDraftAttachment(
      c.env.INBOUND,
      db,
      identity.identityKey,
      c.req.param("draftId"),
      c.req.param("attachmentId"),
    );
    return c.json({ ok: true });
  });

  router.delete("/drafts/:draftId/attachments", async (c) => {
    const identity = await resolveIdentity(c);
    if (identity instanceof Response) return identity;

    const db = createAppDb(c.env.RELAYBASE_DB);
    if (!db) return c.json({ error: "Product database is not configured" }, 503);

    await deleteDraftAttachmentsDir(
      c.env.INBOUND,
      db,
      identity.identityKey,
      c.req.param("draftId"),
    );
    return c.json({ ok: true });
  });

  /**
   * One-time migration upload for existing desktop installs (see
   * `main/desktop/src-tauri/src/storage` `migrate_account_state_to_worker_v1`).
   * Upsert-only and idempotent — safe to retry on partial failure. Distinct
   * from `/console/migrate-db`, which applies schema, not data.
   */
  router.post("/bulk-import", async (c) => {
    const identity = await resolveIdentity(c);
    if (identity instanceof Response) return identity;

    const db = createAppDb(c.env.RELAYBASE_DB);
    if (!db) return c.json({ error: "Product database is not configured" }, 503);

    let body: { items?: Array<{ namespace?: unknown; key?: unknown; value?: unknown }> };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    const items = Array.isArray(body.items) ? body.items : [];

    const imported: Array<{ namespace: string; key: string }> = [];
    const skipped: Array<{ namespace: unknown; key: unknown; reason: string }> = [];
    for (const item of items) {
      const namespace = typeof item.namespace === "string" ? item.namespace : "";
      const key = typeof item.key === "string" ? item.key : "";
      if (!isAllowedAccountStateKey(namespace, key)) {
        skipped.push({ namespace: item.namespace, key: item.key, reason: "unknown key" });
        continue;
      }
      await writeAccountState(db, identity.identityKey, namespace, key, item.value);
      imported.push({ namespace, key });
    }

    return c.json({ ok: true, imported, skipped, allowedKeys: ACCOUNT_STATE_KEYS });
  });

  return router;
}
