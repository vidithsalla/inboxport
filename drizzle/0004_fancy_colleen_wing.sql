CREATE TABLE `relay_sync_state` (
	`account_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`watch_expires_at` text,
	`last_notification_at` text,
	`last_reconciled_at` text,
	`health` text DEFAULT 'not_configured' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `relay_sync_state_watch_expiry_idx` ON `relay_sync_state` (`watch_expires_at`);--> statement-breakpoint
CREATE INDEX `relay_sync_state_user_idx` ON `relay_sync_state` (`user_id`);