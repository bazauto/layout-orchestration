# Route Locking — Decision Record

This document records the design behind route reservation and locking (#3):
`domain/routeLocking.ts`, the `RouteReservation`/`RouteHold` vocabulary in
`domain/types.ts`, `services/ReservationService.ts`, `ports/IRouteLockView.ts`,
and the topology write-guard in `services/TopologyService.ts`. Same posture
as `docs/topology.md` — not binding the way `docs/mqtt-contract.md` is, but it
explains *why*, not just *what*, so the next change doesn't accidentally undo
a deliberate choice.

This PR delivers the reservation aggregate, its persistence, its lifecycle,
and the guards that consume it. It does **not** deliver pathfinding — that is
#4, which supplies the ordered edge list this PR's `ReservationService.grant`
takes as an explicit request. Every decision below is testable without a
pathfinder.

> **Update — #4 has landed.** Pathfinding and setting the road are now
> implemented; see **`docs/pathfinding.md`** (P1–P8) for that decision record.
> Everything below still holds, with three amendments made there rather than
> repeated here:
>
> - `ReservationService.grant` now accepts *either* an explicit `edgeIds` list
>   (unchanged, still first-class) *or* a `destinationBlockId` for the search
>   to resolve. A searched path is validated by `planReservation` exactly like
>   a supplied one — the planner remains the single authority (P6).
> - A granted route now has its points **thrown** (P7), the half D3's ordering
>   note was written in anticipation of.
> - Route-level Safe-Stops are latched in `SystemHealth.routeFaults` (P8).
>   D7's violation path previously called `enterSafeStop` directly and left no
>   latch, so an unrelated health evaluation cleared it — that was a bug, and
>   it is fixed.

## D1 — A lock is held on blocks *and* points; edges are route membership, not a third lock namespace

Blocks alone let a point be thrown under a train; points alone let two routes
into one block. Edges do not need their own exclusion: an edge is only
traversable when its point conditions hold, and those points are locked in
the required position, so an edge between two locked blocks is already
protected. Edges are still recorded on the reservation (as `RouteHold`s with
`kind: 'edge'`) so (a) the topology write-guard (D10) can refuse edits to an
edge under an active route, and (b) #6 can sum `lengthMm` for braking.

**Unit of reservation is the route**, not the individual entity. A
`RouteReservation` is the authoritative record of what is held;
`BlockState.lockedByRoute` / `PointState.lockedByRoute` are a *projection* of
it, maintained by the same code path (`ReservationService`). Before this PR
those fields were the only record, which made "what does route R hold?" an
unanswerable question.

**Not modelled:** a plain (non-switched) diamond crossing, where two routes
physically foul each other while sharing no block and no point. Slips and
three-ways *are* caught, because they are points. Westgate Hollow has no
plain diamond today — recorded as a known limit in #26, which also specifies
the `edge_conflicts` schema and `planReservation` fouling check that would
close it if the layout ever grows one.

## D2 — Locks are exclusive, with no shared or refcounted case

One route per block, one route per point. Two routes needing the same point
in the *same* position still do not share it: sharing would require
refcounting, and refcounted release means route A's completion can throw a
point route B is still standing on. On a layout this size, serialising
through a shared throat point is correct behaviour, not a throughput problem
worth a hazard.

Enforced twice: `planReservation` checks `BlockState.lockedByRoute` /
`PointState.lockedByRoute` before granting (the fast path), and the DB's
partial unique indexes `route_holds_exclusive_unq` /
`route_reservations_one_per_loco_unq` (migration `0004_redundant_tana_nile`)
are the final arbiter — the same "domain check plus DB invariant" posture
#11 put on `block_edges`. See D3 for why the DB index, not the domain check,
is what actually closes the concurrency race.

## D3 — Atomicity by pure computation, then one synchronous commit

Acquisition is a **pure domain function**, `planReservation`. It computes the
entire grant and returns either a complete `RouteReservation` or a list of
every rejection. It mutates nothing — `ReservationView` is a read-only
snapshot — so partial acquisition is not expressible at the domain layer.

**The invariant, stated here because it must be or it will be violated in
#4: no `await` between the conflict check and the lock commit.** Node is
single-threaded and layout state (`LayoutStateManager`) is in-process, so a
synchronous pass from "plan computed" to "locks applied" is sufficient — no
lock manager, no two-phase commit, no retry loop.

`ReservationService.grant` adds exactly one `await` between those two points:
persisting the reservation to the database. That ordering — persist first,
then commit locks synchronously — is deliberate and is why the DB's partial
unique indexes are the true concurrency guard, not just a backstop:

- **Why persist before committing locks, not after:** a crash between the two
  means nothing was ever recorded — the reservation, and the intent behind
  it, are simply gone, which is safe (nothing lies about what it holds). A
  crash *after* persisting revives the reservation as `suspended` on the next
  startup (D9), with locks re-applied — never silently lost. The reverse
  order (commit locks, then persist) risks the opposite failure: an
  in-process lock with no durable record of it, which a crash erases
  invisibly while any external observer that saw the grant succeed still
  believes it holds.
- **Why this doesn't reopen the race D3's invariant exists to prevent:**
  during the `await` for persistence, a second `grant` call could in
  principle run its own `planReservation` against the same (not-yet-locked)
  in-memory state and also believe the resource is free. That race is closed
  by the DB, not by the in-memory check: `route_holds_exclusive_unq` rejects
  the second reservation's conflicting hold insert outright, and
  `createReservation`'s transaction (see `ILayoutRepository`) rolls the whole
  row back on that failure — zero rows persisted, not a partial write. The
  in-memory `planReservation` check is the fast, common-case path that
  avoids a needless DB round trip for an obviously-invalid request; the DB
  index is what makes D2 actually hold under concurrency.

**The load-bearing consequence: point commands are issued *after* locks are
committed, never during acquisition.** You never send a physical command for
a route you have not yet fully reserved. Issuing them is #4's job (driving a
granted route); the ordering constraint is documented here because it
constrains how #4 may be built.

