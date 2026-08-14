# Operator-Facing Names — Decision Record

This document records the design behind #54: rendering an operator-facing
diagnostic string (a route rejection, a topology violation, a Safe-Stop
reason, an HTTP 404 body) with the human-readable name a block/point/sensor/
loco already carries in the roster, instead of the bare UUID every id in this
system actually is (`adapters/db/repository.ts`, `authRepository.ts`).

Same posture as `docs/topology.md`, `docs/route-locking.md`, and
`docs/sensor-fault-recovery.md` — not binding the way `docs/mqtt-contract.md`
is, but it explains *why*, not just *what*, so the next change doesn't
accidentally undo a deliberate choice. Read this before touching
`domain/naming.ts`, `services/nameBook.ts`, or any `describe*` function in
`domain/`.

## The situation this closes

Every entity id is a `randomUUID()`. `blocks`, `points`, `sensors`, and
`locos` all carry a `name` column that no error text consulted. Refusing a
circular route used to report:

```
Route rejected: 1 reason(s) — destination block 3c1dab82-d0db-4271-b695-62b599db0f88 is the start block
```

— including on `system/status.reason`, the Safe-Stop reason string that goes
out over MQTT and is the first thing an operator standing at the layout
reads. `domain/routeLocking.ts#describeRejection`,
`domain/pathfinding.ts#describeBlocker`, `domain/topology.ts#describeViolation`,
and `domain/braking.ts#describeBrakingRefusal` were all affected, along with
error classes and log calls across `LayoutService`, `ReservationService`, and
`TopologyService`.

## D1 — Where the edge label is derived: in the `NameBook` builder

`TopologyViolation`/`BrakingRefusal` carry only `edgeId`, and changing them is
out of scope (see Out of scope below) — `describeViolation` and
`describeBrakingRefusal` have no `BlockEdge` record to derive
`Down Platform:north → Up Loop:south` from. Giving them one would mean the
book carries edge *records*, i.e. a second lookup and real coupling to
`domain/types.ts#BlockEdge`. The builder (`services/nameBook.ts#buildNameBook`)
already holds blocks and edges together, derives the label once at O(E) via
`domain/naming.ts#buildEdgeLabel`, and the single `edges: Map<BlockEdgeId,
string>` then serves `describeViolation`, `describeRejection`'s
`unknown-edge`, and `describeBrakingRefusal`'s `unmeasured-track`/
`unknown-edge` identically. `NameBook.edges`' values are documented as
*derived labels, not names* — `block_edges` has no name column.

## D2 — `NameBook` shape and home

Six `ReadonlyMap`s (layouts, blocks, points, sensors, locos, edges), declared
in `domain/types.ts` — CLAUDE.md makes `types.ts` the authoritative
vocabulary for the whole system, so the shape goes there. The rendering
functions (`label`, `shortId`, `truncateLabel`, `buildEdgeLabel`,
`pluralise`, and the six `*Label` helpers) live in a new `domain/naming.ts`
instead: they are logic, not vocabulary, and putting them in `types.ts` would
make every consumer of a type import a formatter. `ReadonlyMap`, not
`Record`, matching `ReservationView.blocks`/`points` and
`LayoutRuntimeState.locos` (which is keyed by a number, same as
`NameBook.locos`).

## D3 — Routes are deliberately *not* in the `NameBook`

`block-locked`/`point-locked` would read better as "held by *Jinty's*
route", but a route is runtime state that changes on every grant, whereas the
book's whole value is that it caches config and invalidates on config writes
(D5). Mixing the two lifetimes means either a stale map that almost always
misses, or a rebuild on every grant. Route ids therefore keep their current
full-id rendering in `describeRejection` and `describeBrakingRefusal`
(`manual-authority`/`route-not-active`). Residual: a lock message names the
route id holding a block/point, not the train behind that route — worth its
own issue if it turns out to matter in practice; `loco-already-routed` and
the Routes panel already name the loco for the cases that matter most.

## D4 — Ownership: `NameBookCache` behind `INameBook`, injected into all three services

`LayoutService → ReservationService` is one-way and `TopologyService` takes
no service references (`ports/IRouteLockView.ts`'s injection style is the
precedent), so no service can pull the book from another. A cache object
(`services/nameBook.ts#NameBookCache`) constructed once in `index.ts` and
passed to all three — plus into `buildServer` for the transport layer — is
the natural fit. The port (`ports/INameBook.ts`) carries `get()` and
`refresh(layoutId)`; the parameter on every consuming constructor is
**optional with an inert default** (`INERT_NAME_BOOK`), which is what keeps
the ~60 existing `new LayoutService(...)`/`new TopologyService(...)`/
`new ReservationService(...)` call sites in tests compiling untouched.
`INERT_NAME_BOOK.get()` returns `EMPTY_NAME_BOOK`; `refresh()` resolves
without touching a repository.

