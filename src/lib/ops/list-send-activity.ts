import type { D1Database } from "@cloudflare/workers-types";

import type { SendLogEntry } from "../mail/send-logs";

export type SendActivityRow = {
  id: string;
  at: string;
  ok: boolean;
  domain: string | null;
  keyId: string | null;
  fromAddr: string | null;
  toAddr: string | null;
};

/** Dashboard send/API activity from D1 `ops_log` (single query, no R2 fan-out). */
export async function listSendActivitySince(
  db: D1Database | undefined,
  sinceIso: string,
  domain?: string | null,
  limit = 2500,
): Promise<SendActivityRow[]> {
  if (!db) return [];

  const capped = Math.min(Math.max(limit, 1), 5000);
  const conditions = ["at >= ?", "kind IN ('send', 'api_error')"];
  const params: (string | number)[] = [sinceIso];

  const domainNeedle = domain?.trim().toLowerCase();
  if (domainNeedle) {
    conditions.push("LOWER(domain) = ?");
    params.push(domainNeedle);
  }

  try {
    const { results } = await db
      .prepare(
        `SELECT
          id,
          at,
          ok,
          domain,
          key_id AS keyId,
          from_addr AS fromAddr,
          to_addr AS toAddr
        FROM ops_log
        WHERE ${conditions.join(" AND ")}
        ORDER BY at DESC
        LIMIT ?`,
      )
      .bind(...params, capped)
      .all<SendActivityRow>();

    return results ?? [];
  } catch (error) {
    console.error("Failed to list send activity from ops_log", error);
    return [];
  }
}

export function sendActivityToSendLogs(rows: SendActivityRow[]): SendLogEntry[] {
  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    ok: Boolean(row.ok),
    status: row.ok ? 200 : 500,
    domain: row.domain,
    keyId: row.keyId,
    keyPrefix: null,
    keyLabel: null,
    from: row.fromAddr,
    to: row.toAddr,
    subject: null,
  }));
}
