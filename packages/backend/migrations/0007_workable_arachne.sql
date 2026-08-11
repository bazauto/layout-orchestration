CREATE TABLE `block_ends` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`block_id` text NOT NULL,
	`label` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "block_ends_label_non_empty" CHECK(length(trim("block_ends"."label")) > 0)
);
--> statement-breakpoint
CREATE INDEX `block_ends_layout_idx` ON `block_ends` (`layout_id`);--> statement-breakpoint
CREATE INDEX `block_ends_block_idx` ON `block_ends` (`block_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `block_ends_block_label_unq` ON `block_ends` (`block_id`,`label`);