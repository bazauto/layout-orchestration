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

## D8 — Regeneration of end labels was a button, and is now nothing

**Decision (#72), removed (#103 PR 6.2).** `Ends ⟳` regenerated block end labels
on demand and reported what it adopted, created, removed and refused to name.

**Why it was a button and never automatic.** An end label was the only link
between an edge and a block end, so regeneration renamed things the track graph
depended on. Doing that as a side effect of redrawing a corner of the layout
would change the graph while the operator believed they were tidying the
picture.

That whole hazard is gone with the button. A compiled label is regenerated on
every read and referenced by nothing between compiles (D8 in
`docs/track-graph-compilation.md`), so renaming one changes no graph — and the
graph itself only changes when an operator presses Apply on a diff they have
read. Nothing renames anything behind them any more.

The `[brackets]` that marked a pinned label went with it: pinned/generated was a
distinction between "identifier" and "description", and compiled labels are only
ever descriptions. (The `⊣` that marked a buffer-terminated opening survived this
decision and was removed later — D15.)

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

## D12 — Naming an end by hand is gone, and the interaction reasoning is not

**Decision.** `Ends ⟳` and `Ends ✎` are removed from the Track Editor toolbar
(#103 PR 6.2), along with `BlockEndsPanel` and `useBlockEnds`.

D12 used to describe that panel: a list of every stored `block_ends` row —
block, label, pinned/generated, and the cell the drawing placed it at — with
create, rename and delete, beside a button that regenerated the lot from the
drawing.

**Why both controls existed, and why neither does now.** They were the
reconciliation between two copies of the same names: one derived from the
drawing, one stored and referenced by `block_edges`. `Ends ⟳` refreshed the
stored copy; `Ends ✎` patched what refreshing got wrong or refused. Opening
names are now compiled from the drawing on every read and referenced by nothing
between compiles (D8), so there is no second copy to reconcile, nothing for
regeneration to overwrite, and no name for a hand to correct. Removing the
controls removes the work, not a capability.

**The keyboard readout kept pace, deliberately.** The cursor announcement said
`end [yard-3] (buffer)` from the stored row; it now says
`opening yard-3 at the east boundary, buffered` from the compiled one, naming
the boundary rather than merely the cell. That is the same move step 6.1 made
visually — a tick at the boundary the opening occupies instead of a word at a
nearby cell — and it had to be made in both places or the keyboard user would
have been left with the version of the diagram that was wrong (#91's fused
siding). `cursorAnnouncement.ts` is the one implementation of that sentence for
both audiences, which is why there was one thing to change.

### What survives, because it was never about `block_ends`

- **A list of controls, never a click on the drawn label.** The canvas is
  `role="application"` (D11) and a click paints. Making a label clickable means
  a mis-click silently draws a tile — the failure per-stroke undo (D2) exists to
  soften, reintroduced somewhere with no gesture to undo. A list is also the only
  version reachable from the keyboard, which the canvas deliberately is not.
- **`jumpToCell` is one implementation.** It was extracted out of
  `jumpToDiagnostic` for the ends panel and stays exported for the next surface
  that says "go and look here". Two such surfaces landing the operator in
  different places, or moving the cursor without centring the view, is a
  genuinely confusing bug and an easy one to introduce twice.
- **A refusal is rendered verbatim.** The 409 that named the offending edges is
  gone with the rename it refused, but the posture is not: a backend message is
  the entire value of a refusal, and it is held until the next successful write
  rather than cleared by the reload that follows (#62).

### What went with it, and is no longer a limit

A hand-named collided end got no geometry and stayed listed as "not placed"
forever. That was a `block_ends` schema problem — an end could not name a
*specific* opening — and it dissolves rather than being fixed:
`compileOpenings` disambiguates two openings of one block facing the same way
by suffix, so there is nothing for the generator to refuse and nothing for a
hand to rescue. `block_ends` is deleted outright in PR 7, and the four
diagnostics that reported on it with it.

---

## D13 — The Edges tab has no end-label field, because it has no form

**Decision.** Deleted, and replaced by its own removal.

D13 used to describe an end-label `<datalist>` on Configure → Edges: the union
of every `block_ends` row for the selected block and every label existing edges
already used. It existed because the field beside it was free text, and a typo
there produced a valid-looking edge naming an end that does not exist — which
the pathfinder plans on happily.

The field is gone (#103 PR 5). `block_edges` is written by the compile apply and
by nothing else, so there is no name for an operator to type and no typo for a
datalist to prevent. The whole class of error the affordance mitigated is closed
by the write path rather than by the input.

Kept as a numbered decision rather than deleted outright: the reasoning is still
the argument for *why* hand-typing a join key was the wrong shape, and that
argument is the one #103 generalises.

## D14 — Geometry and viewport are shared; authoring is not

**Decision.** #75's extraction half. `GridEditor.tsx` no longer owns the tile
SVG, the pan/zoom viewport, or the model derived from the drawing — those moved
out so a monitor view (#63/#82) consumes the same renderer instead of writing a
second one that draws the same railway a different way, which is the whole risk
#75 names: on a diagram whose purpose is being trusted at a glance, two
renderers will diverge.

The split, along the line the issue drew:

- `diagram/tilePaths.tsx` — `TilePath`, `TILE_SIZE`, the track/sleeper colours.
  Pure SVG per tile type, no state.
- `hooks/useDiagramViewport.ts` — `offset`, `zoom`, middle-drag pan, wheel zoom,
  `fitToContent`, `centerOn`, and the per-layout `localStorage` persistence
  (D5 above). Moved **verbatim**, including the `pendingRestore`/`hydratedFor`
  dance — the persist effect fires in the same commit as the restore, and
  writing there without the guard clobbers the entry the restore just read.
- `diagram/diagramModel.ts` — pure functions of `(tiles, openings)`:
  `parseTileMetadata` (D10's `{}`-on-parse-failure behaviour travels with it,
  `docs/track-grid.md` D10), `computeBlockRuns`, `computePointLabelAt`,
  `computePortsAtCell`, `computeOpeningsAtCell`, `computeOpeningsAtCursor`,
  `computeExtent` (D1) — plus `useDiagramModel`, a thin memoising hook over all
  of them. No live state in or out: a monitor reading a WebSocket snapshot
  needs exactly this, computed the same way.
- `components/TrackDiagram.tsx` — the presentational `<svg>`: grid lines, block
  tints, tile paths, point-road letters, annotations, opening port ticks and
  stop glyphs, opening labels, point labels, block run labels, ruler gutters
  (D5's "outside the pan/zoom `<g>`, positioned by hand" survives unchanged).
  It owns `role="application"`, `tabIndex`, `aria-label` and the `<title>`
  (D11) because it owns the `<svg>` element. Editor-only decorations — the
  ghost preview tile, the keyboard cursor crosshair, the diagnostics "jump to"
  pulse — arrive as **optional** props (`ghostPreview`, `cursor`, `jumpPulse`)
  so the component renders correctly with none of them supplied; that
  optionality is what makes it reusable, and it is exercised today with the
  editor as the only caller.
- `GridEditor.tsx` — what is left: the toolbar, the palette, paint/erase/
  annotate, undo, `onCanvasKeyDown`, the diagnostics panel, and the cursor
  readout (D11's `aria-live` string stays here — it is a keyboard-authoring
  concept, not part of the `<svg>`). It composes `TrackDiagram`, owning the
  policy of *which* tile/rotation/block a ghost preview shows and *when* the
  keyboard cursor moves, and hands the results down as inert data.

**What did not move.** Live state — occupancy, point position/lock, routes —
is not a prop on `TrackDiagram`. This was the geometry-only half of #75; a
later PR binds a live overlay once there is a real shape (`StateSnapshot`) to
validate against, at the extension point `TrackDiagram.tsx`'s header comment
names. An unused `occupancy`/`points`/`routes` prop today would only be a
guess.

**What this does not fix.** Three backend↔frontend duplicates recorded in
CLAUDE.md's "Open limits" (`findBlockRuns` vs `diagram/blockRuns.ts`,
`TILE_LEGS` vs `DRAWN_LEGS`, `EDGE_OFFSET` mirrored in `diagram/openings.ts`)
are **not** touched here. They are backend↔frontend duplicates, not
editor↔monitor ones — unifying them needs a shared workspace package, a
different and riskier change than this seam. The limit stays open. (Two of
those three have since changed shape — see D15 and D16.)

## D15 — Nothing about an opening is drawn on the canvas

**Removed:** the boundary tick, the `⊣` stop glyph and the opening label — all
three of the marks #103 step 6.1 introduced under D-H. `diagram/openings.ts`
and `portMarkGeometry` are deleted with them, along with `computePortsAtCell`
and `computeOpeningsAtCell`.

**Kept:** the keyboard readout (D11), which still says `opening yard-3 at the
east boundary, buffered`; the Edges tab; and the compile diff. Those are the
places an end label is either asked for or load-bearing.

### Why the argument for drawing them stopped applying

D-H's case was that a label at a *nearby* cell is plausible when it is wrong —
#91's fused siding read as a perfectly reasonable end name right up until
someone checked it against the drawing — whereas a mark at the *wrong
boundary* is visibly wrong. That reasoning was about **authoring**. It made a
compile mistake catchable by eye while the graph was being got right.

Westgate Hollow's graph is compiled and applied. An opening's name is now
disposable output, regenerated on every compile, referenced by nothing between
compiles (D8), and named after a compass bearing rather than after anything an
operator says out loud. Three marks per opening — nineteen openings on the live
layout — were being spent on a fact nobody reads, on cells that also carry
occupancy fills, lock marks, block names, point names and road letters.

The check those marks provided has not gone anywhere; it moved. The compile
diff and its gaps are where a wrong connection surfaces now, under review and
before an apply, which is a stronger place to catch it than a tick someone has
to notice.

### What this is not

It is not "openings do not matter". It is that the **diagram** is not where
they are read. The keyboard readout keeps them precisely because a readout is
asked a question about one cell, so it costs nothing until it is wanted — the
opposite trade from a mark that is always on screen.

### The rule that survives

Anything proposing to draw a *derived* fact on the canvas has to justify the
cell it occupies against everything already competing for it. D-H's own
formulation — a mark says *where*, a label says *which* — still holds for
**state**, which is what `docs/diagram-encoding.md` governs. It stopped
applying to openings because an opening is not state.

## D16 — One table describes what shape a drawn leg is

`diagram/trackGeometry.ts` owns the SVG path of every leg of every tile type.
`TilePath` renders from it, the live point-road overlay strokes along it, and
anything later that highlights track — a route line — reads the same table.

### The bug that forced it

`TilePath` drew a `point-left`'s divergent leg as a straight diagonal from the
west edge to the north edge. The live road overlay in `TrackDiagram` drew *the
same leg* as a polyline through the tile centre: a 90° corner over a diagonal.
Two drawings of one leg, disagreeing, inside the one component #75 created so
that the editor and the monitor could not disagree. The seam #75 closed was
between *surfaces*; this one was between *the drawing and the overlay*, and it
was invisible until someone watched a point throw on the live mimic.

### Why a table and not a formula

A chord between the two edge anchors fixes the point tiles and nothing else.
`w`↔`s` is a straight line on `straight-45` and a quarter-arc on `curve` — one
edge pair, two shapes — so any rule keyed on the edge pair alone has to be
wrong for one of them. Only a per-tile-type table can answer "what shape is
this leg".

### What it also cleaned up

`DRAWN_LEGS` in `diagram/pointRoads.ts` held two rows of the backend's
`TILE_LEGS` — a *fragment* of a table, free to drift from both the backend it
mirrored and the paths `TilePath` drew. It is gone; `pointLegs` derives from
here. The frontend's half of that duplicate is now complete and in one file,
and `trackGeometry.test.ts` asserts the full pair list literally so a backend
change surfaces as a failing test rather than as a diagram that quietly
disagrees with the compiler. The duplicate itself stays open — closing it needs
the shared workspace package D14 describes.

`EDGE_OFFSET`'s frontend mirror went with `diagram/openings.ts` (D15), so that
duplicate is closed outright rather than merely reshaped.

## D17 — The `N`/`R` road letters are placed by rotation but never turned by it

A point tile rotated 180° drew an upside-down `N`. The letters sit inside the
tile's rotation group, which is correct for *where* they go — the anchor has to
follow the leg — and wrong for how they are oriented. Each letter now carries a
counter-rotation about its own anchor.

`⊣` deliberately did **not** get this treatment while it existed (D15 has since
removed it): it pointed at the closed side of a terminated opening, so turning
with the tile was the whole of its meaning. The distinction is the rule — a
glyph that encodes a *direction* rotates, a glyph that is a *symbol* stays
upright.

## D18 — Every hatch is drawn corner to corner, and its period divides the tile

The occupied hatch was a vertical line under `patternTransform="rotate(45)"`.
`patternUnits="userSpaceOnUse"` anchors a pattern in the user space of the
element referencing it, and every occupancy wash rect sits inside its own
tile's `translate(x*40, y*40)` — so each tile re-anchors the pattern at its own
origin. Shifting 40px along a 45° axis is 28.28, and `28.28 mod 8` left every
tile offset by half a stripe: on a multi-tile block the hatch read as a ragged
seam at every tile boundary, because it had genuinely been drawn per cell.

No pattern carries a `patternTransform` now. The 45° comes from drawing the
line corner to corner in a square cell, which tiles seamlessly under any
translation that is a multiple of the pattern period, and the period divides
`TILE_SIZE`. The `unknown` cross-hatch never had the bug because it was always
drawn that way — so the fix was to draw the other two like that one, not to
invent anything. `patterns.test.ts` asserts the divisibility rather than
trusting the comment.
