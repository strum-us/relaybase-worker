import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { readAccountState, writeAccountState } from "../../lib/account-state";
import { createAppDb } from "../../../db/app";

const NAMESPACE = "broadcast";
const KEY = "broadcast-drafts.json";
/** Broadcast composing is owner/console-only today — no team scoping. */
const IDENTITY_KEY = "owner";

/**
 * `~/.relaybase/{scopeId}/cache/dashboard/broadcast-drafts.json` replacement
 * (`main/app/src/lib/dashboard/broadcast-drafts-disk.ts`) — in-progress
 * broadcast composer state, owner-only, so it's a distinct D1 `account_state`
 * row rather than routed through `/mail/account-state` (which is scoped per
 * mail identity, owner or team).
 */
const consoleBroadcastDrafts = new Hono<{ Bindings: Env }>();

consoleBroadcastDrafts.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  const db = createAppDb(c.env.RELAYBASE_DB);
  if (!db) return c.json({ error: "Product database is not configured" }, 503);

  const record = await readAccountState(db, IDENTITY_KEY, NAMESPACE, KEY);
  if (!record) return c.json({ value: null, updatedAt: null });
  return c.json(record);
});

consoleBroadcastDrafts.put("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

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

  const record = await writeAccountState(db, IDENTITY_KEY, NAMESPACE, KEY, body.value);
  return c.json(record);
});

export { consoleBroadcastDrafts };
