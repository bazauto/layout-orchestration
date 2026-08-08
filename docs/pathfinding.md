# Route Pathfinding and Setting the Road — Decision Record (#4)

Companion to `docs/route-locking.md`. That document (D1–D14) decided what a
lock *means* and how a reservation lives and dies; it deliberately took an
explicit ordered edge list and left two things to this one:

- **Pathfinding** — producing that edge list from a start block and a
  destination.
- **Driving a granted route's infrastructure** — actually throwing the points
  the route needs.

Both land here. Throttle control, braking, and collision avoidance remain
with #6/#7 and are still out of scope.

Read this before touching `domain/pathfinding.ts`, `ReservationService`'s
`resolvePath`, or `LayoutService`'s `requestRoute` / `commandPointHolds` /
route-fault methods.

---

## P1 — The search state is **(block, end entered by)**, not block

A plain block-keyed graph search cannot express the one constraint that
matters most on a railway: a train that entered a block by its north end must
leave by some *other* end. Encode the state as the block plus the end it was
entered through and the constraint becomes structural — "b2 entered from the
west" and "b2 entered from the south" are different nodes with different
successors, and no reversal can be represented at all.

The alternative, filtering reversals out of a block-keyed result afterwards,
is worse than it sounds: the search will have already settled b2 by whichever
route was cheapest, and a post-filter cannot recover the more expensive
arrival that would actually have worked. It does not merely produce a worse
answer, it produces "no path" where one exists.

The start node has *no* entry end, so any edge out of it is admissible —
subject to P4.

`domain/graph.ts` already carried `traversableEdgesFrom(..., { arrivedAtEnd })`
for exactly this shape; this is that idea made into the search's key.

## P2 — Cost is edge length, with a constant for unmeasured track

Dijkstra over `BlockEdge.lengthMm`. `lengthMm` is nullable and a lot of a
layout gets authored without it, so a NULL costs `DEFAULT_EDGE_LENGTH_MM`
(1,000mm) rather than being refused, treated as free, or treated as
impassable.

The two rejected options are rejected for concrete reasons: **zero** makes
unmeasured track free, so the search would systematically prefer the parts of
the layout nobody has measured — the worst possible bias. **Infinity** makes
it impassable, so a layout with no lengths recorded has no routes at all.

The constant has a useful degenerate case: on a layout where *nothing* is
measured, every edge costs the same and the search becomes fewest-hops, which
is the right answer when you have no distance information. As lengths get
filled in, it degrades gracefully rather than flipping behaviour.

Ties are broken deterministically — by node key in the frontier, and by
incoming edge id when two equal-cost paths reach the same node. Without that,
the same request can return different (equally short) paths between runs
depending on the order rows came out of SQLite, which is miserable to test and
worse to reason about against a live layout.

## P3 — The search ignores current point *positions* and respects point *locks*

An edge requiring `p1 = normal` is usable even when p1 is currently `reverse`
or `unknown`. Setting the road is what granting a route *is*; refusing to
route over a point because it happens to be thrown the wrong way right now
would make the pathfinder useless on any layout with a junction.

A point **locked by another route** is different, and unusable. D2's
exclusivity means no other authority may command it, and a lock is precisely
an authority guarantee (D11). It does not matter which position the holder has
it in — this route cannot command it, so it cannot use edges that depend on
it.

Blocks are the mirror image: a block must be positively `clear` and unlocked.
`unknown` is not routable, via the shared `isBlockEffectivelyOccupied` rather
than an open-coded `!== 'clear'`, so "unknown means occupied" stays one
decision in one place (CLAUDE.md safety rule 1).

The start block is excluded as a *destination* of any edge. It holds the loco,
so it is occupied by definition, and `planReservation` refuses any block after
the first that is not clear — a path returning to it could only ever be
rejected, so the search does not propose one.

## P4 — Loco orientation is not modelled; `startExitEnd` is the operator's answer

Nothing in the system records which way round a loco is sitting.
`BlockState.locoAddress` says a loco is in a block, not which way it faces.
So the search cannot know which end of the start block the train can actually
leave by, and by default it will consider both.

Rather than invent an orientation field — which would need a source of truth
nobody has, and would be wrong the moment someone turns a loco on a turntable
— the request carries an optional `startExitEnd`. The operator can see which
way the loco faces; this lets them say so. Omitted means either end.

