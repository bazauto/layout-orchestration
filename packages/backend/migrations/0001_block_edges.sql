CREATE TABLE `block_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`from_block_id` text NOT NULL,
	`from_end` text NOT NULL,
	`to_block_id` text NOT NULL,
	`to_end` text NOT NULL,
	`point_conditions` text DEFAULT '[]' NOT NULL,
	`length_mm` integer,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `block_edges_layout_idx` ON `block_edges` (`layout_id`);--> statement-breakpoint
CREATE INDEX `block_edges_from_block_idx` ON `block_edges` (`from_block_id`);--> statement-breakpoint
CREATE INDEX `block_edges_to_block_idx` ON `block_edges` (`to_block_id`);