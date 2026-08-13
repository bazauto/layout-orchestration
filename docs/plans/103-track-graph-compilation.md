# #103 — Compile the track graph from the drawing

Implementation plan. **Seven PRs**, each individually mergeable, each green on
`npm test` from the repo root, each leaving the system coherent.

The design is accepted and recorded in `docs/track-graph-compilation.md`
(D1–D10). Nothing below re-litigates it. Where the record and the code disagree,
the disagreement is named in *Contradictions found* rather than resolved
silently.

Assumes **#104 is already fixed** on its own branch: arriving at a block's point
tile requires only that some authored road includes the arriving leg, the road's
`when` supplying the conditions. Departure keeps the `leadsIntoBlock` test. This
plan builds on that shape and does not re-plan it.

## Verified against the live database

Run against `packages/backend/data/layout.db` before writing this, not trusted
from `CLAUDE.md`:

| table | rows |
|---|---|
| `block_edges` | **0** |
| `block_ends` | 19 (6 pinned) |
| `blocks` | 9 |
| `grid_tiles` | 90 (6 carrying `pointRoads`) |
| `route_reservations` | 3, all `released` — nothing `active` or `suspended` |

Three consequences that shape the whole migration story:

1. **There is no window in which the pathfinder plans on nothing, because it
   already plans on nothing.** Every "how does a deployment with authored edges
   reach the compiled world" question is moot on this layout. The plan still
   states what a non-empty deployment would need (PR 3), but nothing is
   sequenced around it.
2. **No `block_edges.length_mm` value exists to preserve**, so dropping the
   column is a table rebuild over zero rows.
3. **No `block_ends` label is load-bearing**, because no edge references one.
   All 19 rows, pinned included, are disposable.

---

## Design decisions

### D-A — The walk is moved, not copied

`services/edgeProposals.ts` holds the port walk. The compiler needs exactly that
walk with a different output shape. PR 2 **moves** `walkFrom`, `exitsOf`,
`pointTransitConditions`, `mergeConditions` and `rotatedLegs` into
`services/trackGraphCompiler.ts` and leaves `edgeProposals.ts` as a thin shim
over `compileConnections` until PR 5 deletes it. Two copies of a point-condition
walk, even for one PR, is the exact failure mode #103 exists to end.

### D-B — Gaps are one flat list; connected components are not a gap

D7 asks for four assertions. Three of them (`block-not-in-graph`,
`opening-unresolved`, `block-without-detection`) are unambiguous holes and every
one of them gates `auto`.

The fourth — "one connected component, or its components are named" — is not.
A layout with two genuinely separate railways is legal, and a gap has no
acknowledge mechanism, so making it a gap would gate `auto` **permanently** with
no way out. So: `CompileReport.components: BlockId[][]` is always present, and
`components.length > 1` is rendered prominently by the review UI. Named, as D7
requires; not a gate.

Every other `CompileGap` gates `auto` with no severity field. There is no
`warning`/`info` split here — that is the grid diagnostics' rule, and D6 is
explicit that a compile gap is a different object from a diagnostic.

### D-C — Auto is gated at the mode transition, and a gappy apply demotes

`canIssueAutoCommand(status, mode)` keeps its signature: it is a pure predicate
over two enums and adding a third argument ripples through every caller for no
gain. The gate goes in two places instead:

- `LayoutService.handleSetMode` throws when the target mode is auto-capable and
  the compiled graph has gaps. The WebSocket transport already turns a throw
  into an `ERROR` frame, so the operator gets the reason.
- After a successful apply that leaves gaps, if the current mode is auto-capable,
  `LayoutService` drops it to `manual` and logs why. Not a Safe-Stop (D9
  forbids that), just the removal of an authority the graph no longer supports.

**`hybrid` is gated as well as `auto`.** D6 names only `auto`, but
`canIssueAutoCommand` returns true for `hybrid`, so gating `auto` alone would
leave the automated-command path open through the side door.

Gap count is read live through a new port rather than cached:
`IGraphCompletenessView { gapCount(layoutId): Promise<number> }`, implemented by
`CompileService`, injected into `LayoutService` as an optional trailing
constructor parameter — the same shape `INameBook` uses. A mode change is a
rare, human-initiated action; 90 tiles is nothing.

### D-D — `TopologyService` stays the only writer of `block_edges`

The compiler reads tiles and produces candidates. The *write* is
`TopologyService.replaceGraph(layoutId, edges, fingerprint)` — the same class
that owns edge validation, the route-lock guard and `onTopologyChanged`. A
second write path for the track graph is what D1's "one process writes
`block_edges`" forbids, and the cheapest way to keep that true is to not build
one.

`CompileService` therefore depends on `TopologyService`, not on the repository's
edge methods.

### D-E — Apply refuses if *any* route holds, not per-target

`TopologyService.updateEdge`/`deleteEdge` guard per target id. A whole-graph
replace touches every edge, so the equivalent guard is "no route may be holding
anything in this layout". `IRouteLockView` gains
`findAnyHeldRoute(layoutId): RouteId | null`.

This is what makes D8's accepted consequence safe: a compile renames ends, and
nothing can be holding a stale string when it happens.

### D-F — The fingerprint is a row in `compiled_graphs`, not a column on `layouts`

One row per layout: `layout_id` (PK, FK → `layouts` cascade),
`drawing_fingerprint`, `compiled_at`. Three reasons over two nullable columns on
`layouts`:

- a `CREATE TABLE` is zero-risk on a live SQLite file; an `ALTER TABLE` on the
  root config table is not zero-risk for no reason;
- "never compiled" is a missing row, not a NULL that every reader must remember
  to check;
- `layouts` is config; a compiled graph's provenance is topology.

No `edge_count`, no `gap_count` columns. Both are recomputable and a stored copy
is a second source of truth about the thing this issue exists to stop having two
of.

### D-G — The fingerprint includes coordinates, and the raw blob of an unreadable tile

D10 lists "tile type, rotation, `blockId`, `trackRole`, `pointId`, `pointRoads`"
and omits `x`/`y`. That must be an oversight: the walk's entire structure is
coordinates. They are in.

`annotations` stay **out** — moving a sensor marker must not stale the graph.

An unreadable tile contributes its **raw** `metadata` string rather than the `{}`
`parseTileMetadata` degrades it to. Otherwise two different corruptions hash
identically and fixing one does not move the fingerprint.

### D-H — Openings get their own cheap read; the compile walk is on demand

`GET .../grid/openings` returns `CompiledOpening[]` — pure geometry, no walk.
The Track Editor calls it on every stroke end (replacing `useBlockEnds`), the
way it already calls `grid/diagnostics`.

`GET .../topology/compile` runs the full branch search and is called when the
review panel is opened. Splitting them keeps a per-stroke read cheap and keeps
"where does this block open" (a drawing question) separate from "what edges does
that imply" (a review action).

### D-I — Labels disambiguate by suffix, and no opening is ever dropped

Per `(blockId, cardinal)`: one cluster → the bare cardinal (`east`). *n* clusters
→ `east-1` … `east-n`, ordered by the cluster representative's `(y, x)` so the
same drawing always produces the same strings.

`bearingLabel` returns `null` for an opening sitting exactly on the run centroid,
and `generateBlockEnds` currently **drops** it. Under D8 that silently loses a
trafficable opening, which is precisely the failure `end-label-collision` was.
Fallback chain: cardinal bearing → the cardinal name of the most common
`TileEdge` among the cluster's ports → `opening-<n>`. All three satisfy
`blockEndLabelSchema` (`^[a-z0-9][a-z0-9_-]*$`).

The generator gains no cleverness beyond this: no 16-point scale, no anchor
coordinate, no `pinned`.

### D-J — The diff matches on the physical connection, not on the label

Labels are regenerated wholesale, so keying the diff on
`(fromBlockId, fromEnd, toBlockId, toEnd)` makes a redraw that renames `east` to
`east-1` read as "every edge removed, every edge added". Useless for review.

Key on `(fromBlockId, toBlockId, conditionKey)`. Within a bucket, pair live and
proposed in sorted-by-end order; surplus on either side falls to `added` /
`removed`. A pair whose labels differ is `relabelled`, which is information the
operator wants and would otherwise drown in noise.

### D-K — Braking sums block lengths; the target block's own length is excluded

`remainingRouteDistanceMm` sums `blocks.length_mm` over path indices
`confirmedIndex + 1 … targetIndex - 1`. Joints contribute zero (D5). The target
block contributes nothing, because B4's target is its **entry boundary**.

Consequence, accepted: when `targetIndex === confirmedIndex + 1` the sum is
**zero** and the run is refused with `insufficient-distance`. That is correct
under block-level occupancy — the train may be anywhere in its confirmed block,
including hard against the exit — and it is the fail-safe direction. It is a
behaviour change from today's model, and it is recorded as a limit rather than
worked around.

