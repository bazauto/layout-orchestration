# Connection Health, Staleness, and the Control Plane — Decision Record

This document records the design behind #82: whether a client is still
receiving live layout state, as distinct from the layout simply being quiet —
and, since #165, the design of the view that state is displayed on, which is
now also the view the layout is driven from (M10–M16).
Same posture as `docs/auth.md`, `docs/route-locking.md`, and
`docs/point-feedback.md` — not binding the way `docs/mqtt-contract.md` is, but
it explains *why*, not just *what*, so a later change doesn't quietly undo a
deliberate choice.

## The problem

Every state object on the wire carries a timestamp — `BlockState.lastUpdated`,
`PointState.lastUpdated`, `LocoState.lastUpdated` — and none of it is
liveness. A track diagram is a display whose entire value is that it reflects
the layout *now*. A frozen WebSocket produces a diagram that looks completely
normal: every block still shows its last known occupancy, every point its
last known position, and nothing on screen distinguishes "the layout is
quiet" from "this browser stopped receiving updates four minutes ago." An
operator reading a stale mimic and concluding a block is clear is precisely
the class of error `CLAUDE.md` safety rule 1 forbids the backend from making
on its own account — a stale display makes the same guess on the operator's
behalf, one layer up.

#63 (the monitor role) is the strongest case for this, and the reason the two
issues land together: an unattended wall display or a tablet handed to a
visitor at an open day is exactly where a silently frozen diagram goes
unnoticed for longest, and where the viewer is least equipped to notice on
their own.

## Scope

