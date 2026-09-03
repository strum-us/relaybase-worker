import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import type { LogsDb } from "./index";
import { opsLog } from "./schema";

export type OpsLogKind = "send" | "bounce" | "api_error";
export type OpsLogSource =
  | "compose"
  | "api"
  | "broadcast"
  | "inbound"
  | "mobile";

export type OpsLogEntry = {
  id: string;
  at: string;
  kind: OpsLogKind;
  ok: boolean;
  status: number | null;
  source: OpsLogSource | null;
  domain: string | null;
  fromAddr: string | null;
  toAddr: string | null;
  subject: string | null;
  messageId: string | null;
  error: string | null;
  keyId: string | null;
  keyPrefix: string | null;
  metaJson: string | null;
};

export type OpsLogInput = Omit<
  OpsLogEntry,
  | "id"
  | "at"
  | "status"
  | "source"
  | "domain"
  | "fromAddr"
  | "toAddr"
  | "subject"
  | "messageId"
  | "error"
  | "keyId"
  | "keyPrefix"
  | "metaJson"
> & {
  id?: string;
  at?: string;
  status?: number | null;
  source?: OpsLogSource | null;
  domain?: string | null;
  fromAddr?: string | null;
  toAddr?: string | null;
  subject?: string | null;
  messageId?: string | null;
  error?: string | null;
  keyId?: string | null;
  keyPrefix?: string | null;
  metaJson?: string | null;
};

export type OpsLogListResult = {
  logs: OpsLogEntry[];
  summary: {
    total: number;
    failed: number;
    failedLast24h: number;
  };
};

function rowToEntry(row: typeof opsLog.$inferSelect): OpsLogEntry {
  return {
    id: row.id,
    at: row.at,
    kind: row.kind as OpsLogKind,
    ok: row.ok === 1,
    status: row.status,
    source: (row.source as OpsLogSource | null) ?? null,
    domain: row.domain,
    fromAddr: row.fromAddr,
    toAddr: row.toAddr,
    subject: row.subject,
    messageId: row.messageId,
    error: row.error,
    keyId: row.keyId,
    keyPrefix: row.keyPrefix,
    metaJson: row.metaJson,
  };
}

export async function recordOpsLog(
  db: LogsDb,
  input: OpsLogInput,
): Promise<OpsLogEntry | null> {
  if (!db) return null;
  const entry: OpsLogEntry = {
    id: input.id ?? crypto.randomUUID(),
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    ok: input.ok,
    status: input.status ?? null,
    source: input.source ?? null,
    domain: input.domain ?? null,
    fromAddr: input.fromAddr ?? null,
    toAddr: input.toAddr ?? null,
    subject: input.subject ?? null,
    messageId: input.messageId ?? null,
    error: input.error ?? null,
    keyId: input.keyId ?? null,
    keyPrefix: input.keyPrefix ?? null,
    metaJson: input.metaJson ?? null,
  };
  try {
    await db
      .insert(opsLog)
      .values({
        id: entry.id,
        at: entry.at,
        kind: entry.kind,
        ok: entry.ok ? 1 : 0,
        status: entry.status,
        source: entry.source,
        domain: entry.domain,
        fromAddr: entry.fromAddr,
        toAddr: entry.toAddr,
        subject: entry.subject,
        messageId: entry.messageId,
        error: entry.error,
        keyId: entry.keyId,
        keyPrefix: entry.keyPrefix,
        metaJson: entry.metaJson,
      })
      .run();
    return entry;
  } catch (error) {
    console.error("Failed to record ops log", error);
    return null;
  }
}

export async function listOpsLogs(
  db: LogsDb,
  filters: {
    limit?: number;
    status?: "all" | "failed" | "success";
    domain?: string;
    kind?: OpsLogKind | null;
  } = {},
): Promise<OpsLogListResult> {
  if (!db) {
    return { logs: [], summary: { total: 0, failed: 0, failedLast24h: 0 } };
  }
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const status = filters.status ?? "all";
  const domain = filters.domain?.trim().toLowerCase();
  const kind = filters.kind;

  const conditions = [];
  if (status === "failed") conditions.push(eq(opsLog.ok, 0));
  else if (status === "success") conditions.push(eq(opsLog.ok, 1));
  if (domain) conditions.push(eq(sql`LOWER(${opsLog.domain})`, domain));
  if (kind) conditions.push(eq(opsLog.kind, kind));

  const where = conditions.length ? and(...conditions) : undefined;
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  try {
    const [rows, summaryRows] = await Promise.all([
      db
        .select()
        .from(opsLog)
        .where(where)
        .orderBy(desc(opsLog.at))
        .limit(limit)
        .all(),
      db
        .select({
          total: count(),
          failed: sql<number>`SUM(CASE WHEN ${opsLog.ok} = 0 THEN 1 ELSE 0 END)`,
          failedLast24h: sql<number>`SUM(CASE WHEN ${opsLog.ok} = 0 AND ${opsLog.at} >= ${since24h} THEN 1 ELSE 0 END)`,
        })
        .from(opsLog)
        .all(),
    ]);

    const summary = summaryRows[0] ?? { total: 0, failed: 0, failedLast24h: 0 };
    return {
      logs: rows.map(rowToEntry),
      summary: {
        total: Number(summary.total) || 0,
        failed: Number(summary.failed) || 0,
        failedLast24h: Number(summary.failedLast24h) || 0,
      },
    };
  } catch (error) {
    console.error("Failed to list ops logs", error);
    return { logs: [], summary: { total: 0, failed: 0, failedLast24h: 0 } };
  }
}
