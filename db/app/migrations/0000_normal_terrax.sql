CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_domain_unique` ON `domains` (`domain`);
--> statement-breakpoint
CREATE TABLE `addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`domain` text NOT NULL,
	`display_name` text,
	`signature` text,
	`inbound_enabled` integer DEFAULT 1 NOT NULL,
	`mobile_enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`domain`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `addresses_email_unique` ON `addresses` (`email`);
--> statement-breakpoint
CREATE INDEX `addresses_domain_idx` ON `addresses` (`domain`);
--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`key_hash` text NOT NULL,
	`domain` text NOT NULL,
	`label` text,
	`key_prefix` text NOT NULL,
	`created_at` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);
--> statement-breakpoint
CREATE INDEX `api_keys_domain_idx` ON `api_keys` (`domain`);
--> statement-breakpoint
CREATE INDEX `api_keys_active_idx` ON `api_keys` (`active`);
--> statement-breakpoint
CREATE TABLE `app_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`inbound_retain_per_domain` integer,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audience_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`domain` text NOT NULL,
	`created_at` text NOT NULL,
	`default_from` text,
	`data_source_json` text,
	`cron_enabled` integer DEFAULT 0 NOT NULL,
	`cron_interval_minutes` integer,
	`last_sync_at` text,
	`last_sync_status` text,
	`last_sync_error` text,
	`last_sync_count` integer,
	`sync_progress_json` text,
	`sync_history_json` text
);
--> statement-breakpoint
CREATE INDEX `audience_groups_domain_idx` ON `audience_groups` (`domain`);
--> statement-breakpoint
CREATE TABLE `audience_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text,
	`domain` text NOT NULL,
	`group_id` text NOT NULL,
	`source` text NOT NULL,
	`added_at` text NOT NULL,
	FOREIGN KEY (`group_id`) REFERENCES `audience_groups`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audience_contacts_group_email_idx` ON `audience_contacts` (`group_id`,`email`);
--> statement-breakpoint
CREATE INDEX `audience_contacts_group_idx` ON `audience_contacts` (`group_id`);
--> statement-breakpoint
CREATE INDEX `audience_contacts_domain_idx` ON `audience_contacts` (`domain`);
--> statement-breakpoint
CREATE TABLE `broadcasts` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`domain` text NOT NULL,
	`group_ids_json` text NOT NULL,
	`from_addr` text,
	`body` text,
	`recipient_count` integer,
	`sent_at` text,
	`send_progress_json` text,
	`send_history_json` text
);
--> statement-breakpoint
CREATE INDEX `broadcasts_domain_idx` ON `broadcasts` (`domain`);
--> statement-breakpoint
CREATE INDEX `broadcasts_status_idx` ON `broadcasts` (`status`);
--> statement-breakpoint
CREATE INDEX `broadcasts_created_at_idx` ON `broadcasts` (`created_at`);
--> statement-breakpoint
CREATE TABLE `domain_branding` (
	`domain` text PRIMARY KEY NOT NULL,
	`dmarc_policy` text DEFAULT 'quarantine' NOT NULL,
	`dmarc_rua` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `inbound_events` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`event_type` text NOT NULL,
	`created_at` text NOT NULL,
	`payload_json` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `inbound_events_domain_idx` ON `inbound_events` (`domain`);
--> statement-breakpoint
CREATE INDEX `inbound_events_expires_idx` ON `inbound_events` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `mobile_passwords` (
	`email` text PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`salt` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `owner_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`owner_email` text,
	`worker_url` text,
	`passtoken_salt` text,
	`passtoken_hash` text,
	`passtoken_prefix` text,
	`passtoken_updated_at` text,
	`cf_account_id` text
);
--> statement-breakpoint
CREATE TABLE `owner_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`family` text NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `owner_sessions_token_hash_unique` ON `owner_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `owner_sessions_family_idx` ON `owner_sessions` (`family`);
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`domain` text NOT NULL,
	`url` text NOT NULL,
	`secret_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`active` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhooks_domain_idx` ON `webhooks` (`domain`);
--> statement-breakpoint
CREATE INDEX `webhooks_active_idx` ON `webhooks` (`active`);
--> statement-breakpoint
CREATE TABLE `webhook_fails` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event_id` text NOT NULL,
	`url` text NOT NULL,
	`failed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_fails_webhook_idx` ON `webhook_fails` (`webhook_id`);
--> statement-breakpoint
CREATE INDEX `webhook_fails_expires_idx` ON `webhook_fails` (`expires_at`);
--> statement-breakpoint
CREATE TABLE `webhook_secrets` (
	`webhook_id` text PRIMARY KEY NOT NULL,
	`secret` text NOT NULL,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
