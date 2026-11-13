CREATE TABLE `relay_account_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`account_id` text NOT NULL,
	`permissions` text NOT NULL,
	`constraints` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_account_grants_installation_account_unique` ON `relay_account_grants` (`installation_id`,`account_id`);--> statement-breakpoint
CREATE INDEX `relay_account_grants_account_idx` ON `relay_account_grants` (`account_id`);--> statement-breakpoint
CREATE TABLE `relay_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`client_id` text NOT NULL,
	`client_name` text,
	`revoked` integer DEFAULT false NOT NULL,
	`revocation_epoch` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_seen_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_installations_user_client_unique` ON `relay_installations` (`user_id`,`client_id`);--> statement-breakpoint
CREATE INDEX `relay_installations_user_idx` ON `relay_installations` (`user_id`);