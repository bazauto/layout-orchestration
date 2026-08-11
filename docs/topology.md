# Track Topology — Decision Record

This document records the design decisions behind `block_edges` and the topology
validation/Safe-Stop machinery built on top of it (`src/domain/topology.ts`,
`src/domain/graph.ts`, `src/services/topologyLoader.ts`, `src/services/TopologyService.ts`).
It is not binding in the way `docs/mqtt-contract.md` is — there is no hardware on
the other end of it — but it explains *why* the schema and validation are shaped
the way they are, so the next change doesn't accidentally undo a deliberate
choice.

## The edge model

A `BlockEdge` is a directed connection from one named end of one block to a
named end of another block:

```
{ id, layoutId, fromBlockId, fromEnd, toBlockId, toEnd, pointConditions, lengthMm }
```

A bidirectional physical connection between two blocks is represented as two
rows, one in each direction — edge direction is purely geometric and unrelated
to a loco's direction of travel.

### Block-end labels

`fromEnd`/`toEnd` are free-text labels ('north', 'yard-3', ...) naming a
physical opening of a block. They only need to be used consistently for a
given block. On write, `edgeCreateSchema`/`edgeUpdateSchema` trim and
lower-case them before checking them against `blockEndLabelSchema`:

```
/^[a-z0-9][a-z0-9_-]*$/, length 1–64
```

so `' North '` normalises to `'north'` rather than being rejected, and a
block never ends up with both `'north'` and `'North'` as distinct ends by
accident. A `block_edges` row that fails this pattern (e.g. `'North'`,
un-normalised) did not come through the API and is treated as DB corruption —
see "Safe-Stop on invalid topology" below.

Since #72 the labels are also **generated and stored** in a `block_ends` table
— see the next section. The contract above is unchanged: `fromEnd`/`toEnd` stay
free text, stay un-FK'd, and an end label with no other referent stays legal.

## Block ends: derived by default, authored by exception (#72)

### The problem

Authoring an edge meant looking at the drawing, deciding that the left-hand end
of Fiddle Yard 1 was the one you previously called `north`, and typing it
correctly — every time, for every edge, with **no feedback if you got it
wrong**. Nothing on the track diagram showed which end of a block was which.

A transposed pair produces a valid-looking edge that connects the wrong ends,
and the pathfinder plans through it happily: `(block, end entered by)` is its
search state (`domain/pathfinding.ts`) and it has no independent notion of
geometry. This is a plausible contributor to the Westgate Hollow edge set being
mostly unauthored — the task was tedious *and* unverifiable.

### The decision

**Generate end labels from the drawn geometry as 8-point cardinal directions,
with north at the top of the diagram, and let a manual override stick.**

- **Vocabulary**: `north`, `northeast`, `east`, `southeast`, `south`,
  `southwest`, `west`, `northwest` (`CARDINAL_END_LABELS`). All satisfy
  `blockEndLabelSchema`, so no contract change was needed.
- **Generated vs pinned**: `block_ends.pinned` records that a label was
  authored. Regeneration replaces unpinned rows and never touches pinned ones.
- **Existing labels are pinned on adoption.** Any label already referenced by a
  `block_edges` row is pinned the first time `generate` runs. This is why the
  feature needed **no migration and no rename machinery**: Westgate Hollow's
  authored edges protect their own labels.
- **Collisions are refused, not suffixed.** Two openings of one block that face
  the same way from different places produce a reported collision and no label
  at all. A silently suffixed `east_2` is exactly the kind of name that gets
  typed wrong later in an edge.
- **Regeneration is on demand**, never on a grid write. Redrawing a corner of
  the layout must not silently rename ends underneath the edges referencing
  them.

### Why a table, and not tile metadata

Deliberately the **opposite** call to #71's tile classification and #74's
annotations, which both landed in `grid_tiles.metadata` in the same wave. The
distinction is the point:

- A tile's classification and an entity's diagram placement are properties of
  **the drawing**.
- A block end is a property of **the block**. It is referenced as free text by
  `block_edges`, it is the anchor #79 attaches signals to and #84 resolves
  buffers against, and it survives the drawing being re-laid. Burying it in a
  tile blob would make the one thing edges depend on the least durable record
  in the system.

### No foreign key from `block_edges`, deliberately

`fromEnd`/`toEnd` are **not** FK'd to `block_ends` and must not become so:

