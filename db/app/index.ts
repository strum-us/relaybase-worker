import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import * as schema from "./schema";

export type AppDb = ReturnType<typeof createAppDb>;

/** Build a Drizzle client bound to `RELAYBASE_DB`. `undefined` → null. */
export function createAppDb(db: D1Database | undefined) {
  if (!db) return null;
  return drizzle(db, { schema });
}

export * from "./schema";