## D5 — Invalidation points, and what a missed one costs

The cache is bound to one `layoutId` at construction; `refresh(layoutId)` is
a documented no-op on mismatch, so a config write against a non-running
layout cannot clobber the running layout's book. Refresh is called from:

| Trigger | Call site |
|---|---|
| Startup | `LayoutService.initializeLayoutState` → `reloadTopology()` |
| Edge create/update/delete, block delete | `TopologyService.onTopologyChanged` → `LayoutService.reloadTopology()` (first statement, before `loadTopology`) |
| Sensor create/update/delete | `LayoutService.createSensorConfig`/`updateSensorConfig`/`deleteSensorConfig`, immediately after the repo write and before `recomputeBlock`/`evaluateAndApplySafeStop` |
| Block create/update, point create/update/delete, loco create/update/delete | the route handler (`transport/http/routes/{blocks,points,locos}.ts`), after a successful write |

The last row is the only new plumbing — everything above it is delegation,
so safety rule 2 is not engaged. **A missed refresh degrades to a stale
display name and never to unsafe behaviour**, which is the property that
makes eager-refresh-with-explicit-call-sites acceptable instead of a
generation counter or a per-request rebuild.

## D6 — Truncation and the resulting bound

`blocks.name`/`points.name`/`sensors.name`/`locos.name` are `z.string().min(1)`
with **no maximum** (`services/validation.ts`), so without a cap the reason
string is unbounded. One rule, applied to every book *value* at build time:
`MAX_LABEL_CHARS = 40` (cut at 39 chars + `…`). `label()` itself never
truncates — truncation happens once, when the book is built, not on every
render.

Rendered form is `"Down Platform" (3c1dab82)` — name for the human,
`SHORT_ID_CHARS = 8` of id so a log line still correlates with the
structured fields and the API. Max 53 chars per label.

Worst case for `system/status.reason` (the only published reason string) is
`describeViolations` with the longest template, `duplicate-connection`,
which carries two edge labels: ~538 bytes for a 3-violation, 20-blocker
worst case — about 115 bytes over the pre-#54 UUID form, still comfortably
under 600. The 3-violation cap on `describeViolations` and
`MAX_REPORTED_BLOCKERS` (pathfinding.ts) both stay unchanged.

`describeRejections` (route-locking.ts) stays untruncated and is unaffected
by the bound: it reaches only HTTP 422 bodies and log lines
(`transport/http/routes/routes.ts`'s `POST .../routes` is its sole call
site), not MQTT. `TopologyService.deletePointIfUnreferenced`'s rejection
message follows the same truncation posture — at most 5 referencing edges
shown, `(first 5 shown)` past that — because that list is bounded only by
`MAX_EDGES_PER_LAYOUT` (2,000).

Separate, pre-existing, and explicitly out of scope: `abandonRouteOnPointFailure`'s
reason (`LayoutService.ts`) interpolates raw DCC adapter error text, which
was already unbounded before #54 and stays that way — names add roughly 17
bytes per point-command failure, not a new problem.

## D7 — Delimiters and plurals

Nested blockers move from a second em-dash to a bracketed sub-list, so the
sentence structure is unambiguous exactly where it matters:

```
Route rejected: 1 reason — no route exists to block "Up Loop" (b2) [blocked by: block "Up Loop" (b2) is occupied]
Route rejected: 3 reasons — ...; ...; ...
Topology invalid: 1 violation — ...
Topology invalid: 5 violations (first 3 shown) — ...; ...; ...
```

Square brackets rather than parentheses because labels already contain
parentheses (`(shortid)`). `(first 3 shown)` is new on `describeViolations`
and only appears when `n > 3` — the pre-#54 version silently dropped the
rest, which is worse than saying so.

## D8 — What "degrades to today's output" means

With no book (or a book miss) `label()` (and every `*Label` helper built on
it) emits the full id verbatim — **byte-for-byte identical to the pre-#54
output**. Every domain unit test added for #54 asserts this path explicitly,
not just the with-a-book path. The D7 wording fixes (plural/delimiter) are
**unconditional** — the issue asked for them explicitly, so they are not
part of the degradation contract and apply whether or not a book is
supplied.

### An end label needs no book, by construction (#103)

D8's degradation contract is about ids, which are UUIDs and unreadable without a
book. An end label never was: `north`, `southeast-1`. It carried a name already.

That is now guaranteed rather than incidental. Since #103 PR 7 a label is
derived from the drawing by `compileOpenings` — an 8-point cardinal, suffixed
`-1`…`-n` where a block opens the same way twice — so there is no id to resolve
and no book to miss. `describeConnection` and the compile diff render
`Fiddle Yard 1 : east` with the block id looked up and the label used verbatim.

