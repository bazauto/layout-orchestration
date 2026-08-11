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

**Why closed.** Every queued addition to the drawing lands in this blob: #71's
decorative/unassigned classification, #74's tile annotations. A passthrough
schema cannot tell a key a future feature will add from a key a client
misspelled today, and #80's decision 2 explicitly places the classification here
"under a closed Zod schema on #70's validated write path". New fields are added
to `GridTileMetadata` and `gridTileMetadataSchema` together, or not at all.

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

Note what is still **not** handled: deleting a block or point does not clean up
tiles referencing it, so an existing tile can still be left dangling. That is a
cascade-vs-validate-on-read question the annotation work (#74) has to answer for
its own references anyway, and it is deliberately deferred to there rather than
answered twice.

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
