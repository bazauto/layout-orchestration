CREATE TABLE `blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`name` text NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `grid_tiles` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`x` integer NOT NULL,
	`y` integer NOT NULL,
	`tile_type` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `layouts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `locos` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`name` text NOT NULL,
	`address` integer NOT NULL,
	`type` text DEFAULT 'unknown' NOT NULL,
	`max_speed` integer DEFAULT 126 NOT NULL,
	`braking_factor` real DEFAULT 0.5 NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `points` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`name` text NOT NULL,
	`dcc_address` integer NOT NULL,
	`block_id` text,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `sensors` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`block_id` text,
	`mqtt_topic` text NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE set null
);