**Complete.** The backend half — the heartbeat itself (#82 item 3) and the
verification that a reconnect resynchronises correctly (open question 2) —
is D5–D7 below. The frontend half is M1–M5 further down: the connection-state
indicator (item 1), the treatment of staleness (item 2, and see D6 for why it
is not what the issue asked for), and Safe-Stop made unmissable on the diagram
(item 4).

The view this document describes stopped being read-only in #165 — it is the
screen the layout is driven from, and M10–M16 at the end record what that
changed and, more importantly, what it deliberately did not. Everything in
D5–D9 is unchanged by it: a control plane that has stopped receiving updates is
a *worse* thing to act on than a mimic that has, not a better one.

## D5 — The heartbeat is an application-level `ServerMessage`, not a protocol-level ping

#82's open question 1 asked whether to use `ws` protocol-level ping/pong or an
application-level message, and leaned toward the latter for testability. There
is a decisive reason beyond preference: **a `ws` protocol ping is not
observable through the browser's `WebSocket` API at all.** The browser opens
and responds to pings automatically at the transport layer; no event fires
that application code — the eventual frontend consumer of this work — could
hook to detect one arriving, or failing to. A protocol-level ping could keep
the *connection* alive without ever proving to the *page* that data is still
flowing. `HEARTBEAT` is therefore an ordinary member of the `ServerMessage`
union (`domain/types.ts`, mirrored in `packages/frontend/src/types.ts`),
carrying the server's send time as an ISO 8601 string, broadcast to every open
client on the same fan-out path `LayoutEvent`s already use.

This is not MQTT. `docs/mqtt-contract.md` governs topics between the backend
and the ESP firmware; a heartbeat is purely a backend↔browser WebSocket
concern and needed no amendment to that contract.

## D6 — Liveness is a connection-level property, not per-entity `lastUpdated` age

#82 item 2 asked for per-entity staleness using the `lastUpdated` values
already on the wire, and then undermined its own ask in the same paragraph:
on a quiet layout nothing changes for long periods, and that is *normal* — a
block that has shown `clear` for twenty minutes because no train has visited
it is not stale, it is simply true. Per-entity age therefore carries no
information about whether *the client* is still receiving updates; it only
says when *the layout* last changed, which is a different question the
heartbeat answers completely on its own. Building a per-entity staleness
computation on top of `lastUpdated` would have produced a second liveness
signal that agrees with the heartbeat everywhere except the one case that
matters — a quiet-but-live layout — where it would have been actively wrong
in the "everything looks fine" direction, exactly backwards for a safety
display.

**Rejected explicitly, not merely deferred**, so a later session does not
"complete" #82 by adding it: no `BlockState`/`PointState`/`LocoState` gains a
derived staleness flag, and no per-entity threshold is ever introduced. The
connection either received a `HEARTBEAT` within `STALE_AFTER_MS` or it did
not; that single fact governs the whole diagram at once, which is also the
correct granularity for the display it feeds — `docs/liveness.md`'s whole
argument is that staleness is a fact about the *page*, not about any one
block on it.

## D7 — One threshold, tied to the heartbeat interval: 5s / 3 missed / 15s

#82 open question 3 asked whether the stale threshold should differ per
entity type, and D6 already answers "no entity-level anything." What remains
is a single interval and a single miss-tolerance, both owned by the backend
and exported from one module so the two numbers cannot drift apart:

- `HEARTBEAT_INTERVAL_MS = 5000` — how often
  `transport/websocket/index.ts` broadcasts `HEARTBEAT` to every open client.
- `STALE_AFTER_MISSED_HEARTBEATS = 3` — how many consecutive heartbeats a
  client may miss before it is stale.
- `STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * STALE_AFTER_MISSED_HEARTBEATS`
  (15s) — derived, not independently tuned, which is what makes it
  structurally impossible for a client's threshold to outlive a change to the
  server's actual send interval.

All three live in `packages/backend/src/domain/liveness.ts`, the backend
being authoritative since it is the one broadcasting. There is no shared
workspace package between backend and frontend today (see `CLAUDE.md`'s
module-system note on the two being CommonJS/ESM respectively), so
`packages/frontend/src/types.ts` carries a plain mirrored copy of all three
constants with a comment pointing back here — the same posture every other
type duplicated across the wire already takes in that file. Three missed
intervals, not one, because a single dropped frame under ordinary network
jitter must not flip a live connection to "stale" and back within the length
of one heartbeat; the margin needs to be wide enough to only fire on an
actually-stopped stream.

The interval is registered with `setInterval` inside `registerWebSocket`,
`unref()`'d so it cannot hold the Node process open on its own, and cleared
on Fastify's `onClose` hook so a test building and closing a server does not
hang waiting on it.

## Verified — reconnect resynchronises correctly (open question 2)

#82 asked this as an open question and flagged it as "worth doing early and
cheaply — it is a correctness question, not a feature," ahead of the rest of
the issue landing with #63/#75. It has been verified, not merely assumed:
`registerWebSocket` sends a full `STATE_SNAPSHOT` to every new connection
before anything else, and the frontend's `applyMessage`
(`packages/frontend/src/hooks/useLayoutSocket.ts`) **replaces** the snapshot
wholesale on `STATE_SNAPSHOT` rather than merging it into whatever state a
previous connection had left behind. There is no delta stream resumed from an
unknown point — a reconnect is a clean read of current truth, not a
continuation of a conversation the server does not remember having. A
regression test in `packages/backend/tests/integration/wsBroadcast.test.ts`
("WebSocket reconnect resynchronisation (#82 open question 2)") pins this: it
changes system state over one connection, closes it, opens an entirely new
one, and asserts the new connection's first frame is a `STATE_SNAPSHOT`
already carrying the change the first connection made — proving the second
connection's view is current, not stale-then-corrected.

This was not a bug. It is recorded here, verified rather than left as an open
question, because #82 explicitly asked for the check rather than the
assumption.

## The frontend half (#63, #75)

### M1 — Liveness is derived once, at the top, and handed down

`useLayoutSocket` records `lastMessageAt` on **every** inbound frame, not just
`HEARTBEAT`: a layout busy enough to be emitting state changes is
self-evidently live, and requiring a heartbeat specifically would report a
stale connection on a socket delivering events. The heartbeat covers the
*quiet* case, which is the only one a mimic cannot otherwise tell from a
frozen socket.

`useConnectionHealth` turns that into one word — `live` / `stale` /
`disconnected` — in `App`, which passes it down. Two indicators computing
their own answer could disagree, and a display whose two liveness indicators
differ is worse than one with none.

Two details that are decisions rather than mechanics:

- **A frame that fails to parse does not stamp liveness.** It proves the
  socket is open, not that the two ends still agree about what is on it.
- **A drop resets `lastMessageAt` to `null`.** Carrying the old stamp across a
  reconnect would let a socket that has reopened but not yet delivered its
  snapshot read as `live` for up to one stale-window, showing pre-drop state
  as current.

### M2 — The health check needs a timer, and that timer is the whole feature

Staleness is the *absence* of messages, and an absence produces no React
render. Without a tick, a socket that froze at 12:00 keeps reporting `live`
for ever — the component simply never re-evaluates. `useConnectionHealth`
therefore re-checks on a `HEARTBEAT_INTERVAL_MS` interval. The worst case is
one interval of over-reporting freshness past the threshold (20s against a 15s
threshold), which is why the threshold is three missed heartbeats rather than
one: it is already sized not to trip on jitter.

### M3 — Degradation covers the canvas; it is never a badge

When `freshness` is anything but `live`, the mimic is overlaid with a wash, a
glyph and a sentence saying the diagram is showing the last state received and
is not a picture of the layout now. Not a corner badge: the failure this
addresses is that a frozen mimic looks *completely normal*, so the marking has
to be impossible to read past. Per #81 it carries a word and a glyph, never a
tint alone.

The overlay is `pointer-events: none` so pan and zoom still work. Someone
investigating a frozen display should not also find the diagram unresponsive.

Safe-Stop gets the same treatment for the same reason (#82 item 4) and the two
**stack** rather than competing — a stale Safe-Stop is still a Safe-Stop.

### M4 — The status strip stays mounted with no layout loaded

`MonitorView` renders its strip above the canvas whether or not a drawing
loaded. An unattended display that failed to fetch a layout would otherwise
show a bare "No layout selected" with nothing saying whether it is even still
connected — the same "looks fine, is not" failure as a frozen mimic, reached
from a different direction. A unit test pins it.

### M5 — What the overlay draws, and what it refuses to

Drawn, all through the one shared `TrackDiagram` (#75) so the editor and the
monitor cannot drift:

| Fact | Treatment | Why that channel |
|---|---|---|
| Block occupancy | Fill + hatch pattern | Areas; three states must survive greyscale (#81) |
| Block lock | `LOCK.glyph` on the run label, and the route line below | The outline it used to be is gone — M8 |
| Route | A coloured, dashed line **along the track**, under it and wider | The only mark that can say *which* route holds a road (M8) |
| Commanded point road | Solid where set, dimmed where not, dashed where indeterminate — **and the tile's own roads drawn faint beneath**, or a point reverse still showed its normal road as connected track | `docs/diagram-encoding.md` D3 says a set/dimmed pair is already a non-colour encoding |
| Point lock | `LOCK.glyph`, once per point, **beside its name** (M7) | A glyph, not a colour; the same mark a locked block's label carries |
| Occupants | Words beside the block label | The only naming channel left once state takes the colour |

**Decorative track is drawn like any other track here** (M9). The editor draws
it faint and dashed because the question there is "is this tile finished"; the
question on a mimic is "where can a train go", and a route running over a
feeder that belongs to no block was drawn as a solid line crossing three faint
dashed tiles. Nothing is lost — a decorative cell carries no occupancy wash,
which says the same thing in the channel this view already uses for state.

**Block identity gives up the colour channel.** A tile cannot carry two
independent colour systems and stay readable, so where live state is drawn the
`BLOCK_TINTS` wash is not. That is the standing rule
`docs/diagram-encoding.md` already recorded, and it is why one-label-per-run
(#68) matters beyond tidiness: on the monitor the label is the *only* thing
naming a block.

Refused, each for a recorded reason:

- **No route layer *in addition to* the lock.** The rule used to be "no route
  layer" full stop; M8 records why the conclusion inverted while the argument
  held. A highlight drawn *alongside* the lock outline would still be two marks
  for one fact and is still refused.
- **No train placed at a spot, and nothing animated between blocks.** Position
  is block-granular and always will be (`docs/braking.md` B7 — open-loop dead
  reckoning, no loco feedback). Interpolation would assert a precision the
  system does not have.
- **No per-point commanded/confirmed qualifier.** Until #25 *every* position
  is commanded, so the view says so once in the status strip. A distinction
  drawn before there is anything to distinguish would be a lie, and per-point
  noise besides.
- **An occupied block with no identified occupant says nothing**, rather than
  implying it is empty of vehicles. Rolling stock is not modelled (#39); the
  occupant model is a list precisely so #39 populates it rather than reshaping
  every consumer.

### M6 — The point key is a panel the operator places over the canvas

The diagram draws `P1` where the point is called `P1 - Fiddle Yard`, with the
full name in a `<title>` (#93). That trade is right on a 40px tile and it
assumes a mouse. A wall display has nobody standing at it, so the tooltip is
unreachable and the abbreviation is all there is.

`PointKeyPanel` resolves every abbreviation at once: `On diagram` (exactly what
the tile draws, so the eye can match the two), `Name`, `Set` and `Held`. A key,
and a status table — the same row answers "which point is P3" and "why will
this route not set", and carrying both costs nothing once the row exists.

**Over the canvas, dragged where the operator wants it.** This said *beside,
not over*, on the argument that an overlay covers track on the one view whose
whole job is showing all of it. The argument was right about overlays and wrong
about the alternative: a fixed column covers track too — permanently,
everywhere, whether or not anything is under it. On Westgate Hollow that was a
260px strip of two-line wrapped names taken off a diagram that is mostly empty
canvas in the corners.

Which corner is empty is a property of the drawing, and the person looking at
it is the one who knows. So the panel floats, and it is placed by dragging its
grip — or by the arrow keys, because a panel that can only be dragged is one a
keyboard user cannot move at all, and the position is the whole feature. It is
clamped inside the canvas on every move: a panel dragged off the edge of an
unattended display cannot be dragged back, because there is nothing left to
grab.

Floating is also what pays for the width. Out of the canvas's flex row it sizes
to its own content between a floor and a ceiling, so the names stop wrapping.

It is collapsible, and both the collapsed state and the position persist per
layout, in the same tolerant, failure-swallowing style as the viewport
(M-adjacent: a corrupt `localStorage` entry must never stop the monitor coming
up unattended — the loader also still reads the bare `open`/`closed` string the
key held before there was a position to store).

**Monitor only.** The editor shows no live state at all, so two of the four
columns would be blank there and the other two are already on the tiles.

Two degradations, both the standing ones:

- **A point with no live state reads `unknown`, never `normal`.** Absence of a
  position is not evidence of a position — the same posture `roadSelection`
  takes when one clause of a road is unknown.
- **A live point with no roster record still gets a row**, named by its raw id
  (`docs/naming.md` D8). A point the layout is reporting on and the table
  silently omits is worse than an ugly row.

### M7 — A point lock is a glyph on the point, and is not a label

`PointState.lockedByRoute` was on the snapshot and drawn nowhere. It is now
`LOCK.glyph` at the point's label tile — once per point, matching where its
name goes, since a point is two tiles sharing one `pointId` (#93).

**Beside the name, in the same text run.** It first went in the tile's
bottom-right corner, as far from the name as a 40px cell allows, and the
operator's reading of it was the one that predicts: *it isn't immediately
obvious which point is locked*. A point is drawn as two tiles and only one
carries the mark, so a glyph floating in a corner had nothing tying it to a
point at all. As a `<tspan>` of the name's own `<text>` it moves with the name
and cannot drift out of alignment with it.

The same glyph a locked block's run label carries, deliberately: one mark means
one thing across the diagram, and a lock on a point and a lock on a block are
the same kind of fact about the same route.

**Not gated on label density.** "Labels: off" is an authoring control for
seeing the track under the text; it must not be able to hide the fact that a
route holds the road. With labels off the glyph draws alone, at the position
the name would have taken. Since the editor never receives `live` at all, this
only ever draws on the monitor — but the gating is written to say which of the
two it is, rather than relying on that.

This remains an **authority** guarantee, not a position guarantee. A locked
point can still be showing `unknown`, and both marks draw: until #25 there is
no feedback channel, and a lock has never meant the blades are where they were
commanded.

### M8 — A route is a line along the track, and it replaces the lock outline

**This inverts a conclusion M5 stated flatly, while keeping its argument.**
M5 said there is no route layer, because every block on a granted route carries
`lockedByRoute` and a highlight would be a second mark for one fact. Correct —
and it left the diagram unable to answer the question an operator actually
asks.

A locked run was a dashed yellow box. Two concurrent routes were two identical
dashed yellow boxes. The outline could say **held**; it could never say
**held by which**, which is exactly what someone wants to know when a route
will not set.

So the outline is gone and a coloured line along the held road takes its place
(`diagram/routePaths.ts`, #129). Still one mark for one fact, still derived
from `lockedByRoute` — **a step is drawn only while its block reports this
route's lock** — so the new mark cannot contradict the fact the old one
carried. Deriving the replacement from the replaced mark's own source is what
makes it a replacement rather than the second layer M5 forbids. A highlight
drawn *alongside* an outline would still be wrong.

### M9 — The line follows the road, and the road is walked

The first version of M8 lit every leg of every cell of every held block, and
recorded the alternative — a walk through the block — as "the compiler's job
and not a display's". The operator found what that costs on the first route
they set: **ES1 → Engine / Goods Transfer lit the three tiles between that
block's point and the Goods Shed**, track the train will not run over, on the
far side of a point this very route was holding the other way.

A block is not a piece of track. A destination block containing a point has a
road out of it the route has not claimed, and washing the block draws a road
that does not exist — the same class of error as guessing a path through the
wrong decorative cells, which M8 already refuses.

So the segments come from a walk (`diagram/routePaths.ts`):

- **Seeded from the joins**, never from the cells. The walk starts at the
  boundary where one held block's track meets the connective cells, and follows
  legs from there. Seeding whole cells instead would light both roads of a
  crossing, which is the junction #26 says a plain diamond is not.
- **A point offers only the road this route's holds select** — the same match
  `roadSelection` performs, but against the positions the route *requires*
  rather than the ones the points are lying in, because the line shows the road
  the route has claimed.
- **The state is a port**, a cell plus the boundary entered by, not a cell. It
  is what lets a crossing be entered from the west and left only by the east,
  and it is the same reason `tileGeometry.ts#exitsFrom` takes legs rather than
  an edge set.

Two fallbacks, both erring toward drawing **more**, because a line that
understates what is locked is the worse failure:

- A point tile no hold resolves stays fully traversable. The route demonstrably
  runs through the cell, and an empty cell mid-line reads as a break in the
  road rather than as "the position is unclaimed".
- A held block the walk never reaches is washed whole, as before. That happens
  when the joins either side could not be resolved to cells — the condition
  `hasGaps` already reports — and for a single-block route, which has no join
  to enter by at all.

The first block is walked from its exit join like any other, so a fork it
cannot take is not drawn; everything it *can* reach is, because position within
a block is not modelled (`docs/braking.md` B7).

**The cost is a re-opened duplicate.** Walking the drawing on the client needs
`EDGE_OFFSET`, `rotateEdge` and `oppositeEdge`, which #103 deleted from the
frontend along with the opening marks. They are back in
`diagram/trackGeometry.ts`, beside the leg table they belong with, and
`trackGeometry.test.ts` asserts the offsets literally so a backend change fails
a test here. The alternative was a backend read per route, which is a much
larger change to avoid one small table (`CLAUDE.md`, "Open limits").

`LOCK.glyph` stays on the block's run label, so "held" survives colour being
removed entirely.

**Colour is not the carrier.** Route identity in hue alone is what #81 forbids,
so each route also gets a dash pattern, cycling on a different period from the
hues — four by four is sixteen combinations, and past that the key in the strip
is the answer, which it is anyway. The palette is `BLOCK_TINTS` reused: where
live state is drawn the identity wash is not, so those four already-validated
hues are free, and the two systems never share a surface.

**Suspended routes are drawn**, dimmed and labelled. They still hold their
locks; what they are not is the road being run.

### Where the decorative cells come from, and what happens when they are missing

A route's path is a list of *blocks*, and the track between two blocks is
frequently drawn but tagged to neither — the Fiddle Yard reaches its sidings
through a feeder deliberately part of no block. A line that stopped at every
block boundary would read as broken rather than as a road.

`CompiledEdge.via` already carries those cells in walk order. The monitor reads
`GET .../topology/compile` once at mount — the same argument `useOpenings`
takes, a drawing being a config artefact a display does not poll — and joins
`RoutePathStep.edgeId` → `BlockEdgeRecord` → the connection tuple → `via`.

Walking the drawing in the frontend was **rejected**: it would be a third
hand-maintained copy of `TILE_LEGS` across the wire, on the geometry side, and
`CLAUDE.md` already carries two. A dedicated backend read cached by fingerprint
is the better long-term shape and is deferred until the monitor is more than
one display.

**A join that does not resolve draws a gap, and the key says so.** If the
drawing moved after the compile was read, the lookup misses for the changed
edges. A gap the operator can see and account for beats a plausible path
through the wrong decorative tiles — the "plausible until checked" failure #91
was about.

### Which legs light up

On a tile carrying point roads, the leg the route's own point holds select —
the same match `roadSelection` makes, but against the positions this route has
*claimed* rather than the ones the points are currently lying in, because the
line shows the road the route holds. On every other tile, every leg it draws.

A block containing a passing loop therefore lights both roads. Accepted: the
alternative is a walk through the block, which is the compiler's job and not a
display's.

## The control plane (#165)

Through #129 this view was `MonitorView`, and "no write path" was stated in its
own header as a virtue. Operating the layout for a while showed what that cost:
every act — a speed change, a point — meant leaving the picture of the railway,
finding a form on the Operate tab, and coming back to a train that had moved.
The Operate screen's throttle is a *form* — pick a loco, set a speed, press
**Set** — which is the right shape for issuing a command and the wrong one for
driving something you are watching. It also holds one loco at a time.

So the mimic became the screen the layout is driven from. The decisions below
are what that cost and what it deliberately did not buy.

### M10 — Controls are overlays; **track is never a button**

Every control #165 adds floats *over* the canvas (throttle cards) or lives in a
panel already floating over it (the point key's buttons). Nothing on the drawing
itself became clickable, and `ControlView` still hands `TrackDiagram` a set of
no-op mouse handlers.

Clicking a point on the diagram to throw it was the obvious design and is
rejected. This display's most valuable form is a wall panel, often a
touchscreen, read from across a room: on it a pan gesture and a tap are
separated by a movement threshold, and the cost of the threshold guessing wrong
is a point moving under a train. A drawing that can be operated by mis-click is
a drawing an operator learns not to touch, which takes away the pan and zoom
too.

The overlay form also keeps the canvas whole for the audience that wants the
display and nothing else — nothing is permanently reserved, because a card the
operator did not open does not exist.

### M11 — The slider commands; there is no **Set**

Moving a card's slider sends a `THROTTLE_COMMAND` immediately, throttled to one
command per 120 ms while dragging, with the released value always sent — a
trailing timer holding the *latest* value, never a dropped final frame. A run of
intermediate speeds is what a physical throttle produces on the wire too; the
one that must not be lost is the last.

Staging the value behind a button was considered and is what the Operate panel
already does. Two throttles with different commit rules would be worse than
either rule applied consistently, and the whole complaint that opened #165 was
the extra press.

### M12 — A card for a loco under automation opens **armed**, not live

`LayoutService.handleThrottleCommand` cancels an auto-authority route holding
that loco and abandons its automation run (`docs/route-locking.md` D6,
`docs/automation.md` A12). That is correct — two authorities on one train is
worse than a lost route — but combined with M11 it makes a brushed slider on a
wall display into a cancelled run.

So the card renders its controls inert behind a **Take control** button naming
the route it will cancel. One press to get there, and no way to arrive by
accident. The interlock is re-armed if the loco is later held by another auto
route, and it is checked *in the handlers*, not only as a `disabled` attribute:
the attribute is a presentational guarantee standing in for a behavioural one,
and what it is standing in front of cancels routes.

A `manual`-authority route is deliberately not armed against. That route *is*
the operator driving their own reserved road, and warning them off their own
throttle would be nonsense — `autoRouteHoldingLoco` mirrors
`ReservationService.routeHoldingLoco` (`active`/`suspended`) narrowed to `auto`,
and is one of the hand-maintained backend↔frontend duplicates.

### M13 — Direction cannot change under a moving train

The forward/reverse buttons are disabled while the loco is commanded above
speed 0. Stop first.

This is mechanical sympathy, not system safety: the backend accepts a reversal
at speed and a decoder will perform it. But the two direction buttons sit a
few millimetres apart on a small card, and a mis-tap at speed 60 is a
locomotive slamming into reverse. `ThrottlePanel`'s form is left unchanged —
its **Set** press is the same protection arrived at differently.

`'stop'` is a direction on the wire but not a heading, so a stopped card keeps
offering the way the loco last went rather than re-arming as forward.

### M14 — A point is set from its row in the key, and a held point offers nothing

The point key already carried everything needed to decide whether to move a
point — its trusted position, how far that position can be trusted, and whether
a route holds it — and could not act on any of it. Each row gained explicit
`Normal` and `Reverse` buttons.

**Explicit positions, never a toggle.** A toggle asks the operator to work out
what "the other one" means from a position that may read `unknown`, which is
precisely the state where guessing is worst. Re-commanding the position a point
already reports is allowed on purpose: that is how an operator re-asserts a
point whose confirmation came back `mismatch` or `timed-out`.

**A point a route holds shows no buttons at all** — the word "route", not two
greyed controls. Forcing it cancels the holding route (`docs/point-feedback.md`
D6), which is a consequential act that belongs on the Routes panel where the
route it destroys is named and visible, not one mis-tap from a table that is
mostly read.

No function or lights buttons, either: `SerialDccAdapter.setFunction` throws
rather than writing against PicoDCC (#150, `docs/dcc-link.md` D8), so on the
live layout that control is one that always fails.

### M15 — A refused command is said out loud

The backend answers a rejected `ClientMessage` with an `ERROR` frame. Until
#165, `useLayoutSocket` sent it to `console.warn` and nowhere else — the code
said so, and called surfacing it "still open".

That was survivable while every control was a form the operator had just pressed
**Set** on. It is not survivable on a control plane, where "point P4 is held by
route r-7" is the entire answer to why a button appeared to do nothing. The hook
now keeps the last refusal (with a sequence number, so an identical refusal
twice reads as two events) and the view shows it above the canvas.

Dismissible, and never self-clearing: a notice that faded after three seconds
would be missed by exactly the operator who was watching the train rather than
the screen. The `console.warn` stays too — the on-screen notice shows one
refusal at a time, and a burst of them is a thing you want the whole of, in
order, with a timestamp.

### M16 — The role is `monitor`; the view is the control plane

The tab reads **Control** for `admin` and `operator`, and still reads
**Monitor** for the `monitor` role, which gets the same component with
`canControl` false: no throttle affordance, no Set column. Absent, not disabled
— #61's argument, applied per control.

This is affordance only. `DRIVING_MESSAGE_TYPES` in the WebSocket transport
already refused a throttle or point command from a `monitor` connection (#63
D2/D3), which is why this view could be given controls with no new gate.

### What the operator's desk remembers

Which locos have a card is one entry per layout; where each card sits and
whether it is expanded is one entry per card, in `useFloatingPlacement` —
extracted from the point key, which established the placement posture in M6, so
that the drag, the clamp, the arrow-key nudge and the persistence exist once
rather than per panel.

The split is deliberate: closing a card and re-opening it later brings it back
to the corner the operator put it in, and no record accumulates for cards that
no longer exist. A stored address that is not a plain positive integer is
dropped rather than coerced — `parseInt("3junk")` is `3`, and a truncated
localStorage entry must never be the thing that decides which train a slider
drives.

## Related

- #63 (monitor role, `docs/auth.md` "The monitor role") is the strongest
  motivating case, per "The problem" above.
- #28 (retained `sensor/*/reading` replays a dead sensor's last `clear`) is
  the same hazard one layer down — a stale reading presented as current.
  Worth keeping the two consistent in how staleness is expressed once the
  frontend side of this lands.
- #75 (shared renderer) is what lets the editor and control views degrade
  identically once the frontend consumer exists.
- #165 (the control plane) is why this view has controls at all. Its
  interlocks lean on `docs/route-locking.md` D6 and `docs/automation.md` A12
  for what a manual throttle command does to a route, and on
  `docs/point-feedback.md` D6 for what forcing a held point costs.