### D-L — The pathfinder costs the destination block, not the edge

`DEFAULT_EDGE_LENGTH_MM` becomes `DEFAULT_BLOCK_LENGTH_MM` (same value, 1000).
`relax` costs `blockLengthsMm.get(edge.toBlockId) ?? DEFAULT_BLOCK_LENGTH_MM`.
`TrackGraph` gains `blockLengthsMm: ReadonlyMap<BlockId, number>` — absent means
unmeasured, which costs the default for search and **refuses** for braking. P2's
reasoning is unchanged: guessing a cost is fine, guessing a stopping distance is
a collision.

`buildTrackGraph`'s third parameter is optional and defaults to an empty map, so
every existing test compiles. Absent = unmeasured = refuse is the fail-safe
default, which is what makes the optional parameter acceptable.

---

## Open questions (with recommendations)

### OQ1 — Do `POST` / `PUT` / `DELETE .../edges` survive?

D3 says the compiler owns the whole edge set and a recompile is a replace. If the
manual edge routes stay, a hand-authored edge can be created and silently deleted
by the next compile — the mixed graph D3 forbids, at a new seam.

**Recommendation: delete all three routes and the corresponding
`TopologyService.createEdge` / `updateEdge` / `deleteEdge` methods in PR 5**,
alongside the manual form they serve. `GET .../edges` stays (the Edges tab still
lists the graph). `deleteBlockWithEdges` stays — deleting a block must still
remove its edges atomically, and that is not authoring.

`MAX_EDGES_PER_LAYOUT` admission control moves from `createEdge` to
`replaceGraph`, where it becomes a check on the whole candidate set — which is
what it always should have been.

### OQ2 — Does a plain diamond on a compiled path become a gap?

