-- Custom SQL migration file, put your code below! --
-- Last-admin guard (Q1, docs/auth.md, issue #53). Generated with
-- `drizzle-kit generate --custom` — this SQL is not representable in
-- schema.ts (Drizzle has no trigger DSL). See the comment above the `users`
-- table in schema.ts before touching this file: removing these triggers
-- means a new migration with DROP TRIGGER, never editing this one in place.
--
-- `SELECT RAISE(...) WHERE <cond>` is the SQLite idiom for a conditional
-- abort: the RAISE only fires if the WHERE clause yields a row.
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
