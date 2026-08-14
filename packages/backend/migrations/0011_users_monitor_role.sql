PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text,
	`role` text DEFAULT 'operator' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "users_role_valid" CHECK("__new_users"."role" IN ('admin', 'operator', 'monitor')),
	CONSTRAINT "users_username_non_empty" CHECK(length(trim("__new_users"."username")) > 0)
);
--> statement-breakpoint
INSERT INTO `__new_users`("id", "username", "password_hash", "role", "created_at") SELECT "id", "username", "password_hash", "role", "created_at" FROM `users`;--> statement-breakpoint
DROP TABLE `users`;--> statement-breakpoint
ALTER TABLE `__new_users` RENAME TO `users`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unq` ON `users` (`username`);--> statement-breakpoint
-- Everything below this line is hand-appended, not drizzle-kit output.
--
-- `DROP TABLE users` above (part of the generated table rebuild) drops every
-- trigger attached to `users` along with it — SQLite has no "rebuild but
-- keep my triggers" mode. The two guard triggers from
-- `migrations/0006_users_last_admin_guard.sql` are therefore gone the moment
-- the DROP TABLE runs, and must be re-created here, verbatim, or a
-- SQLite CHECK-widening migration would silently reopen "delete the last
-- admin" (#53 Q1, docs/auth.md). See the comment above `users` in
-- schema.ts before touching this file.
CREATE TRIGGER users_last_admin_no_demote
BEFORE UPDATE OF role ON users
FOR EACH ROW WHEN OLD.role = 'admin' AND NEW.role <> 'admin'
BEGIN
  SELECT RAISE(ABORT, 'users_last_admin')
  WHERE (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1;
END;
--> statement-breakpoint
CREATE TRIGGER users_last_admin_no_delete
BEFORE DELETE ON users
FOR EACH ROW WHEN OLD.role = 'admin'
BEGIN
  SELECT RAISE(ABORT, 'users_last_admin')
  WHERE (SELECT COUNT(*) FROM users WHERE role = 'admin') <= 1;
END;