-- #77 sub-block sensor position (docs/sensor-position.md D1/D5).
--
-- `ON DELETE SET NULL` is hand-added to the first statement. drizzle-kit
-- generated a bare `REFERENCES blocks(id)` even though `schema.ts` declares
-- `{ onDelete: 'set null' }` — it emits the full clause when it writes a
-- CREATE TABLE and drops it on an ALTER TABLE ADD. Left as generated, foreign
-- key enforcement (`PRAGMA foreign_keys = ON`, connection.ts) would default to
-- NO ACTION and *refuse* to delete any block a sensor's position anchors to,
-- which is a behaviour change nobody asked for. SQLite permits the full
-- REFERENCES clause on ADD COLUMN provided the default is NULL, which it is.
--
-- Both columns nullable, nothing back-filled: every existing sensor reads
-- "unmeasured" and the live layout behaves identically (D3).
ALTER TABLE `sensors` ADD `position_toward_block_id` text REFERENCES blocks(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `sensors` ADD `position_offset_mm` integer;
