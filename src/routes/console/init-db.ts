import { Hono } from "hono";
import type { Env } from "../../env";
import { requireSchemaAuth } from "../../lib/auth";
import { ownerIsConfigured } from "../../../db/app/owner";
import { createAppDb } from "../../../db/app";
import {
  anyProbeTableExists,
  applyPendingMigrations,
} from "../../lib/d1-migrations";

const consoleInitDb = new Hono<{ Bindings: Env }>();

/**
 * POST /console/init-db
 *
 * Empty D1 only. If any probe table already exists, returns 409 and writes
 * nothing — including when the body has `{ clear: true }`. Existing databases
 * use POST /console/migrate-db. To wipe, delete the D1s in Cloudflare and
 * create empty ones, then call this again.
 *
 * Auth: owner access token, Cloudflare OAuth account proof (install /
 * upgrade), or AUTH_PEPPER when no owner exists yet.
 */
consoleInitDb.post("/", async (c) => {
  const db = createAppDb(c.env.RELAYBASE_DB);
  const hasOwner = db ? await ownerIsConfigured(db) : false;
  const denied = await requireSchemaAuth(c, hasOwner);
  if (denied) return denied;

  const probe = await anyProbeTableExists(c.env);
  if (probe.alreadyInitialized) {
    return c.json(
      {
        ok: false,
        error: "DB_ALREADY_INITIALIZED",
        alreadyInitialized: true,
        applied: [],
        skipped: [],
        results: probe.results,
      },
      409,
    );
  }

  const applied = await applyPendingMigrations(c.env);
  if (applied.errors.length > 0) {
    return c.json(
      {
        ok: false,
        alreadyInitialized: false,
        applied: applied.applied,
        skipped: applied.skipped,
        results: applied.results,
        error: applied.errors.join("; "),
      },
      500,
    );
  }

  return c.json({
    ok: true,
    alreadyInitialized: false,
    applied: applied.applied,
    skipped: applied.skipped,
    results: applied.results,
  });
});

export { consoleInitDb };