- the existing model deliberately tolerates an end label with no other referent;
- a malformed label is DB corruption handled by the Safe-Stop path, not by
  referential integrity — an FK would change that failure mode to "write
  refused", a regression against #10;
- the adoption pass would become a chicken-and-egg problem against its own
  constraint.

`tests/integration/migrations.test.ts` asserts the absence of that FK directly.

### A rename is a track-graph change, and is refused

An end label is the **only** link between an edge and a block end, so renaming
one silently re-points every edge referencing it. `BlockEndService` therefore
answers **409** to a rename or delete of a label any edge uses, rather than
cascading. The operator edits the edges, or keeps the name.

### Known property: a cardinal label describes the diagram, not the railway

The drawing is explicitly not to scale and its orientation is a drawing
convention (see `docs/track-grid.md`). If the diagram is re-laid or rotated, a
*generated* label regenerates to match — but a *pinned* one does not, and
neither do the `block_edges` rows referencing either.

That is the correct behaviour: an end label is a name, and once edges reference
it its meaning is frozen. But it means **a block end called `north` can end up
pointing east on the drawing.** Recorded here so nobody later "fixes" it and
rewrites the track graph as a side effect.

### Geometry can propose connectivity; it can never supply length

`services/gridGeometry.ts` derives openings from tile adjacency. It does not,
and must not, derive distance. Tile count bears no relation to physical extent —
the Westgate Hollow entry feeder is drawn long and is short in reality, and is
not a block at all. `block_edges.lengthMm` stays authored, with
nullable-means-unmeasured (`docs/braking.md` B4). This sharpens the deferred
"derive edges from grid tiles" note below: #78 can propose complete rows
*except* `lengthMm`, and the reason is now known rather than assumed.

## Why `(from_block_id, from_end)` is NOT unique

A naive schema might make `(layout_id, from_block_id, from_end)` unique, on
the theory that "one physical opening, one edge". That's wrong for anything
with a point: a turnout, three-way point, or slip gives a single block-end
**several** outgoing edges — one per point setting — and the correct one is
selected at runtime by whichever edge's `pointConditions` are currently
satisfied (`isEdgeTraversable` in `domain/graph.ts`). A throat block's east
end might have two outgoing edges to two different platforms, discriminated
only by a point's position. Enforcing uniqueness on `(from_block_id,
from_end)` would make that layout un-representable.

What **is** unique is the full connection tuple:

```
uniqueIndex('block_edges_connection_unq')
  .on(layoutId, fromBlockId, fromEnd, toBlockId, toEnd)
```

Two edges may not describe the exact same physical connection twice — that's
data duplication, not a fan-out. `migrations/0002_bitter_jane_foster.sql` and
`tests/integration/migrations.test.ts` both assert this directly: two edges
from the same `(from_block_id, from_end)` to two *different* blocks both
succeed; the same tuple inserted twice fails.

The other three `block_edges` CHECK constraints (also in that migration) are
plainer data-integrity rules: `from_block_id <> to_block_id` (no self-loop),
`length_mm IS NULL OR length_mm > 0` (a measured length must be positive;
`NULL` means "unmeasured, treat as unsafe for automated braking" — see the
column comment in `schema.ts`), and both ends must be non-blank after
trimming.

## Violations: fatal vs non-fatal

`domain/topology.ts` defines six violation kinds. `isFatalViolation` treats
five as fatal and one as not:

| Kind | Fatal? | Why |
|---|---|---|
| `layout-mismatch` | Yes | An edge claiming a different `layoutId` than the one it was loaded under is corrupt data; nothing about it can be trusted. |
| `duplicate-edge-id` | Yes | Two edges sharing a primary key means the graph cannot be built (`Map` semantics would silently drop one). |
| `self-loop` | Yes | A block cannot connect to itself; downstream reachability logic assumes it can't. |
| `unknown-block` | Yes | An edge referencing a block that doesn't exist can't be placed in the graph at all. |
| `duplicate-connection` | Yes | Two edges describing the same physical connection is data duplication (see above) — ambiguous, must be fixed. |
| `unknown-point` | **No** | An edge referencing a point that no longer exists. |

`unknown-point` is the sole exception because of how point conditions already
fail closed. `unsatisfiedConditions` in `domain/graph.ts` treats a point that
is missing from the position map — which a deleted point always will be — as
unsatisfied. A dangling point reference therefore makes **that one edge**
permanently non-traversable; it does not corrupt the rest of the graph or
allow the domain layer to reach an unsafe conclusion about it. Refusing to
build the whole graph over one broken edge condition would be a stricter
Safe-Stop than the actual risk justifies, so the topology load path
(`services/topologyLoader.ts`) tolerates it and keeps the system online.

The normal way for this to happen is prevented at the door:
`TopologyService#deletePointIfUnreferenced` refuses to delete a point that
any edge's `pointConditions` still mention, naming the referencing edge ids.
The tolerance in `isFatalViolation` exists for defence in depth — data
predating that check, or written outside the API — not as the primary
guard rail.

