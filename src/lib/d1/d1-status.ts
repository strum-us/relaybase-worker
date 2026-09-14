import type { D1Database } from "@cloudflare/workers-types";

export const D1_LOGS_DATABASE_NAME = "relaybase-logs";
export const D1_MAIL_DATABASE_NAME = "relaybase-mail";
export const D1_APP_DATABASE_NAME = "relaybase-db";
export const D1_LOGS_BINDING = "RELAYBASE_LOGS";
export const D1_MAIL_BINDING = "RELAYBASE_MAIL";
export const D1_APP_BINDING = "RELAYBASE_DB";

/** Cloudflare D1 per-database size cap on Workers Paid (display only). */
export const D1_DATABASE_SIZE_LIMIT_BYTES = 10 * 1024 ** 3;

const LOGS_TABLE = "ops_log";
const MAIL_TABLE = "mailbox_messages";
const APP_TABLE = "domains";

export type D1BindingStatus = {
  configured: boolean;
  databaseName: string;
  binding: string;
  sizeBytes: number | null;
};

export type D1ConnectionStatus = {
  logs: D1BindingStatus;
  mail: D1BindingStatus;
  app: D1BindingStatus;
};

async function tableReady(
  db: D1Database | undefined,
  tableName: string,
): Promise<boolean> {
  if (!db) return false;
  try {
    await db.prepare(`SELECT 1 AS ok FROM ${tableName} LIMIT 1`).first();
    return true;
  } catch (error) {
    console.error(`D1 table check failed (${tableName})`, error);
    return false;
  }
}

async function databaseSizeBytes(db: D1Database | undefined): Promise<number | null> {
  if (!db) return null;
  const queries = [
    `SELECT
      (SELECT * FROM pragma_page_count()) *
      (SELECT * FROM pragma_page_size()) AS size_bytes`,
    `SELECT page_count * page_size AS size_bytes
     FROM pragma_page_count(), pragma_page_size()`,
  ];
  for (const sql of queries) {
    try {
      const row = await db.prepare(sql).first<{ size_bytes: number }>();
      const size = row?.size_bytes;
      if (typeof size === "number" && Number.isFinite(size) && size >= 0) {
        return size;
      }
    } catch {
      // try next query shape
    }
  }
  return null;
}

async function databaseSizeFromCfApi(
  accountId: string | undefined,
  apiToken: string | undefined,
  databaseName: string,
): Promise<number | null> {
  const id = accountId?.trim();
  const token = apiToken?.trim();
  if (!id || !token) return null;
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: { name?: string; file_size?: number }[];
    };
    const match = json.result?.find((entry) => entry.name === databaseName);
    const size = match?.file_size;
    return typeof size === "number" && Number.isFinite(size) && size >= 0
      ? size
      : null;
  } catch (error) {
    console.error("D1 Cloudflare API size lookup failed", error);
    return null;
  }
}

async function probeBinding(
  db: D1Database | undefined,
  tableName: string,
  databaseName: string,
  binding: string,
  cfAccountId?: string,
  cfApiToken?: string,
): Promise<D1BindingStatus> {
  if (!db) {
    return {
      configured: false,
      databaseName,
      binding,
      sizeBytes: null,
    };
  }
  const configured = await tableReady(db, tableName);
  if (!configured) {
    return { configured: false, databaseName, binding, sizeBytes: null };
  }
  let sizeBytes = await databaseSizeBytes(db);
  if (sizeBytes == null) {
    sizeBytes = await databaseSizeFromCfApi(cfAccountId, cfApiToken, databaseName);
  }
  return { configured: true, databaseName, binding, sizeBytes };
}

/** Binding present + expected table readable (migrations applied). */
export async function probeD1Connection(
  logs: D1Database | undefined,
  mail: D1Database | undefined,
  app: D1Database | undefined,
  cfAccountId?: string,
  cfApiToken?: string,
): Promise<D1ConnectionStatus> {
  const [logsStatus, mailStatus, appStatus] = await Promise.all([
    probeBinding(
      logs,
      LOGS_TABLE,
      D1_LOGS_DATABASE_NAME,
      D1_LOGS_BINDING,
      cfAccountId,
      cfApiToken,
    ),
    probeBinding(
      mail,
      MAIL_TABLE,
      D1_MAIL_DATABASE_NAME,
      D1_MAIL_BINDING,
      cfAccountId,
      cfApiToken,
    ),
    probeBinding(
      app,
      APP_TABLE,
      D1_APP_DATABASE_NAME,
      D1_APP_BINDING,
      cfAccountId,
      cfApiToken,
    ),
  ]);
  return {
    logs: logsStatus,
    mail: mailStatus,
    app: appStatus,
  };
}
