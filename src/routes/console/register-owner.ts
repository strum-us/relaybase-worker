import { Hono } from "hono";
import type { Env } from "../../env";
import { requireConsoleSession } from "../../lib/auth";
import { createAppDb } from "../../../db/app";
import {
  getOwnerLoginConfig,
  setOwnerConfig,
} from "../../../db/app/owner";

const consoleRegisterOwner = new Hono<{ Bindings: Env }>();

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Records the Relaybase console account that owns this Worker. Called by the
 * desktop app after a successful install (owner session proves the caller
 * controls this Worker). The owner email is informational binding metadata.
 *
 * Body: { accountEmail, workerUrl }
 */
consoleRegisterOwner.post("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;

  let body: { accountEmail?: string; workerUrl?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const email = body.accountEmail?.trim().toLowerCase() ?? "";
  const workerUrl = body.workerUrl?.trim().replace(/\/$/, "") ?? "";
  if (!email || !EMAIL_RE.test(email)) {
    return c.json({ error: "A valid accountEmail is required" }, 400);
  }
  if (!workerUrl || !/^https:\/\/[a-z0-9.-]+\.workers\.dev$/i.test(workerUrl)) {
    return c.json({ error: "A valid https://*.workers.dev workerUrl is required" }, 400);
  }

  const db = createAppDb(c.env.RELAYBASE_DB);
  await setOwnerConfig(db, { ownerEmail: email, workerUrl });

  return c.json({ ok: true, ownerEmail: email, workerUrl });
});

/** Returns the owner email (owner session) — used by the desktop to confirm. */
consoleRegisterOwner.get("/", async (c) => {
  const denied = await requireConsoleSession(c);
  if (denied) return denied;
  const db = createAppDb(c.env.RELAYBASE_DB);
  const config = await getOwnerLoginConfig(db);
  return c.json({
    ok: true,
    ownerEmail: config?.ownerEmail ?? null,
    workerUrl: config?.workerUrl ?? null,
  });
});

export { consoleRegisterOwner };
