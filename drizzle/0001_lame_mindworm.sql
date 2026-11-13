CREATE TABLE `relay_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`account_id` text NOT NULL,
	`operation` text NOT NULL,
	`window_id` integer NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `relay_rate_limits_cleanup_idx` ON `relay_rate_limits` (`window_id`);