export type SendLogEntry = {
  id: string;
  at: string;
  ok: boolean;
  status: number;
  domain: string | null;
  keyId: string | null;
  keyPrefix: string | null;
  keyLabel: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  messageId?: string;
  error?: string;
};

export type SendLogSummary = {
  total: number;
  failed: number;
  failedLast24h: number;
};

const MAX_LOGS = 500;
const SENDLOG_PREFIX = "sent/_sendlog/";

function logKey(id: string): string {
  return `${SENDLOG_PREFIX}${id}.json`;
}

const JSON_META = { httpMetadata: { contentType: "application/json" } };

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  try {
    return JSON.parse(await object.text()) as T;
  } catch {
    return null;
  }
}

/** True when a key looks like a send-log JSON object (not the old array index). */
function isSendLogKey(key: string): boolean {
  return (
    key.startsWith(SENDLOG_PREFIX) &&
    key.endsWith(".json") &&
    key !== `${SENDLOG_PREFIX}_index.json`
  );
}

function idFromKey(key: string): string {
  const base = key.slice(SENDLOG_PREFIX.length).replace(/\.json$/, "");
  return base;
}

export async function recordSendLog(
  bucket: R2Bucket,
  entry: Omit<SendLogEntry, "id" | "at"> & { id?: string; at?: string },
): Promise<SendLogEntry> {
  const id = entry.id ?? crypto.randomUUID();
  const at = entry.at ?? new Date().toISOString();
  const record: SendLogEntry = { ...entry, id, at };

  await bucket.put(logKey(id), JSON.stringify(record), JSON_META);
  return record;
}

function matchesFilters(
  log: SendLogEntry,
  filters: { status?: "all" | "failed" | "success"; domain?: string },
): boolean {
  if (filters.status === "failed" && log.ok) return false;
  if (filters.status === "success" && !log.ok) return false;
  if (filters.domain) {
    const needle = filters.domain.trim().toLowerCase();
    if (!needle) return true;
    if (!log.domain?.toLowerCase().includes(needle)) return false;
  }
  return true;
}

function summarize(logs: SendLogEntry[]): SendLogSummary {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let failed = 0;
  let failedLast24h = 0;

  for (const log of logs) {
    if (log.ok) continue;
    failed += 1;
    if (new Date(log.at).getTime() >= cutoff) {
      failedLast24h += 1;
    }
  }

  return { total: logs.length, failed, failedLast24h };
}

/**
 * List send logs by listing `sent/_sendlog/*.json` in R2 (newest first by
 * object listing order is not guaranteed, so we sort by `at` after load).
 * No `_index.json` array is maintained. Caps at MAX_LOGS objects listed.
 */
export async function listSendLogs(
  bucket: R2Bucket,
  filters: {
    limit?: number;
    status?: "all" | "failed" | "success";
    domain?: string;
  } = {},
): Promise<{ logs: SendLogEntry[]; summary: SendLogSummary }> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), MAX_LOGS);

  const listed: SendLogEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix: SENDLOG_PREFIX,
      limit: 1000,
      cursor,
    });
    for (const object of page.objects) {
      if (!isSendLogKey(object.key)) continue;
      const id = idFromKey(object.key);
      const log = await readJson<SendLogEntry>(bucket, object.key);
      if (!log) continue;
      // Keep `id` consistent with the key (legacy entries stored their own).
      if (!log.id) log.id = id;
      listed.push(log);
    }
    cursor = page.truncated ? page.cursor : undefined;
    if (listed.length >= MAX_LOGS) break;
  } while (cursor);

  listed.sort((a, b) => b.at.localeCompare(a.at));

  const filtered = listed.filter((log) => matchesFilters(log, filters));
  const logs = filtered.slice(0, limit);
  return { logs, summary: summarize(listed) };
}
