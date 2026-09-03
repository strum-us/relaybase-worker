import type { Env } from "../env";
import {
  MIGRATIONS,
  splitMigrationSql,
  type MigrationTarget,
} from "../../db/migrations";
import {
  d1ErrorText,
  isSchemaAlreadyPresentError,
  normalizeMigrationName,
} from "./d1-migration-names";

export const MIGRATIONS_TABLE = "d1_migrations";
export { isSchemaAlreadyPresentError, normalizeMigrationName };

export const PROBE_TABLES: Record<MigrationTarget, string> = {
  app: "domains",
  logs: "ops_log",
  mail: "mailbox_messages",
};

export const MIGRATION_TARGETS: MigrationTarget[] = ["app", "logs", "mail"];

const BINDING_MAP: Record<MigrationTarget, string> = {
  app: "RELAYBASE_DB",
  logs: "RELAYBASE_LOGS",
  mail: "RELAYBASE_MAIL",
};

export type DbMigrationResult = {
  target: MigrationTarget;
  binding: string;
  configured: boolean;
  alreadyInitialized: boolean;
  applied: string[];
  skipped: string[];
  error?: string;
};

export async function tableExists(
  db: D1Database,
  tableName: string,
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1`,
      )
      .bind(tableName)
      .first<{ ok: number }>();
    if (row) return true;
  } catch {
    /* fall through to a direct select */
  }
  try {
    await db.prepare(`SELECT 1 AS ok FROM "${tableName}" LIMIT 1`).first();
    return true;
  } catch {
    return false;
  }
}

function bindingFor(target: MigrationTarget): string {
  return BINDING_MAP[target];
}

function dbFor(env: Env, target: MigrationTarget): D1Database | undefined {
  return (env as Record<string, unknown>)[bindingFor(target)] as
    | D1Database
    | undefined;
}

/** Probe all three D1s before any write. True if any product schema table exists. */
export async function anyProbeTableExists(env: Env): Promise<{
  alreadyInitialized: boolean;
  results: Array<{ target: MigrationTarget; binding: string; present: boolean }>;
}> {
  const results: Array<{
    target: MigrationTarget;
    binding: string;
    present: boolean;
  }> = [];
  for (const target of MIGRATION_TARGETS) {
    const binding = bindingFor(target);
    const db = dbFor(env, target);
    if (!db) {
      results.push({ target, binding, present: false });
      continue;
    }
    results.push({
      target,
      binding,
      present: await tableExists(db, PROBE_TABLES[target]),
    });
  }
  return {
    alreadyInitialized: results.some((r) => r.present),
    results,
  };
}

async function listAppliedMigrations(db: D1Database): Promise<Set<string>> {
  try {
    const rows = await db
      .prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY name`)
      .all<{ name: string }>();
    return new Set(
      (rows.results ?? [])
        .map((r) => normalizeMigrationName(r.name))
        .filter((n) => n.length > 0),
    );
  } catch {
    return new Set();
  }
}

async function stampMigration(db: D1Database, name: string): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`,
    )
    .bind(normalizeMigrationName(name))
    .run();
}

async function applyPendingForTarget(
  env: Env,
  target: MigrationTarget,
): Promise<DbMigrationResult> {
  const binding = bindingFor(target);
  const db = dbFor(env, target);

  if (!db) {
    return {
      target,
      binding,
      configured: false,
      alreadyInitialized: false,
      applied: [],
      skipped: [],
      error: `D1 binding ${binding} is not configured`,
    };
  }

  try {
    const alreadyInitialized = await tableExists(db, PROBE_TABLES[target]);

    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`,
      )
      .run();

    const appliedSet = await listAppliedMigrations(db);
    const targetMigrations = MIGRATIONS.filter((m) => m.target === target);
    const applied: string[] = [];
    const skipped: string[] = [];

    for (const [index, migration] of targetMigrations.entries()) {
      const name = normalizeMigrationName(migration.name);
      if (appliedSet.has(name)) {
        skipped.push(name);
        continue;
      }

      // Schema exists (probe table) but the ledger missed the baseline file
      // (older init-db, wrangler name mismatch, empty d1_migrations). Do not
      // re-run CREATE TABLE — stamp and continue to later pending files.
      const isBaseline = index === 0;
      if (alreadyInitialized && isBaseline) {
        await stampMigration(db, name);
        appliedSet.add(name);
        skipped.push(name);
        continue;
      }

      try {
        const statements = splitMigrationSql(migration.sql);
        for (const stmt of statements) {
          try {
            const result = await db.prepare(stmt).run();
            const resultError =
              result &&
              typeof result === "object" &&
              "error" in result &&
              result.error
                ? String(result.error)
                : "";
            if (resultError && !isSchemaAlreadyPresentError(resultError)) {
              throw new Error(resultError);
            }
          } catch (error) {
            const message = d1ErrorText(error);
            if (!isSchemaAlreadyPresentError(message)) {
              throw error;
            }
          }
        }
        await stampMigration(db, name);
        appliedSet.add(name);
        applied.push(name);
      } catch (error) {
        const message = d1ErrorText(error);
        if (isSchemaAlreadyPresentError(message)) {
          await stampMigration(db, name);
          appliedSet.add(name);
          skipped.push(name);
          continue;
        }
        throw error;
      }
    }

    return {
      target,
      binding,
      configured: true,
      alreadyInitialized,
      applied,
      skipped,
    };
  } catch (error) {
    const message = d1ErrorText(error);
    return {
      target,
      binding,
      configured: true,
      alreadyInitialized: false,
      applied: [],
      skipped: [],
      error: message,
    };
  }
}

/** Apply only pending migrations. Never drops tables. */
export async function applyPendingMigrations(env: Env): Promise<{
  alreadyInitialized: boolean;
  applied: string[];
  skipped: string[];
  results: DbMigrationResult[];
  errors: string[];
}> {
  const results: DbMigrationResult[] = [];
  for (const target of MIGRATION_TARGETS) {
    results.push(await applyPendingForTarget(env, target));
  }
  return {
    alreadyInitialized: results.some((r) => r.alreadyInitialized),
    applied: results.flatMap((r) => r.applied),
    skipped: results.flatMap((r) => r.skipped),
    results,
    errors: results
      .filter((r) => r.error)
      .map((r) => `${r.binding}: ${r.error}`),
  };
}
