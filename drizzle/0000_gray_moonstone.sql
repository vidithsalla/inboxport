CREATE TABLE `relay_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_subject_hash` text NOT NULL,
	`encrypted_address` text NOT NULL,
	`credential_envelope` text,
	`scopes` text NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'connected' NOT NULL,
	`health` text DEFAULT 'healthy' NOT NULL,
	`history_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`disconnected_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_accounts_user_provider_subject_unique` ON `relay_accounts` (`user_id`,`provider`,`provider_subject_hash`);--> statement-breakpoint
CREATE INDEX `relay_accounts_user_state_idx` ON `relay_accounts` (`user_id`,`state`);--> statement-breakpoint
CREATE TABLE `relay_audit_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`account_id` text,
	`operation` text NOT NULL,
	`decision` text NOT NULL,
	`reason_code` text NOT NULL,
	`policy_version` integer NOT NULL,
	`request_id` text NOT NULL,
	`result_count` integer,
	`provider_result_class` text
);
--> statement-breakpoint
CREATE INDEX `relay_audit_user_time_idx` ON `relay_audit_events` (`user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `relay_audit_account_time_idx` ON `relay_audit_events` (`account_id`,`occurred_at`);