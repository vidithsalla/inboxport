CREATE TABLE `relay_approval_envelopes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`installation_id` text NOT NULL,
	`account_id` text NOT NULL,
	`provider_draft_id` text NOT NULL,
	`payload_hash` text NOT NULL,
	`encrypted_envelope` text NOT NULL,
	`state` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `relay_approval_envelopes_user_state_idx` ON `relay_approval_envelopes` (`user_id`,`state`);--> statement-breakpoint
CREATE INDEX `relay_approval_envelopes_expiry_idx` ON `relay_approval_envelopes` (`expires_at`);