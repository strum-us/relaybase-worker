import { Hono } from "hono";
import type { Env } from "../../env";
import { requireSchemaAuth } from "../../lib/auth";
import { applyPendingMigrations } from "../../lib/d1-migrations";
import { ownerIsConfigured } from "../../../db/app/owner";
import { createAppDb } from "../../../db/app";

const consoleMigrateDb = new Hono<{ Bindings: Env }>();

/**
 * POST /console/migrate-db
 *
 * Apply pending D1 migrations only. Never drops tables. No `clear` body.
 * Used after Worker updates and when install reuses existing D1s.
 *
 * Auth: owner access token, Cloudflare OAuth account proof (install /
 * upgrade), or AUTH_PEPPER bootstrap when no owner exists yet.
 */
consoleMigrateDb.post("/", async (c) => {
  const db = createAppDb(c.env.RELAYBASE_DB);
  const hasOwner = db ? await ownerIsConfigured(db) : false;
  const denied = await requireSchemaAuth(c, hasOwner);
  if (denied) return denied;

  const applied = await applyPendingMigrations(c.env);
  if (applied.errors.length > 0) {
    return c.json(
      {
        ok: false,
        alreadyInitialized: applied.alreadyInitialized,
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
    alreadyInitialized: applied.alreadyInitialized,
    applied: applied.applied,
    skipped: applied.skipped,
    results: applied.results,
  });
});

export { consoleMigrateDb };