The walk already reports `crossesDiamond`, and `diamond-blind-spot` is an
existing grid diagnostic (#26).

**Recommendation: no.** It stays a per-edge review flag in the diff and an
advisory diagnostic. Westgate Hollow has no diamond, and turning #26 into an
auto gate is a separate decision about #26, not about compilation.

### OQ3 — What happens to `buffer-contradicted-by-edge`?

It is not in "What this deletes", and it should not be — but it is currently
computed over `block_ends` rows.

**Recommendation: keep it, re-expressed over openings** in PR 7: an opening with
`terminated: true` that the compiled graph nonetheless has an edge through. It
stays a `warning`-severity grid diagnostic, not a gap, because it is a
drawing-versus-graph disagreement and diagnostics are where those live.

### OQ4 — `end-unfinished` is deleted, but its check is not

"What this deletes" lists `end-unfinished`. The check it performs — an opening
with no edge and no buffer — is D7's second assertion.

**Recommendation: the diagnostic is deleted and the check is promoted** to the
compile gap `opening-unresolved`, which gates `auto`. The implementer must not
read "delete `end-unfinished`" as "stop checking for unresolved openings"; the
whole point of D7 is that this check gets *stronger*.

### OQ5 — Is PR 4's `auto` gate wanted before the UI lands?

Nothing drives in `auto` today (`CLAUDE.md`: "Driving a granted route is
manual"), so the gate protects nothing yet.

**Recommendation: land it at PR 4 anyway**, before the UI. It is small, it is
independent, and folding a safety gate into the large UI PR is how safety gates
get reviewed badly. If it is deferred, it must not slip past PR 7.

### OQ6 — Does the review UI need to render `via` paths on the diagram?

The diff lists cells crossed; highlighting them on the canvas would be better
review.

**Recommendation: no, not in this issue.** The panel lives on the Configure →
Edges tab and the canvas is in the Track Editor. Cross-screen highlighting is a
new affordance, not part of #103. `via` renders as a hover title, exactly as
`EdgeProposalsPanel` does today.

---

## Contradictions found between the design record and the code

1. **D10's fingerprint field list omits `x`/`y`.** The walk is structured
   entirely by coordinates. Resolved by D-G: they are included.
2. **D8 says end labels match "`TileEdge`'s vocabulary".** `TileEdge` is
   `n|ne|e|se|s|sw|w|nw`; `CARDINAL_END_LABELS` is `north|northeast|…`. The
   correspondence is positional, not literal. The compiler keeps
   `CARDINAL_END_LABELS` — changing to two-letter labels would rewrite
   `blockEndLabelSchema`'s meaning for no benefit. No action beyond noting it.
3. **"What this deletes" lists `end-unfinished`; D7 requires the same check.**
   See OQ4. It is a rename and a promotion, not a deletion.
4. **D4 says "~40 edges to 10 blocks".** The live layout has 9 blocks and 0
   edges. Cosmetic.
5. **D3 does not say what happens to the manual edge write routes.** See OQ1.
   This is the one genuinely unspecified consequence of D3 and needs a ruling.

---

## Plan

### PR 1 — `blocks.length_mm`, and braking sums blocks (#105)

Closes #105. No compiler yet; this PR stands alone and is worth landing even if
the rest slips.

#### Step 1.1 — Schema

**Files:** `packages/backend/src/adapters/db/schema.ts`,
`packages/backend/migrations/` (generated).

**Change:**

- `blocks` gains `lengthMm: integer('length_mm')`, nullable, with
  `check('blocks_length_positive', sql\`${table.lengthMm} IS NULL OR ${table.lengthMm} > 0\`)`.
  Nullable, not defaulted: NULL means unmeasured, and unmeasured must refuse a
  braked run (B4). A default would assert a measurement nobody took.
- `blockEdges` **loses** `lengthMm` and the `block_edges_length_positive` check.
  Keep `block_edges_connection_unq`, `block_edges_not_self_loop`,
  `block_edges_ends_non_empty` and all three indexes.
- Rewrite the `blocks` and `blockEdges` block comments to carry D4/D5's
  reasoning.

Then, **once**, from the repo root:
`npm run db:generate --workspace=packages/backend`.

Expect **one** migration file (`0008_*.sql`) containing an `ALTER TABLE blocks
ADD length_mm` and a `__new_block_edges` table rebuild. SQLite cannot
`DROP COLUMN` a column named in a `CHECK`, so the rebuild is unavoidable and
correct.

**Read the generated SQL before committing.** If drizzle-kit drops any of the
three surviving constraints or the unique index in the rebuild, regenerate with
`drizzle-kit generate --custom` and hand-write it, following
`0006_users_last_admin_guard.sql`'s precedent. Do not edit an already-committed
migration.

**Test:** `packages/backend/tests/integration/migrations.test.ts`.

- `PRAGMA table_info(blocks)` contains `length_mm`, nullable;
- inserting a block with `length_mm = 0` and `-1` is rejected, `NULL` accepted;
- `PRAGMA table_info(block_edges)` does **not** contain `length_mm`;
- the surviving `block_edges` constraints still bite: amend the existing
  self-loop, duplicate-connection and empty-end cases to run after the rebuild
  and assert they still reject. **This is the failure path that matters** — a
  rebuild that silently drops a `CHECK` looks identical to a successful one.
- delete the `rejects length_mm of 0 and -5, but allows NULL` case for
  `block_edges` and re-add its equivalent for `blocks`.

#### Step 1.2 — Types, port, repository, validation

**Files:** `packages/backend/src/domain/types.ts`,
`src/ports/ILayoutRepository.ts`, `src/adapters/db/repository.ts`,
`src/services/validation.ts`, `src/transport/http/routes/blocks.ts`.

**Change:**

- `BlockEdge` loses `lengthMm`.
- `BlockRecord` gains `lengthMm: number | null`.
- `blockEdgeRowSchema` loses `lengthMm`; `parseBlockEdgeRow` stops returning it.
- `edgeCreateSchema` / `edgeUpdateSchema` lose `lengthMm`. `.strict()` already
  turns a body still carrying it into a 400, which is the honest answer.
- `blockCreateSchema` / `blockUpdateSchema` gain
  `lengthMm: z.number().int().positive().nullable().default(null)` (create) and
  `.optional()` (update).
- `repository.createBlock` / `updateBlock` / `listBlocks` carry it;
  `createBlockEdge` / `updateBlockEdge` drop it.

**Test:** `tests/unit/services/validation.test.ts` — an edge body carrying
`lengthMm` is a 400 (`.strict()` failure path); a block body with `lengthMm: 0`
is rejected, `null` accepted. `tests/integration/blocks.test.ts` — round-trip a
measured block through `POST` and `GET`.

#### Step 1.3 — `TrackGraph` carries block lengths

**Files:** `packages/backend/src/domain/graph.ts`,
`src/services/topologyLoader.ts`.

**Change:**

```ts
export interface TrackGraph {
  readonly layoutId: LayoutId;
  readonly edges: ReadonlyMap<BlockEdgeId, BlockEdge>;
  readonly outgoing: ReadonlyMap<BlockId, readonly BlockEdge[]>;
  readonly incoming: ReadonlyMap<BlockId, readonly BlockEdge[]>;
  /** Measured length per block, in mm. An absent key is unmeasured: costed as `DEFAULT_BLOCK_LENGTH_MM` by the search, and refused outright by the braking model (D4). */
  readonly blockLengthsMm: ReadonlyMap<BlockId, number>;
}

export function buildTrackGraph(
  layoutId: LayoutId,
  edges: readonly BlockEdge[],
  blockLengthsMm: ReadonlyMap<BlockId, number> = new Map(),
): TrackGraph;
```

`loadTopology` already fetches `blocks`; it builds the map from rows whose
`lengthMm !== null` and passes it in.

**Test:** `tests/unit/domain/graph.test.ts` — the map round-trips; the default is
empty and does not throw.

#### Step 1.4 — `remainingRouteDistanceMm` sums blocks

**Files:** `packages/backend/src/domain/braking.ts`, `src/domain/types.ts`.

**Change:**

- `BrakingRefusal`'s `unmeasured-track` becomes
  `{ kind: 'unmeasured-track'; blockId: BlockId }`.
- `remainingRouteDistanceMm(reservation, graph, targetIndex)` keeps its
  signature and loops `i` from `confirmedIndex + 1` to `targetIndex - 1`
  inclusive, summing `graph.blockLengthsMm.get(reservation.path[i].blockId)`.
  A missing entry refuses `unmeasured-track` naming that block. Joints add
  nothing (D5).
- `describeBrakingRefusal`'s `unmeasured-track` case reads
  `block ${blockLabel(reason.blockId, book)} has no measured length — unsafe for automated braking`.
- Rewrite the function docstring: it currently states the edge convention as
  fact.

**Test:** `tests/unit/domain/braking.test.ts`.

- three measured blocks, target two ahead → the sum of the **intermediate**
  block only, not the target's;
- `targetIndex === confirmedIndex + 1` → `{ ok: true, distanceMm: 0 }`, and the
  resulting `planBrakingSchedule` refuses `insufficient-distance`. **This is the
  D-K behaviour change and must have its own named test.**
- **failure path:** one unmeasured block anywhere in the summed range refuses
  `unmeasured-track` naming that block, and does not fall back to
  `DEFAULT_BLOCK_LENGTH_MM`;
- `targetIndex <= confirmedIndex` still refuses `target-behind-train`.

#### Step 1.5 — Pathfinder cost

**Files:** `packages/backend/src/domain/pathfinding.ts`.

**Change:** rename `DEFAULT_EDGE_LENGTH_MM` → `DEFAULT_BLOCK_LENGTH_MM` (value
unchanged). `relax` takes the graph's `blockLengthsMm` and costs
`blockLengthsMm.get(edge.toBlockId) ?? DEFAULT_BLOCK_LENGTH_MM`. Update the
constant's docstring to say "block", not "edge".

**Test:** `tests/unit/domain/pathfinding.test.ts` — with no lengths recorded the
search still degenerates to fewest-hops (existing cases pass unchanged); with one
short block on a longer hop-count route, the short route wins.

#### Step 1.6 — Frontend

**Files:** `packages/frontend/src/types.ts`,
`src/components/EdgesTab.tsx`, `src/components/ConfigPanel.tsx`,
`src/hooks/useLayoutConfig.ts`.

**Change:** `BlockEdgeRecord` loses `lengthMm`; `BlockRecord` gains it. Remove
the `Length (mm)` input and table column from `EdgesTab` and
`buildEdgeDraft`/`EdgeFormState`. Add a `Length (mm)` input to the blocks form
in `ConfigPanel`.

**Test:** `tests/e2e/edge-authoring.spec.ts` — remove the length assertions;
`packages/frontend/src/hooks/useLayoutConfig.test.ts` — block create carries
`lengthMm`.

#### Step 1.7 — Docs, in this PR

- `docs/braking.md` — **rewrite B4**: delete the `> This decision is wrong`
  block-quote and state the block-length rule as the decision, including D-K's
  zero-distance consequence as a recorded limit. Add the joints-are-zero rule
  (D5) as a short **B11**, cross-referencing `docs/track-graph-compilation.md`.
- `docs/pathfinding.md` — P2 retitled and rewritten for block length.
- `docs/topology.md` — *Geometry can propose connectivity; it can never supply
  length* is now stronger: length is not on the edge at all. Rewrite in place.
- `docs/track-graph-compilation.md` — mark D4/D5 shipped.
- `CLAUDE.md` — remove #105 from the Open limits bullet; amend the **Track
  topology** row to say edges carry no length.
- `README.md` — check Known Limits for a braking/length claim; amend if present.

---

### PR 2 — The compiler, the fingerprint, and `GET .../topology/compile`

> **PR 2 is complete.** Steps 2.1 and 2.2 shipped as PRs #110 and #111; steps
> 2.3–2.5 shipped together.
>
> **What changed in 2.3–2.5 against what is written below:**
>
> 1. **`CompileService` takes the repository alone**, not
>    `(repo, topology, log)`. `TopologyService` is needed by the *apply* and by
>    nothing in PR 2, and there is nothing to log on a read-only GET. It arrives
>    in PR 3 with `replaceGraph`. Same shape as `GridService` and
>    `BlockEndService`, which are repository-only for the same reason.
> 2. **The port gains `getCompiledGraph` only.** No writer, because nothing
>    writes `compiled_graphs` until the apply does; a writer with no caller is
>    an untested path into the record of which drawing the graph came from.
> 3. **The diff is matched in two passes, not one.** D-J's single bucket on
>    `(fromBlockId, toBlockId, conditionKey)` leaves `CompileDiff.changed`
>    unreachable — conditions are equal inside every such bucket by
>    construction. Resolution: exact-ends first (`unchanged` / `changed`), then
>    D-J's connection key on the remainder (`relabelled`), then
>    `added` / `removed`. D-J's intent is preserved and the safety-relevant case
>    — same openings, different blades — is reported precisely instead of
>    drowning in an add and a remove. Recorded in `docs/topology.md`.
> 4. **`conditionKey` is exported from `trackGraphCompiler.ts`** so the diff and
>    the walk cannot disagree about whether two condition sets are the same.
>
> **Verified against the live drawing**, through the wired endpoint, on a copy
> taken with its `-wal`: 90 tiles, 9 blocks, 0 unreadable → **22 edges, 19
> openings, 1 component, 0 gaps, 0 unique-index tuple conflicts**. The plan's
> baseline, reproduced exactly.
>
> **Corrections found while building them — this plan was written before #104
> and #105 merged, and got three things wrong:**
>
> 1. **"the `assemble` synthesis moves here" is wrong and dangerous.** #104
>    removed that synthesis because mirroring an arrival into a departure
>    manufactures the edge the departure test refuses. Both directions come from
>    the walk. It matters *more* in the compiler than it did in the proposals,
>    since nothing stands between a false edge and the graph the pathfinder
>    plans on. As built: no mirroring, with a test naming #104.
> 2. **The `CompileGap` union's `no-road-into-block` no longer exists.** #104
>    split it into `leg-not-covered-by-road` and `no-road-out-of-block`, and both
>    are carried. `stopped-in-own-block` is dropped as planned.
> 3. **`CompiledEdge` has no length field**, because #105 removed `lengthMm`
>    from `BlockEdge` entirely.
>
> **For step 2.4, one thing the plan does not mention:**
> `parseTileMetadata(json)` returns `{ metadata, ok }` and **never throws** — a
> corrupt blob comes back as `{ metadata: {}, ok: false }` (D10 of
> `docs/track-grid.md`). `CompileInput.unreadable` must therefore be built from
> `ok === false`, not from a `try`/`catch`. Getting this wrong is silent: every
> tile parses, every block disappears, and the compiler returns an empty graph
> with no gaps at all. It cost a debugging round on the live-data probe.
>
> **Baseline for step 2.4, measured against a copy of the live database taken
> with its `-wal`:** 90 tiles, 9 blocks, 0 unreadable → **22 edges, 1 component,
> 0 gaps**, and zero unique-index tuple conflicts. If a wired-up
> `GET .../topology/compile` does not reproduce those numbers, the wiring is
> wrong, not the compiler.
>
> **Copy `layout.db-wal` and `layout.db-shm` alongside `layout.db`.** Reading the
> main file alone gives a stale layout with no error of any kind. It produced 14
> edges, 3 components and 8 gaps from the same drawing, and sent me chasing two
> "unclassified" tiles the operator had correctly marked decorative.

Read-only end to end. Nothing writes `block_edges`; nothing is deleted from the
UI. `block_ends` and the edge-proposal surface both still work.

#### Step 2.1 — Openings, disambiguated

**Files:** `packages/backend/src/services/gridGeometry.ts`.

**Change:** factor the existing per-run opening derivation out of
`generateBlockEnds` into

```ts
/** One place drawn track leaves a run, clustered and bearing-labelled, before disambiguation. */
interface RawOpening { blockId: BlockId; at: Coordinate; label: CardinalEndLabel | null; terminated: boolean; ports: Port[] }
function rawOpenings(tiles: readonly GeometryTile[]): RawOpening[];
```

Note `label` becomes nullable here — the zero-bearing case is no longer dropped
inside the derivation (D-I).

`generateBlockEnds` keeps its exact current behaviour on top of `rawOpenings`
(drops null labels, refuses collisions) so nothing that reads it changes. It is
deleted in PR 7.

Add:

```ts
export interface CompiledOpening {
  blockId: BlockId;
  /** Disposable compiler output (D8). 8-point cardinal, suffixed `-1`…`-n` when a block has several facing the same way. */
  label: string;
  /** A tile of the block, where a label may be drawn. */
  at: Coordinate;
  terminated: boolean;
  /** The tile boundaries this opening covers. Empty for a buffer's closed side. */
  ports: Port[];
}

/** Every drawn block's openings, named. Never refuses and never drops one (D8, D-I). */
export function compileOpenings(tiles: readonly GeometryTile[]): CompiledOpening[];
```

Suffix and fallback rules exactly as D-I. Output sorted by
`(blockId, label)` for a stable diff.

**Test:** `tests/unit/services/gridGeometry.test.ts`.

- the Engine / Goods Transfer shape (two openings both bearing `southeast` from
  the run centroid) yields `southeast-1` and `southeast-2`, deterministically
  ordered by `(y, x)`. **This is the fixture that used to produce
  `end-label-collision` and it is the reason the feature exists.**
- a single opening keeps the bare cardinal — no gratuitous `-1`;
- **failure path:** an opening whose bearing is zero gets a port-derived label,
  not dropped, and the returned list length matches the raw opening cluster
  count;
- output is stable across input permutation;
- every existing `generateBlockEnds` case still passes byte-for-byte.

#### Step 2.2 — `services/trackGraphCompiler.ts`

**Files:** create `packages/backend/src/services/trackGraphCompiler.ts`; gut
`packages/backend/src/services/edgeProposals.ts`.

**Change:** move `walkFrom`, `exitsOf`, `pointTransitConditions`,
`mergeConditions`, `rotatedLegs` and the constants
(`MAX_COMPILED_PATH_TILES`, `MAX_BRANCHES_PER_OPENING`) into the new module
(D-A). `edgeProposals.ts` keeps only `EdgeProposal`, `reconcileProposals` and a
shim that shapes `compileConnections` output into `EdgeProposalReport`.

New module surface:

```ts
export interface CompiledEdge {
  fromBlockId: BlockId;
  fromEnd: string;
  toBlockId: BlockId;
  toEnd: string;
  pointConditions: PointCondition[];
  /** Review aid, never persisted: cells crossed between the two blocks, in walk order. */
  via: Coordinate[];
  /** Review aid, never persisted: the path crosses a plain diamond (#26, OQ2). */
  crossesDiamond: boolean;
}

export type CompileGap =
  /** D7 — a drawn block that appears in no edge. The assertion the per-cell notes could not make. */
  | { kind: 'block-not-in-graph'; blockId: BlockId }
  /** D7/D9 — a block in the graph with no in-service sensor. Load-bearing, not tidy: it is what makes the mis-mapped-point argument hold. */
  | { kind: 'block-without-detection'; blockId: BlockId }
  /** D7 — an opening that produced no edge and is not terminated by a buffer. Supersedes `end-unfinished` (OQ4). */
  | { kind: 'opening-unresolved'; blockId: BlockId; label: string; at: Coordinate }
  /** A tile names a block that no longer exists. Would be an `unknown-block` violation if emitted. */
  | { kind: 'dangling-block-reference'; at: Coordinate; blockId: BlockId }
  /** D9 — a corrupt blob, distinguished from an untagged tile. */
  | { kind: 'tile-metadata-unreadable'; at: Coordinate }
  /** Supporting evidence: the walk stopped here. */
  | { kind: 'unclassified-tile-blocks-walk'; at: Coordinate }
  | { kind: 'point-tile-unmapped'; at: Coordinate; pointId: PointId }
  | { kind: 'no-road-into-block'; at: Coordinate; blockId: BlockId; edge: TileEdge }
  | { kind: 'search-truncated'; blockId: BlockId; at: Coordinate };

export interface CompileReport {
  /** SHA-256 hex over exactly what the walk reads (D10, D-G). */
  fingerprint: string;
  edges: CompiledEdge[];
  openings: CompiledOpening[];
  gaps: CompileGap[];
  /** Connected components of the candidate graph, each sorted. Length > 1 is named, never gated (D-B). */
  components: BlockId[][];
}

export interface CompileInput {
  tiles: readonly GeometryTile[];
  /** Coordinates whose metadata blob failed to parse, with the raw string, for the fingerprint (D-G). */
  unreadable: readonly { at: Coordinate; raw: string }[];
  blocks: readonly { id: BlockId }[];
  sensors: readonly { blockId: string | null; inService: boolean }[];
}

/** Pure. Plain data in, plain data out — no repository, no clock, no I/O. */
export function compileTrackGraph(input: CompileInput): CompileReport;

/** The walk alone, shared with `edgeProposals.ts` until PR 5 deletes it. */
export function compileConnections(input: { tiles; openings }): { connections: CompiledEdge[]; gaps: CompileGap[] };

export function drawingFingerprint(input: { tiles; unreadable }): string;

/** Admission control on the whole candidate set, mirroring `MAX_EDGES_PER_LAYOUT`. */
export class CompileLimitExceededError extends Error { readonly limit: number; readonly found: number }
```

Notes the implementer must not get wrong:

- `stopped-in-own-block` from #78's notes is **dropped**, not ported. Under
  #104's fix it is an ordinary walk outcome, and D7's `block-not-in-graph`
  catches the consequence that actually matters. Say so in the file header.
- both directions of every connection are emitted (the `assemble` synthesis in
  `edgeProposals.ts` moves here), because `block_edges` is directional and the
  compiler owns both sides in one pass (D2).
- `fromEnd`/`toEnd` are **always** strings. The `null` end that made
  `EdgeProposal.status: 'needs-end-label'` necessary cannot occur: openings are
  compiler output and every one has a label (D-I).
- de-duplication keeps the shortest `via`, as `assemble` does today.
- `components` is computed over the candidate edge set treated as undirected.

`drawingFingerprint`: sort tiles by `(y, x)`; per tile emit
`x|y|tileType|rotation|blockId|trackRole|pointId|roads`, where `roads` is
`pointRoads` sorted by `legs.join('-')` with each `when` sorted by `pointId` and
rendered `leg0>leg1:pointId=position,…`; an unreadable tile emits
`x|y|!raw:<its raw metadata string>`. Join with `\n`, SHA-256, hex. Node's
`crypto` — this is `services/`, not `domain/`.

**Test:** new `packages/backend/tests/unit/services/trackGraphCompiler.test.ts`.

- two blocks meeting at a boundary compile to two edges, one each way, with
  matching ends;
- a point at a throat compiles the correct `pointConditions` at **both** ends
  (departure via `leadsIntoBlock`, arrival via #104's relaxed rule);
- the parallel-yard-roads fixture compiles **no** edge between the two roads —
  the #91 guarantee, restated here because the compiler is a new caller;
- **D7, one test each:**
  - a drawn block reachable from nothing yields `block-not-in-graph` naming it,
    *and* the walk emits its per-cell note. The graph assertion is the primary
    finding; assert both are present and that the block-level one names the
    block, not a cell. This is D7's whole argument in one test.
  - a block with only an out-of-service sensor yields `block-without-detection`;
  - an opening with no edge and no buffer yields `opening-unresolved`; the same
    opening with a buffer yields nothing;
  - two disconnected pairs of blocks yield `components.length === 2` and **no**
    gap (D-B);
- **failure path:** an unreadable tile yields `tile-metadata-unreadable` and
  compiles no edge through that cell;
- **failure path:** a tile naming a deleted block yields
  `dangling-block-reference` and **no** edge naming that block — the thing that
  would otherwise become an `unknown-block` violation and Safe-Stop on reload;
- fingerprint: stable across input permutation; changes when `rotation`,
  `blockId`, `trackRole`, `pointId`, `pointRoads` or a coordinate changes;
  **unchanged** when an `annotations` entry is added; changes when an unreadable
  tile's raw blob changes;
- over `MAX_COMPILED_EDGES` throws `CompileLimitExceededError`.

Existing `tests/unit/services/edgeProposals.test.ts` must pass unchanged — the
shim preserves its contract.

#### Step 2.3 — `compiled_graphs`

**Files:** `packages/backend/src/adapters/db/schema.ts`, migration,
`src/ports/ILayoutRepository.ts`, `src/adapters/db/repository.ts`.

**Change:** the table exactly as D-F. Port:

```ts
export interface CompiledGraphRecord { layoutId: string; drawingFingerprint: string; compiledAt: Date }
getCompiledGraph(layoutId: string): Promise<CompiledGraphRecord | null>;
```

Generate the migration (`0009_*.sql`) in the same commit. Pure `CREATE TABLE`.

**Test:** `migrations.test.ts` — the table exists with the three columns,
`layout_id` is the primary key, and the FK to `layouts` is `ON DELETE cascade`.

#### Step 2.4 — `CompileService` and the two GETs

**Files:** create `packages/backend/src/services/CompileService.ts`;
`src/transport/http/routes/topology.ts`, `src/transport/http/routes/grid.ts`,
`src/transport/http/server.ts`.

**Change:**

```ts
export interface CompiledGraphStatus {
  compiledAt: string | null;
  compiledFingerprint: string | null;
  drawingFingerprint: string;
  /** A warning, never a gate (D10). */
  stale: boolean;
  gapCount: number;
}

export interface CompileView {
  report: CompileReport;
  status: CompiledGraphStatus;
  diff: CompileDiff;
}

export interface CompileDiff {
  added: CompiledEdge[];
  removed: BlockEdge[];
  unchanged: BlockEdge[];
  changed: Array<{ live: BlockEdge; proposed: CompiledEdge }>;
  /** Same connection, same conditions, different disposable label (D-J). */
  relabelled: Array<{ live: BlockEdge; proposed: CompiledEdge }>;
}

export class CompileService {
  constructor(repo: ILayoutRepository, topology: TopologyService, log: CompileServiceLogger) {}
  async compile(layoutId: LayoutId): Promise<CompileView>;
  async openings(layoutId: LayoutId): Promise<CompiledOpening[]>;
  async status(layoutId: LayoutId): Promise<CompiledGraphStatus>;
  /** `IGraphCompletenessView`, for PR 4. */
  async gapCount(layoutId: LayoutId): Promise<number>;
}
```

Assembly mirrors `GridService.diagnose` exactly: read rows, parse metadata
tolerantly while collecting the unreadable ones and their raw strings, call the
pure functions. `CompileService` owns no policy.

Routes:

- `GET /api/layouts/:layoutId/topology/compile` → `CompileView`. Not
  admin-gated, matching `grid/diagnostics` and `edge-proposals`: the *write* is
  what is gated.
- `GET /api/layouts/:layoutId/grid/openings` → `CompiledOpening[]` (D-H).
- Error map: `LayoutNotFoundError` → 404, `CompileLimitExceededError` → 409
  with `{ error, limit, found }`, mirroring `ProposalLimitExceededError`.

**Test:** new `packages/backend/tests/integration/compile.test.ts`.

- `GET .../topology/compile` on a drawn layout with no edges: `diff.added`
  non-empty, `diff.removed`/`unchanged` empty, `status.compiledAt === null`,
  `status.stale === true`;
- after a tile write, the `drawingFingerprint` changes and `stale` stays true;
- `GET .../grid/openings` returns the openings and is **not** admin-gated;
- **failure path:** a bad `:layoutId` is a 404 on both, not a 500;
- **failure path:** nothing here Safe-Stops.
  `layoutService.getSystemStatus().status` is `online` before and after, however
  many gaps the report carries. Mirror the existing
  `never Safe-Stops, however much it finds` case in `blockEnds.test.ts`.

#### Step 2.5 — Docs

- `docs/topology.md` — new top-level section **Compiling the graph from the
  drawing (#103)**, carrying D-A, D-B, D-G, D-I, D-J and the endpoint contracts.
  Add a one-line "superseded by" pointer at the head of *Proposing candidate
  edges from the drawing (#78)*; do not delete it yet, it is still live.
- `docs/track-graph-compilation.md` — status line: D2/D7/D8/D10 partially
  shipped, apply still to come.
- `CLAUDE.md` — one new **Track graph compilation (#103)** row.
- `docs/mqtt-contract.md` — **untouched**, and say so in the PR description.
  Nothing here reaches a topic.

---

### OQ7 — a latent unique-index conflict. **Not a blocker; does not occur today.**

> **Corrected.** This was first written up as blocking PR 3, on the strength of
> a compile of the live drawing that had read `layout.db` **without its
> write-ahead log** and was therefore working from a stale layout. Against the
> real current drawing the compiler emits 22 edges, one component, zero gaps and
> **zero tuple conflicts**. What follows is a real latent case, kept because the
> design permits the shape that causes it — not an observed problem.

The clash arises when a point tile carries a `blockId` **and** is reached
through its toe. Every road covers the toe, so #104's arrival rule correctly
emits one entry per road, and for a binary point that is "normal or reverse" — a
tautology producing two edges that differ only in point conditions:

```
Siding 1 : west  ->  Fiddle Yard 1 : east-1   [P-88d5527d=normal  8ccb1cf8=normal  acc2150b=normal]
Siding 1 : west  ->  Fiddle Yard 1 : east-1   [P-88d5527d=reverse 8ccb1cf8=normal  acc2150b=normal]
```

`block_edges_connection_unq` is on `(layout_id, from_block_id, from_end,
to_block_id, to_end)` and does **not** include `point_conditions`, so the
second insert of each pair fails. An all-or-nothing apply would refuse the
whole graph.

`block_edges_connection_unq` covers `(layout_id, from_block_id, from_end,
to_block_id, to_end)` and excludes `point_conditions`, so only one of the pair
can be stored and an all-or-nothing apply would refuse the whole graph.

Westgate Hollow does not hit this: its points are drawn decorative, so arrivals
land on ordinary block tiles and carry no conditions. But #103 explicitly
permits a point inside a block (P5 in Engine / Goods Transfer), so the shape is
reachable. **PR 3 should detect the conflict and refuse the apply with a named
reason rather than letting SQLite raise it** — that costs nothing today and
turns a future constraint violation into a sentence. Choosing between the
options below can wait until a drawing actually produces one.

**The options, when it matters:**

- **(a) Drop the condition on that point.** Minimal and honest — the position
  genuinely does not discriminate. But `LayoutService` commands exactly the
  conditions on the path, so an uncommanded point could be left mid-throw or
  `unknown` under a moving train. Weakens the fail-safe posture, and #25 means
  there is no position feedback to lean on.
- **(b) Keep one canonical position, deterministically chosen.** Over-constrains
  — a route may be refused because another holds that point the other way, when
  physically either would do — but every point on a granted path is then
  commanded to a known position. Refusing a legal route is the safe direction;
  running over an unconfirmed point is not.
- **(c) Emit neither, and record a gap.** Matches the under-emit posture, but
  costs 4 of 19 edges on the live layout including `Siding 1 -> Fiddle Yard 1`,
  which is a connection the operator explicitly wants.
- **(d) Widen the unique index to include `point_conditions`.** Schema change on
  a live DB, and it makes "two ways between the same pair of ends" a first-class
  concept the pathfinder and `planReservation` would both have to handle.

**Recommendation: (b).** It keeps every real connection, stores cleanly, and
errs toward refusing rather than running. Record it as a decision with the
over-constraint stated, and revisit if it ever refuses a route in practice.

### PR 3 — `POST .../topology/compile/apply`

The write. Small, and the one to review hardest.

> **Shipped.** Built as planned, with three notes:
>
> 1. **OQ7 needs no special case.** The plan asked PR 3 to "detect the conflict
>    and refuse the apply with a named reason rather than letting SQLite raise
>    it". That falls out of step 3.2's pre-validation for free:
>    `validateTopology`'s `duplicate-connection` check keys on exactly the same
>    tuple as `block_edges_connection_unq`, so the collision is a named 422
>    before any write. Covered by an integration test that *draws* the shape (a
>    point tile tinted as the block it serves, reached through its toe) rather
>    than hand-building the edges. Choosing between OQ7's options (a)–(d)
>    remains deferred until a real drawing produces one.
> 2. **`CompileFingerprintMismatchError` lives in `CompileService.ts`**, not
>    `TopologyService.ts` as step 3.2 lists it. The comparison happens in
>    `apply`; `replaceGraph` only stores the fingerprint it is handed.
> 3. **`LockedByRouteError` was previously mapped to a 409 nowhere in the HTTP
>    layer** — `PUT`/`DELETE .../edges` and the block/point deletes all reach
>    Fastify's default handler and answer **500** when a route holds the target.
>    Pre-existing, not introduced here, and not fixed here either: the new
>    `mapCompileError` maps it correctly for the apply. Worth its own small PR.

#### Step 3.1 — Repository: the atomic replace

**Files:** `packages/backend/src/ports/ILayoutRepository.ts`,
`src/adapters/db/repository.ts`.

**Change:**

```ts
/**
 * Replaces this layout's entire `block_edges` set and records the drawing it
 * was compiled from, in ONE transaction (D9, D10). A partially applied graph is
 * exactly the write-then-discover failure the apply path exists to prevent:
 * implementations MUST NOT leave the old edges deleted and the new ones
 * uninserted. Matches the atomicity contract `createReservation` documents.
 */
replaceBlockEdges(
  layoutId: string,
  edges: readonly Omit<BlockEdge, 'id' | 'layoutId'>[],
  fingerprint: string,
  compiledAt: Date,
): Promise<BlockEdge[]>;
```

Implementation: `db.transaction` — delete all `block_edges` for the layout,
insert each candidate with a fresh `randomUUID()`, upsert the `compiled_graphs`
row.

**Test:** `tests/integration/repository.test.ts` (or the migrations harness,
which already has a real DB) — a replace over a non-empty set leaves exactly the
new edges and one `compiled_graphs` row; **failure path:** an insert that
violates `block_edges_connection_unq` mid-batch leaves the *original* edges
intact and no `compiled_graphs` row written.

#### Step 3.2 — `TopologyService.replaceGraph`

**Files:** `packages/backend/src/services/TopologyService.ts`,
`src/ports/IRouteLockView.ts`, `src/services/ReservationService.ts`.

**Change:**

```ts
export class CompileFingerprintMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {}
}

/**
 * Replaces the whole edge set (D1, D3). The only write path for a compiled
 * graph, for the same reason `createEdge` was the only one for an authored edge.
 *
 * Order is load-bearing and is the whole of D9: refuse-then-write, never
 * write-then-discover. An apply that could write rows and have `reloadTopology`
 * reject them would turn an authoring action into a Safe-Stop.
 */
async replaceGraph(
  layoutId: LayoutId,
  edges: readonly EdgeCreateData[],
  fingerprint: string,
): Promise<BlockEdge[]>;
```

Steps, in this order:

1. `findAnyHeldRoute(layoutId)` → `LockedByRouteError('graph', layoutId, routeId)`
   if non-null (D-E).
2. `edges.length > MAX_EDGES_PER_LAYOUT` → `EdgeLimitExceededError` (OQ1).
3. Build the candidate list with synthetic ids (`__compiled__0`, `…1`, …) and
   run `validateTopology(layoutId, candidates, context)`. Any violation →
   `TopologyRejectedError`. This is the pre-validation D9 requires; the synthetic
   ids are the same trick `createEdge` already uses.
4. `repo.replaceBlockEdges(...)`.
5. `log.info` with `layoutId`, `layoutName`, `edgeCount`, `fingerprint`.
6. `await this.onTopologyChanged()`.

`IRouteLockView` gains:

```ts
/** Any route holding anything in this layout, or null. A whole-graph write touches everything, so the per-target guards do not compose (D-E). */
findAnyHeldRoute(layoutId: LayoutId): RouteId | null;
```

`LockedByRouteError`'s `kind` union gains `'graph'`.

**Test:** `tests/unit/services/topologyService.test.ts`.

- a valid candidate set replaces the live one and calls `onTopologyChanged`
  exactly once;
- **failure path:** with a stub `lockView` reporting a held route, nothing is
  written (`repo.replaceBlockEdges` never called) and `LockedByRouteError` is
  thrown;
- **failure path:** a candidate naming a nonexistent block throws
  `TopologyRejectedError` and `repo.replaceBlockEdges` is **never called**. This
  is the never-write-then-discover assertion and it must assert the *absence* of
  the call, not just the throw;
- **failure path:** over the cap throws `EdgeLimitExceededError` before
  validating.

#### Step 3.3 — The endpoint

**Files:** `packages/backend/src/services/CompileService.ts`,
`src/services/validation.ts`, `src/transport/http/routes/topology.ts`.

**Change:**

```ts
export const compileApplySchema = z.object({ fingerprint: z.string().min(1) }).strict();

async apply(layoutId: LayoutId, fingerprint: string): Promise<CompileView>;
```

`apply` recompiles from the current drawing, compares the fresh fingerprint
against the supplied one, throws `CompileFingerprintMismatchError` on a
difference (D10's time-of-check/time-of-use guarantee), then delegates to
`topology.replaceGraph` and returns the post-apply `CompileView` — whose `diff`
is now empty and whose `status.stale` is false, which is the idempotence proof.

`POST /api/layouts/:layoutId/topology/compile/apply`, `preHandler: requireAdmin`.

Status map:

| condition | status | body |
|---|---|---|
| success | 200 | `CompileView` |
| bad body | 400 | `{ error, details }` |
| unknown layout | 404 | `{ error }` |
| fingerprint mismatch | 409 | `{ error, expected, actual }` |
| a route holds | 409 | `{ error, routeId }` |
| over the cap | 409 | `{ error, limit, current }` |
| candidate graph invalid | 422 | `{ error, violations }` |

**Test:** `tests/integration/compile.test.ts`.

- apply writes the edges, and a second `GET .../topology/compile` shows an empty
  `diff.added` and `status.stale === false` — D10's idempotence, asserted;
- re-applying the same fingerprint is a no-op 200, not an error;
- **failure path:** paint a tile between the `GET` and the `POST` and the apply
  is a **409**, with nothing written. Assert `GET .../edges` is unchanged;
- **failure path:** a non-admin gets 403 and nothing is written;
- **failure path:** the system stays `online` across a successful apply, a
  409 and a 422. **The Safe-Stop assertion is the point of D9 and must be
  explicit.**
- a scenario test in `packages/backend/tests/scenario/` — grant a route, then
  attempt an apply: 409, the route still holds, the graph is unchanged, and the
  system is still `online`. Any change to routing or topology needs one
  (`CLAUDE.md`), and this is the failure path.

#### Step 3.4 — Docs

`docs/topology.md` — apply semantics, the status table above, and the
refuse-then-write ordering. `docs/track-graph-compilation.md` — D9/D10 shipped.
`CLAUDE.md` — amend the #103 row.

**A note for the PR description, not the code:** on a deployment whose
`block_edges` is *not* empty, the first apply deletes every hand-authored edge
the compile does not reproduce. Westgate Hollow has none (verified: 0 rows), so
this is a statement about other deployments, and the diff review is the
protection. Do not add a merge mode.

---

### PR 4 — Gaps gate `SystemMode: auto`; staleness warns

> **Shipped**, with two notes:
>
> 1. **Step 4.1's WebSocket integration test was not added.** The `SET_MODE`
>    throw → `ERROR` frame path is generic in `transport/websocket/index.ts` and
>    already covered; reproducing it would have meant duplicating the whole
>    three-way `completeness`/`CompileService`/`TopologyService` wiring into
>    `wsBroadcast.test.ts`. The gate is covered at unit level (9 cases) and at
>    integration level against a real drawing in `compile.test.ts`.
> 2. **A gappy reload suspends auto-authority routes**, which step 4.2 does not
>    mention. Dropping the mode to `manual` without it would leave an
>    `auto`-authority route running under an authority the system has just
>    withdrawn. It is the same D7 consequence a manual mode change already has —
>    suspend, not cancel, so the locks stay held and the operator decides.
>
> Step 4.3's frontend half landed on `EdgesTab` rather than a Configure header:
> that is where the graph is already displayed, and the notice sits directly
> above the violation banner it is deliberately styled apart from.

#### Step 4.1 — The port and the gate

**Files:** create `packages/backend/src/ports/IGraphCompletenessView.ts`;
`src/services/LayoutService.ts`, `src/index.ts`.

**Change:**

```ts
/** Read-only view of how complete the compiled graph is (D6). Implemented by `CompileService`, injected the same way `INameBook` is. */
export interface IGraphCompletenessView {
  gapCount(layoutId: LayoutId): Promise<number>;
}
```

`LayoutService` takes it as an optional trailing constructor parameter defaulting
to a `{ gapCount: async () => 0 }` inert implementation — the same posture as
`INERT_NAME_BOOK`, so every existing test construction compiles unchanged.

`handleSetMode`, before `stateManager.setMode`:

```ts
if (cmd.mode === 'auto' || cmd.mode === 'hybrid') {
  const gaps = await this.completeness.gapCount(layoutId);
  if (gaps > 0) throw new Error(
    `Cannot enter ${cmd.mode} mode: the compiled track graph has ${pluralise(gaps, 'gap')}. Compile the drawing and resolve them first.`,
  );
}
```

`hybrid` included per D-C. The throw reaches the operator as a WebSocket `ERROR`
frame; that path already exists and needs no change.

**Test:** `tests/unit/services/layoutService.test.ts`.

- with `gapCount → 0`, `handleSetMode({ mode: 'auto' })` succeeds and broadcasts
  as today;
- **failure path:** with `gapCount → 3`, both `auto` and `hybrid` throw, the mode
  stays where it was, and `getSystemStatus().status` is still `online` — a
  refused mode change is not a Safe-Stop;
- `manual` is never gated.

Integration: `tests/integration/wsBroadcast.test.ts` — a `SET_MODE` to `auto`
against a gappy graph returns an `ERROR` frame naming the gap count, and no
`SYSTEM_STATUS` with `mode: 'auto'`.

#### Step 4.2 — A gappy apply demotes an auto mode

**Files:** `packages/backend/src/services/LayoutService.ts`.

**Change:** `reloadTopology`, after the existing `evaluateAndApplySafeStop`, asks
`completeness.gapCount`; if `> 0` and the current mode is auto-capable, calls
`handleSetMode({ mode: 'manual' })`-equivalent internals and logs
`[LayoutService] Mode dropped to manual — compiled graph has gaps`. Not a
Safe-Stop, not a fault latch.

**Test:** `tests/unit/services/layoutService.test.ts` — in `auto` with a graph
that gains a gap, a reload leaves the mode `manual` and the status `online`.

#### Step 4.3 — Staleness on the topology read

**Files:** `packages/backend/src/services/TopologyService.ts` (or the route),
`src/transport/http/routes/topology.ts`, `packages/frontend/src/types.ts`,
`packages/frontend/src/components/ConfigPanel.tsx`.

**Change:** `TopologyStatus` gains `compiled: CompiledGraphStatus`. The route
composes it from `CompileService.status`. The Configure header renders a
one-line warning when `stale` is true and a gap count when non-zero.

**Deliberately not** added to the MQTT `system/status` payload or the WebSocket
`SYSTEM_STATUS` event, which mirrors it. That payload is binding
(`docs/mqtt-contract.md`) and the ESP firmware is built against it. Staleness is
an HTTP concern.

**Test:** `tests/integration/topology.test.ts` — `GET .../topology` reports
`compiled.stale === true` before any apply and `false` after; a tile write flips
it back to true. Frontend: `ConfigPanel` renders the warning (React Testing
Library, or a Playwright assertion in the compile spec from PR 5).

#### Step 4.4 — Docs

`docs/track-graph-compilation.md` — D6 shipped, and record D-B and D-C's
`hybrid` extension as decisions taken during implementation.
`docs/pathfinding.md`/`docs/route-locking.md` — check for any claim that
`SystemMode` is ungated; amend. `CLAUDE.md` — amend the #103 row.

---

### PR 5 — The compile-diff review UI; the manual edge form goes

This is where the operator finally compiles Westgate Hollow.

#### Step 5.1 — Delete the proposal surface

**Files:** delete `packages/backend/src/services/edgeProposals.ts`,
`packages/backend/tests/unit/services/edgeProposals.test.ts`,
`packages/frontend/src/components/EdgeProposalsPanel.tsx`,
`packages/frontend/src/hooks/useEdgeProposals.ts`,
`packages/frontend/src/diagram/edgeProposals.ts` (+ its test),
`tests/e2e/edge-proposals.spec.ts`. Amend
`packages/backend/src/services/GridService.ts` (drop `proposeEdges`),
`src/transport/http/routes/grid.ts` (drop the route and the
`ProposalLimitExceededError` mapping), `packages/frontend/src/types.ts` (drop
`EdgeProposal*`).

#### Step 5.2 — Delete the manual edge write path (OQ1)

**Files:** `packages/backend/src/transport/http/routes/edges.ts`,
`src/services/TopologyService.ts`, `src/services/validation.ts`,
`packages/frontend/src/hooks/useLayoutConfig.ts`,
`packages/frontend/src/components/EdgesTab.tsx`.

**Change:** remove `POST`, `PUT` and `DELETE /api/layouts/:layoutId/edges[/:id]`;
keep `GET`. Remove `TopologyService.createEdge`/`updateEdge`/`deleteEdge` and
`EdgeCreateData`/`EdgeUpdateData`'s write use; keep `EdgeCreateData` as the
shape `replaceGraph` takes. Remove `edgeCreateSchema`/`edgeUpdateSchema`. Remove
`createEdge`/`updateEdge`/`deleteEdge` from `useLayoutConfig`. `EdgesTab` loses
the form, `buildEdgeDraft`, `reverseOf`, `endsForBlock`, both datalists and the
delete button; it keeps the violation banner and the read-only edge table.

**Test:** `tests/integration/edges.test.ts` — `POST .../edges` is a **404**
(the route does not exist), not a 403 or 405. Mirrors the `sensorSimulation`
posture: an absent route, never a route that exists and refuses. Existing
`GET .../edges` cases pass unchanged. Delete the create/update/delete cases and
`tests/e2e/edge-authoring.spec.ts`'s authoring half.

#### Step 5.3 — `CompilePanel`

**Files:** create `packages/frontend/src/components/CompilePanel.tsx`,
`packages/frontend/src/hooks/useCompile.ts`,
`packages/frontend/src/diagram/compile.ts` (pure describe/sort helpers, unit
tested without React — the same split `diagram/edgeProposals.ts` used);
`packages/frontend/src/components/EdgesTab.tsx`;
`packages/frontend/src/types.ts` (mirror `CompileView`, `CompiledEdge`,
`CompileGap`, `CompiledOpening`, `CompiledGraphStatus`).

**Change:** the panel replaces `EdgeProposalsPanel` at the top of the Edges tab.

- Fetches on first open only, as `EdgeProposalsPanel` does, for the same reason.
- Sections in this order: **gaps first**, then the diff, then components if
  `> 1`. Gaps first because D7's whole argument is that "Fiddle Yard 2 has no
  connections" outranks a cell-level note; the graph-level gap kinds sort above
  the evidence kinds.
- Diff rows are grouped `added` / `removed` / `changed` / `relabelled` /
  `unchanged`, with counts. `crossesDiamond` renders the existing ⚠ text
  (`#81`: never colour alone). `via` is a hover title.
- **One button: `Apply`.** It posts `{ fingerprint }` from the report currently
  displayed. There is no per-row accept — D3 forbids a partial graph, and an
  accept-one button would be a mixed-graph write with a friendly face.
- `Apply` is disabled while `diff` is empty. A 409 fingerprint mismatch renders
  as "The drawing changed while you were reviewing. Re-compile and look again."
  with a `Re-compile` button — not an auto-retry, which would defeat the guard.
- A 422 renders the violations with the same `describeViolation` the tab already
  has.

**Test:** `packages/frontend/src/diagram/compile.test.ts` — sort order puts
graph-level gaps above evidence; the describe functions cover every `CompileGap`
member (exhaustive switch, so a new kind fails the build).
`tests/e2e/compile.spec.ts` — draw two blocks, open the panel, see the diff,
apply, see the edges in the table, re-open and see an empty diff. **Failure
path:** paint a tile in a second tab between compile and apply, and the apply
shows the mismatch message rather than writing.

#### Step 5.4 — Rollout on Westgate Hollow

No code. The runbook for the PR description.

1. Deploy. Migrations from PRs 1–2 apply on startup.
2. Confirm `select count(*) from block_edges` is still 0. If not, read the diff
   carefully before applying — the apply is a replace.
3. Configure → Edges → open the compile panel. Record the gap list and the
   candidate edge count in the PR description before applying, so the numbers
   are on record and a later divergence is visible.
4. Expect the Engine / Goods Transfer's two south-east openings to compile as
   `southeast-1` / `southeast-2` and to produce edges. That opening pair is the
   `end-label-collision` this whole issue was named after; if it still produces
   no edge, stop and say so — the compiler is wrong, not the drawing.
5. Apply. Confirm `GET .../topology` reports `compiled.stale === false` and the
   system is `online`.

#### Step 5.5 — Docs

`docs/topology.md` — delete *Proposing candidate edges from the drawing (#78)*
and *Reviewing and accepting proposals*; fold anything still true into the #103
section. Record that the edge write routes are gone.
`docs/track-editor.md` — **delete D13** (the end-label datalist).
`CLAUDE.md` — replace the **Edge proposals (#78)** row with the compile row;
amend **Track topology (#2, #21)** (edges are compiled, not authored).
`README.md` — Known Limits / Next Milestones.

---

### PR 6 — The Track Editor draws openings at tile boundaries

#### Step 6.1 — Openings on the canvas

**Files:** `packages/frontend/src/components/GridEditor.tsx`,
create `packages/frontend/src/hooks/useOpenings.ts`,
`packages/frontend/src/diagram/encoding.ts`,
`packages/frontend/src/types.ts`.

**Change:**

- `useOpenings(layoutId, gridRevision)` reads `GET .../grid/openings`, exactly
  as `useGridDiagnostics` does.
- Delete the `cellEnds` text rendering. Replace it with a mark **on the boundary
  each port names**: a short tick perpendicular to the tile edge, drawn at that
  edge's midpoint in the tile's `<g>` transform. A terminated opening draws the
  existing `⊣` stop glyph on the tile's closed side.
- The label still renders, once per opening, at `opening.at`, small — the mark
  says *where*, the label says *which*, and #81 forbids either being carried by
  colour alone. Add `OPENING` to `diagram/encoding.ts` as a `StateEncoding` with
  its glyph and text, so the encoding module stays the single source.
- The `⌂`/label-density controls treat opening marks as labels for the `off` and
  `hover` densities.

This is strictly more informative than a word at a nearby cell: #91's fused
siding was invisible behind a plausible label, and a mark at the wrong boundary
is not.

**Test:** `tests/e2e/track-editor-labels.spec.ts` — an opening mark appears at
the boundary the geometry names, and a buffered opening draws the stop glyph.
Extend `packages/frontend/src/diagram/` unit coverage for the port→coordinate
mapping (pure function, `portMarkGeometry(port): { x1, y1, x2, y2 }`).

#### Step 6.2 — `Ends ⟳` and `Ends ✎` go

**Files:** `packages/frontend/src/components/GridEditor.tsx`, delete
`packages/frontend/src/components/BlockEndsPanel.tsx` and
`packages/frontend/src/hooks/useBlockEnds.ts`; delete
`tests/e2e/track-editor-ends.spec.ts`.

**Change:** remove both toolbar buttons, `regenerateEnds`, `endsSummary`,
`showEnds`, `endsAtCell` and the `BlockEndsPanel` mount. The status line loses
its `Ends:` clause.

**Test:** `tests/e2e/track-editor-happy-path.spec.ts` — the toolbar no longer
offers either control; the editor still loads, paints and reports diagnostics.

#### Step 6.3 — Docs

`docs/track-editor.md` — **delete D12**; add a new **D12 — an opening is marked
at the boundary it occupies, not written at a nearby cell**, carrying the
reasoning above and the #91 evidence. `docs/diagram-encoding.md` — add the
opening mark to the encoding table. `CLAUDE.md` — amend the **Track Editor
authoring** row.

---

### PR 7 — `block_ends` is deleted

Last, because everything that read it is gone by now.

#### Step 7.1 — Backend deletions

**Files:** delete `packages/backend/src/services/BlockEndService.ts`,
`src/transport/http/routes/blockEnds.ts`,
`tests/integration/blockEnds.test.ts` (move its still-relevant diagnostics cases
into a new `tests/integration/gridDiagnostics.test.ts` — several of them are the
only coverage of `track-not-joined` and `diamond-blind-spot`).

Amend:

- `src/domain/types.ts` — delete `BlockEnd`. Keep `BlockEndLabel` (still the type
  of `block_edges.fromEnd`/`toEnd` and `RoutePathStep.entryEnd`) and rewrite its
  doc comment: a label is now disposable compiler output, unique per block per
  compile, and referenced by nothing but the edge that carries it.
- `src/ports/ILayoutRepository.ts` — delete all six block-end methods including
  `replaceGeneratedBlockEnds`.
- `src/adapters/db/repository.ts` — delete their implementations.
- `src/services/validation.ts` — delete `blockEndRowSchema`,
  `parseBlockEndRow`, `BlockEndRowInvalidError`, `blockEndCreateSchema`,
  `blockEndUpdateSchema`. **Keep `blockEndLabelSchema`** — `blockEdgeRowSchema`
  still uses it, and it is what makes `southeast-1` legal.
- `src/services/gridGeometry.ts` — delete `generateBlockEnds`, `GeneratedEnds`,
  `EndLabelCollision` and `groupOpenings`. `rawOpenings` + `compileOpenings`
  remain.
- `src/transport/http/server.ts` — drop the `blockEndRoutes` registration.
- `toGeometryTiles` moves from `BlockEndService.ts` to `gridGeometry.ts` — it is
  geometry, and it was only living in the service because that is where it was
  first needed.

**Check the trap before touching `NameBookCache`:** `NameBookCache.refresh`
narrowly catches `BlockEdgeRowInvalidError` and nothing else, and that narrowness
is load-bearing (#10). `BlockEndRowInvalidError` is a different class and is not
caught there. Deleting it changes nothing — verify, do not assume.

#### Step 7.2 — Diagnostics

**Files:** `packages/backend/src/services/gridDiagnostics.ts`,
`src/services/GridService.ts`, `packages/frontend/src/types.ts`,
`packages/frontend/src/diagram/diagnostics.ts`.

**Change:** delete the `GridDiagnostic` members `end-not-on-diagram`,
`pinned-end-not-on-diagram`, `end-unfinished` and `end-label-collision`, and
`DiagnosticsInput`'s `ends` and `collisions`. Delete
`block-without-detection` — it is now a compile gap (D9) and having it in two
places with two different statuses is the duplication this issue exists to end.

Keep `buffer-contradicted-by-edge` (OQ3), re-expressed over `openings`: an
opening with `terminated: true` for which some live `block_edges` row names
`(blockId, label)`. `DiagnosticsInput.openings` becomes `CompiledOpening[]`.

`describeDiagnostic`'s switch is exhaustive, so the frontend fails to build until
the mirrored union is updated — which is the intended forcing function.

**Test:** `tests/integration/gridDiagnostics.test.ts` — a buffered opening with
an edge through it still warns; none of the four deleted kinds can be produced;
`block-without-detection` no longer appears in the diagnostics and does appear
in the compile report's gaps.

#### Step 7.3 — Schema

**Files:** `packages/backend/src/adapters/db/schema.ts`, migration.

**Change:** delete the `blockEnds` table and its `BlockEndRow`/`NewBlockEndRow`
types. `npm run db:generate --workspace=packages/backend` → `0010_*.sql`,
containing `DROP TABLE block_ends`. Nothing FKs to it (verified — the *absence*
of that FK is #72's own recorded decision), so this is a clean drop of 19 rows,
none of which any edge references (verified: `block_edges` is empty).

**Test:** `migrations.test.ts` — delete the whole `block_ends` describe block;
add one case asserting the table does **not** exist after migration. Keep the
`has NO foreign key from block_edges ends to it` case in spirit by asserting
`PRAGMA foreign_key_list(block_edges)` still names only `layouts` and `blocks`.

#### Step 7.4 — Docs

- `docs/topology.md` — delete *Block ends: derived by default, authored by
  exception (#72)* and its six subsections wholesale. *Block-end labels* under
  *The edge model* is rewritten: a label is compiler output, string equality is
  the only operation performed on it.
- `docs/track-grid.md` — D12's closing paragraphs reference `block_ends`;
  rewrite to reference openings. D11's diagnostics list loses the four deleted
  kinds and gains the diagnostics-versus-gaps inversion (D6).
- `docs/naming.md` — add a line to D8 or the contract check: end labels are now
  readable without a `NameBook` by construction, which is what D8 predicted.
- `docs/track-graph-compilation.md` — mark the whole record shipped.
- `CLAUDE.md` — **delete** the **Block ends (#72, #91)** row rather than
  amending it; rewrite the **Grid diagnostics** row; delete the two Open-limits
  bullets about `end-label-collision`/`Engine / Goods Transfer` and about the
  drawing↔graph model being replaced, since it now is.
- `README.md` — Known Limits.

---

## Out of scope

- **#75, unifying `findBlockRuns` and `TILE_LEGS` across the two packages.** PR 6
  adds one more small backend→frontend mirror (`portMarkGeometry` needs
  `EDGE_OFFSET`); record it alongside the existing duplicates rather than
  unifying here.
- **#25, point-position feedback.** D9's mis-mapped-`pointRoads` argument depends
  on first-movement detection, not on a feedback channel, and stands unchanged.
- **#26, the plain-diamond blind spot.** OQ2.
- **#7, collision avoidance, and driving a granted route.** The gate in PR 4
  protects an `auto` mode that nothing yet drives.
- **Version history for compiled graphs, and undo for `grid_tiles`.** Both
  explicitly rejected in D10; the second is a separate question about the Track
  Editor.
- **A `jointLengthMm` column.** D5 says a nullable one defaulting to zero is
  additive and can arrive later. It is not arriving now.
- **Any MQTT change.** `docs/mqtt-contract.md` is untouched by all seven PRs.
