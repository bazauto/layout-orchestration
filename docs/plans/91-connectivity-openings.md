# #91 — Block openings from track connectivity, not tile adjacency

Implementation plan. One PR. No schema change, no migration.

Verified against the live `packages/backend/data/layout.db` (90 tiles, 9 blocks,
15 `block_ends` rows of which 4 pinned, **0** `block_edges` rows) by running the
proposed algorithm over the real grid before writing this.

---

## Design decisions

### D1 — An opening is where **drawn track leaves the run**, not where a foreign cell touches it

Today `generateBlockEnds` calls a tile an opening if any of its eight neighbour
cells is not in the same run. Two parallel yard roads touch along their whole
length and connect nowhere, so every tile of both is an opening; they cluster
into one phantom end at the middle of the run.

The replacement rule, applied per tile of a run, per **drawn tile edge**:

| the drawn edge faces | result |
|---|---|
| a tile of the same run whose own edge set reciprocates | internal — no opening |
| a tile **not** of this run whose edge set reciprocates | **connection** opening |
| an empty cell | **terminus** opening (open air) |
| a tile whose edge set does **not** reciprocate | **terminus** opening, plus a `track-not-joined` diagnostic (D9) |

"Reciprocates" means: the neighbour's own rotated edge set contains
`oppositeEdge(e)`. Connectivity is therefore mutual, and a tile that merely sits
next to another asserts nothing.

`outward` stays half a cell toward the neighbouring cell (`EDGE_OFFSET[e]/2`),
so the bearing maths downstream is unchanged.

### D2 — The per-tile edge table

Every `TileType`, in the tile's **unrotated** frame, tracking exactly what
`TilePath` in `packages/frontend/src/components/GridEditor.tsx` draws:

| `tileType` | drawn edges (unrotated) | drawn as |
|---|---|---|
| `straight-h` | `w`, `e` | line `(0,H)→(T,H)` |
| `straight-v` | `n`, `s` | line `(H,0)→(H,T)` |
| `straight-45` | `w`, `n` | line `(0,H)→(H,0)` — the palette's "Corner"; it joins two **orthogonal** edge midpoints, it does not cross the tile corner-to-corner |
| `curve` | `w`, `s` | arc `(0,H)→(H,T)` |
| `curve-ne` | `s`, `e` | arc `(H,T)→(T,H)` |
| `curve-nw` | `s`, `w` | arc `(H,T)→(0,H)` — same pair as `curve`, drawn the other way round; both are legacy names that must keep round-tripping |
| `curve-se` | `n`, `e` | arc `(H,0)→(T,H)` |
| `curve-sw` | `n`, `w` | arc `(H,0)→(0,H)` |
| `point-left` | `w`, `e`, `n` | through `w–e` + divergent `w–n` |
| `point-right` | `w`, `e`, `s` | through `w–e` + divergent `w–s` |
| `buffer` | `w` **and terminates** | stub `(0,H)→(H,H)` + stop block |
| `platform` | `w`, `e` | through line + platform rect |
| `crossing` | `n`, `e`, `s`, `w` | the two full lines |

The two point rows are the union of `DRAWN_LEGS` in
`packages/frontend/src/diagram/pointRoads.ts` and must stay equal to it. Same
convention, same rotation rule.

### D3 — The table lives in `packages/backend/src/services/tileGeometry.ts`

Not `domain/`. `domain/types.ts` already owns the *vocabulary* (`TILE_TYPES`,
`TILE_EDGES`, `TileRotation`) and keeps it. What must not go there is the
mapping from a tile to the track it depicts, because that is the first step of
reading a tile, and the guardrail recorded in the header of `gridGeometry.ts`
and in `docs/track-grid.md` is that `domain/` never reads one. Putting
`TILE_DRAWN_EDGES` beside `TILE_TYPES` invites precisely the import the
guardrail exists to prevent — a routing decision reaching for drawn geometry.

