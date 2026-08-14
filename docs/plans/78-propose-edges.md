# #78 — Propose candidate `block_edges` from the drawn geometry

Implementation plan. Read `docs/topology.md` ("Geometry can propose connectivity; it can
never supply length"), `docs/track-grid.md` D7/D9/D10/D11, and `packages/backend/src/services/gridGeometry.ts`
before starting.

**Hard dependency: #91.** This plan assumes a correct, *connectivity*-derived opening set
exists. It does not design it. See "Dependency contract on #91" below for the exact
exports this feature consumes; if #91 ships them under different names, adapt the imports —
that is mechanical, not a design change.

**No schema change. No migration.** Proposals are computed on demand from `grid_tiles`,
`block_edges` and `block_ends`. Nothing new is persisted.

---

## Design decisions

### D1 — A proposal is a complete `EdgeCreateData` except `lengthMm`, which is always `null`

`docs/topology.md` already binds this: geometry proposes connectivity, never distance.
Tile count bears no relation to physical extent (the Westgate Hollow entry feeder is drawn
long and is short in reality, and is not a block at all). `lengthMm: null` already means
"unmeasured, unsafe for automated braking" (`docs/braking.md` B4), which is the honest
value.

The type declares `lengthMm: null` — the literal, not `number | null` — so a later change
that computes a length from geometry fails to compile rather than shipping. The frontend
omits the field entirely when accepting; `edgeCreateSchema` defaults it to `null`.

### D2 — The walk is over **tile ports**, not tile cells

A port is `(x, y, edge)` where `edge` is a `TileEdge` in the tile's **rotated** (screen)
frame. Two relations move the walk:

- **Within a tile**: a leg `[a, b]` joins port `(t, a)` to `(t, b)`.
- **Between tiles**: edge `e` of the tile at `(x, y)` joins the *opposite* edge of the
  neighbouring cell in direction `e`. `(x,y,'e')` ↔ `(x+1,y,'w')`, `(x,y,'ne')` ↔
  `(x+1,y-1,'sw')`, and so on.

Coupling requires **both** sides to have a leg endpoint at the shared boundary. This is
the whole reason #91 is a prerequisite: two yard roads drawn on adjacent rows touch along
their entire length and connect nowhere, because neither tile has a leg endpoint on the
shared horizontal boundary. A cell-adjacency walk finds a connection everywhere; a port
walk finds none.

### D3 — Traversal rule: block terminates, decorative traverses, unclassified stops and says so

At each tile the walk enters, by `classifyTile(metadata)`:

| classification | action |
|---|---|
| `block`, different `blockId` from the start | **Terminate — candidate found.** Never continue past it (first-block-wins). |
| `block`, same `blockId` as the start | Discard the branch. A self-loop is refused by the schema anyway (`from_block_id <> to_block_id`), and a block reachable from itself is not a connection to author. |
| `decorative` | Traverse. This is #71's positive property and the case that motivated #78: Fiddle Yard 1 → entry feeder → sidings points → Siding 1. |
| `unclassified` | **Do not traverse. Do not propose.** Emit a `blocked-by-unclassified` note at that coordinate. |

Refusing to traverse `unclassified` is the under-propose posture #78 asks for. Walking
through untagged tiles finds wrong things confidently; stopping silently at them looks
identical to "there is no connection". The note is the difference — it tells the operator
that classifying one cell will unlock the proposal.

The classification pass over Westgate Hollow is still manual and unfinished (CLAUDE.md
Open limits). Expect the first run on the live layout to produce mostly notes. That is the
intended behaviour, not a failure.

### D4 — `pointConditions` come from `metadata.pointRoads`, and a point with no roads blocks the walk

On a tile whose `metadata.pointRoads` is non-empty, **the roads govern the legs** — the
generic leg table is not consulted. For each road `r` whose `legs` (rotated by
`metadata.rotation`; legs are stored unrotated, D9) touch the entry edge, the walk forks
down that leg and appends every entry of `r.when` to the accumulated conditions as
`{ pointId, requiredPosition: position }`.

- Duplicate `(pointId, position)` is deduped.
- The **same** `pointId` at a **different** position on one branch is a contradiction —
  the branch is discarded silently. No path requires P1 both normal and reverse.
- A slip or three-way falls out for free: `when` with several entries contributes several
  conditions. This is exactly why D9 keyed roads on a position *tuple*.
- Multi-point paths fall out too: crossing two points accumulates both conditions, giving
  #78's Siding 1 / 2 / 3 table in one pass with no special casing.

**What cannot be inferred, and is refused rather than guessed:**

- A tile carrying `metadata.pointId` with **no** `pointRoads` is not traversable. Note:
  `blocked-by-unmapped-point`. Without D9's mapping the walk knows it crossed a point but
  not which position selects the road, and `pointConditions` is the field whose errors are
  least visible. `gridDiagnostics` already reports the same tile as `point-tile-unmapped`.
- A leg on a point tile that no road covers is not traversable. Note:
  `blocked-by-unmapped-leg`.
- **The leg mapping itself is unverifiable authored data** (D9). There is no independent
  source of truth for which way round a physical point is wired, and `pointConditions`
  carries no geometry to cross-check it against. A proposal inherits that uncertainty
  exactly, and the review UI says so in words. This feature does not make point wiring
  checkable; it makes the drawing and the graph say the same wrong thing consistently
  instead of two different wrong things.

### D5 — A `crossing` is traversed and flagged, not refused

A plain diamond is real track with two independent roads. The leg table gives it two legs
that do not interconnect, so a walk entering `w` exits `e` and never `n`. The resulting
proposal carries `crossesDiamond: true`, because the edge it would author sits in #26's
blind spot: two routes fouling at a plain diamond share neither a block nor a point and
are not detected. Refusing outright would make a diamond-containing layout unmodellable;
saying nothing would hide a known hazard behind a confident-looking button. Westgate
Hollow has none today, and `gridDiagnostics` already emits `diamond-blind-spot` for the
tile.

### D6 — Arriving at a buffered opening is refused

If the opening the walk arrives at (or departs from) has `terminated: true`, no proposal
is emitted; note `blocked-by-buffer`. A buffer asserts "track ends here, nothing continues
beyond" (#84). Proposing an edge there would author the exact
`buffer-contradicted-by-edge` disagreement the diagnostics exist to surface. The drawing
contradicts itself and the answer is to fix the drawing — #83's "refuse and say so, rather
than guess".

### D7 — A point tile tinted as a block terminates like any other block tile, and says why

`metadata.blockId` is a *tint* assertion and is deliberately allowed to disagree with
`points.blockId` (D3). The walk never reads `points.blockId`. Uniform rule, no special
case: a `block`-classified tile terminates the walk whatever else it carries.

Consequence: a point drawn on a cell tinted as the approach block makes a walk out of that
block re-enter it, and the branch is discarded — so no proposal, silently. To stop that
being an unexplained absence, a branch discarded for re-entering its own block **on a tile
carrying a `pointId`** emits a `stopped-in-own-block` note. The remedy is one edit: mark
the point tile `decorative` (which is what Westgate Hollow's P2/P3/P4 tiles already do) or
remove the tint.

This resolves #78's open question 5 without touching the tile-`blockId`-versus-
`points.blockId` question, which stays as D3 left it.

### D8 — Both directions are always offered; the operator may decline one

A physical connection is two rows (`schema.ts:91`, `docs/topology.md`). Walks are run from
every non-terminated opening port, forward rows are deduped, and then the reverse of each
surviving row is synthesised if no walk produced it. Both share a `pairId` so the UI can
present them as one connection with two checkboxes, both ticked by default. This answers
#78's open question 1 in the direction it leaned.

The reverse row carries the **same** `pointConditions` — it is the same physical road, and
`PointCondition` has no direction.

### D9 — Stateless. Rejections are not remembered

No new table, no `dismissed` flag. Re-running re-asks. The mitigation is D10: already
authored connections come back grouped and greyed out, so the list shrinks as work is
done rather than repeating in full. This answers #78's open question 3 in the direction
the issue itself recommends, and is the only option that has no invalidation problem when
the drawing changes.

### D10 — Existing edges are reported, not filtered out

A proposal whose `(fromBlockId, fromEnd, toBlockId, toEnd)` tuple matches an existing edge
is returned with:

- `status: 'existing'` when the condition sets match (compared as sets of
  `pointId:position`, order-insensitive; `lengthMm` is never compared, since a proposal
  has none by construction);
- `status: 'conflicting'` when the tuple matches but the conditions differ.

Both carry `existingEdgeId` and are **not selectable**. Neither is ever auto-updated: an
update from geometry would rewrite the track graph, which is precisely what this feature
promises not to do. A conflict is resolved by hand in the Edges tab.

Returning them rather than dropping them is deliberate. Silence is indistinguishable from
"the walk did not find it", and "the graph I typed agrees with what I drew" is the single
most valuable confirmation this feature can give on a layout that is drawn and modelled
twice. It also makes idempotence visible: accept a proposal, re-run, see it as `existing`.

`(from_block_id, from_end)` is **not** unique and must not be treated as a conflict key —
a throat block's east end legitimately has one outgoing edge per point setting, and that
fan-out is exactly what this walk produces (`docs/topology.md`, "Why `(from_block_id,
from_end)` is NOT unique"). Only the full four-part tuple is unique
(`block_edges_connection_unq`).

### D11 — An end with no `block_ends` row yields `fromEnd: null`, not a guessed label

An end label is the only link between an edge and a block end, and a pinned label outranks
geometry permanently (#72). So a port is attributed a label only when the generated
opening containing it has a label that **exists as a `block_ends` row for that block**.
Otherwise the field is `null` and the proposal's status is `'needs-end-label'`.

The review UI then offers a `<select>` of that block's stored ends, plus a "run Ends ⟳
first" hint. It never invents a label, and it never proposes a generated name that
regeneration might replace next week. After #91 lands and `Ends ⟳` is run once, this
should be rare.

### D12 — The accepted write is the existing `POST /api/layouts/:layoutId/edges`, one row at a time

**There is no accept endpoint.** The frontend posts each accepted proposal's fields to the
edge route that already exists. Consequences, all of them wanted:

- No bypass can exist, by construction. There is no second write surface to keep in sync
  with `TopologyService`, and no proposal id that a stale client could use to write
  something the operator never reviewed — what is written is the fields that were on
  screen.
- A partially-accepted batch is the natural shape (#78 open question 6): each POST
  independently succeeds or fails, succeeded rows disappear from the list, failed rows
  stay with their error attached.
- Posts are **sequential, not parallel**. `createEdge` reads the existing edge list, then
  writes; two concurrent accepts of the same connection could both pass the
  duplicate-connection check. (The DB unique index is the backstop, but a 500 from a
  constraint violation is a worse operator experience than a 422 with violations.) A
  failure does not stop the batch — the remaining rows are still attempted.
- N reloads of the topology, one per write. `TopologyService` calls `onTopologyChanged` →
  `reloadTopology()` synchronously after every write with no coalescing, deliberately
  (`docs/topology.md`, "Debouncing `onTopologyChanged` is rejected"). At 2,000 edges the
  full pass measures ~11ms; at Westgate Hollow's scale it is microseconds. Not a reason to
  add a batch endpoint.

Rejected alternative: `POST .../edges/batch` looping over `createEdge`. Its only benefit is
one round trip, and it costs a second write surface with its own partial-failure result
shape — a new place for a bypass to appear later.

**What that write path validates and will reject:**

| Gate | Failure | Status |
|---|---|---|
| `requireAdmin` | non-admin session | 403 |
| `edgeCreateSchema` (`.strict()`) | unknown field, blank/mis-shaped end label (`/^[a-z0-9][a-z0-9_-]*$/` after trim + lower-case), non-positive `lengthMm` | 400 |
| `MAX_EDGES_PER_LAYOUT` (2,000) | `EdgeLimitExceededError` | 409 |
| `validateEdgeAgainstLayout` → `self-loop` | same block both ends | 422 |
| → `unknown-block` | a block deleted between propose and accept | 422 |
| → `unknown-point` | a point in `pointConditions` deleted between propose and accept. Note the asymmetry: the *load* path tolerates a dangling point reference, the *write* path never creates one | 422 |
| → `duplicate-connection` | the tuple already exists | 422 |
| DB `block_edges_connection_unq` + CHECKs | backstop below the service | 500 |

**What it does not reject, contrary to #78's open question 6:** a route holding the blocks.
`createEdge` is deliberately *not* guarded by `IRouteLockView` (D10 in `docs/topology.md`,
and verified in `TopologyService.ts` — only `updateEdge`, `deleteEdge`,
`deleteBlockWithEdges` and `deletePointIfUnreferenced` call the `assert*Unlocked` helpers).
A new edge moves no train and cannot be traversed into reserved track, because the target
block is already locked. Accepting a proposal while a route is active is permitted, as is
accepting one while the system is in Safe-Stop (edge writes stay permitted so an operator
can recover).

### D13 — The read is a GET under `/grid`, not admin-gated

`GET /api/layouts/:layoutId/grid/edge-proposals`, in
`packages/backend/src/transport/http/routes/grid.ts`, alongside `/grid/diagnostics`. The
input is the drawing; the output is advisory and writes nothing. Not admin-gated, matching
`/grid/diagnostics` and the `block-ends` read — the write is what is gated. Under `/grid`
rather than `/edges` so that nothing in the edges namespace looks like a second edge-write
surface.

### D14 — Bounded search, and a global cap that refuses rather than floods

In `services/edgeProposals.ts`:

```
MAX_PROPOSAL_PATH_TILES  = 32   // tiles crossed on one branch before it is abandoned
MAX_BRANCHES_PER_OPENING = 32   // live branches from one start port
MAX_EDGE_PROPOSALS       = 200  // total, per layout
```

Path and branch caps abandon **that branch** and emit a `search-truncated` note, so one
mis-tagged corner does not kill the run. The global cap **refuses the whole run** —
`ProposalLimitExceededError` → **409**, no proposals returned, mirroring
`EdgeLimitExceededError` exactly (well-formed request, resource state refuses it). 200
proposals on a nine-block layout means the tagging is wrong, and rendering them as a review
list invites bulk-accepting nonsense. This is #78's "refuse and say so".

Westgate Hollow's longest decorative run is ~11 tiles, so 32 is roughly 3x headroom.

### D15 — Types live in `services/`, not `domain/`

`EdgeProposal` and friends follow the `GridDiagnostic` precedent: they live in
`packages/backend/src/services/edgeProposals.ts` and are hand-mirrored in
`packages/frontend/src/types.ts`. CLAUDE.md's "add types to `domain/types.ts`" rule is
about the shared vocabulary the domain reasons over; nothing in `domain/` reads a proposal,
for the same reason nothing in `domain/` reads a tile. The proposal *reuses*
`PointCondition`, `BlockId`, `TileEdge` and `Coordinate` from their existing homes.

### D16 — The review panel lives in the Configure screen's Edges tab

Not in `GridEditor`. Reasons: the accept action writes edges and `EdgesTab` already holds
`ops.createEdge`; the existing-edge cross-reference and the violation banner are already
there; `GridEditor` is 1,400 lines, has no edge-write ops, and is a different top-level app
tab. Each proposal row lists the coordinates it crossed (`via`), which is what makes it
checkable against the drawing without a diagram overlay.

Highlighting a proposal's path on the diagram is real value and is **out of scope** — it
belongs with #75's renderer unification.

---

## Open questions (with recommendations)

1. **Does #91's `BlockOpening` expose the ports it was derived from?**
   This plan needs, for each opening, the `(x, y, edge)` ports the block opens through —
   both to start walks and to attribute an arrival to a named end. #91 must compute
   exactly this to decide an opening exists at all, so exposing it is nearly free there and
   is not reconstructible here without duplicating #91's logic.
   **Recommendation: tell the #91 designer now to add `ports: Port[]` to `BlockOpening`.**
   If it lands without them, Step 1 of this plan grows a `blockOpeningPorts(tiles)` export
   in `gridGeometry.ts` computed the same way (for each tile of a run, each leg endpoint
   whose neighbour is not a member of that run) — mechanical, but a second implementation
   of something #91 already knows, and the label attribution in D11 becomes unreliable.

2. **Does #91 expose per-tile *legs* (pairs), or only an edge set?**
   An edge set is enough to find openings; it is **not** enough to walk. A `crossing` has
   four edges and two non-interconnecting roads, and a point has three edges and two legs.
   **Recommendation: #91 exports `tileLegs(tile): Array<[TileEdge, TileEdge]>` in the
   rotated frame**, and derives its edge set from it. If #91 ships only the edge set, Step 1
   of this plan creates `services/tileConnectivity.ts` with the leg table, and #91 should
   later be refactored onto it (#75-adjacent) so there is one table, not two.

3. **Should the operator be able to accept a proposal that only exists in one direction?**
   D8 synthesises the missing reverse. A drawn asymmetry (one end buffered, the other not)
   is a drawing bug and is reported, not silently made symmetric.
   **Recommendation: yes, keep synthesis, and let either direction be unticked.** No
   further ruling needed unless you disagree.

4. **Is `unclassified` blocking too strict for the first run on Westgate Hollow?**
   The manual classification pass is not done, so a run today may produce nothing but
   notes.
   **Recommendation: ship it strict.** The alternative — traversing unclassified track —
   is the "finds wrong things confidently" failure #71 exists to prevent, and the notes are
   an actionable, coordinate-precise to-do list. If the first run is unusable, the fix is
   to finish the classification pass, which is wanted anyway.

**Ruling needed before implementation starts:** items 1 and 2, because they are requests
*to #91* and are cheap there and expensive here. Items 3 and 4 need only a nod.

---

## Dependency contract on #91

This plan consumes, from `packages/backend/src/services/gridGeometry.ts` (or wherever #91
puts them):

```ts
/** A tile boundary, in the tile's ROTATED (screen) frame. */
export interface Port { x: number; y: number; edge: TileEdge; }

/** The pairs of tile edges the drawn track joins within this tile, rotated frame. */
export function tileLegs(tile: GeometryTile): Array<[TileEdge, TileEdge]>;

export interface BlockOpening {
  blockId: BlockId;
  label: CardinalEndLabel;
  at: Coordinate;
  terminated: boolean;
  ports: Port[];   // ← required by this feature (open question 1)
}
```

Step 1 below is where any gap is filled. Nothing after Step 1 touches #91's code.

---

## Plan

### Step 1 — Tile connectivity: legs, rotation, and port arithmetic

**Files**
- `packages/backend/src/services/tileConnectivity.ts` (new — **only if #91 did not land
  `tileLegs`**; if it did, this step is an import check and a rotation test, nothing more)
- `packages/backend/tests/unit/services/tileConnectivity.test.ts` (new)

**Change**

```ts
export interface Port { x: number; y: number; edge: TileEdge; }

/** Rotates a tile edge clockwise by a 45° step. TILE_EDGES is ordered clockwise from north, so this is an index shift. */
export function rotateEdge(edge: TileEdge, rotation: TileRotation): TileEdge;

/** The pairs of tile edges the drawn track joins, in the tile's ROTATED frame. Unrotated table + `rotateEdge`. */
export function tileLegs(tile: GeometryTile): Array<[TileEdge, TileEdge]>;

/** The port on the adjacent cell that shares this boundary. Pure coordinate arithmetic; does not check a tile is there. */
export function opposingPort(port: Port): Port;

/** Legs incident to `edge`, as the edge they lead to. */
export function exitsFrom(legs: Array<[TileEdge, TileEdge]>, edge: TileEdge): TileEdge[];
```

The unrotated leg table must cover every member of `TILE_TYPES`. `buffer` is a **stub**:
one edge, no leg (track enters and stops), expressed as an empty leg list plus a documented
comment — a walk entering a buffer finds no exit and the branch ends. `platform` is a
through tile. `crossing` has two non-interconnecting legs. `point-left` / `point-right`
mirror `DRAWN_LEGS` in `packages/frontend/src/diagram/pointRoads.ts` (through `w`–`e`,
divergent `w`–`n` / `w`–`s`); a divergence between the two tables is a bug, and the file
header must say so, exactly as `pointRoads.ts` already does about `TilePath`.

**Test**
- `rotateEdge('n', 45) === 'ne'`, `rotateEdge('nw', 90) === 'ne'`, `rotateEdge(e, 0) === e`
  for all eight.
- `opposingPort` round-trips for all eight edges: `opposingPort(opposingPort(p))` deep-equals `p`.
- `tileLegs` on an unrotated `straight-h` gives `[['w','e']]`; on the same tile rotated 90°
  gives `[['n','s']]`.
- `tileLegs` on `crossing` gives two legs, and `exitsFrom(legs, 'w')` is `['e']` only —
  **the failure path**: a walk entering a diamond from the west must not be offered the
  north leg.
- `tileLegs` on `buffer` is empty.
- Exhaustiveness: `TILE_TYPES.every((t) => tileLegs(tileOfType(t)) !== undefined)` — a new
  tile type with no entry fails here rather than silently becoming untraversable.

### Step 2 — The walk

**Files**
- `packages/backend/src/services/edgeProposals.ts` (new)
- `packages/backend/tests/unit/services/edgeProposals.test.ts` (new)

**Change**

```ts
export const MAX_PROPOSAL_PATH_TILES = 32;
export const MAX_BRANCHES_PER_OPENING = 32;
export const MAX_EDGE_PROPOSALS = 200;

export type EdgeProposalStatus = 'new' | 'needs-end-label' | 'existing' | 'conflicting';

export interface EdgeProposal {
  /** Stable within one response; pairs the two directions of one physical connection (D8). */
  pairId: string;
  fromBlockId: BlockId;
  /** `null` when no `block_ends` row names this opening (D11). */
  fromEnd: string | null;
  toBlockId: BlockId;
  toEnd: string | null;
  pointConditions: PointCondition[];
  /** Always `null`. The literal type is the guard: geometry can never supply distance (D1). */
  lengthMm: null;
  /** Cells crossed between the two blocks, in walk order, so the operator can find it on the drawing. */
  via: Coordinate[];
  /** The path crosses a plain diamond; route conflicts through it are not detected (#26, D5). */
  crossesDiamond: boolean;
  status: EdgeProposalStatus;
  existingEdgeId?: BlockEdgeId;
}

export type ProposalNote =
  | { kind: 'blocked-by-unclassified'; at: Coordinate }
  | { kind: 'blocked-by-unmapped-point'; at: Coordinate; pointId: PointId }
  | { kind: 'blocked-by-unmapped-leg'; at: Coordinate; pointId: PointId; leg: [TileEdge, TileEdge] }
  | { kind: 'blocked-by-buffer'; blockId: BlockId; label: string; at: Coordinate }
  | { kind: 'stopped-in-own-block'; blockId: BlockId; at: Coordinate }
  | { kind: 'search-truncated'; blockId: BlockId; at: Coordinate };

export interface EdgeProposalReport {
  proposals: EdgeProposal[];
  notes: ProposalNote[];
}

export class ProposalLimitExceededError extends Error {
  constructor(readonly limit: number, readonly found: number) { ... }
}

/** Pure. Walks the drawing and returns forward+reverse candidates with no knowledge of existing edges. */
export function proposeEdges(input: {
  tiles: readonly GeometryTile[];
  openings: readonly BlockOpening[];
}): EdgeProposalReport;
```

Algorithm, per non-`terminated` opening, per port of that opening:

1. Seed one branch at `opposingPort(port)` with empty conditions, `via: []`, a per-branch
   visited set of port keys, and the start `blockId`.
2. Pop a branch. If the tile at the branch's cell is absent, discard.
3. Classify the tile (D3). Terminate / discard / traverse as tabled; emit notes as tabled.
4. On a traversable tile, choose the leg set: `metadata.pointRoads` if non-empty (rotate
   each road's `legs`), otherwise `tileLegs(tile)`. Fork once per leg incident to the entry
   edge. A point tile with no road covering an incident leg emits `blocked-by-unmapped-leg`
   and that fork is dropped.
5. Merge the road's `when` into the branch conditions (D4); discard on contradiction.
6. Append the cell to `via`, mark the exit port visited, and push the branch at
   `opposingPort(exitPort)`. Discard on a revisited port, on `via.length >
   MAX_PROPOSAL_PATH_TILES`, or when live branches exceed `MAX_BRANCHES_PER_OPENING`
   (emitting `search-truncated`).
7. On termination, emit a forward candidate. Its ends are looked up in a
   `Map<portKey, {blockId, label}>` built from every opening's `ports`; a miss leaves the
   label `null`.

Then: dedupe forward candidates on `(fromBlockId, fromEnd, toBlockId, toEnd, conditionKey)`
keeping the shortest `via`; synthesise any missing reverse (swap blocks and ends, same
conditions, `via` reversed); dedupe again; assign `pairId` as
`[endKeyA, endKeyB].sort().join('^@') + '^@' + conditionKey`, where `conditionKey` is the
sorted `pointId:position` list. `^@` for the same reason `domain/topology.ts` uses it — it
cannot appear in a block id or an end label. Throw `ProposalLimitExceededError` if the
final count exceeds `MAX_EDGE_PROPOSALS`. Sort deterministically by
`(fromBlockId, fromEnd ?? '', toBlockId, toEnd ?? '', conditionKey)`, and sort notes the
same way diagnostics are, so the list does not reshuffle between polls.

**Test** — each of these is a hand-built tile array, no repository:

1. **Two parallel single-row blocks on adjacent rows, straights only → zero proposals.**
   The #91 shape seen from this side: they touch everywhere and connect nowhere. *This is
   the test that fails loudly if the walk regresses to cell adjacency.*
2. Block A — decorative straight — `point-left` (P1, default roads) — Block B and Block C:
   two proposals from A, one with `[{P1, normal}]`, one with `[{P1, reverse}]`.
3. Two points in series → three destinations with `[]`-free multi-condition sets matching
   #78's Siding 1/2/3 table.
4. A — decorative — B — decorative — C: proposes A↔B and B↔C, **never** A↔C
   (first-block-wins).
5. Unclassified tile on the path → zero proposals, exactly one `blocked-by-unclassified`
   note at its coordinate.
6. Point tile with `pointId` and no `pointRoads` → zero proposals, one
   `blocked-by-unmapped-point`. **The "conditions cannot be inferred" refusal.**
7. A loop returning through the same point at the opposite position → branch discarded,
   zero proposals.
8. Arrival opening `terminated: true` → zero proposals, one `blocked-by-buffer`.
9. Every proposal has `lengthMm === null`, on every fixture. Assert it as a loop over all
   proposals from every other test's fixture, so a future field cannot slip past one case.
10. Bidirectional: every proposal's reverse is present, shares its `pairId`, and carries an
    identical condition set.
11. Point tile rotated 90°: conditions attach to the rotated legs, and the unrotated legs
    are *not* traversable. Legs are stored unrotated (D9) and this is the test that pins it.
12. A `crossing` on the path → proposal emitted with `crossesDiamond: true`; a walk
    entering from the west arrives opposite, never on the crossing road.
13. A point tile tinted with the start block's `blockId` → zero proposals, one
    `stopped-in-own-block` note (D7).
14. A grid fabricated to exceed `MAX_EDGE_PROPOSALS` → throws `ProposalLimitExceededError`
    with `limit`/`found`, and returns nothing.
15. An opening whose port has no `block_ends` match → `fromEnd: null`, status left for
    Step 3 to set.

### Step 3 — Reconciliation against existing edges and stored ends

**Files**
- `packages/backend/src/services/edgeProposals.ts` (extend)
- `packages/backend/tests/unit/services/edgeProposals.test.ts` (extend)

**Change**

```ts
/** Pure. Sets `status`/`existingEdgeId` (D10) and clears end labels with no `block_ends` row (D11). */
export function reconcileProposals(
  proposals: readonly EdgeProposal[],
  existingEdges: readonly BlockEdge[],
  ends: readonly BlockEnd[],
): EdgeProposal[];
```

Builds a `Map<connectionTuple, BlockEdge>` (the same `^@`-joined four-part key
`block_edges_connection_unq` enforces) and a `Set<'blockId label'>` of stored ends. Order:
clear unstored labels first, *then* match tuples — a proposal with a `null` end can never
match an existing edge, and must land as `needs-end-label`, not `new`.

**Test**
- Tuple match, same conditions → `existing` + `existingEdgeId`.
- Tuple match, different conditions → `conflicting` + `existingEdgeId`.
- Same conditions in a different order → `existing`, not `conflicting` (set comparison).
- An existing edge with a `lengthMm` and a proposal with `null` → `existing`. Length is
  never part of the comparison.
- Two edges from one `(fromBlockId, fromEnd)` to two different blocks → both proposals
  reconcile independently and neither is flagged. **The `(from_block_id, from_end)`-is-not-
  unique guard**; a naive implementation keys on the wrong pair and breaks every point
  fan-out.
- An end label with no `block_ends` row → `fromEnd: null`, `status: 'needs-end-label'`,
  even when an edge with the generated label exists.

### Step 4 — Service and route

**Files**
- `packages/backend/src/services/GridService.ts` (extend)
- `packages/backend/src/transport/http/routes/grid.ts` (extend)
- `packages/backend/tests/integration/edgeProposals.test.ts` (new)

**Change**

`GridService.proposeEdges(layoutId): Promise<EdgeProposalReport>` — same assembly as
`diagnose`: `assertLayoutExists`, read tiles/edges/ends, `toGeometryTiles`-style parse
(tolerant, D10 of `docs/track-grid.md`), `generateBlockEnds` for openings, then
`proposeEdges` + `reconcileProposals`. It owns no policy; both callees are pure. No
`TopologyService` dependency — it reads `block_edges` from the repository, and it never
writes.

`GET /api/layouts/:layoutId/grid/edge-proposals` — not admin-gated (D13), delegates,
maps errors through the existing `mapGridError` extended with
`ProposalLimitExceededError → 409 { error, limit, found }`.

**Test**
- 404 on an unknown layout.
- 200 with the report shape on a seeded grid; `proposals` and `notes` both present.
- An operator (non-admin) session gets 200 — this is a read.
- `POST` and `PUT` to the same path are 404: the surface is GET-only, and that is the
  structural guarantee that no bypass write path exists.
- A grid whose tiles are all unclassified returns `proposals: []` and a note per tile,
  and the system stays `online` — a proposal run can never reach `SystemHealth`.

### Step 5 — The accept path, end to end, including the refusal

**Files**
- `packages/backend/tests/integration/edgeProposals.test.ts` (extend)
- `packages/backend/tests/scenario/edge-proposal-accept.scenario.test.ts` (new)

**Change** — none. The accept path is `POST .../edges`, which already exists. This step
exists to *prove* that, and is where the plan earns the "not a bypass" claim.

**Test (integration)**
- Propose → `POST .../edges` with a proposal's `{fromBlockId, fromEnd, toBlockId, toEnd,
  pointConditions}` and **no `lengthMm` field** → 201, and the created edge has
  `lengthMm: null`.
- Re-propose → the same connection now returns `status: 'existing'` with the new edge's id.
  **Idempotence, end to end.**
- Accept the same proposal twice → second is 422 `duplicate-connection`.
- Accept a proposal for a block deleted in between → 422 `unknown-block`. Proves the write
  went through `TopologyService`, not around it.
- Accept a proposal whose `pointConditions` name a deleted point → 422 `unknown-point`
  (write path is stricter than the load path, `docs/topology.md`).
- Accept as an `operator` → 403.
- Accept while a route holds both blocks → **201**. `createEdge` is deliberately unguarded
  (D10 in `docs/topology.md`). This test pins the behaviour so nobody "fixes" it later.

**Test (scenario)** — the failure path CLAUDE.md requires:
- Seed a layout, propose a batch of four, delete one proposal's target block, then accept
  all four sequentially as the UI would.
- Assert: three edges written, one 422 with `unknown-block` in `violations`, the topology
  reports `valid: true` afterwards, `SystemHealth.topologyValid` stays `true`, and the
  system status stays `online` throughout. A refused proposal is an ordinary 4xx and must
  never halt a layout.

### Step 6 — Frontend types and hook

**Files**
- `packages/frontend/src/types.ts` (extend — mirror `EdgeProposal`, `ProposalNote`,
  `EdgeProposalReport`, `EdgeProposalStatus`, beside the existing `GridDiagnostic` mirror)
- `packages/frontend/src/hooks/useEdgeProposals.ts` (new)

**Change**

```ts
export function useEdgeProposals(layoutId: string | null): {
  report: EdgeProposalReport | null;
  loading: boolean;
  loadError: string | null;
  /** Explicitly operator-triggered. Never fires on mount or on a grid write. */
  propose: () => Promise<void>;
  clear: () => void;
};
```

On demand only, exactly like `Ends ⟳` (#72) — this walks the whole drawing and its output
is a review list, not live state. `loadError` carries the 409 body's message when the cap
refuses.

**Test** — none of its own; covered through the component tests in Step 7 and the e2e in
Step 8. (Matching the existing hooks: `useBlockEnds` and `useGridDiagnostics` have no unit
tests either.)

### Step 7 — The review panel

**Files**
- `packages/frontend/src/components/EdgeProposalsPanel.tsx` (new)
- `packages/frontend/src/components/EdgesTab.tsx` (extend — render the panel above the
  add-row)
- `packages/frontend/src/components/edgeProposals.ts` (new — pure helpers)
- `packages/frontend/src/components/edgeProposals.test.ts` (new)

**Change**

Pure helpers, kept out of the component so the copy is testable without rendering
(`diagram/diagnostics.ts` precedent):

```ts
/** The POST body for an accepted proposal. Omits `lengthMm` entirely — `edgeCreateSchema` defaults it to null (D1). */
export function proposalToEdgeInput(p: EdgeProposal, ends: { fromEnd: string; toEnd: string }): EdgeWriteInput;

/** `new` and `needs-end-label` first, then `conflicting`, then `existing` collapsed. */
export function groupProposals(ps: readonly EdgeProposal[]): {
  actionable: EdgeProposal[]; conflicting: EdgeProposal[]; existing: EdgeProposal[];
};

/** Operator-facing text for a note, with ids paired with names per docs/naming.md D8 — raw id byte-for-byte when unnamed. */
export function describeProposalNote(n: ProposalNote, names: DiagnosticNames): string;
```

Panel behaviour:

- A **"Propose from drawing"** button. Nothing runs on mount.
- One row per `pairId`, showing both directions with a checkbox each, both ticked by
  default (D8), the point conditions as the same chips the edges table uses, the `via`
  coordinates, and `lengthMm` rendered as a literal **"unmeasured"** with the reason —
  never an empty field that looks like an oversight.
- `needs-end-label` rows show a `<select>` of that block's stored ends (from
  `useBlockEnds`) and are un-tickable until both ends are chosen.
- `crossesDiamond` rows carry an inline warning naming #26 — text, not colour alone (#81).
- `conflicting` and `existing` rows are grouped, greyed, and have no checkbox.
- **Accept selected** posts sequentially via `ops.createEdge`. Succeeded rows leave the
  list; failed rows stay, each with its own message/violations rendered by the tab's
  existing `describeViolation`. The batch does not abort on the first failure.
- Notes render in their own list below, styled like the diagnostics `TODO` lines — this is
  a to-do list, not a wall of errors (D11 of `docs/track-grid.md`).
- Copy states plainly that a point's leg mapping is an author's assertion that nothing can
  verify (D4), and that a length must be measured on the real railway.

**Test**
- `proposalToEdgeInput` has no `lengthMm` key at all (`'lengthMm' in result === false`) —
  `edgeCreateSchema` is `.strict()`, so this is also a 400 guard.
- `proposalToEdgeInput` lower-cases and trims the end labels client-side, matching
  `edgeCreateSchema` and `buildEdgeDraft`'s existing behaviour, so the operator sees the
  value that will be persisted.
- `groupProposals` puts `needs-end-label` in `actionable`, not `existing`.
- `describeProposalNote` renders each note kind, and degrades an unnamed id to the raw id
  byte-for-byte (docs/naming.md D8).

### Step 8 — e2e

**Files**
- `tests/e2e/edge-proposals.spec.ts` (new)

**Test**
- Draw (or seed) two blocks joined by decorative track through a mapped point; open
  Configure → Edges; press **Propose from drawing**; see two rows for one `pairId`.
- Accept both; the edges table gains both rows with `Length (mm)` showing `—`.
- Press Propose again; the connection now appears in the collapsed **already authored**
  group and offers no checkbox. **Idempotence, visible to the operator.**
- Delete one accepted edge in the table, propose again, and it returns as actionable —
  proving statelessness (D9) is a property the operator can rely on rather than a bug.

### Step 9 — Documentation, in the same PR

**Files**
- `docs/topology.md` — extend "Geometry can propose connectivity; it can never supply
  length" with what #78 landed: the port walk, the refusal set (D3–D7), and the fact that
  accepting goes through `createEdge` with no new write surface.
- `docs/track-grid.md` — add **D12 — Proposals read tiles; they never write the graph**,
  recording D3, D4, D7 and D9's unverifiability, and cross-referencing `docs/topology.md`.
- `CLAUDE.md` — one new row in "What has landed": *Edge proposals (#78)*, naming
  `services/edgeProposals.ts`, the GET route, "accepted rows go through the ordinary
  `TopologyService.createEdge` path", and `docs/topology.md` as the read-first document.
  Amend the "Open limits" bullet on the manual classification pass to note that unfinished
  classification blocks proposals by design.
- `README.md` — rewrite the Known Limits sentence "Edges are still authored explicitly
  through the Edges tab rather than derived from grid tiles (#78)": they are still
  authored, but the drawing now proposes them for review. Amend Next Milestone 4 ("Link
  grid tiles to the topology graph, so tile placement can derive edges") — deriving stays
  rejected; proposing has landed.

Run `npm run lint` and `npm test` **from the repo root** before reporting complete.

---

## Out of scope

- **Deriving** edges. The grid stays presentational; nothing in `domain/` reads a tile.
  This feature only ever produces a list a human confirms.
- `lengthMm` in any form. #77 is where a length model goes, gated on #6.
- Persisting rejections (D9), and any `dismissed` state.
- Highlighting a proposal's path on the diagram — wants #75's unified renderer.
- Proposing `block_ends` rows. If an end has no label the proposal says so and stops; it
  does not create one. `Ends ⟳` (#72) is the tool for that and stays a separate, deliberate
  act.
- Fixing #91. This plan assumes it, consumes it, and adds nothing to it beyond the two
  exports named in the open questions.
- Any change to `TopologyService`, `edgeCreateSchema`, or the `block_edges` schema.
- Searching around a point-position conflict (P5 in `docs/pathfinding.md`) — unrelated, and
  a pathfinder concern rather than an authoring one.