This is a deliberate non-decision about orientation, not an oversight. If
per-loco orientation is ever modelled it belongs with the roster and #6's
braking model, and this parameter becomes its default rather than its
replacement.

## P5 — A point-position conflict is reported, not searched around

If the chosen path needs one point in both positions, it cannot be set. The
search detects this after the fact (via `collectPointConditions`) and reports
`point-position-conflict` rather than handing the planner a path it is
guaranteed to refuse.

It does **not** backtrack to look for an alternative avoiding the conflict.
Doing so means carrying the set of point commitments in the search state,
which is exponential in the worst case, to solve a case that requires a path
through the same junction twice in opposite positions. On Westgate Hollow that
is not reachable at all.

**This is a recorded limit, not a claim of completeness.** A path can exist
that this pathfinder will not find. If a real layout ever produces one, the
fix is a bounded commitment set in the search state, not a wider rewrite.

## P6 — The pathfinder proposes, `planReservation` disposes

`ReservationService.resolvePath` turns a destination into an edge list, and
then feeds it to `planReservation` exactly as if the operator had typed it.
Every precondition the search checked — block clear, block unlocked, point
unlocked, no reversal, no point conflict — is checked again there.

That redundancy is the design, not an oversight:

- The planner stays **the single authority** on what may be reserved. The
  search is an optimiser over the graph. If they ever disagree the planner
  wins and the grant is refused, which is the fail-safe direction.
- An explicitly-supplied path and a searched path get **identical** scrutiny.
  A searched path is not more trusted for having been computed.
- It keeps `domain/pathfinding.ts` free to be tuned, or replaced, without
  anyone having to re-audit whether it enforces safety properties. It does
  not; it only avoids proposing things that would be refused.

The cost is one wasted validation pass per grant, over a path bounded by the
layout size. That is nothing next to what it buys.

### D14 and a failed search

D14 requires a refused grant to name *every* applicable reason, not the first.
A search failure happens before `planReservation` runs, so its rejections
would never be reported. `checkPathIndependentPreconditions` was extracted
from `planReservation` for this: on a search failure the service reports the
path rejections **plus** the system-status / roster / one-route-per-loco /
graph rejections. An operator whose system is Safe-Stopped *and* whose
destination is blocked is told both, instead of clearing the blockage and
being refused again.

## P7 — Setting the road: point commands after the locks, and a rejection invalidates the route

D3 already fixed the ordering and said why: **point commands are issued after
the locks are committed, never during acquisition.** You never send a physical
command for a route you have not fully reserved. `LayoutService.requestRoute`
calls `ReservationService.grant` (plan → persist → commit locks) and only then
issues the commands.

A command the DCC adapter **rejects** invalidates the whole route. Not a
retry, not best-effort:

- Some points may already have moved. The layout's physical state now matches
  neither the old road nor the intended one.
