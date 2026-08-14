# The track grid: what a tile is, and what it is not

Decision record for `grid_tiles` — the Track Editor's drawing — and for the
validated write path introduced by #70.

Related: `docs/topology.md` (the actual track model), and issue #80, which
carries the running order for the wider Track Editor / mimic work stream.

---

## The thing to understand first

**The grid is a drawing, not a model.**

`block_edges` is the model. It is what the pathfinder searches, what
reservations lock, and what Safe-Stop reasons about. It is authored explicitly
in the Configure screen's Edges tab and validated against the rest of the
layout by `TopologyService`.

`grid_tiles` is a picture of the railway drawn on a grid. Nothing in the
backend reads a tile to make a decision, and nothing ever should. A tile
carries no authority: it cannot assert that two blocks are connected, cannot
say where a train is, and cannot be a source of distance.

This is not a temporary state of affairs to be tidied up later. It is the
boundary that makes the drawing safe to be wrong: an operator can draw the
fiddle yard however it fits on screen, and the worst outcome is a diagram that
does not look like the railway. The same mistake made in `block_edges` is a
route granted over track that is not there.

Two consequences worth stating outright:

- **Tile count is never physical length.** The Westgate Hollow entry feeder is
  drawn long and is short in reality. Nothing may compute `lengthMm` from
  geometry. (#77 is where a real length model would go, and it is gated on #6.)
- **A tile's `blockId` is a drawing assertion**, not a claim about the track
  graph. It says "tint this cell as that block". It does not say the cell is
  part of the block, and no reservation or occupancy decision consults it.

---

## D1 — The grid write path is validated, and a rejection is a 400

**Decision.** `PUT /api/layouts/:layoutId/grid` and
`DELETE /api/layouts/:layoutId/grid/tile` validate with Zod before anything is
persisted. Every rejection is an ordinary 4xx. Nothing in this path may reach
`SystemHealth`.

**Why it needed saying.** The route declared its body with a Fastify `Body`
generic and nothing else. That generic is erased at compile time and validates
nothing at runtime — the same gap #36 closed on blocks and sensors, which the
grid route was not included in. Any `tileType` string, any coordinate, and any
`metadata` object persisted verbatim.

**Why 400 and not Safe-Stop.** CLAUDE.md's fail-safe rule — a malformed payload
is a Safe-Stop trigger — is scoped to sensor and control topics, where the
payload is evidence about where a train is. The Track Editor is an admin config
surface. Halting a layout because someone typo'd a tile type would itself be a
bug, and the Traps section already records the general form of this.

`grid.test.ts` pins it: a burst of rejected writes leaves the system `online`.

---

## D2 — `tileType` is a closed enum; `'empty'` is not in it

**Decision.** `TILE_TYPES` in `domain/types.ts` is authoritative. `'empty'` is
excluded. The legacy `straight-v` and named `curve-*` entries are kept.

**Why exclude `'empty'`.** An `'empty'` row is a contradiction: it renders as
nothing (`TilePath`'s `default: return null`) while still occupying its cell and
still blocking placement — an invisible obstruction, which is precisely the
failure mode validating `tileType` exists to prevent. The absence of a tile is
expressed by DELETE.

**Why keep the legacy types.** They are in already-authored grids. A closed
enum that refuses to round-trip an existing layout is a worse bug than the one
it fixes.

**Why the enum lives in `domain/types.ts`** despite being presentational: it is
the vocabulary the frontend mirrors, and CLAUDE.md makes that file authoritative
for the whole system. The frontend's `TileType` in `packages/frontend/src/types.ts`
is a hand-maintained mirror; a value present in one and not the other is a 400
at runtime.

---

## D3 — `metadata` is a **closed** schema, and a point tile's `blockId` need not
agree with the point's own `blockId`

**Decision.** `gridTileMetadataSchema` is `.strict()`. Unknown keys are a 400,
not a passthrough. `blockId` and `pointId` are checked to resolve to records **in
the same layout**. `metadata.blockId` on a point tile is *not* required to equal
that point's `points.blockId`, and no warning is raised when they differ.

**Why closed.** Every queued addition to the drawing lands in this blob, and
wave 2 landed three of them at once — #71's classification (`trackRole`), #74's
annotations, #73's point roads. A passthrough schema cannot tell a key a future
feature will add from a key a client misspelled today. New fields are added to
`GridTileMetadata` and `gridTileMetadataSchema` together, or not at all.

Closing it in #70 is what made wave 2 cheap: each of those three arrived as a
schema addition on a path that already validated, rather than as a widening of
an unvalidated blob.

**Why the two `blockId`s are allowed to differ** — this was #70's stated open
question, resolved here in the direction it leaned. They answer different
questions. A tile's `blockId` says which block's tint this cell draws in; a
point's `blockId` says which block the point physically sits in. A point at the
throat of a yard is routinely drawn on a cell tinted as the approach block while
the point belongs to the yard. Requiring agreement would make a correct drawing
unauthorable; warning on it would fire across most of the real layout and train
the operator to ignore warnings.

Nothing is lost by leaving them independent, because neither is consulted by any
domain decision (see the boundary above). Revisit with the point leg-mapping work
(#73), which is the first change that gives a point tile any structural meaning
at all.

**Why referential checks at all**, given a tile carries no authority: a tile
naming a deleted block renders as an untinted, unlabelled cell that looks
identical to a deliberately-untagged one, and #78's edge-proposal walk will read
these fields. Cheap to check on write; expensive to untangle later.

**Dangling references, answered in #74's direction.** Deleting a block, point or
sensor still does not clean up tiles referencing it — deliberately. The tile is a
drawing; a cascade would silently delete authored artwork because a config row
went away. Instead the reference is **reported**: `GET .../grid/diagnostics`
emits `dangling-tile-reference`, and the editor shows it. Validate-on-read, not
cascade-on-delete, and it covers `blockId`, `pointId` and annotation ids alike.

---

## D4 — Coordinates are bounded, and a querystring coordinate is matched before
it is converted

**Decision.** `x`/`y` are non-negative integers bounded by
`MAX_TILE_COORDINATE` (999). The `DELETE .../grid/tile` querystring is validated
with `/^\d+$/` and *then* converted.

**Why a bound at all**, given #69 makes the drawn extent derive from content and
so removes the canvas edge: this is admission control against an absurd
coordinate creating a row nothing can ever scroll to, in the same spirit as
`MAX_EDGES_PER_LAYOUT`. It is not a canvas size and must not be read as one.

**Why not `z.coerce.number()` or `parseInt`.** Every lenient numeric conversion
in JavaScript is lenient in a different direction: `parseInt('3abc')` is `3`,
`parseInt('')` is `NaN`, and `Number('')` is `0` — a valid coordinate conjured
out of an absent one. The route previously used `parseInt` and compared the
result against every tile, so all three matched nothing and answered **204**: a
delete that reported success and deleted nothing. `z.coerce.number()` fixes two
of the three and quietly keeps the worst. Matching digits first has no such
corner. (The `?x=` case was caught by a test written against the coerce version,
which is the only reason it is not still in the code.)

---

## D5 — Erasing an empty cell is a 204, not a 404

**Decision.** `DELETE .../grid/tile` at a coordinate holding no tile succeeds.

**Why.** Right-drag erase sweeps across cells that may or may not hold a tile.
Answering 404 to half a drag would turn ordinary authoring into a stream of
errors the operator must dismiss, and — after #62 — actually surfaces them.
A *malformed* coordinate is a different thing and is a 400: it means the client
asked for something incoherent, not that the cell was already clear.

---

## D6 — Referential validation lives in `GridService`, not the route

**Decision.** `services/GridService.ts` owns "does this layout exist" and "does
this `blockId` belong to this layout". The route parses, delegates, and maps
typed errors to status codes.

**Why.** CLAUDE.md safety rule 2. The route callback's job is shape and
transport; anything that has to consult other records is a decision. `GridService`
is constructed in `server.ts` from the repository it already holds rather than
plumbed through `index.ts`, because it is stateless and depends on nothing else.

**Status codes.** `LayoutNotFoundError` → 404. `TileReferenceError` → **400**,
not 422: in this codebase 422 means the topology graph refused a proposal
(`TopologyRejectedError`, carrying `violations` an operator can act on). A tile
naming a block that is not there is just a bad field in a config write.

---

## D7 — A tile says "deliberately not a block"; it never says "this is a block"

**Decision (#71).** `metadata.trackRole` carries exactly one value today,
`'decorative'`. The three-way classification is *derived*, by `classifyTile`:

| stored | classification | meaning |
|---|---|---|
| `blockId` present | `block` | drawn as part of that block |
| `trackRole: 'decorative'` | `decorative` | deliberately not part of any block |
| neither | `unclassified` | nobody has said yet — a to-do |

A tile carrying **both** is a 400. They are contradictory assertions, and a tile
holding both would classify differently depending on which check ran first.

**Why only the deliberate assertion is stored.** "Block track" is already
carried by `blockId`; re-stating it would create two ways to say one thing that
can disagree. "Unclassified" is the absence of both — exactly the unfinished
state the editor needs to surface.

**Why an enum and not a boolean.** #71's parked open question 2 — a named feeder
that is not a block, closer to a block-with-no-detection than to decoration —
would arrive as another member here. A `decorative: true` boolean could not grow
one.

**Why untagged cannot simply be an error.** The Westgate Hollow entry feeder is
plain track the system neither detects nor reserves. Warning on every untagged
cell would light up the whole run — useless. But the opposite failure is real: a
tile that should have been tagged and was not is silently invisible to live
state and appears on a mimic as a permanent hole. Both cases used to be the same
absent key.

**Existing tiles are classified by a manual pass, not a defaulting rule.** A
default would have to guess which track is monitored, and guessing in that
direction is the wrong way round: silently classifying unfinished track as
deliberately-decorative would hide it from the editor's own warnings and from
#78's walk, permanently and quietly. The migration adds no default; the editor
reports `unclassified-tile` as `info` until the pass is done — the same
affordance the feature provides afterwards anyway.

---

## D8 — Placement is a generic annotation, not a coordinate column per entity

**Decision (#74).** `metadata.annotations` is a bounded list of
`{ entityType, entityId, orientation? }`. `entityType` is a closed enum —
`'sensor'` today; signals (#79) and RFID readers (#39) are the queued consumers.
**Nothing reading an annotation may assume it is an IR sensor.**

**Why a list.** A tile is 40px, and a sensor and a signal at the same spot is
plausible. Designing for one value and widening later costs a migration.

**Why a type discriminator and not a bare id.** An id alone cannot be resolved
back to a table. `GridService` switches on `entityType` to check the reference,
with an exhaustiveness check so a new member nobody wrote a case for fails to
compile rather than shipping as an unvalidated reference.

**Why not `sensors.x`/`sensors.y` columns.** Diagram position is
**presentational**. The drawing is explicitly not to scale, so where a sensor
appears on it is a drawing concern, not a railway fact — the railway fact is
#77's `offsetMm` from a block end, a different field on a different issue with a
different safety posture. Coordinate columns would solve it for sensors only and
start a pattern of every table growing an `x`/`y`.

**Secondary questions, answered explicitly rather than left implied:**

- **A beam at a block boundary belongs to which block?** `sensors.blockId` stays
  singular and this changes nothing about it. Physically a beam can sit across a
  joint; the occupancy model tolerates that (an IR sensor may only ever raise
  occupancy — `docs/sensor-fault-recovery.md` D3), so the answer is
  **display-only**.
- **Does an annotation have an orientation?** Yes, optional, and **cosmetic
  only**: which way a beam points on the diagram. It asserts nothing about
  detection direction, which the system does not model.
- **One entity on two tiles** is a `duplicate-annotation` *warning*, not a
  refused write. Moving a sensor is a two-step edit, and refusing the first step
  would make it impossible without deleting it first.

---

## D9 — Point roads are leg-list shaped, keyed by a position tuple

**Decision (#73, shaped by #83).** `metadata.pointRoads` is a list of
`{ when: [{ pointId, position }], legs: [TileEdge, TileEdge] }`.

**Why not `normalLeg`.** A field naming one of two legs forecloses three-way
points immediately, and keying on a single point's position forecloses slips —
one piece of track carrying two independently switched mechanisms. A mapping
from a position *tuple* to a leg pair, over an open set of legs, costs no more
to write now. This is the highest-value item in #83 precisely because the data
is authored against real point tiles: retrofitting means a migration plus
revisiting every point on the layout by hand.

**Legs are named in the tile's UNROTATED frame.** `metadata.rotation` is applied
at render time, exactly as the drawing already is. Recording the post-rotation
edge would silently become wrong the moment the tile was rotated — and rotation
is a single keypress in this editor.

**Two roads selected by the same conditions are a 400.** An ambiguous mapping
would force the renderer to pick one, and picking silently is how a mimic ends
up drawing the wrong road.

**This is unverifiable authored data.** There is no independent source of truth
for which way round a physical point is wired, and it cannot be cross-checked
against `block_edges` either — `pointConditions` names a required position with
no geometric meaning. Accept it as an author's assertion; the editor's job is to
make it visible and easy to correct, which is why the mapping is drawn as an
`N`/`R` letter on the tile rather than as a colour (#81).

**It draws a commanded position, never a confirmed one.** There is no
point-position feedback channel (#25), and a point lock is an authority
guarantee rather than a physical-position guarantee. The road mapping is
independent of where a position came from, so when #25 lands, confirmed and
commanded can be drawn differently without re-modelling any of this.

This supersedes D3's closing note. A point tile now has structural meaning, and
it changes nothing about the two `blockId`s, which stay independent.

---

## D10 — A persisted tile's metadata degrades on read; it does not throw

**Decision.** `parseTileMetadata` returns `{ metadata: {}, ok: false }` for a
blob it cannot read, and the diagnostics report it as
`tile-metadata-unreadable`. This is the **opposite** of every other row parser
in `validation.ts`, all of which throw on a bad row.

**Why the asymmetry.** A bad `block_edges` row throws because the pathfinder
plans on it: a route granted over a misread edge moves a train onto track that
is not there, so the load path turns it into a Safe-Stop. A tile decides
nothing. Its worst outcome is a picture that does not match the railway, and
refusing to open the Track Editor because one legacy cell carries a key the
schema no longer accepts would take away the only tool that can fix it.

Rows written since #70 cannot reach this path. Rows authored before it can.

---

## D11 — The diagnostics surface is advisory, and never escalates

**Decision.** `GET /api/layouts/:layoutId/grid/diagnostics` reports everything
the drawing and the track graph disagree about. It refuses nothing, writes
nothing, and cannot reach `SystemHealth`.

Two severities, on a rule: **`warning` means two representations disagree or a
known hazard is drawn; `info` means authoring is unfinished.** An unfinished
layout is a normal state, and a to-do list styled as a wall of errors trains the
operator to ignore the findings that matter.

**What is left here, and what moved (#103 PR 7).** This surface once carried
five end-related findings. Four are gone with `block_ends` —
`end-not-on-diagram`, `pinned-end-not-on-diagram` and `end-label-collision`
described states a stored label could be in and none of them can occur now, and
`end-unfinished` was **promoted** rather than deleted: it is the compile gap
`opening-unresolved`, which refuses `auto` where an `info` line refused nothing.
`block-without-detection` moved the same way and for the same reason.

That inversion is worth stating plainly, because it cuts against D6's framing
above. A diagnostic is advisory *because it compares two representations that
may legitimately disagree while authoring*. A **gap** is a statement that the
compiler is not confident, and confidence is precisely what automatic running
requires — so a gap gates and a diagnostic does not. Anything that was really
the second kind belonged in the compiler all along.

**Buffers (#84).** A `buffer` tile asserts "track ends here, nothing continues
beyond", and that is checkable against `block_edges`. It is the one end-related
finding that survives, because it is the one that still has two artefacts to
compare: the drawing, and the graph some earlier compile wrote. Keyed on
`(blockId, label)` over compiled openings (OQ3) — draw a buffer across an
opening the live graph routes through and it says so, before anyone recompiles.

It is **not** a route-safety mechanism. The pathfinder already cannot plan
beyond a block end with no outgoing edge, and the absence of that edge remains
the authority. Nothing in `domain/` reads a tile. A buffer contradicted by an
edge is a *drawing-versus-graph* disagreement, so it is surfaced and
`TopologyService` does **not** start refusing edge writes because of it.

**A buffer on decorative track asserts nothing checkable** and is not flagged. A
dead end on undetected track — the end of the entry feeder — is perfectly real;
it just has no block end to attach to.

**`platform` stays decorative.** It is operationally meaningful — it is where
you stop a train — but that only becomes useful once stopping marks exist, which
is #77, gated on #6. Revisit it there rather than inventing a meaning now.

**Plain diamonds (#83 item 4).** The palette has had a `crossing` tile all
along, so a plain diamond can be drawn today — while #26 records that two routes
fouling at one are not detected, because neither shares a block nor a point. The
editor will happily let you draw trackwork the safety model cannot see, so the
editor is where it is said: a drawn `crossing` emits `diamond-blind-spot`.

### A finding must be one the operator can act on (#92)

Two rules learned by checking the reported list against the live layout, both
worth stating because both failures look correct in isolation.

**Never ask for what the editor will not let you author.** `point-tile-unmapped`
fired on `metadata.pointId !== undefined` alone. But a point is drawn as *two*
tiles — the `point-left`/`point-right` tile, and a `straight-45` companion
carrying the divergent road across to the adjacent row — and both are tagged
with the same `pointId`, because both depict part of that point. Only the first
has legs to map: `defaultPointRoads` returns nothing for any other type, and the
editor hides the mapping control unless `isPointTile(selectedType)`. So the
diagnostic demanded something no operator could supply, on two of Westgate
Hollow's six points. It now gates on `depictsPoint(tileType)`, and that
predicate lives in `domain/types.ts` beside `TILE_TYPES` so the two cannot drift.

**A pinned end is an assertion, and its absence from the drawing is news.**
This was `pinned-end-not-on-diagram` (#92), and it is gone with `block_ends`
(#103 PR 7) — a compiled label cannot be pinned, and cannot exist without the
opening it was derived from.

The rule it established is the one worth keeping: **a guard tuned for the
common case can silence the case that matters.** `end-not-on-diagram` only fired
once an edge referenced the end, which was right for a generated end (an opening
by construction) and for a hand-authored end naming track not yet drawn (a
legitimate work order) — and wrong for a deliberately pinned end on a layout
with no edges yet, which is exactly when hearing about it is useful. Ask of any
new finding what state it is silent in, and whether that state is the
interesting one.

The same two-tiles-one-point fact is why a point is labelled once per *point*
rather than once per tile (`docs/track-editor.md` D10). One property of the
drawing, two findings — worth knowing as one thing rather than two coincidences.

---

## D12 — A tile's drawn edges are what connect, and touching is not connecting

**Decision (#91).** `services/tileGeometry.ts` holds, for every `TileType`, the
**legs** its drawing joins — pairs of tile edges — in the tile's unrotated
frame. Two cells are connected when the track each draws meets at their shared
boundary: the neighbour's own rotated edge set must contain the opposite edge.
Mere adjacency asserts nothing.

**Why legs and not an edge set**, when block-end generation only needs the set:
a set cannot express a `crossing`. Its two roads deliberately do not
interconnect, and four edges in a bag reads as a four-way junction where any
road reaches any other — a worse version of the blind spot #26 already records.
A point is the same shape of problem in miniature. So `TILE_LEGS` is authored
and `TILE_DRAWN_EDGES` is derived from it, and the two cannot drift.

A `buffer` is the exception that proves the rule: it has **no leg**, because
nothing passes through it. It has one drawn edge, a stub, and it terminates.

**Rotation is applied at derivation, never stored.** Same rule as D9's point
roads, for the same reason: rotation is a single keypress in the editor, and a
stored post-rotation edge is wrong the moment the tile turns.

**Why `services/` and not `domain/`.** `domain/types.ts` keeps the *vocabulary*
— `TILE_TYPES`, `TILE_EDGES`, `TileRotation`, and predicates over it such as
`depictsPoint` above. What must not go there is the mapping from a tile to the
track it depicts, because that is the first step of reading a tile, and the
standing rule is that nothing in `domain/` reads one. The line is between "which
tile types are points" — a fact about the vocabulary — and "which edges this
tile's track touches", which is geometry. Putting the table beside `TILE_TYPES`
would invite precisely the import the rule exists to prevent: a routing decision
reaching for drawn geometry.

**The table tracks `TilePath`.** It is a hand-maintained description of what the
editor draws, and nothing can check that automatically — so every row is
asserted literally in `tests/unit/services/tileGeometry.test.ts`, and a test
iterates `TILE_TYPES` so the next palette addition cannot arrive without one.
The one row worth reading twice is `straight-45`: the palette calls it "Corner"
and it draws `(0,H)→(H,0)`, joining the **west and north edge midpoints**. It
does not run corner to corner.

`packages/frontend/src/diagram/trackGeometry.ts` mirrors this whole table on the
other side of the wire, maintained by hand, and pairs each leg with the SVG path
it is drawn along. It used to be `DRAWN_LEGS` in `diagram/pointRoads.ts` —
*two rows* of this table, free to drift from both this file and the paths the
editor actually drew (`docs/track-editor.md` D16). Still a duplicate, same
situation as `findBlockRuns` existing twice, but a complete one with a test
asserting the pair list literally.

**`track-not-joined`** is the finding this makes possible: drawn track running
into a tile that draws nothing back. `warning`, because the drawing contradicts
itself, and it is the one case where the new model produces an end an operator
would not predict from looking at the diagram. Zero findings on Westgate Hollow
as drawn.