On contention: **reject, listing every conflicting entity and the route
holding it.** Never queue — matches this issue's original requirement and
keeps D4 valid.

## D4 — Deadlock: prevention by construction

Deadlock needs a wait-for cycle. There is none: a route either acquires
everything at once or holds nothing, and it never blocks waiting for a
resource. No detection, no timeout-and-retry, no banker's algorithm.

**The invariant that keeps this true, and it must be written down or it will
be violated in #4: a route's resource set is fixed at grant time and never
grows.** `RouteReservation.holds` and `.path` are set once, at
`planReservation` time, and nothing in `ReservationService` ever appends to
them after a grant. To extend a move, request a *new* route from the train's
current confirmed position. Never bolt blocks onto a live reservation — doing
so would let two routes each hold half of what they need and wait on each
other, precisely the cycle this design otherwise cannot construct.

Starvation (two routes repeatedly losing a race for the same point) remains
possible. It is a throughput matter, operator-visible, not a safety matter.
Out of scope (see "Out of scope" below).

## D5 — Progressive (tail-first) release on a two-condition rule; no timeout release

Block-by-block release is better for throughput than releasing the whole
route at once, and harder to get right, so it is taken conservatively. A
block's `RouteHold` releases only when **both** hold:

1. the train has been confirmed in a **later** block of the path, **and**
2. the block in question has transitioned `occupied` -> `clear`.

Neither alone is safe. "Clear" alone is meaningless for a block that never
read `occupied` — that is detection dropout, not evidence of clearance,
which is why `evaluateOccupancyChange` ignores a `clear` reading whose
`previous` value wasn't `occupied`. "Confirmed in a later block" alone
ignores the tail — the train could still physically be standing across two
blocks. Blocks *ahead* of the train are never released early:
`evaluateOccupancyChange` checks `confirmedIndex` against the block's own
(last) path index before considering release at all.

**What "the block transitioned `occupied` -> `clear`" means is settled by
#34, not here.** `evaluateOccupancyChange` is fed a block's *derived*
occupancy — the fusion of every in-service, non-faulted sensor on that block,
in which an `ir_position` sensor may raise occupancy but never lower it. See
`docs/sensor-fault-recovery.md` D3 and D6. This matters for condition 2
above: before #34 the raw reading of whichever sensor last spoke was passed
straight through, so a single IR beam reporting `clear` could satisfy it and
release a hold on track a train was still standing on. `recomputeBlock` in
`LayoutService` is the only caller of `onOccupancyChange`, and it passes the
derived value precisely to keep that impossible. A fault-driven `unknown`
reaches this function too, and is inert to it by construction — neither
branch here acts on `unknown`.

