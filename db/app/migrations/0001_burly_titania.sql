CREATE TABLE `account_state` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_key` text NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_state_identity_ns_key_idx` ON `account_state` (`identity_key`,`namespace`,`key`);--> statement-breakpoint
CREATE INDEX `account_state_identity_idx` ON `account_state` (`identity_key`);--> statement-breakpoint
CREATE TABLE `draft_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_key` text NOT NULL,
	`draft_id` text NOT NULL,
	`attachment_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text,
	`size` integer NOT NULL,
	`r2_key` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draft_attachments_identity_draft_attach_idx` ON `draft_attachments` (`identity_key`,`draft_id`,`attachment_id`);--> statement-breakpoint
CREATE INDEX `draft_attachments_identity_draft_idx` ON `draft_attachments` (`identity_key`,`draft_id`);