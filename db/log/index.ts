import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import * as schema from "./schema";

export type LogsDb = ReturnType<typeof createLogsDb>;

/** Build a Drizzle client bound to `RELAYBASE_LOGS`. `undefined` → null db. */
export function createLogsDb(db: D1Database | undefined) {
  if (!db) return null;
  return drizzle(db, { schema });
}
