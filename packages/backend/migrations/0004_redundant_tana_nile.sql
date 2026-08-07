CREATE TABLE `route_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`layout_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`required_position` text,
	`release_after_index` integer NOT NULL,
	`released` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`route_id`) REFERENCES `route_reservations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "route_holds_kind_valid" CHECK("route_holds"."kind" IN ('block', 'point', 'edge')),
	CONSTRAINT "route_holds_required_position_valid" CHECK("route_holds"."required_position" IS NULL OR "route_holds"."required_position" IN ('normal', 'reverse'))
);
--> statement-breakpoint
CREATE INDEX `route_holds_route_idx` ON `route_holds` (`route_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `route_holds_exclusive_unq` ON `route_holds` (`layout_id`,`kind`,`target_id`) WHERE "route_holds"."released" = 0;--> statement-breakpoint
CREATE TABLE `route_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`layout_id` text NOT NULL,
	`loco_address` integer NOT NULL,
	`authority` text NOT NULL,
	`status` text NOT NULL,
	`path` text NOT NULL,
	`confirmed_index` integer NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "route_reservations_status_valid" CHECK("route_reservations"."status" IN ('active', 'suspended', 'released', 'cancelled')),
	CONSTRAINT "route_reservations_authority_valid" CHECK("route_reservations"."authority" IN ('manual', 'auto')),
	CONSTRAINT "route_reservations_loco_address_range" CHECK("route_reservations"."loco_address" BETWEEN 1 AND 9999),
	CONSTRAINT "route_reservations_confirmed_index_non_negative" CHECK("route_reservations"."confirmed_index" >= 0)
);
--> statement-breakpoint
CREATE INDEX `route_reservations_layout_idx` ON `route_reservations` (`layout_id`);--> statement-breakpoint
CREATE INDEX `route_reservations_layout_status_idx` ON `route_reservations` (`layout_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `route_reservations_one_per_loco_unq` ON `route_reservations` (`layout_id`,`loco_address`) WHERE "route_reservations"."status" IN ('active', 'suspended');