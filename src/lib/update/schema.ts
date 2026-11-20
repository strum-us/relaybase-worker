import type { Env } from "../../env";
import { ensureGrantTables } from "../grant/cf-grant";

/**
 * Tables the updater owns, in RELAYBASE_DB. Created here rather than by a
 * migration, because the updater is what applies migrations. Columns may be
 * added but never renamed: an older Worker reads these rows after a rollback.
 */
const BOOTSTRAP = [
  "CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS update_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    from_version TEXT NOT NULL,
    to_version TEXT NOT NULL,
    step TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    error_code TEXT,
    state TEXT NOT NULL DEFAULT '{}',
    lease_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  )`,
  "CREATE INDEX IF NOT EXISTS idx_update_jobs_created ON update_jobs(created_at)",
];

let bootstrapped = false;

export function updateDb(env: Env): D1Database {
  if (!env.RELAYBASE_DB) throw new Error("This Relaybase Worker has no RELAYBASE_DB binding.");
  return env.RELAYBASE_DB;
}

export async function ensureUpdateTables(env: Env): Promise<void> {
  if (bootstrapped) return;
  const db = updateDb(env);
  await db.batch(BOOTSTRAP.map((sql) => db.prepare(sql)));
  await ensureGrantTables(env);
  bootstrapped = true;
}

export async function getMeta(env: Env, key: string): Promise<string | null> {
  try {
    const row = await updateDb(env).prepare("SELECT value FROM app_meta WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await updateDb(env)
    .prepare("INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}
