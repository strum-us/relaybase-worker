import type { D1Database } from "@cloudflare/workers-types";

export type OpsLogKind = "send" | "bounce" | "api_error" | "inbound";
export type OpsLogSource = "compose" | "api" | "broadcast" | "inbound" | "mobile";

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
  "id" | "at" | "status" | "source" | "domain" | "fromAddr" | "toAddr" | "subject" | "messageId" | "error" | "keyId" | "keyPrefix" | "metaJson"
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

function logId(): string {
  return crypto.randomUUID();
}

function logAt(): string {
  return new Date().toISOString();
}

export async function recordOpsLog(
  db: D1Database | undefined,
  input: OpsLogInput,
): Promise<OpsLogEntry | null> {
  if (!db) return null;

  const entry: OpsLogEntry = {
    id: input.id ?? logId(),
    at: input.at ?? logAt(),
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
      .prepare(
        `INSERT INTO ops_log (
          id, at, kind, ok, status, source, domain,
          from_addr, to_addr, subject, message_id, error,
          key_id, key_prefix, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        entry.id,
        entry.at,
        entry.kind,
        entry.ok ? 1 : 0,
        entry.status,
        entry.source,
        entry.domain,
        entry.fromAddr,
        entry.toAddr,
        entry.subject,
        entry.messageId,
        entry.error,
        entry.keyId,
        entry.keyPrefix,
        entry.metaJson,
      )
      .run();
    return entry;
  } catch (error) {
    console.error("Failed to record ops log", error);
    return null;
  }
}

export async function listOpsLogs(
  db: D1Database | undefined,
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

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (status === "failed") {
    conditions.push("ok = 0");
  } else if (status === "success") {
    conditions.push("ok = 1");
  }
  if (domain) {
    conditions.push("LOWER(domain) = ?");
    params.push(domain);
  }
  if (kind) {
    conditions.push("kind = ?");
    params.push(kind);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  try {
    const { results } = await db
      .prepare(
        `SELECT
          id, at, kind, ok, status, source, domain,
          from_addr AS fromAddr, to_addr AS toAddr, subject,
          message_id AS messageId, error, key_id AS keyId,
          key_prefix AS keyPrefix, meta_json AS metaJson
        FROM ops_log
        ${where}
        ORDER BY at DESC
        LIMIT ?`,
      )
      .bind(...params, limit)
      .all<OpsLogEntry>();

    const { results: summaryRows } = await db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN ok = 0 AND at >= ? THEN 1 ELSE 0 END) AS failedLast24h
        FROM ops_log`,
      )
      .bind(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .all<{ total: number; failed: number; failedLast24h: number }>();

    const summary = summaryRows?.[0] ?? {
      total: 0,
      failed: 0,
      failedLast24h: 0,
    };

    return {
      logs: results ?? [],
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
