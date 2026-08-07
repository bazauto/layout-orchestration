CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unq` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'operator' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "users_role_valid" CHECK("users"."role" IN ('admin', 'operator')),
	CONSTRAINT "users_username_non_empty" CHECK(length(trim("users"."username")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unq` ON `users` (`username`);