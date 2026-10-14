import type { Env } from "../../env";
import { listKeys } from "../auth/keys";
import { readMailbox } from "../catalog/catalog-store";
import { createAppDb } from "../../../db/app";
import {
  listSendActivitySince,
  sendActivityToSendLogs,
} from "./list-send-activity";
import { listSendLogs, type SendLogEntry } from "../mail/send-logs";
import {
  bucketIndex,
  createBuckets,
  incrementBucket,
  parseStatsRange,
  RANGE_MS,
  type StatsBucket,
  type StatsRange,
} from "./stats-buckets";

function isApiSend(log: SendLogEntry): boolean {
  return Boolean(log.keyId);
}

function sumBuckets(buckets: StatsBucket[]): number {
  return buckets.reduce((sum, b) => sum + b.value, 0);
}

export async function loadSendLogsForRange(
  env: Env,
  since: number,
  domain: string | null,
): Promise<SendLogEntry[]> {
  const sinceIso = new Date(since).toISOString();
  const fromD1 = await listSendActivitySince(
    env.RELAYBASE_LOGS,
    sinceIso,
    domain,
  );
  if (fromD1.length > 0) {
    return sendActivityToSendLogs(fromD1);
  }

  const { logs } = await listSendLogs(env.INBOUND, {
    limit: 500,
    domain: domain ?? undefined,
  });
  return logs.filter((log) => {
    const ts = new Date(log.at).getTime();
    return !Number.isNaN(ts) && ts >= since;
  });
}

export type ConsoleDashboardStats = {
  domain: string | null;
  range: StatsRange;
  workerConnected: true;
  totals: {
    domains: number;
    addresses: number;
    audience: number;
    subscribers: number;
    broadcasts: number;
    drafts: number;
    sent: number;
    apiKeys: number;
    apiKeysUsed: number;
    requests: number;
    errors: number;
    apiEmails: number;
  };
  series: {
    sent: StatsBucket[];
    apiKeysUsed: StatsBucket[];
    requests: StatsBucket[];
    errors: StatsBucket[];
    apiEmails: StatsBucket[];
  };
};

export async function buildConsoleDashboardStats(
  env: Env,
  rangeInput: string | undefined,
  domainInput: string | null | undefined,
): Promise<ConsoleDashboardStats> {
  const range = parseStatsRange(rangeInput);
  const domain = domainInput?.trim().toLowerCase() || null;
  const now = Date.now();
  const since = now - RANGE_MS[range];

  const [mailbox, sendLogs, keys] = await Promise.all([
    readMailbox(createAppDb(env.RELAYBASE_DB)),
    loadSendLogsForRange(env, since, domain),
    listKeys(createAppDb(env.RELAYBASE_DB)),
  ]);

  const addresses = domain
    ? mailbox.addresses.filter((a) => a.domain === domain)
    : mailbox.addresses;
  const domainKeys = domain ? keys.filter((k) => k.domain === domain) : keys;

  const sentBuckets = createBuckets(range, now);
  const requestBuckets = createBuckets(range, now);
  const errorBuckets = createBuckets(range, now);
  const apiEmailBuckets = createBuckets(range, now);
  const apiKeyBuckets = createBuckets(range, now);
  const keysUsedInRange = new Set<string>();
  const keysByBucket = new Map<number, Set<string>>();

  for (const log of sendLogs) {
    const ts = new Date(log.at).getTime();
    if (Number.isNaN(ts) || ts < since) continue;
    const index = bucketIndex(ts, range, now);
    incrementBucket(sentBuckets, index);
    incrementBucket(requestBuckets, index);
    if (!log.ok) incrementBucket(errorBuckets, index);
    if (isApiSend(log) && log.ok) incrementBucket(apiEmailBuckets, index);
    if (log.keyId) {
      keysUsedInRange.add(log.keyId);
      if (index !== null) {
        const set = keysByBucket.get(index) ?? new Set<string>();
        set.add(log.keyId);
        keysByBucket.set(index, set);
      }
    }
  }

  for (const [index, used] of keysByBucket) {
    if (index >= 0 && index < apiKeyBuckets.length) {
      apiKeyBuckets[index].value = used.size;
    }
  }

  return {
    domain,
    range,
    workerConnected: true,
    totals: {
      domains: domain ? 1 : mailbox.domains.length,
      addresses: addresses.length,
      /** Audience + broadcasts live in HQ Studio, not Worker D1. */
      audience: 0,
      subscribers: 0,
      broadcasts: 0,
      drafts: 0,
      sent: sumBuckets(sentBuckets),
      apiKeys: domainKeys.length,
      apiKeysUsed: keysUsedInRange.size,
      requests: sumBuckets(requestBuckets),
      errors: sumBuckets(errorBuckets),
      apiEmails: sumBuckets(apiEmailBuckets),
    },
    series: {
      sent: sentBuckets,
      apiKeysUsed: apiKeyBuckets,
      requests: requestBuckets,
      errors: errorBuckets,
      apiEmails: apiEmailBuckets,
    },
  };
}
