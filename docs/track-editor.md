# Track Editor authoring ergonomics

Decision record for #69 — the canvas extent, undo, and view persistence — for
the wave-2 authoring affordances (#71, #72, #73, #74, #84), for keyboard
navigation (#94), and for the surfaces that finally reach #72's manual override
and #78's proposals from the browser (D12, D13).

Scope note: this document is about **authoring the drawing**. What a tile *is*
and how its writes are validated is `docs/track-grid.md` (#70, plus D7–D11 for
the wave-2 fields); what a block end is and how its label is generated is
`docs/topology.md`; how the drawing is coloured and labelled is
`docs/diagram-encoding.md` (#81, #68). The running order for the wider work
stream is issue #80.

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

---

## D6 — Annotating is a mode, not a modifier

**Decision (#74).** The toolbar has a Track/Annotate mode. In Annotate mode a
click toggles the selected entity's annotation on an existing tile; it never
creates or erases a tile, and clicking an empty cell says so rather than
painting one.

**Why a mode.** An annotation is a different kind of edit: it changes an
existing tile's metadata only. Overloading a modifier onto the paint gesture
would make a slipped key place a sensor instead of a tile — and unlike a stray
paint stroke, that one is invisible until you look for it.

**Why a toggle rather than an add.** Clicking the same sensor on the same tile
twice removes it. Without that, correcting a misplacement means repainting the
tile and losing everything else on it.

**Repainting a tile preserves its annotations.** Changing a curve to a straight
is a change to the drawing; it is not a statement that the sensor sitting there
has moved. Losing authored placement to a cosmetic edit would be a silent data
loss on the exact surface #62 was about.

---

## D7 — The point leg mapping is captured while the point is placed

**Decision (#73).** Painting a point tile with a point selected writes a default
road mapping, and a "Divergent = normal" checkbox — shown only when it applies —
swaps it.

**Why defaulted rather than left empty.** The mapping is only cheap to capture
*while the points are being placed*. An empty default means an authoring step
nobody performs, and the retrofit is revisiting every point tile on the layout
by hand. The default is the conventional wiring; the checkbox covers the rest.

The mapping is drawn on the tile as an `N`/`R` letter at the leg's outer edge.
That is the editor's whole contribution to a piece of data nothing can validate
(`docs/track-grid.md` D9): make it visible, and make it one click to correct.

---

## D8 — Regeneration of end labels is a button

**Decision (#72).** `Ends ⟳` regenerates block end labels on demand and reports
what it adopted, created, removed and refused to name.

**Why not on every grid write.** An end label is the only link between an edge
and a block end, so regeneration renames things the track graph depends on.
Doing that as a side effect of redrawing a corner of the layout would change the
graph while the operator believed they were tidying the picture. Pinned labels
are never touched, but the operator should still see the change happen.

Generated labels are drawn plain; pinned ones are drawn in `[brackets]`, so you
can see at a glance which names are load-bearing. A `⊣` marks an end a buffer
terminates.

---

## D9 — Diagnostics are a panel, and unfinished work is not an error

**Decision (#71, #84).** A toolbar button shows `⚠ warnings/todos` and toggles a
panel listing every finding in words, with ids paired with names.

**Why counts and not a coloured dot.** A bare red dot says something is wrong
without saying how much or of what kind, and colour is never the sole carrier of
meaning (#81).

**Why two severities that look different.** Half of what this produces on
Westgate Hollow today is a to-do list — unclassified tiles, ends with no edges
yet. An unfinished layout is a normal state, and rendering it as a wall of
errors is how an operator learns to ignore the findings that matter.

**Recomputed at the end of a gesture, not per cell.** The findings are derived
from the whole layout, so recomputing per painted cell of a drag would be one
round trip per tile for a result nobody reads until the drag stops.

---

## D10 — A point is labelled once, by its identifier, at the tile that depicts it

**Decision (#93).** The point name is drawn **once per point**, at the tile
chosen by `diagram/pointLabels.ts#pointLabelAnchors`, abbreviated by
`shortPointLabel`, with the full name in a `<title>`.

**Why once per point and not once per tile.** A point is drawn as *two* tiles —
the `point-left`/`point-right` tile, and a `straight-45` companion carrying the
divergent road across to the adjacent row — and both are tagged with the same
`pointId`, because both depict part of that point. Labelling per tile therefore
drew every name twice, one cell below itself. The point tile wins the choice
because that is where the roads and their `N`/`R` letters already are, so the
name lands with the rest of the point's annotation.

The same two-tiles-one-point fact is why `point-tile-unmapped` had to be gated on
tile type (`docs/track-grid.md` D11) — it is worth knowing as a shape of this
drawing, not as two separate bugs.

**Why abbreviate.** A tile is 40px and `P1 - Fiddle Yard` is about 67px at the
label's size, so every name overflowed by most of a tile in each direction. On
Westgate Hollow `P5 - Goods Shed` and `P6 - Engine Shed` are one cell apart and
ran together into a single unreadable string. The layout's own convention is
`P1 - Fiddle Yard` — an identifier, then what it serves — so the identifier is
what the diagram draws, exactly as a lever number does on a real signalling
diagram. A name not following the convention truncates rather than being assumed
to have one.

**Nothing is hidden, it is moved.** The full name is the `<title>`, which is both
the hover tooltip and what assistive technology reads. That `<title>` belongs on
a wrapping `<g>` and **not** inside the `<text>`: as a child of `<text>` it is
still not drawn, but it *is* part of that element's `textContent`, so anything
reading the diagram back sees `Yard ThroatYard Th…` and the abbreviation quietly
stops being one.

**Why the leading `⌥` is gone.** It was carrying the "points and blocks are
different namespaces" distinction from #68, and it is U+2325 — the Mac option
key — which resolves to a replacement box in the monospace fallback. The
distinction is carried by position and slant instead: a point label is italic at
the top of its cell, a block label upright at the bottom.

---

## D11 — The grid is navigable without a mouse, and says where you are

**Decision (#94).** The `<svg>` takes keyboard focus (`tabIndex={0}`,
`role="application"`). A `cursor: {x, y}` state, distinct from the pre-existing
`hoverCell`, moves on arrow keys, paints on Enter/Space, and erases on
Delete/Backspace; mouse hover sets the same state, so the two input paths
converge on one piece of truth rather than the readout having to pick between
two that could disagree. Escape returns focus to the toolbar. Ruler gutters
(column numbers along the top, row numbers down the left) and a faint
crosshair band across the cursor's row and column give a persistent spatial
reference independent of the cursor readout. Every 5th gridline is
emphasised. Each diagnostics-panel line that structurally carries a
coordinate is a button that moves the cursor there, centres the view, and
briefly pulses the cell.

**Why a hover readout alone was rejected.** It was the obvious ten-line fix —
`hoverCell` already existed — and it would have made the editor *more*
mouse-dependent, not less: the `<svg>` had no `tabIndex`, no `role`, and the
keyboard handler that existed (palette selection, rotation, undo) was a
`window` listener gated only by "is a form field focused", not a real
keyboard path onto the grid at all. Shipping a readout that only the mouse
could drive, on a control surface with zero keyboard affordance, would have
been a WCAG 2.1.1 (keyboard) failure with a status line bolted on top of it.
Ruler gutters alone have the same defect from the other direction: legible at
a glance, but visual-only and no better for someone who cannot use a pointing
device.

**Why `role="application"` over `role="grid"`.** `role="grid"` with real
`gridcell` semantics is the more standard accessible pattern for a
spreadsheet-shaped structure, but this grid is sparse (a `Map`, not a 2-D
array) and its "cells" are absolutely-positioned SVG shapes, not DOM table
cells a screen reader can enumerate the way it enumerates `<td>`s — modelling
that faithfully is a significantly larger change than #94 scoped.
`application` hands the arrow keys to the component entirely, which is
exactly what the existing 1–9/R/Ctrl+Z shortcuts already assumed; the cost is
that it also takes the screen reader's own navigation away, which is why
Escape-to-toolbar is not optional polish but the thing that makes
`application` an acceptable choice at all.

**The `<title>`/`aria-label`/`aria-live` split.** Three different audiences,
not one mechanism triplicated. `aria-label` is the accessible name a screen
reader reads once, on focus — it does not change per keystroke, and firing it
on every arrow press would violate `aria-live`'s own convention of announcing
*changes*, not restating a static name. The SVG `<title>` is a native browser
tooltip for a sighted mouse user hovering the canvas who may never tab into
it at all, and who therefore never hears `aria-label` or the live region
either. The `aria-live="polite"` region is what actually fires on every
cursor move, built from the same `describeCursor` string the visible readout
below the canvas renders — deliberately **one** pure function, not a visible
copy and a screen-reader copy that can say different things the moment either
one is edited without the other.

**Why the window keydown listener had to move, not just gain a cursor.** It
intercepted `1`–`9`, `r`, and `Ctrl+Z` globally, guarded only against a form
field having focus. The moment the canvas became focusable, leaving that
listener on `window` would have meant arrow keys moved the cursor while focus
was anywhere else on the page — including inside the diagnostics list, which
is exactly the two-input-paths-disagreeing failure this feature exists to
prevent elsewhere. It is now the canvas's own `onKeyDown`, and needs no guard
at all: an `<input>` living elsewhere in the DOM tree simply never receives
an event whose listener is attached to the `<svg>`.

**Ruler gutters render outside the pan/zoom `<g>`, positioned by hand.** Text
inside a `scale()`-transformed group shrinks with it; at zoom 0.3 a scaled
"11" is illegible exactly when the ruler is doing the most work. The gutters
are a sibling group computed from `offset`/`zoom` directly, and labels thin
out via `rulerTicks` (`diagram/ruler.ts`) rather than shrinking further —
skipping a label at low zoom keeps every one that *is* printed full size. The
same tick maths marks every 5th gridline as major, so the two consumers of
"which line is a 5" can never drift out of step with each other.

---

## D12 — Naming an end by hand is a list, not a click on the label

> **Superseded in design (#103), still shipped.** `docs/track-graph-compilation.md`
> deletes `block_ends`, so both this decision and D13 below go with it: an end
> label becomes disposable compiler output that nothing references and nobody
> edits, and there is nothing left to name by hand. The *interaction* reasoning
> here — why a list of controls rather than a click on a `role="application"`
> canvas, and why `jumpToCell` is one implementation — survives and applies to
> whatever the compile-diff surface becomes.

**Decision.** `Ends ✎` toggles a panel listing every stored block end — block,
label, pinned/generated, and the cell the drawing places it at — with create,
rename and delete. It sits beside `Ends ⟳` (D8), which regenerates.

`BlockEndService` has had all three writes since #72; nothing in the browser
could reach any of them, so the editor's only end control was regeneration. That
left the case the generator explicitly refuses — `end-label-collision`, two
openings of a block facing the same bearing — with **no resolution at all**,
since a collision emits no end row to rename.

**Why not a click on the drawn end label.** The canvas is `role="application"`
(D11) and a click paints. Making a label clickable means a mis-click silently
draws a tile, which is the failure per-stroke undo (D2) exists to soften and
this would reintroduce somewhere with no gesture to undo. A list of ordinary
controls is also the only version reachable from the keyboard, which the canvas
deliberately is not.

**Why its own toggle rather than a section of the diagnostics panel.** The
diagnostics are a read of what is wrong; this is a write surface. Both are tall,
and stacking them under the canvas is how the canvas stops being visible.

**"Rename" with the label unchanged is how you pin.** A no-op rename still pins,
which is an operator saying *this generated name is the right one, stop
regenerating it*. The button is therefore offered on every row, not only the
ones whose name looks wrong.

**A refusal is rendered verbatim.** Renaming or deleting an end an edge
references is a 409 whose body names the edges. That message is the entire value
of the refusal — an end label is the only link between an edge and a block end,
so the operator has to know which edges to fix. It is held until the next
successful write rather than cleared by the reload that follows (the #62
posture), because a stale error is less misleading than none.

**Jumping to an end's cell is the diagnostics panel's jump, not a second one.**
`jumpToCell` was extracted out of `jumpToDiagnostic` for this. Two surfaces that
both say "go and look here" landing the operator in different places, or moving
the cursor without centring the view, is a genuinely confusing bug and an easy
one to introduce twice.

**What it still cannot do.** A hand-named collided end gets no geometry: it
lists as "not placed" and stays there. The limitation, and what closing it would
cost, is recorded in `docs/topology.md` — it is a `block_ends` schema question,
not an editor one.

---

## D13 — The Edges tab offers the drawing's own end names

**Decision.** The end-label `<datalist>` on Configure → Edges is the union of
every `block_ends` row for the selected block and every label existing edges
already use. It was derived from `edges` alone, so on a layout with no edges yet
it was empty and the operator typed the opening's name from memory — into a
field where a typo produces a valid-looking edge naming an end that does not
exist, which the pathfinder will plan on happily.

Still a datalist, still not enforced. Authoring an edge against a name before
the track carrying it is drawn is a legitimate work order; the diagnostics
report the mismatch (`end-not-on-diagram`) rather than the write path refusing
it.
