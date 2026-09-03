import type { Env } from "../env";
import { createAppDb } from "../../db/app";
import { getOwnerLoginConfig } from "../../db/app/owner";
import { normalizeCfAccountId } from "./cf-account-id.ts";

/**
 * Pinned CF account for this Worker: env `CF_ACCOUNT_ID`, else D1
 * `owner_config.cf_account_id`. Does not guess from `GET /zones` — the
 * server token often sees zones on every account the user belongs to.
 */
export async function pinnedCfAccountId(env: Env): Promise<string> {
  const fromEnv = normalizeCfAccountId(env.CF_ACCOUNT_ID) ?? "";
  if (fromEnv) return fromEnv;
  const db = createAppDb(env.RELAYBASE_DB);
  if (!db) return "";
  const cfg = await getOwnerLoginConfig(db);
  return normalizeCfAccountId(cfg?.cfAccountId) ?? "";
}