Note the asymmetry with the *write* path: `TopologyService#createEdge` and
`#updateEdge` reject on **any** violation, including `unknown-point` — you
should never be able to *create* an edge with a dangling point reference
through the API, even though the system tolerates one it finds already
sitting in the database.

## Validation cost, the edge cap, and why the full pass stays

`domain/topology.ts` re-runs `validateTopology` over the *entire* edge list on
every load (`LayoutService.reloadTopology`, on startup and after every write)
rather than caching a verdict or revalidating incrementally. That was an
O(n^2) pass until #21, because `duplicate-connection` detection was an
`Array#find` scan per edge. Both halves of that — "full pass, every time" and
"O(n)" — are deliberate, not merely convenient, and worth recording so a
future change doesn't undo either by accident.

### Why a full pass, not incremental revalidation or a cache

Not every violation kind is local to the one edge that triggers it:

| Kind | Local to one edge? | Non-local effect |
|---|---|---|
| `layout-mismatch` | yes | none |
| `self-loop` | yes | none |
| `unknown-block` | no | a block delete invalidates other edges' verdicts |
| `unknown-point` | no | a point delete invalidates other edges' verdicts |
| `duplicate-connection` | **no** | inserting X makes both X *and* pre-existing Y violate; deleting one of a duplicate pair *heals* the other |
| `duplicate-edge-id` | no | set-level property |

Only two of six are genuinely local. `duplicate-connection` healing on delete
is the reason incremental revalidation with a cached verdict is rejected: an
operation that *removes* a violation (deleting one of a duplicate pair) would
have to invalidate a cached "layout is invalid" result — exactly the
direction an incremental scheme tends to get wrong. Getting it wrong
stale-invalid means a Safe-Stop that never clears; getting it wrong
stale-valid means running trains on a graph nobody has actually checked.
Either failure is worse than the cost of a full O(n) pass, so the pass stays
full and unconditional.

A cached *edge list* (as opposed to a cached verdict) is rejected for the same
underlying reason: it's a second source of truth about track geometry, and
its failure mode is a graph built from edges that no longer exist.

### The two-slot duplicate-connection index

`buildEdgeIndex` builds a `Map` from a `^@`-joined connection tuple
(`fromBlockId^@fromEnd^@toBlockId^@toEnd`) to the first and second edge ids
seen for that tuple. `^@` rather than `:` because block ids are UUIDs today
but `fromEnd`/`toEnd` are free text matching `/^[a-z0-9][a-z0-9_-]*$/` — a
separator that cannot appear in either field removes any ambiguity between,
say, `a` + `^@b` and `a^@` + `b`.