A point (or edge) hold releases with the **last path step whose edge**
mentions it — a plain index computation over the ordered path
(`holdsReleasableAt`), with no second occupancy condition. `releaseAfterIndex`
on a point/edge hold is the *source* step of the edge that needs it (the
block the edge leaves from); a block hold's `releaseAfterIndex` is the last
path index that block itself occupies. Both compare against `confirmedIndex`
the same way — `confirmedIndex > releaseAfterIndex` — which is what lets one
`holdsReleasableAt(reservation, confirmedIndex)` call answer "what releases
now" for every hold kind at once, once a block's own two-condition check has
separately cleared it.

**No timeout-based release.** A stalled train is precisely the state in
which you must not un-reserve track. A route with no progress for a
configured interval is a throughput/operator-visibility concern (out of
scope here, see below), not a trigger to release locks — releasing on a
timeout is a timeout that invents a train position, which the fail-safe rule
forbids outright.

Release paths in full: progressive (above, via `onOccupancyChange`'s
`release` effect), completion (`complete` effect — see below), operator
cancel (`ReservationService.cancel`), and force-override cancel (D6).

**Completion**, a decision not explicitly in the original issue text but the
smallest one consistent with D5's "release paths in full" list: `occupied`
in the *final* block of the path is `complete`, and `ReservationService`
releases every remaining hold at that point rather than waiting for the
destination block to later clear. Once a train has arrived, its final block
is ordinary occupancy, not reservation-tracked track — the reservation's job
is done.

## D6 — Manual command vs. an active lock: reject with a typed error; `force` is permitted but **cancels the route**

This was the part of the pre-#3 code that was actually unsafe:
`handlePointCommand` with `force: true` threw the point and left
`lockedByRoute` pointing at a route that now held a false belief about that
point's position — textbook "guess a train's position".

- **No `force`:** rejected with a typed `PointLockedError`, mapped to HTTP
  409 / WS `ERROR`. The operator sees why and which route.
- **`force: true`:** refused outright when `systemMode === 'auto'`
  (`canForcePointOverride` — there is no manual authority in auto, codifying
  the existing `PointCommand.force` doc comment). Otherwise permitted, and it
  **cancels the route holding the point** (`ReservationService.cancel`),
  releasing all of that route's locks, and stops that route's loco if the
  route's authority is `auto` (a manual-authority route's loco is left alone
  — the operator driving it manually is not itself the fault).
- It does **not** trigger a system-wide Safe-Stop. This is a deliberate,
  authorised operator action scoped to one route; Safe-Stopping on an
  intentional override teaches operators to ignore Safe-Stops.

Applied consistently to throttle: a manual `THROTTLE_COMMAND` for a loco that
is the subject of an **auto-authority** route cancels that route (the
operator has taken the train; two authorities on one loco is worse than a
lost route). A manual throttle on a **manual-authority** route does nothing —
that *is* the operator driving their own reserved road. This is
`RouteReservation.authority`, consulted via
`ReservationService.routeHoldingLoco`.

## D7 — Modes: routes are grantable in **any** mode; mode governs who drives

`canGrantRoute(status) === (status === 'online')`, independent of
`SystemMode`. A reservation in `manual` mode is a pure interlocking: points
set and locked, blocks reserved, the operator drives it. Genuinely useful on
a shunting layout, costs nothing, and means the reservation engine is worth
having before automation exists.

Can an automated route reserve a block an operator is manually driving
through? **No** — and it falls out of the grant precondition rather than
needing a mode-specific rule: a route is only granted over blocks confirmed
`clear` (`isBlockEffectivelyOccupied` already treats `unknown` as occupied),
so a block with a manual train in it is never grantable.

The residual case — a manual train entering a block *already* reserved by
another route — is a **route violation**: `evaluateOccupancyChange` reports
`unexpected-occupancy` for `occupied` appearing in a reserved block that is
not the route's next expected step (adjacent to `confirmedIndex`).
`ReservationService.onOccupancyChange` cancels the route and releases its
locks itself; `LayoutService` (which alone has DCC/MQTT access) stops that
route's loco and enters Safe-Stop. Occupancy in the next expected step is
normal progress, not a violation.

Unexpected occupancy in **unreserved** track is left to #7; this PR handles
reserved track only, and says so in the code (`handleRouteViolation`'s doc
comment in `LayoutService`).

This also settles a long-open review item (`docs/claude-review.md` §3,
`docs/gpt-review.md` §4): **flipping `systemMode` to `manual` suspends every
auto-authority route** (`ReservationService.suspendAuto`) — suspends, not
cancels, so the locks stay held and the operator decides what happens next.