`BlockEndService` used to be the counter-example: a hand-authored label could be
anything, including something meaningless. It is deleted, and the vocabulary is
closed.

## D9 — Render time vs. generation time

`reservation.reason`, `RouteFault.reason`, `SensorFault.reason`, and
`SystemHealth.topologyReason` render through the book **at the moment they
are created** — inside the service methods that construct them, before the
`await` that persists or publishes. An old row therefore records the name
the operator was told at the time, not the current one; that is correct for
a diagnostic record and is documented behaviour, not staleness. The one
exception is the HTTP 422 body from a rejected route request
(`routes.ts`'s `describeRejections(outcome.rejections, layoutService.getNames())`):
it renders at the transport edge, which is correct because that body is
neither persisted nor published — there is nothing to re-render later, and
rendering it as late as possible means it always reflects the most current
names available.

## D10 — `NameBookCache.refresh` and corrupt edge rows

`ILayoutRepository#listBlockEdges` runs `parseBlockEdgeRow` and throws
`BlockEdgeRowInvalidError` on a corrupt row. Since D5 makes
`LayoutService.reloadTopology` call `names.refresh(layoutId)` **before**
`loadTopology(...)`, an unguarded refresh would let that same error escape
`loadTopology`'s own narrow catch — the one #10 added specifically so a
corrupt-row problem surfaces as Safe-Stop rather than a bare throw — and
regress it. `NameBookCache.refresh` therefore wraps its own
`listBlockEdges` call in a `catch` scoped to `BlockEdgeRowInvalidError`
**only**, falling back to an empty `edges` map; every other repository call
in the same `Promise.all` (layouts, blocks, points, sensors, locos) is left
to propagate normally, and a *generic* error from any of them still rejects
`refresh()`. The name book is diagnostic; it must never be the thing that
fails. `tests/unit/services/nameBook.test.ts` and the corrupt-row scenario
case in `tests/scenario/topology-invalid.scenario.test.ts` both prove this —
the latter is the regression guard, since it exercises the real ordering
inside `reloadTopology`.

## Resolved questions

**Q1 — `TopologyRejectedError`'s default message.** Changed from the old
`Topology rejected: N violation(s)` (which deliberately did not list the
violations) to the rendered `describeViolations(violations, book)`.
`EdgesTab` falls back to `submitError.message` whenever the structured
`violations` list is empty (the `deletePointIfUnreferenced` case, which
constructs `TopologyRejectedError([], message)` with no structured list at
all), so a self-describing error body is more useful there and in logs.

**Q2 — Layout ids in 404 bodies.** `routes.ts`'s `GET .../route-faults` and
`sensors.ts`'s `GET .../sensor-faults` each render a bare layout id in their
"not the running layout" 404. Closed by including `layouts` in the
`NameBook` — one extra `repo.listLayouts()` in the builder, deliberately
**not** scoped to the running layout (it is the global list), so even a
`:layoutId` that isn't the one currently running can still resolve to a
name if it exists in the database.

**Q3 — `TopologyInvalidError` (`domain/topology.ts`).** Left un-booked.
Only thrown by `graph.ts#buildTrackGraph`, which `loadTopology` reaches only
after already deciding the violation set is non-fatal — a near-dead path
not worth threading a book through.

## Out of scope

- Renaming ids, adding slugs, or any wire-format change. `RouteRejection` /
  `TopologyViolation` / `PathBlocker` / `RouteFaultView` / `SensorFaultView`
  keep their id fields byte-for-byte; the UI reads some structurally
  (`frontend/src/types.ts`), and #4's design record (`docs/pathfinding.md`)
  depends on them.
- Naming the *train* behind a route lock (D3's residual).
- `TopologyInvalidError` (Q3).
- Bounding the DCC adapter's error text inside
  `LayoutService.abandonRouteOnPointFailure`'s reason (D6's residual) —
  pre-existing and unbounded before #54.
- A shared workspace package to let the frontend import `domain/naming.ts`
  instead of mirroring it in `packages/frontend/src/naming.ts`.
- Frontend unit tests (#8) — the frontend half of #54 is proved by
  Playwright (`tests/e2e/edge-authoring.spec.ts`,
  `tests/e2e/route-building.spec.ts`).

## Contract check

`docs/mqtt-contract.md` §`layout/{layoutId}/system/status`'s `reason` field
is documented as free-text string, no enum and no length constraint, and
there is no global payload-size clause anywhere in the contract. **No
contract amendment was required** — D6 is what keeps the now-richer text
bounded to something sensible for MQTT.