`services/` is where the only consumers are (`gridGeometry`, `gridDiagnostics`
via `GridService`), and the module is pure — plain data in, plain data out — so
#75 can lift it into a shared module, or the frontend can mirror it by hand the
way `packages/frontend/src/types.ts` already mirrors `domain/types.ts`.

**No frontend mirror in this PR.** Nothing in the frontend needs the table today
(the editor draws SVG paths, not edge sets). `DRAWN_LEGS` becomes a known
duplicate of two rows of it, recorded next to the existing `findBlockRuns`
duplication for #75 to unify.

### D4 — Rotation is applied at derivation time, never stored

`metadata.rotation` rotates the edge set **clockwise in screen coordinates**,
matching SVG `rotate(deg, H, H)`: index step `= rotation / 45` over
`TILE_EDGES` (`['n','ne','e','se','s','sw','w','nw']`). `n @ 90° → e`.
Absent rotation is 0. Identical to #73's rule for `pointRoads`, for the same
reason: rotation is a single keypress, and a stored post-rotation edge is wrong
the moment the tile turns.

Diagonal edges need no special case. No tile type touches one unrotated, but a
45° rotation produces them (`straight-h @ 45° → {nw, se}`), and the model treats
all eight uniformly: one neighbour offset and one opposite per edge.

### D5 — A buffer emits one terminus, on its closed side

`buffer` is the only terminating type today. It emits:

- a connection opening for its drawn edge, if that edge joins a tile outside the
  run (a buffer drawn on a block boundary);
- exactly one **terminus** opening on its closed side —
  `outward = -mean(EDGE_OFFSET[e] for e in drawn edges) / 2` — with
  `terminated: true`;
- **never** an open-air opening from its own drawn edge. The tile asserts track
  ends here; it cannot also have track leaving both ways.

This is what recovers the buffer ends. On Westgate Hollow the west-end buffers
are `rotation: 180` (stub pointing east, into the run), so their drawn edge
joins internally and produces nothing; the terminus is the entire contribution.

Degenerate guard: a terminating tile with an empty drawn-edge set falls back to
the old dead-end vector, `at - runCentroid`; if that is zero, `bearingLabel`
returns `null` and the opening is dropped, exactly as today.

### D6 — `terminated` aggregates with `every()`, not `some()`

At both aggregation points — the cluster loop in `generateBlockEnds` and
`groupOpenings`. An end is a dead end only if **every** opening making it up is
terminated.

`some()` is the bug's fourth mechanism: it let one buffer tile mark a fused
whole-siding end as finished, which suppressed `end-unfinished` for both Fiddle
Yards on a layout with zero authored edges. It stays wrong under the new model
for a real shape: a handover face where one cell is buffered and the next
continues into another block reads as "finished" under `some()`, and would emit
a false `buffer-contradicted-by-edge` warning the moment the edge is authored.
`every()` reports it as unfinished until the edge exists, which is true.

### D7 — Openings are per drawn edge; the clustering and labelling rules are unchanged

The current `OpeningTile` comment says one opening per tile, not one per
direction. That reasoning was a consequence of adjacency: a junction cell
touches its neighbour on up to three of eight *sides*. Under D1 the unit is a
**leg**, and two legs leading to two different blocks are two different places
the block opens.

Everything downstream stays exactly as #72 built it:

- cluster adjacent openings that face compatibly (dot product > 0);
- label by `bearingLabel` from the **run's** centroid to the opening position;
- one end per `(block, label)`; two non-adjacent openings sharing a label are a
  refused collision, never a suffix;
- pinned labels are never regenerated.

Rejected: labelling from the edge direction instead of the centroid bearing.
Checked against the live grid — it collapses the Engine / Goods Transfer's
`northwest` end into `east` and puts three `east` ends on one block. The
centroid bearing is better information and it is also the recorded decision.