## D8 — Safe-Stop holds locks, it does not release them; recovery is explicit and per-route

Releasing locks on Safe-Stop would make track look available while trains
are, as far as anyone knows, still standing on it. So:

- **On Safe-Stop:** every `active` reservation -> `suspended`
  (`ReservationService.suspendAll`), reason = the Safe-Stop reason. Locks
  **retained**. New grants refused (`canGrantRoute` requires `online`).
  Automated movement already halts via the existing `stopAllLocos`.
- **On Safe-Stop clearing:** **nothing happens to routes.** Suspended routes
  never auto-resume. The operator must **cancel** (releases locks, via
  `ReservationService.cancel`) or explicitly **resume**
  (`ReservationService.resume`).
- **Resume is refused unless:** every remaining block in the path reads
  `clear`, the train's current confirmed block reads `occupied`, and (any
  `unknown` anywhere refuses outright — both prior checks already fail
  closed on `unknown`, since neither `clear` nor `occupied` matches it).
  `ReservationService.resume` has no DCC access, so it cannot itself
  re-command the held points D8 also calls for; it flips the route back to
  `active` and returns the point holds needing a physical re-command, which
  `LayoutService.resumeRoute` issues afterward.

  **That re-commanding is not best-effort, and its ordering is
  load-bearing.** `resume` returning `resumed: true` is *provisional*: the
  commands are issued before the resume is treated as successful — before
  the `ROUTE_STATE` event and before D9's restart latch is cleared. If any
  command is rejected, or a hold names a point that no longer exists, the
  route goes straight back to `suspended` via
  `ReservationService.suspendOne` (locks retained), `recoveredRouteCount` is
  left untouched so a restart Safe-Stop does **not** clear, and the caller
  gets `resumed: false` with every failure named.

  It would be easy to read D11 as licence to swallow these failures — a
  point lock is an authority guarantee, not a physical position guarantee,
  so the system cannot promise the point is where it should be either way.
  That reading is backwards. Precisely *because* there is no position
  feedback channel (#25), a command the DCC adapter **rejects** is the only
  evidence available that the road is not set, and resume is the exact
  moment an operator is asserting it is safe to proceed. Discarding the one
  signal we have, at the one moment it matters most, is not a neutral
  simplification. This is the same criterion #4 applies to a granted
  route — a rejected point command invalidates it — arriving early on the
  recovery path.

A runtime Safe-Stop does **not** latch on suspended routes by itself — the
system may return to `online` with routes still suspended, which is safe
because those blocks remain locked and nothing new can take them. Only
**restart-recovered** routes latch the system in Safe-Stop until resolved —
see D9.

> **#4 amendment.** A Safe-Stop caused by the *route itself* now does latch,
> in `SystemHealth.routeFaults`, and needs an explicit acknowledge
> (`POST .../routes/:routeId/acknowledge-fault`). That is not a reversal of
> the paragraph above: a route suspended because MQTT dropped still clears
> when MQTT returns. What latches is a route fault — a violation (D7), a
> rejected point command while setting the road, or a reserved block ceasing
> to be determinable. See `docs/pathfinding.md` P8, including why a block
> going `unknown` mid-route suspends rather than cancels, which is this
> section's rule applied to a cause D8 did not originally enumerate.

## D9 — Locks are persisted; a restart revives them as `suspended` and Safe-Stops

The argument for in-memory-only reservations is that after a restart every
block reads `unknown` anyway, so nothing could be granted over held track
regardless. True, but insufficient: once sensors report again, the system
would cheerfully grant a *new* route over track actually occupied by a
stalled auto train sitting in a detection gap — and detection gaps are the
norm on points and short spurs. Persistence is the only durable record that a
train was under automated control and roughly where.

The argument against reviving as live authority is staleness: the process
may have been down for a week, and nothing about a persisted row proves the
train is still there.

**Resolution: persist, revive only as `suspended`, never as live authority.**
`ReservationService.loadOnStartup` loads every reservation still
`active`/`suspended`, flips it to `suspended` with reason `backend
restarted`, and re-applies its locks to the freshly-registered (all-`unknown`)
block/point state. `LayoutService.initializeLayoutState` calls this *before*
`reloadTopology` (for the same ordering reason `start()` goes `online` before
initialising state at all — see the comment there: a recovered route must
land on `safe-stop`, not be skipped) and folds `recovered.length` into
`SystemHealth.recoveredRouteCount`.

That count is what makes the restart Safe-Stop latch: `evaluateSystemSafeStop`
(`domain/safety.ts`) checks it **after** topology, with the reason `N route
reservation(s) survived a restart and must be cleared`. Unlike the
connection/topology checks, this one does not clear itself — `LayoutService`
only removes a route id from its recovered set (and re-evaluates Safe-Stop)
when the operator explicitly cancels or resumes that specific route via
`cancelRoute`/`resumeRoute`. A clean shutdown has no active routes, so this
never fires in normal operation.

## D10 — Closing the `docs/topology.md` deferred note

`TopologyService`'s constructor gains a fourth argument,
`lockView: IRouteLockView`, implemented by `ReservationService` — matching
the existing `onTopologyChanged` callback injection style so `TopologyService`
stays testable standalone (a hand-rolled `IRouteLockView` in tests, no real
`ReservationService` needed).

- `updateEdge` / `deleteEdge`: refused (`LockedByRouteError` -> HTTP 409 with
  `{ error, routeId }`) when the edge is held by an `active` or `suspended`
  reservation.
- `deleteBlockWithEdges`: refused when the block itself, or **any** edge
  referencing it, is held.
- `deletePointIfUnreferenced`: refused when the point is held.
- `createEdge` stays **permitted**, deliberately. A new edge moves no train,
  and it cannot be traversed into reserved track because the target block is
  already locked — the block/point locks are what protect a live route, not
  an admission check on every new edge.
- `replaceGraph` (#103's compiled apply) is refused when **any** route holds
  **anything** in the layout — `findAnyHeldRoute`, not a per-target lookup.
  This is not extra caution; the per-target guards genuinely do not compose
  into it. A compiled apply deletes every edge in the layout and regenerates
  every end label, so "is *this* edge held" has no answer worth acting on: the
  row may not survive, and the `fromEnd`/`toEnd` strings a live reservation
  recorded in its path may name openings that no longer exist afterwards. It is
  also what makes end labels safe to treat as disposable
  (`docs/track-graph-compilation.md` D8) — nothing can be holding a stale one
  when they are regenerated.

### The HTTP mapping, which was documented before it existed

Every refusal above is **HTTP 409 with `{ error, routeId }`**, on all four
routes: `PUT`/`DELETE .../edges/:id`, `DELETE .../blocks/:id`,
`DELETE .../points/:id`, and `POST .../topology/compile/apply`.

For a long time only the compile apply actually did that. The other three named
`LockedByRouteError` in this document and mapped it nowhere, so the refusal
fell through to Fastify's default handler and came back as a bare **500** —
the server reporting itself broken for correctly refusing a write. Worse, a 500
carries no `routeId`, so the one fact that makes the situation actionable was
lost: a named route is holding this, cancel it and the write succeeds.

409 rather than 422 throughout, and the distinction is worth keeping: 422 means
the *graph* refused the change (an edge still references this point, a candidate
set has violations), 409 means the layout's live state conflicts with an
otherwise valid request. They call for different actions.

Note the interaction with the existing rule that edge writes stay permitted
during Safe-Stop for recovery (`docs/topology.md`): still true, but a
*suspended* reservation still blocks the write, because `IRouteLockView`
reports both `active` and `suspended` holders. The operator cancels the
route first, then edits. Cancel is always available (D4's resource-set
invariant doesn't apply to cancelling — only to growing a live reservation),
so this is an explicit ordering, not a deadlock.

## D11 — What a point lock actually guarantees

A point lock guarantees **"no other authority will command this point."** It
does **not** guarantee the point is physically in the required position:
`IDccController.setPoint` resolves on send, `PointState.position` is
*commanded*, not confirmed, and `docs/mqtt-contract.md` lists
`point/{pointId}/state` as Backend -> Subscribers with no feedback direction
at all. True position confirmation is tracked as **#25** and is a real gap —
a point that fails to throw (servo stall, disconnected wire, mechanical
bind, dead controller) is today indistinguishable from one that threw
correctly, and this PR does nothing to close that. Every place in this
codebase that could be read as claiming otherwise — the resume flow (D8),
the force-override cancel (D6) — is documented as an authority guarantee,
not a position guarantee. #4's acceptance criteria are already amended to
match: "a point command the DCC adapter *rejects* invalidates the route" is
implementable today; "a point that fails to confirm" is not, until #25 lands.

## D12 — No MQTT contract change is required

`block/{blockId}/state` and `point/{pointId}/state` already carry
`lockedByRoute`; that is everything a subscriber needs to know about route
locking. The route aggregate itself is exposed over **REST and WebSocket
only** — `GET/POST /api/layouts/:layoutId/routes`,
`DELETE .../routes/:routeId`, `POST .../routes/:routeId/resume`, and a
`ROUTE_STATE` `LayoutEvent` forwarded generically over `/ws` the same way
`BLOCK_STATE`/`POINT_STATE`/`LOCO_STATE` already are. If a
`route/{routeId}/state` MQTT topic is ever wanted, `docs/mqtt-contract.md` is
amended **first**, in its own PR, before any code — this PR does not add
one, and does not need to.

## D13 — Grant preconditions and the loco<->block assertion

`planReservation` checks, and reports every failure rather than stopping at
the first (D14):

- The loco must exist in the roster (`knownLocoAddresses` — this is also
  what gives #6 its `brakingFactor` once that lands).
- At most one `active`/`suspended` reservation per loco per layout
  (`loco-already-routed`).
- The **first** block of the path must read `occupied`. If its
  `locoAddress` is non-null it must match the request
  (`start-block-holds-other-loco`); if null, the grant **assigns** it
  (`ReservationService`'s `assignStartBlockLoco`, part of the same
  synchronous commit pass as lock application — D3). This is the operator
  asserting "loco 3 is in block A" — an assertion, not a system guess, and
  it is recorded. It is also where the loco<->block association gets
  established, which #6 and #7 both need. Before this PR, nothing ever set
  `locoAddress` from a sensor reading, which would have made requiring a
  match impossible for every grant.
- Every subsequent block must be confirmed `clear`
  (`isBlockEffectivelyOccupied` treats `unknown` as occupied — fail-safe).
- The path must be connected, present in the graph, and free of reversals
  (an edge may not leave a block by the end it was entered by —
  `traversableEdgesFrom`'s existing `arrivedAtEnd` logic is mirrored inline
  in `planReservation`'s chain walk).

## D14 — Minor, stated so nobody has to ask

`RouteId` is `randomUUID()`, generated in `ReservationService`, never in
transport. `planReservation` takes `routeId` and `now` as parameters so the
domain stays pure and deterministic — no `crypto`/`Date.now()` call inside
`domain/`. Rejections are returned as a **list** of every problem found, no
early return — matching `validateTopology`'s existing posture in
`docs/topology.md`.

Since #54, `describeRejections` (the human-readable rendering of that list,
for HTTP 422 bodies and log lines) takes an optional `NameBook` and renders
every id it can as `"Name" (shortid)` — see `docs/naming.md` (D1–D10) before
touching it or `domain/routeLocking.ts`'s `describeRejection`. Route ids
themselves (`heldBy`, `loco-already-routed`'s `routeId`) stay bare by design
(`docs/naming.md` D3) — a route is runtime state, not layout config, so it
is deliberately not part of the `NameBook`.

---

## Out of scope

Restated here from the issue, because it is easy to accidentally reach for
one of these while implementing #4/#6/#7 against this PR's surface. The first
two have since landed with #4 — see `docs/pathfinding.md`:

- ~~**Pathfinding** (#4). This PR takes an explicit ordered edge list.~~
  **Landed (#4).** An explicit edge list is still accepted; a destination is
  now accepted too.
- ~~**Driving a granted route** — issuing point commands~~ **Point commands
  landed (#4)**; throttle control and speed profiles remain out of scope
  (#6/#7).
- **Braking model / stopping distances** (#6). `lengthMm` is recorded on
  edge holds for it, unused here.
- **Point position confirmation** (#25). See D11.
- **Fouling / diamond-crossing conflict relation** (#26). See D1.
- **Shared or directional block occupancy** (permissive working, following
  moves) — explicitly *rejected* in D2, not deferred.
- **Route queuing, priority, or starvation avoidance** — rejecting rather
  than queuing is what makes D4's deadlock-by-construction argument valid.
- ~~**A route-building frontend UI** beyond a minimal route list with Cancel —
  belongs with #4's pathfinder.~~ **Landed (#4)** — the Operate screen's
  Routes panel builds a route from loco + start + destination, lists live
  routes with Cancel/Resume, and surfaces latched route faults.
