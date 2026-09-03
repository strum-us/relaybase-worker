import { drizzle } from "drizzle-orm/d1";
import type { D1Database } from "@cloudflare/workers-types";
import * as schema from "./schema";

export type MailDb = ReturnType<typeof createMailDb>;

/** Build a Drizzle client bound to `RELAYBASE_MAIL`. `undefined` → null. */
export function createMailDb(db: D1Database | undefined) {
  if (!db) return null;
  return drizzle(db, { schema });
}