- There is no position feedback channel (#25), so `setPoint` resolving means
  only "the command was sent". A *rejection* is therefore the single strongest
  piece of evidence available that the road is not set, and swallowing the one
  signal you have is indefensible.

So: the route is cancelled (locks released), a `RouteFault` is latched, and
the system Safe-Stops. The caller is told `granted: false` with a
`point-command-rejected` rejection per failed command. The reservation row
survives as `cancelled` for the record — but reporting the request as granted
when nothing it asked for is in effect would be a lie.

Every point is attempted before giving up, rather than stopping at the first
failure. The route is invalidated either way, and an operator diagnosing dead
hardware is better served by "p1 and p4 rejected" than by discovering p4 on a
second attempt.

`commandPointHolds` is shared with D8's resume path, which had already reached
this same conclusion from the other direction (see D8's "not best-effort"
note). They used to differ only by accident.

A hold naming a point that no longer exists counts as a failure, not a skip:
the reservation and the config have drifted apart, which is exactly the kind
of uncertainty that must not be driven through.

## P8 — Route faults are latched in `SystemHealth`

**This closes a live bug, not just a gap.**

Before this PR, a route violation (D7 — unexpected occupancy in a reserved
block) called `LayoutStateManager.enterSafeStop` **directly**, bypassing
`SystemHealth`. The status changed, but nothing recorded *why*. The next
health evaluation — an MQTT reconnect, a sensor-fault acknowledge, any config
write — ran `evaluateSystemSafeStop`, found every tracked condition healthy,
and cleared a Safe-Stop that a train being somewhere it should not be had
caused.

This is exactly the correction #27 made for sensor faults, and it is worth
stating as a rule: **every Safe-Stop goes through `SystemHealth`.** A parallel
mechanism that only sets the status is not a Safe-Stop, it is a status change
that the real mechanism will undo.

`SystemHealth.routeFaults: Record<RouteId, RouteFault>` is keyed, for the same
reason `sensorFaults` is (docs/sensor-fault-recovery.md D2): acknowledging the
fault an operator can see must never silently clear one they were never told
about. Three kinds:

| kind | cause | what happens to the route |
|---|---|---|
| `unexpected-occupancy` | a reserved block read `occupied` that was not the route's next expected step (D7) | cancelled, locks released |
| `occupancy-unknown` | a reserved block stopped being determinable (below) | **suspended, locks retained** |
| `point-command-rejected` | the DCC adapter refused a command while setting the road (P7) | cancelled, locks released |

Priority in `evaluateSystemSafeStop` is MQTT, DCC, topology, sensor faults,
**route faults**, recovered routes. Route faults sit below sensor faults
because a sensor fault is usually the cause and the route fault the symptom: a
detector that stopped reporting is what made the block undeterminable, and
naming the detector points the operator at the thing to fix.

### Acknowledging

`POST /api/layouts/:layoutId/routes/:routeId/acknowledge-fault`, any
authenticated role — the same posture as the sensor-fault acknowledge, and for
the same reason (a driving-adjacent recovery action, not config authoring).

There is deliberately **no arming threshold**. A sensor has one because it can
prove itself by publishing valid readings; a route can prove nothing, because
it is already cancelled or suspended. The operator's acknowledgement *is* the
recovery.

Clearing the fault does not make the route runnable. A cancelled route is
terminal. A suspended one still has to pass `resume`'s preconditions, which
require every remaining block to read `clear` — so acknowledging a fault whose
block is still `unknown` returns the system to `online` with that block simply
un-routable, exactly as an acknowledged sensor fault does
(docs/sensor-fault-recovery.md D6). That is why no extra guard is needed on
the acknowledge itself.

### A reserved block going `unknown` mid-route

`evaluateOccupancyChange` previously ignored `unknown` entirely, on the stated
grounds that the thing which causes it — a sensor fault — Safe-Stops on its
own account. True for that cause. **Not** true for a sensor taken out of
service or deleted while a route is running over it, which raises no fault at
all and left the route active over a block whose state was no longer known.

So a transition into `unknown` on a block a live route still holds is now
`occupancy-unknown`. Only the *transition*: `unknown` → `unknown` is inert, or
every recompute would re-fault an already-latched route.

The route is **suspended, not cancelled**. Safe-Stop holds locks rather than
releasing them (D8) — releasing track under a train whose position just became
less certain is the opposite of fail-safe.

When the cause *was* a sensor fault, the operator now acknowledges two things.
That is accepted, not overlooked: "this detector is faulty" and "route R's
road is no longer known to be clear" are different facts, and clearing the
first does not resolve the second.

---

## What this does not do

- **Throttle control, speed profiles, braking** (#6/#7). A granted route sets
  its points and reserves its track; driving the train along it is still
  manual.
- **Point position confirmation** (#25). Unchanged, and still the reason P7
  can only act on a *rejected* command.
- **Fouling at a plain diamond crossing** (#26). The locking model does not
  model it, so neither does the search.
- **Searching around a point-position conflict** (P5).
- **Route queuing or priority.** Still rejected rather than queued — that is
  what keeps D4's deadlock-by-construction argument valid.
- **Multi-leg moves / run-rounds.** A route's resource set is fixed at grant
  time and never grows (D4). To extend a move, request a new route from the
  train's current confirmed position.
- **Loco orientation** (P4).

## Deferred

- `DEFAULT_EDGE_LENGTH_MM` is layout-wide. If a layout mixes measured and
  unmeasured track heavily enough for the constant to distort choices, the
  answer is to record the lengths, not to tune the constant per layout.
- The `no-path` blocker list is capped at `MAX_REPORTED_BLOCKERS` (20) and
  reports each edge against the first reason it failed. It is a diagnostic
  aid, not an exhaustive account of every obstruction.
