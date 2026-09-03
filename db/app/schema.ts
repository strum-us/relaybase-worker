/**
 * `relaybase-db` schema — durable product state (D1 `RELAYBASE_DB`).
 * Generated into `db/app/migrations/` by drizzle-kit.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// ─── mailbox ────────────────────────────────────────────────────────────

export const domains = sqliteTable("domains", {
  id: text("id").primaryKey(),
  domain: text("domain").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const addresses = sqliteTable(
  "addresses",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    domain: text("domain").notNull().references(() => domains.id, {
      onDelete: "cascade",
    }),
    displayName: text("display_name"),
    signature: text("signature"),
    inboundEnabled: integer("inbound_enabled").notNull().default(1),
    mobileEnabled: integer("mobile_enabled").notNull().default(1),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("addresses_domain_idx").on(t.domain)],
);

// ─── audience ────────────────────────────────────────────────────────────

export const audienceGroups = sqliteTable(
  "audience_groups",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    createdAt: text("created_at").notNull(),
    defaultFrom: text("default_from"),
    dataSourceJson: text("data_source_json"),
    cronEnabled: integer("cron_enabled").notNull().default(0),
    cronIntervalMinutes: integer("cron_interval_minutes"),
    lastSyncAt: text("last_sync_at"),
    lastSyncStatus: text("last_sync_status"),
    lastSyncError: text("last_sync_error"),
    lastSyncCount: integer("last_sync_count"),
    syncProgressJson: text("sync_progress_json"),
    syncHistoryJson: text("sync_history_json"),
  },
  (t) => [index("audience_groups_domain_idx").on(t.domain)],
);

export const audienceContacts = sqliteTable(
  "audience_contacts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name"),
    domain: text("domain").notNull(),
    groupId: text("group_id").notNull().references(() => audienceGroups.id, {
      onDelete: "cascade",
    }),
    source: text("source").notNull(),
    addedAt: text("added_at").notNull(),
  },
  (t) => [
    uniqueIndex("audience_contacts_group_email_idx").on(t.groupId, t.email),
    index("audience_contacts_group_idx").on(t.groupId),
    index("audience_contacts_domain_idx").on(t.domain),
  ],
);

// ─── broadcasts ──────────────────────────────────────────────────────────

export const broadcasts = sqliteTable(
  "broadcasts",
  {
    id: text("id").primaryKey(),
    subject: text("subject").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    domain: text("domain").notNull(),
    groupIdsJson: text("group_ids_json").notNull(),
    fromAddr: text("from_addr"),
    body: text("body"),
    recipientCount: integer("recipient_count"),
    sentAt: text("sent_at"),
    sendProgressJson: text("send_progress_json"),
    sendHistoryJson: text("send_history_json"),
  },
  (t) => [
    index("broadcasts_domain_idx").on(t.domain),
    index("broadcasts_status_idx").on(t.status),
    index("broadcasts_created_at_idx").on(t.createdAt),
  ],
);

// ─── branding ─────────────────────────────────────────────────────────────

export const domainBranding = sqliteTable("domain_branding", {
  domain: text("domain").primaryKey(),
  dmarcPolicy: text("dmarc_policy").notNull().default("quarantine"),
  dmarcRua: text("dmarc_rua").notNull(),
});

// ─── keys ─────────────────────────────────────────────────────────────────

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    keyHash: text("key_hash").notNull().unique(),
    domain: text("domain").notNull(),
    label: text("label"),
    keyPrefix: text("key_prefix").notNull(),
    createdAt: text("created_at").notNull(),
    active: integer("active").notNull().default(1),
  },
  (t) => [
    index("api_keys_domain_idx").on(t.domain),
    index("api_keys_active_idx").on(t.active),
  ],
);

// ─── mobile passwords ────────────────────────────────────────────────────

export const mobilePasswords = sqliteTable("mobile_passwords", {
  email: text("email").primaryKey(),
  passwordHash: text("password_hash").notNull(),
  salt: text("salt").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// ─── webhooks ────────────────────────────────────────────────────────────

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    url: text("url").notNull(),
    secretHash: text("secret_hash").notNull(),
    createdAt: text("created_at").notNull(),
    active: integer("active").notNull().default(1),
  },
  (t) => [
    index("webhooks_domain_idx").on(t.domain),
    index("webhooks_active_idx").on(t.active),
  ],
);

export const webhookSecrets = sqliteTable("webhook_secrets", {
  webhookId: text("webhook_id")
    .primaryKey()
    .references(() => webhooks.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
});

export const webhookFails = sqliteTable(
  "webhook_fails",
  {
    id: text("id").primaryKey(),
    webhookId: text("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    url: text("url").notNull(),
    failedAt: text("failed_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    index("webhook_fails_webhook_idx").on(t.webhookId),
    index("webhook_fails_expires_idx").on(t.expiresAt),
  ],
);

// ─── app settings (singleton — product options, not owner identity) ──────

export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey(),
  /** NULL = unlimited inbound per domain. Positive = keep newest N inbound. */
  inboundRetainPerDomain: integer("inbound_retain_per_domain"),
  updatedAt: text("updated_at").notNull(),
});

