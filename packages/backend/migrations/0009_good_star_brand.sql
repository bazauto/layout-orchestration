CREATE TABLE `compiled_graphs` (
	`layout_id` text PRIMARY KEY NOT NULL,
	`drawing_fingerprint` text NOT NULL,
	`compiled_at` integer NOT NULL,
	FOREIGN KEY (`layout_id`) REFERENCES `layouts`(`id`) ON UPDATE no action ON DELETE cascade
);
