# Track Editor authoring ergonomics

Decision record for #69 — the canvas extent, undo, and view persistence.

Scope note: this document is about **authoring the drawing**. What a tile *is*
and how its writes are validated is `docs/track-grid.md` (#70); how the drawing
is coloured and labelled is `docs/diagram-encoding.md` (#81, #68). The running
order for the wider work stream is issue #80.

---

## D1 — The canvas extent is derived from the content

**Decision.** The drawn canvas is `max(tile coordinate) + margin`, floored at
30×20 so an empty layout still has somewhere to draw. There is no ceiling to
hit.

**Why not simply raise the constants**, which #69 lists as the least good
option: the old fixed 30×20 *silently dropped* any paint outside it, with no
indication that painting further right did nothing at all. Westgate Hollow as
drawn already reached roughly column 29 of 30 — the layout was at the edge of
the canvas with no room for the fiddle yard headshunt to grow. Raising the
number moves the wall. Deriving the extent removes it.

A coordinate bound still exists (`MAX_COORDINATE`, matching the backend's
`MAX_TILE_COORDINATE` from #70), but it is admission control against a fat
finger or a stray script creating a tile nothing can ever scroll to. **It is
not a canvas size and must not be read as one.** If one of the two changes,
change both.

---

## D2 — Undo is one entry per stroke, not per tile

**Decision.** A gesture — a click, or a drag across many cells — is a single
undo step. Each entry records what was at a coordinate *before* the stroke
first touched it, so undo is a replay of inverses. Depth is capped at 50
strokes.

**Why per stroke.** The motivating case is precise: right-click erases, and the
editor continues erasing while the right button is held, so a stray right-drag
across the diagram deletes a run of tiles — one DELETE per tile — with no undo
and no confirmation, on a config surface representing an afternoon of
authoring. Undoing that one tile at a time would be no use to the person it
happened to.

**Why a replay of inverses is safe here.** Each tile is an independent
upsert/delete with no ordering relationship to any other, which is exactly what
makes the naive approach correct. Undo applies its inverses sequentially rather
than in parallel, so a partial failure leaves a coherent result and the first
refusal is the one reported.

**Why it is not persisted.** The stack describes *this session's* edits. One
that outlived a reload would be offering to revert changes that may have been
made from another browser, against a grid it can no longer vouch for.

**This depends on #62.** An undo stack built over a write path that reports a
refused write as a success drifts out of sync with the server — #69 says so
explicitly, and it is why #80 sequences them together. The write path now
returns a per-call result, and a failed undo says so rather than pretending.

---

## D3 — Drag-erase keeps its modifier-free binding

**Decision.** Right-drag continues to erase without a modifier key, and erase
stays a mouse button rather than becoming a palette mode.

**Why**, given #69 raised both as options: with a stroke-level undo the
accident is recoverable in one click, and erasing a run by dragging is
genuinely useful during authoring. Requiring a modifier taxes every deliberate
erase in order to guard against an occasional slip that is now cheap to
reverse. Revisit if it turns out to still bite in practice — the cost of
changing it later is one keybinding.

---

## D4 — `⌂` fits the content instead of resetting to the origin

**Decision.** The home control frames the drawn tiles in the viewport.

**Why.** It previously reset to zoom 1 at the origin, which on a layout drawn
away from the origin leaves the canvas apparently blank: the control that is
supposed to rescue you from being lost was itself a way to get lost. On an
empty grid it still resets to the origin, which is the only sensible answer
when there is nothing to frame.

---

## D5 — Pan and zoom persist per layout, and persistence must not fight the restore

**Decision.** The viewport is saved per layout in `localStorage` under
`layout-orchestrator:gridView:<layoutId>`, restored on mount, and reset when
the selected layout changes. A corrupt or hand-edited entry is ignored, and a
failed write is swallowed.

**The subtlety, recorded because it cost real time.** The obvious
implementation — one effect to restore, another keyed on `[offset, zoom]` to
save — is wrong. Both run in the same commit, and the saving effect sees the
*pre-restore* values, so it writes them over the entry the restore just read.

That is not merely a transient wrong value. Under React StrictMode's deliberate
double-invocation the restore then runs a second time and reads back the value
the save just stamped over it, so the saved view is lost outright. A guard
saying "only save once the restore has run" does not help, because the restore
sets that flag before the save runs in the same commit.

The fix is to hold what was restored and write nothing until the state actually
matches it. The e2e spec (`tests/e2e/track-editor-canvas-undo.spec.ts`) is what
caught this; the first version of the code passed a hand test and failed the
spec.

**The undo stack is cleared when the layout changes.** Its coordinates mean
something else in a different drawing.
