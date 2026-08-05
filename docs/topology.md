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

## Safe-Stop on invalid topology

- **Trigger:** `LayoutService.reloadTopology()` calls `loadTopology`, which
  validates every edge with `validateTopology` and partitions the results
  with `isFatalViolation`. If any fatal violation remains, the graph is not
  built and `SystemHealth.topologyValid` is set to `false`. Check order in
  `evaluateSystemSafeStop` (`domain/safety.ts`) is MQTT → DCC → topology, so
  a connection failure reason always wins over a topology reason if both are
  present.
- **Reason string:** `describeViolations` produces
  `Topology invalid: N violation(s) — <first three, semicolon-separated>`.
  This is the same string that ends up on `SystemHealth.topologyReason`, the
  `SYSTEM_STATUS` event's `reason` field, and the retained
  `system/status.reason` MQTT field — no new topic or payload field was
  needed; `system/status.reason` is already documented in
  `docs/mqtt-contract.md` as free-text "human-readable reason for a
  safe-stop or offline status".
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

- **Ids are enumerable.** `GET /api/layouts` and `GET /api/layouts/:id/blocks`
  are unauthenticated, so any id in the system can be discovered. Deleting by
  id alone would let `DELETE /api/layouts/<anything>/blocks/<real-id>` destroy
  the owning layout's block — and, now that block deletes cascade to edges,
  its topology with it.
- **Ordering matters in `deletePointIfUnreferenced`.** The reference guard
  scans the *path* layout's edges. If ownership were checked after the guard, a
  point belonging to another layout would show no references there and the
  delete would be waved through, stranding the owning layout's edge conditions
  as `unknown-point`. Ownership is therefore checked **first**.

## Deferred: edge writes vs. route reservations (#4)

`RouteId` and `lockedByRoute` exist in `domain/types.ts` but nothing populates
them yet — route reservation (#4) hasn't landed. Once it does,
`TopologyService#updateEdge`/`#deleteEdge` will need to refuse a write against
an edge that is part of a currently-reserved route (or, at minimum, force
that route to be torn down first) — mutating track geometry out from under an
active reservation is exactly the kind of "guess a train's position" failure
CLAUDE.md's fail-safe rule forbids. That check does not exist yet; there is
nothing to conflict with it yet. Do not assume `TopologyService` writes are
currently gated by reservation state — they are not.
