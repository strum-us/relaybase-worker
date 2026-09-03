/** Shared catalog types for audience groups + broadcasts (Worker KV). */

export type AudienceDataSourceType = "generic_json";

export type AudienceDataSource = {
  type: AudienceDataSourceType;
  endpointUrl: string;
  credential?: string;
  credentialHeader?: string;
};

export type AudienceDataSourcePatch = {
  type?: AudienceDataSourceType;
  endpointUrl: string;
  credential?: string;
  credentialHeader?: string;
};

export type AudienceSyncPhase =
  | "idle"
  | "fetching"
  | "parsing"
  | "writing"
  | "done";

export type AudienceSyncRunStatus = "running" | "success" | "error";

export type AudienceSyncRun = {
  id: string;
  trigger: "manual" | "cron";
  status: AudienceSyncRunStatus;
  phase: AudienceSyncPhase;
  startedAt: string;
  finishedAt?: string;
  totalCount?: number;
  processedCount?: number;
  skippedCount?: number;
  successCount?: number;
  failedCount?: number;
  error?: string;
  estimatedRemainingMs?: number;
};

export type AudienceGroup = {
  id: string;
  name: string;
  domain: string;
  createdAt: string;
  defaultFrom?: string;
  dataSource?: AudienceDataSource;
  cronEnabled?: boolean;
  cronIntervalMinutes?: number;
  lastSyncAt?: string;
  lastSyncStatus?: "success" | "error";
  lastSyncError?: string;
  lastSyncCount?: number;
  syncProgress?: AudienceSyncRun;
  syncHistory?: AudienceSyncRun[];
};

export type AudienceContact = {
  id: string;
  email: string;
  name?: string;
  domain: string;
  groupId: string;
  source: "manual" | "synced";
  addedAt: string;
};

export type AudienceGroupSummary = AudienceGroup & { contactCount: number };

export type BroadcastSendPhase = "preparing" | "sending" | "done";
export type BroadcastSendRunStatus = "running" | "success" | "error";

export type BroadcastSendRun = {
  id: string;
  status: BroadcastSendRunStatus;
  phase: BroadcastSendPhase;
  startedAt: string;
  finishedAt?: string;
  totalCount?: number;
  processedCount?: number;
  successCount?: number;
  failedCount?: number;
  error?: string;
  estimatedRemainingMs?: number;
};

export type Broadcast = {
  id: string;
  subject: string;
  /** draft | sending | sent | failed */
  status: string;
  createdAt: string;
  domain: string;
  groupIds: string[];
  from?: string;
  body?: string;
  recipientCount?: number;
  sentAt?: string;
  sendProgress?: BroadcastSendRun;
  sendHistory?: BroadcastSendRun[];
};