Known property, recorded rather than fixed: whether a throat tile with two
outward legs yields one end or two depends on how the two bearings round. On
Westgate Hollow, Fiddle Yard 1's throat gives one `east` end covering both the
feeder and Fiddle Yard 2; a slightly different drawing would give `east` and
`southeast`. Both are legitimate — `(from_block_id, from_end)` is deliberately
not unique, so one end may carry several edges. Do not add a merge rule for it:
over-merging (two openings quietly sharing one name) is the failure #72 refuses,
and it is worse than two names for one place.

### D8 — Runs stay adjacency-based; only openings become connectivity-based

`findBlockRuns` keeps its 8-connected flood fill over same-`blockId` tiles.
Two reasons: it must keep matching `diagram/blockRuns.ts`, which decides tints
and labels and is a drawing concern (#75 unifies them); and a
connectivity-based run would eject a mis-drawn buffer from its own siding and
give it a run — and a pair of ends — of its own.

### D9 — Drawn track that butts a tile which does not meet it is reported

New advisory diagnostic, `track-not-joined`, severity **`warning`** under D11's
rule: one representation contradicts itself, which is the "two representations
disagree" class. It is the only way an operator learns why an end appeared in
the middle of a run.

Computed by a separate pure pass over **all** tiles, not inside the run walk:
the run walk only iterates block tiles, so it would miss a decorative tile
drawing into a block tile that draws nothing back.

Zero findings on the current Westgate Hollow grid — verified — so this adds no
noise on adoption.

### D10 — `BlockOpening` gains no public field

The new derivation knows which tile and which block each connection opening
joins. Keep it on the internal record only. Exporting a `connectsTo` nobody
reads is speculative; #78 (propose candidate `block_edges`) is the consumer and
will export it, and it will not have to re-derive it.

### D11 — Rollout needs no code change

No schema change, no migration. `block_edges` is empty on the live layout, so
regeneration renames nothing anything depends on — this is the cheapest moment
the fix will ever land, which is why the issue says so.

The existing safety machinery is already sufficient and was re-read to confirm
it: `BlockEndService.generate` runs `adoptEdgeReferencedLabels` **first**, so any
label an edge references is pinned before anything is deleted;
`repository.replaceGeneratedBlockEnds` deletes only unpinned rows and skips
inserting a generated label a pinned row already holds. All four currently
pinned labels (Fiddle Yard 1 `west`, Fiddle Yard 2 `west`, Siding 1 `east`,
Siding 2 `east`) are still produced by the new geometry, so nothing is orphaned.

Operator procedure is in Step 8.

---

## Open questions (with recommendations)

### OQ1 — The Engine / Goods Transfer loses a usable end name, and #78 needs one

Under the fix the Transfer has three openings: `northwest` at (13,4) to the
entry feeder, and two more at (18,8) → Engine Shed 2 and (19,10) → Goods Shed.
Both of the latter bear **southeast** from the run centroid, so #72 refuses to
name either and reports one collision. Today the buggy code fuses them into a
single `southeast` end, which looks tidier and is wrong — it is one name for two
physically separate openings.

No bearing scheme can separate them: both openings face east, from a diagonal
run, and the only distinguishing fact is which block is on the other side.

**Recommendation: accept the collision.** It is the designed behaviour, the
operator resolves it by hand-creating two pinned ends before authoring edges,
and refusing to guess is the whole point of #72.

Consequence that must be accepted with it: a hand-created end for a collided
opening has `geometry: null`, so it does not draw on the diagram, and once an
edge references it the diagnostics report `end-not-on-diagram` — a warning for a
situation the operator deliberately created. Fixing that needs an optional
anchor coordinate on `block_ends`, which is a schema change and a different
issue. **Recommend filing it as a follow-up and not doing it here.**

Rejected alternative: merge two same-label openings of one block regardless of
distance, giving one `southeast` end with two edges. Legal (`(from_block_id,
from_end)` is not unique) and exactly the silent mis-naming #72 exists to refuse.

### OQ2 — Ship the `track-not-joined` diagnostic in this PR?

It costs a diagnostic kind, an emit path, a mirrored union member and one line of
copy. It finds nothing on the current layout, so it cannot be validated against
real data beyond "does not fire spuriously".

**Recommendation: ship it.** Without it, the non-reciprocating case (D1, row 4)
is silent, and it is the one case where the new rule produces an end an operator
would not predict from looking at the drawing. If the reviewer disagrees, drop
Step 6 alone; nothing else depends on it.

### OQ3 — Nothing here is a safety change; no scenario test is planned

`domain/` does not read tiles, `TopologyService` does not consult one, and the
diagnostics are advisory. This changes authoring geometry and an advisory report
only, so the coverage is unit plus HTTP integration. Stated explicitly so the
implementer does not invent a scenario test to satisfy the habit.

---

## Plan

### Step 1 — `services/tileGeometry.ts`: the per-tile edge model

**Files:** create `packages/backend/src/services/tileGeometry.ts`.

**Change:** a pure module, no imports outside `domain/types`.

```ts
export interface EdgeOffset { dx: number; dy: number }

/** Which neighbouring cell each tile edge faces. `y` increases downward — north is the top of the diagram. */
export const EDGE_OFFSET: Readonly<Record<TileEdge, EdgeOffset>>;

/** The edges the drawing touches, in the tile's UNROTATED frame. Tracks `TilePath`; if the drawing changes, this changes. */
export const TILE_DRAWN_EDGES: Readonly<Record<TileType, readonly TileEdge[]>>;

/** Tile types whose drawing asserts "track ends here, nothing continues beyond". */
export const TERMINATING_TILE_TYPES: ReadonlySet<TileType>;

export function oppositeEdge(edge: TileEdge): TileEdge;
export function rotateEdge(edge: TileEdge, rotation?: TileRotation): TileEdge;

/** The rotated edge set of a tile. An unrecognised `tileType` draws nothing. */
export function drawnEdges(tileType: string, metadata: GridTileMetadata): ReadonlySet<TileEdge>;

export function terminatesTrack(tileType: string): boolean;
```

Table contents exactly as D2. `rotateEdge` steps `rotation / 45` places
clockwise through `TILE_EDGES` (D4). `oppositeEdge` is `+4 mod 8`.

`drawnEdges` takes `tileType: string`, not `TileType`: `toGeometryTiles` casts a
bare DB column, so an unrecognised legacy value must be tolerated. It returns an
empty set — such a tile draws nothing, joins nothing, and therefore *creates*
open ends in its neighbours rather than silently absorbing them. Fail-visible,
consistent with D10 of `docs/track-grid.md`.

File header must state: the table tracks `TilePath`; legs are unrotated for
#73's reason; this is in `services/` and not `domain/` for D3's reason; and
`DRAWN_LEGS` in `packages/frontend/src/diagram/pointRoads.ts` is the frontend's
partial duplicate until #75.

**Test:** new `packages/backend/tests/unit/services/tileGeometry.test.ts`.

- every member of `TILE_TYPES` has a row in `TILE_DRAWN_EDGES` (iterate the
  constant — this is what catches the next palette addition);
- each row's contents, asserted literally, one case per type;
- the `point-left` / `point-right` rows equal the union of `DRAWN_LEGS`, with a
  comment naming that file;
- `rotateEdge`: `n@90→e`, `w@180→e`, `n@45→ne`, `w@270→n`, `e@0→e`,
  `e@undefined→e`;
- `drawnEdges` applies rotation: `straight-h@90 → {n,s}`, `straight-45@90 →
  {n,e}`, `buffer@180 → {e}`, `straight-h@45 → {nw,se}`;
- `oppositeEdge` for all eight, and `oppositeEdge(oppositeEdge(e)) === e`;
- `EDGE_OFFSET.n` is `{dx:0, dy:-1}` — north is up, the screen convention, and
  inverting it would name every end its opposite;
- **failure path:** `drawnEdges('not-a-tile' as TileType, {})` is empty and does
  not throw;
- `terminatesTrack('buffer')` true, `('platform')` and `('crossing')` false.

Nothing consumes the module yet; the repo is green.

### Step 2 — Derive openings from connectivity

**Files:** `packages/backend/src/services/gridGeometry.ts`.

**Change:** replace the body of the per-run loop in `generateBlockEnds`. Leave
`findBlockRuns` (D8), `bearingLabel`, `clusterTiles`, `sameDirection`,
`representative` and `groupOpenings` untouched.

Precompute once, before the run loop:

```ts
const edgesByKey = new Map<string, ReadonlySet<TileEdge>>(); // every tile, rotation applied
```

Replace `interface OpeningTile` with:

```ts
/** One place drawn track leaves a run, before it is named. */
interface RunOpening {
  at: Coordinate;
  /** Half a cell toward what lies beyond, so the bearing maths is unchanged. */
  outward: Coordinate;
  /** Only a terminating tile sets this (D5). */
  terminated: boolean;
  /** The tile beyond, when one joins. Internal — #78 is what exports it (D10). */
  joinedAt: Coordinate | null;
  joinedBlockId: BlockId | null;
}
```

Per member tile, apply D1's table and D5's buffer rule. Feed the resulting
`RunOpening[]` into the existing `clusterTiles(openings, sameDirection)` loop
unchanged.

Rewrite the block comments that encode the old model: the `OpeningTile`
"one per tile, not one per direction" note (D7), and the `generateBlockEnds`
docstring's "contact"/"terminus" definitions (D1). Both currently describe the
bug as if it were the design.

**Test:** `packages/backend/tests/unit/services/gridGeometry.test.ts`.

New cases — the first is the issue's reproduction and must be written first and
seen to fail:

1. **two parallel single-row blocks on adjacent rows yield two ends each.**
   `b1` at (0,0),(1,0),(2,0) and `b2` at (0,1),(1,1),(2,1), all `straight-h`.
   Expect `b1` = `west`@(0,0) + `east`@(2,0), `b2` = `west`@(0,1) +
   `east`@(2,1), and no collisions. *Failure path:* before the fix this yields
   one mid-run end per block, labelled `south`/`north`, at (1,0)/(1,1).
2. **a block does not open toward a block it merely touches.** Same fixture;
   assert no opening of either block is labelled `north` or `south`.
3. **the Fiddle Yard shape.** Add `buffer` with `rotation: 180` at the west end
   of each row. Expect `west` terminated at the buffer tile and `east` not
   terminated at the far tile, per block. *Failure path:* before the fix, one
   `south`/`north` end at the middle of the run, wrongly `terminated`.
4. **rotation is honoured at derivation.** A vertical run drawn as three
   `straight-h` tiles with `rotation: 90` at (0,0),(0,1),(0,2) yields `north`
   and `south`, not `west` and `east`.
5. **a drawn edge into a non-reciprocating neighbour is an opening, not a
   join.** `b1` `straight-h` at (0,0),(1,0); `b2` `straight-v` at (2,0). Expect
   `b1` has an `east` end, and `b2` has `north` and `south` and **no** `west`.
6. **a point tile's divergent leg opens the block toward what it joins.**
   `b1` = (0,0),(1,0) `straight-h` + (2,0) `point-left` `rotation: 180`;
   `b2` = (2,1) `straight-45` `rotation: 0` + (1,1),(0,1) `straight-h`. Expect
   `b1` gains an opening at (2,0) toward `b2` and `b2` gains one at (2,1) back.
7. **an open-air end is not terminated.** Only a buffer sets `terminated`.

Amend — its expectation encodes the bug:

- **`collapses a multi-cell handover face into a single end`** (three rows, `b1`
  at x=0 and `b2` at x=1). The single-end-per-face assertion holds and is still
  the point of the test. But each `straight-h` in the `b1` column also draws a
  west stub into empty space, so `b1` now correctly gains `west`@(0,1) and `b2`
  gains `east`@(1,1). Update both expectations to the two-end sets and add a
  sentence saying why the outer ends are real.

Unchanged and must keep passing: every `bearingLabel` case; every
`findBlockRuns` case; `names the two ends of a straight block west and east`;
`finds an opening where one block hands over to another`; `finds an opening onto
decorative track…`; `marks an end terminated when a buffer tile sits at it`;
`refuses to name two separate openings that face the same way`; `produces
nothing for a layout with no block-tagged tiles`; `is deterministic across input
order`. All eight were checked against the new model before this plan was
written — they pass without edits.

### Step 3 — `terminated` becomes `every()`

**Files:** `packages/backend/src/services/gridGeometry.ts` — the two
`cluster.some((o) => o.terminated)` / `c.some(...)` sites, in the cluster loop of
`generateBlockEnds` and in `groupOpenings`.

**Change:** `some` → `every`, with a comment carrying D6's reasoning.

**Test:** `gridGeometry.test.ts`, one new case.

- **a mixed face is not a finished dead end.** `b1` at (0,0) `buffer` and (0,1)
  `straight-h`; `b2` at (1,1) `straight-h`. The `b1` opening cluster contains a
  terminated buffer and a connection into `b2`. Expect one end,
  `terminated: false`. *Failure path:* with `some()` the end reads as finished,
  which suppresses `end-unfinished` and, once the `b1→b2` edge is authored,
  raises a false `buffer-contradicted-by-edge`.
- Re-assert `marks an end terminated when a buffer tile sits at it` still gives
  `terminated: true` — the all-terminated cluster is the common case and must
  not regress.

### Step 4 — HTTP-level coverage of the fix

**Files:** `packages/backend/tests/integration/blockEnds.test.ts` only.

**Change:** none to `src`. This step proves the fix through the real write path
and the real repository, which is where the live layout's shape actually lives.

**Test:** two new cases in `describe('POST .../block-ends/generate')`:

- **two sidings drawn on adjacent rows get two ends each.**
  `drawSiding(BLOCK_A, 0)` + `drawSiding(BLOCK_B, 1)` (the existing helper —
  two `straight-h` and a `buffer`). Expect `BLOCK_A` and `BLOCK_B` each list
  exactly `east` and `west`, and `summary.collisions` is empty. *Failure path:*
  before the fix each block gets one end named for the row above or below.
- **an unfinished yard road is reported as unfinished.** Same fixture with
  `bufferAtEnd = false`, no edges, then `GET .../grid/diagnostics`: expect
  `end-unfinished` for all four ends. *Failure path:* the fused end inherited a
  buffer flag and the check never fired — the "hides real work" consequence in
  the issue.

Every existing test in this file must pass unchanged. `drawSiding` draws
unrotated `straight-h`/`buffer`, which the new model reads as `west` + `east`
with the east one terminated; this was checked against all of them, including
the collision, pinning and diagnostics cases.

### Step 5 — Expose the unjoined pass

**Files:** `packages/backend/src/services/gridGeometry.ts`,
`packages/backend/src/services/GridService.ts`.

**Change:** add to `gridGeometry.ts`:

```ts
/** Drawn track that stops against a tile which has nothing meeting it. */
export interface UnjoinedEdge {
  at: Coordinate;
  edge: TileEdge;
  /** The cell it butts against. Always occupied — open air is a legitimate line end, not a fault. */
  against: Coordinate;
}

/** Pure, over ALL tiles — not only block ones, so a decorative tile drawing into a block tile is caught too. */
export function findUnjoinedEdges(tiles: readonly GeometryTile[]): UnjoinedEdge[];
```

Sorted by `(y, x, edge)` for a stable diagnostics list. `GridService.diagnose`
calls it and passes the result into `runGridDiagnostics`.

**Test:** `gridGeometry.test.ts`.

- reports the `straight-h` butted against a `straight-v` exactly once, naming
  edge `e` at the `straight-h` tile;
- returns `[]` for the fully-joined parallel-roads fixture from Step 2 — the
  no-noise guarantee this diagnostic lives or dies by;
- returns `[]` for a line end in open air: an unoccupied neighbour is never a
  finding;
- catches the mirror direction: a decorative tile drawing east into a block tile
  that draws nothing back is reported at the decorative tile.

### Step 6 — The `track-not-joined` diagnostic

Depends on OQ2 being answered yes. Nothing else depends on this step.

**Files:** `packages/backend/src/services/gridDiagnostics.ts`,
`packages/frontend/src/types.ts`, `packages/frontend/src/diagram/diagnostics.ts`.

**Change:**

- `GridDiagnostic` gains
  `{ kind: 'track-not-joined'; severity: 'warning'; at: Coordinate; edge: TileEdge; against: Coordinate }`;
- `DiagnosticsInput` gains `unjoined: readonly UnjoinedEdge[]`;
- `tileDiagnostics` (or a small sibling) maps each entry to a finding;
- mirror the union member in `packages/frontend/src/types.ts`;
- add the sentence to `describeDiagnostic` — the switch is exhaustive, so TS
  fails the build until it is there. Wording: name both cells and say what it
  means, e.g. *"Track at (2, 0) is drawn leaving through its east side, but the
  tile at (3, 0) has nothing meeting it. The block ends at that edge."*

**Test:** `packages/backend/tests/integration/blockEnds.test.ts`, in
`describe('GET .../grid/diagnostics')`:

- a `straight-h` butted against a `straight-v` produces one `track-not-joined`
  at `warning`, naming both cells;
- the adjacent-sidings fixture from Step 4 produces **none** — the false-positive
  guard, and the reason this is safe to turn on for the live layout;
- **failure path:** it never Safe-Stops and never refuses the grid write that
  created it. `service.getSystemStatus().status` stays `online` after the write
  and after the read, matching the existing `never Safe-Stops, however much it
  finds` case.

### Step 7 — Documentation, in this PR

**Files:**

- `docs/topology.md` — in *Block ends: derived by default, authored by
  exception (#72)*, add a subsection **"An opening is drawn connectivity, not
  cell adjacency (#91)"** carrying D1, D5 and D6, and the D7 note that a throat
  may yield one end or two. Amend *Geometry can propose connectivity; it can
  never supply length*: its opening sentence ("derives openings from tile
  adjacency") is now false — it derives them from tile connectivity. The
  length rule itself is unchanged and must stay.
- `docs/track-grid.md` — new **D12 — a tile's drawn edges are what connect, and
  touching is not connecting**, carrying D2, D3, D4 and D9. Cross-reference D9
  (point roads) for the shared unrotated-frame rule.
- `packages/backend/src/services/gridGeometry.ts` header — the "what a generated
  label means" and "never derived from here" sections stand; add a paragraph on
  what an opening now is, and delete nothing about pinned labels.
- `packages/frontend/src/diagram/pointRoads.ts` — one comment line above
  `DRAWN_LEGS` naming `services/tileGeometry.ts` as the full table it is two
  rows of.
- `CLAUDE.md` — rewrite the **Block ends (#72)** row rather than appending to
  it: openings come from drawn connectivity (tile type + rotation), not cell
  adjacency; labels are still bearings from the run centroid; a rename of an
  edge-referenced end is still a 409. Extend the **Open limits** bullet about
  `findBlockRuns` existing twice to name `TILE_DRAWN_EDGES` / `DRAWN_LEGS` as
  the second duplicate #75 unifies. Do not add a new Traps entry — the row now
  says the right thing.
- `README.md` — check Known Limits for any claim about end generation; amend if
  present.

**Test:** none. Prose. But `npm run lint` from the repo root must pass, and the
PR must not be opened with any of these outstanding.

### Step 8 — Rollout on Westgate Hollow

No code. This is the runbook that goes in the PR description.

**Predicted result, computed against the live database.** Before regenerating,
confirm `block_edges` is still empty (Configure → Edges, or
`select count(*) from block_edges`). If it is not, stop and read D11: adoption
pins referenced labels first so nothing is renamed, but a pinned label the new
geometry no longer produces will start reporting `end-not-on-diagram`, which is
a to-do and not a break.

1. Deploy. No migration to apply.
2. Track Editor, as an admin, press **Ends ⟳**.
3. Expect the summary line: **9 created, 7 removed, 0 adopted, 1 collision.**
   - created: Fiddle Yard 1 `east`, Fiddle Yard 2 `east`, Siding 1 `west`,
     Siding 3 `east`, Siding 3 `west`, Engine Shed 1 `east`, Engine Shed 1
     `west`, Engine Shed 2 `east`, Engine Shed 2 `west`;
   - removed: Fiddle Yard 1 `south`, Fiddle Yard 2 `north`, Siding 1 `south`,
     Siding 3 `north`, Engine / Goods Transfer `southeast`, Engine Shed 1
     `south`, Engine Shed 2 `north`;
   - unchanged: the four pinned rows (Fiddle Yard 1 `west`, Fiddle Yard 2
     `west`, Siding 1 `east`, Siding 2 `east`), plus Siding 2 `west`, Goods Shed
     `east`, Goods Shed `west`, Engine / Goods Transfer `northwest`;
   - collision: Engine / Goods Transfer `southeast`, at (18,8) and (19,10).
4. The 17 ends afterwards, which the diagram should show sitting on real tiles:

   | block | ends |
   |---|---|
   | Fiddle Yard 1 | `west` (1,3) buffer · `east` (11,3) |
   | Fiddle Yard 2 | `west` (1,4) buffer · `east` (11,4) |
   | Siding 1 | `west` (20,3) · `east` (26,3) buffer |
   | Siding 2 | `west` (20,4) · `east` (26,4) buffer |
   | Siding 3 | `west` (20,5) · `east` (26,5) buffer |
   | Engine Shed 1 | `west` (19,7) · `east` (26,7) buffer |
   | Engine Shed 2 | `west` (19,8) · `east` (26,8) buffer |
   | Goods Shed | `west` (20,10) · `east` (26,10) buffer |
   | Engine / Goods Transfer | `northwest` (13,4) + one unresolved collision |

5. Resolve the collision by hand before authoring any edge: create two pinned
   ends on Engine / Goods Transfer, named for what is on the other side rather
   than for a compass point. They will show `geometry: null` and will not draw
   on the diagram — OQ1's accepted consequence.
6. Only then author `block_edges` (or run #78, which this unblocks).

**Test:** `npm test` and `npm run lint` from the repo root, quoting real output.
Then, before merging, re-run the generation against a copy of
`packages/backend/data/layout.db` and diff the result against the table in
step 4. If it does not match, the model changed and this plan's numbers are
stale — do not adjust the numbers to match the code without saying why.

---

## Out of scope

- **#78, proposing candidate `block_edges` from the opening set.** This PR is
  what makes that safe; it does not do it. The joined-neighbour information the
  new derivation computes stays internal (D10).
- **An anchor coordinate on `block_ends`**, which is what would let a
  hand-named end for a collided opening draw on the diagram (OQ1). Schema
  change, separate issue.
- **Unifying `findBlockRuns` and the edge table across the two packages** —
  that is #75.
- **Deriving `block_edges` from the drawing automatically**, and deriving
  `lengthMm` from tile count. Still refused, for the reason `docs/topology.md`
  already records.
- **Point-position feedback (#25)** and the plain-diamond blind spot (#26). The
  new model gives a `crossing` tile four drawn edges, which is honest about the
  geometry and changes nothing about the fact that route conflicts through one
  are not detected.