Two slots are enough. The pre-#21 check was `existingEdges.find(o => o.id !==
edge.id && sameTuple)` — the *first* edge in list order whose id isn't the one
being checked. If a bucket's first id isn't that edge's, that's the answer; if
it is, the second slot is; a third or later edge sharing the tuple was never
the answer under the old semantics either. So the two-slot index reproduces
`find`'s result exactly, including for three-or-more-way duplicates — proven
in `tests/unit/domain/topology.test.ts` and by construction in
`domain/topology.ts`'s comments, not just asserted.

`validateEdgeAgainstLayout`'s fourth parameter accepts either the raw edge
array or a prebuilt `EdgeIndex`, discriminated by `Array.isArray` (true for a
plain array and for a `Proxy` over one, so the complexity benchmark below can
wrap the array transparently). `validateTopology` builds the index once
before its loop, making the full pass O(n); a single-edge check
(`TopologyService.createEdge`/`updateEdge`) still passes the raw array, which
costs one O(n) index build for one O(n) check — the same cost it paid before
#21.

### The edge cap: admission control, not an invariant

`domain/topology.ts` exports `MAX_EDGES_PER_LAYOUT = 2000`. It exists because
making the full pass O(n) doesn't bound `n` — `POST
/api/layouts/:layoutId/edges` has no auth (#20) and no rate limit, so nothing
stops it being called far more than a physical layout could ever need. The
seeded Westgate Hollow layout is ~40 edges; a large club-scale layout (~200
blocks) is on the order of 1,200. 2,000 is roughly 50x that, chosen so the
*bounded* worst case stays defensible even if a future change reintroduces a
quadratic path somewhere: 2,000^2 comparisons is tens of milliseconds — bad,
but finite and detectable, not an indefinite event-loop stall.

The cap is enforced by `TopologyService.createEdge` only, checked against the
`existingEdges` list that call already fetches for duplicate-connection
checking — no extra query. It is **not** enforced elsewhere:

- Not `updateEdge` or any delete — they don't grow the count.
- **Not the load path.** `loadTopology`/`reloadTopology` must still load a
  layout that somehow exceeds the cap — data written outside the API, or a
  cap lowered later — or the system Safe-Stops on a *policy* limit with no
  way for an operator to delete their way back under it. Deleting requires a
  loaded graph.
- **Not the database.** #11 put graph invariants at the DB level as well as
  the domain level, but the cap isn't an invariant — exceeding it is policy,
  not corruption. The only SQLite mechanism for a row-count cap is a trigger
  running `SELECT COUNT(*)` per insert, which makes every insert O(n) at the
  storage layer to defend against an O(n) cost at the domain layer, and it
  would need a hand-written migration against the "generate, don't
  hand-write" rule. Service-level only, deliberately — don't "complete" this
  with a DB constraint later.

A cap breach is a distinct `EdgeLimitExceededError` (`limit`/`current`), not a
fabricated `TopologyViolation` — the candidate edge may be perfectly valid,
it's the layout's edge count that refuses it. It maps to HTTP 409, not 422:
the payload is well-formed, it's the resource's state that refuses the write.

### Debouncing `onTopologyChanged` is rejected

`TopologyService` calls `onTopologyChanged` (→
`LayoutService.reloadTopology()`) after every successful write, synchronously
in the request path, with no coalescing. Three reasons this stays as-is:

1. Any debounce window is a window in which an invalid graph is treated as
   valid — the exact failure this validation exists to prevent.
2. `reloadTopology` is the defence-in-depth re-check after a write that
   already validated itself before persisting; delaying it delays the
   Safe-Stop that's the point of having it.
3. Once the pass is O(n) at a capped n, a reload costs microseconds (see
   below) — there's nothing expensive left to debounce.

### Measured ceiling

`tests/integration/topology-scale.test.ts` loads a layout at
`MAX_EDGES_PER_LAYOUT` (2,000 edges) end to end through `loadTopology` and
asserts it completes in well under 500ms; measured at time of writing, about
11ms on ordinary dev hardware. That's a catastrophic-regression smoke check,
not the complexity proof — `tests/unit/domain/topologyComplexity.test.ts`
is, via a deterministic proxy-counted operation count rather than wall-clock
timing, since a wall-clock ratio on CI is flaky and proves nothing about
complexity on its own.

## Safe-Stop on invalid topology

- **Trigger:** `LayoutService.reloadTopology()` calls `loadTopology`, which
  validates every edge with `validateTopology` and partitions the results
  with `isFatalViolation`. If any fatal violation remains, the graph is not
  built and `SystemHealth.topologyValid` is set to `false`. Check order in
  `evaluateSystemSafeStop` (`domain/safety.ts`) is MQTT → DCC → topology, so
  a connection failure reason always wins over a topology reason if both are
  present.
- **Reason string:** `describeViolations` produces
  `Topology invalid: N violation(s) [(first 3 shown)] — <first three,
  semicolon-separated>` — the `(first 3 shown)` suffix appears only when
  `N > 3` (#54; the old version silently dropped the rest). Each id in the
  violation list renders as `"Name" (shortid)` when a `NameBook` is
  supplied to `describeViolations` (as `LayoutService.reloadTopology` now
  does — see `docs/naming.md`) and degrades to the bare id, byte-for-byte,
  with no book. This is the same string that ends up on
  `SystemHealth.topologyReason`, the `SYSTEM_STATUS` event's `reason`
  field, and the retained `system/status.reason` MQTT field — no new topic
  or payload field was needed; `system/status.reason` is already
  documented in `docs/mqtt-contract.md` as free-text "human-readable
  reason for a safe-stop or offline status".
- **Recovery:** an operator (today: via `TopologyService`, once #2 lands: via
  the Configure UI) fixes the offending edge — typically by deleting it — and
  the write path's `onTopologyChanged` callback triggers
  `LayoutService.reloadTopology()` again. If topology is valid and
  connections are healthy, `evaluateAndApplySafeStop` clears Safe-Stop and the
  system returns to `online`.
- **Edge writes stay permitted while in Safe-Stop.** `TopologyService` does
  not check `LayoutService`'s current status before accepting a write — it
  can't recover otherwise. This mirrors `canIssueManualCommand`, which
  already permits manual commands during Safe-Stop "to allow operator
  recovery" (`domain/safety.ts`). What Safe-Stop halts is automated movement
  and new *route* reservations, not topology authoring.
- **The MQTT-reconnect latch.** Because `topologyValid` is folded into the
  same `SystemHealth` object as the connection flags, a connection recovering
  on its own (e.g. the MQTT broker reconnecting) cannot clear a Safe-Stop
  that topology caused — `evaluateSystemSafeStop` still finds
  `topologyValid: false` and keeps `shouldStop: true`. This is exercised
  directly in `tests/unit/services/layoutService.test.ts` (the "regression
  guard for #10").

## An id is not authority to delete

Every delete in `TopologyService` verifies the record belongs to the `layoutId`
in the request path before touching it. `deleteEdge`, `deleteBlockWithEdges`,
and `deletePointIfUnreferenced` all resolve the record first and throw
(`EdgeNotFoundError` / `RecordNotFoundError` → 404) on a mismatch. The
repository methods are scoped by `layoutId` in their `WHERE` clauses too, so a
mismatched layout deletes zero rows rather than another layout's records.

Two reasons this is stated rather than assumed:

- **Ids are enumerable by any logged-in user.** `GET /api/layouts` and
  `GET /api/layouts/:id/blocks` require an authenticated session (see
  `docs/auth.md`) but are not role-gated — an `operator` can read them the
  same as an `admin` — so any id in the system is discoverable by anyone who
  can log in at all. Deleting by id alone would let
  `DELETE /api/layouts/<anything>/blocks/<real-id>` destroy the owning
  layout's block — and, now that block deletes cascade to edges, its
  topology with it.
- **Ordering matters in `deletePointIfUnreferenced`.** The reference guard
  scans the *path* layout's edges. If ownership were checked after the guard, a
  point belonging to another layout would show no references there and the
  delete would be waved through, stranding the owning layout's edge conditions
  as `unknown-point`. Ownership is therefore checked **first**.

## Edge writes vs. route reservations (D10, #3)

This used to be a deferred note: `RouteId` and `lockedByRoute` existed in
`domain/types.ts` but nothing populated them, and `TopologyService` writes
were not gated by reservation state at all. Route locking (#3) closed it.
Full design record: `docs/route-locking.md` D10.

`TopologyService`'s constructor now takes a fourth argument,
`lockView: IRouteLockView`, implemented by `ReservationService` — the same
injection style as the existing `onTopologyChanged` callback, so
`TopologyService` stays testable standalone (a hand-rolled `IRouteLockView`
in tests, no real `ReservationService` needed).

- `updateEdge` / `deleteEdge`: refused (`LockedByRouteError` -> HTTP 409)
  when the edge is held by an `active` or `suspended` reservation.
- `deleteBlockWithEdges`: refused when the block itself, or any edge
  referencing it, is held.
- `deletePointIfUnreferenced`: refused when the point is held.
- `createEdge` stays **permitted** — a new edge moves no train, and it
  cannot be traversed into reserved track because the target block is
  already locked.

The interaction with the "edge writes stay permitted during Safe-Stop"
rule above still holds, but a *suspended* reservation (not just `active`)
still blocks the write, since `IRouteLockView` reports both. The operator
cancels the route first, then edits — cancel is always available, so this
is an explicit ordering, not a deadlock.