// ─── owner config (singleton) ────────────────────────────────────────────

export const ownerConfig = sqliteTable("owner_config", {
  id: integer("id").primaryKey(),
  ownerEmail: text("owner_email"),
  workerUrl: text("worker_url"),
  /** Salt for the passtoken hash. */
  passtokenSalt: text("passtoken_salt"),
  /** sha256(pepper || salt || passtoken). Plaintext is shown once at issue. */
  passtokenHash: text("passtoken_hash"),
  passtokenPrefix: text("passtoken_prefix"),
  passtokenUpdatedAt: text("passtoken_updated_at"),
  /** Cloudflare account id for forgot-passtoken recover (public hint). */
  cfAccountId: text("cf_account_id"),
});

// ─── owner sessions (refresh tokens, hash-only) ──────────────────────────

export const ownerSessions = sqliteTable(
  "owner_sessions",
  {
    id: text("id").primaryKey(),
    /** sha256(refresh). Plaintext lives only in the OS keyring. */
    tokenHash: text("token_hash").notNull().unique(),
    /** Groups access+refresh issued by one login; reuse of a revoked refresh
     *  revokes the whole family. */
    family: text("family").notNull(),
    label: text("label"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [index("owner_sessions_family_idx").on(t.family)],
);

// ─── inbound events (KV TTL queue replacement) ───────────────────────────

export const inboundEvents = sqliteTable(
  "inbound_events",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    eventType: text("event_type").notNull(),
    createdAt: text("created_at").notNull(),
    payloadJson: text("payload_json").notNull(),
    expiresAt: text("expires_at").notNull(),
  },
  (t) => [
    index("inbound_events_domain_idx").on(t.domain),
    index("inbound_events_expires_idx").on(t.expiresAt),
  ],
);

// ─── re-exports for the client ────────────────────────────────────────────

export type DomainRow = typeof domains.$inferSelect;
export type AddressRow = typeof addresses.$inferSelect;
export type AudienceGroupRow = typeof audienceGroups.$inferSelect;
export type AudienceContactRow = typeof audienceContacts.$inferSelect;
export type BroadcastRow = typeof broadcasts.$inferSelect;
export type DomainBrandingRow = typeof domainBranding.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type MobilePasswordRow = typeof mobilePasswords.$inferSelect;
export type WebhookRow = typeof webhooks.$inferSelect;
export type WebhookSecretRow = typeof webhookSecrets.$inferSelect;
export type WebhookFailRow = typeof webhookFails.$inferSelect;
export type OwnerConfigRow = typeof ownerConfig.$inferSelect;
export type OwnerSessionRow = typeof ownerSessions.$inferSelect;
export type AppSettingsRow = typeof appSettings.$inferSelect;
export type InboundEventRow = typeof inboundEvents.$inferSelect;
