PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_block_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`from_block_id` text NOT NULL,
	`from_end` text NOT NULL,
	`to_block_id` text NOT NULL,
	`to_end` text NOT NULL,
	`point_conditions` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "block_edges_not_self_loop" CHECK("__new_block_edges"."from_block_id" <> "__new_block_edges"."to_block_id"),
	CONSTRAINT "block_edges_ends_non_empty" CHECK(length(trim("__new_block_edges"."from_end")) > 0 AND length(trim("__new_block_edges"."to_end")) > 0)
);
--> statement-breakpoint
INSERT INTO `__new_block_edges`("id", "layout_id", "from_block_id", "from_end", "to_block_id", "to_end", "point_conditions") SELECT "id", "layout_id", "from_block_id", "from_end", "to_block_id", "to_end", "point_conditions" FROM `block_edges`;--> statement-breakpoint
DROP TABLE `block_edges`;--> statement-breakpoint
ALTER TABLE `__new_block_edges` RENAME TO `block_edges`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `block_edges_layout_idx` ON `block_edges` (`layout_id`);--> statement-breakpoint
CREATE INDEX `block_edges_from_block_idx` ON `block_edges` (`from_block_id`);--> statement-breakpoint
CREATE INDEX `block_edges_to_block_idx` ON `block_edges` (`to_block_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `block_edges_connection_unq` ON `block_edges` (`layout_id`,`from_block_id`,`from_end`,`to_block_id`,`to_end`);--> statement-breakpoint
ALTER TABLE `blocks` ADD `length_mm` integer;