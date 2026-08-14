# Connection Health and Staleness — Decision Record

This document records the design behind #82: whether a client is still
receiving live layout state, as distinct from the layout simply being quiet.
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

## Scope: this PR is the backend half

This document covers what #82 asks for in its "What to do" list only insofar
as the backend has to move: the heartbeat itself (item 3), and the
verification that a reconnect resynchronises correctly (open question 2). The
frontend consumer — a visible connection-state indicator, per-item staleness
dimming derived from it, and Safe-Stop made unmissable on the diagram (items
1, 2 and 4) — lands in a later PR, once #75's shared renderer exists for the
editor and monitor views to degrade identically. Nothing here is blocked on
that; the wire contract (D5–D7 below) is stable and frontend-independent.

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

## Related

- #63 (monitor role, `docs/auth.md` "The monitor role") is the strongest
  motivating case, per "The problem" above.
- #28 (retained `sensor/*/reading` replays a dead sensor's last `clear`) is
  the same hazard one layer down — a stale reading presented as current.
  Worth keeping the two consistent in how staleness is expressed once the
  frontend side of this lands.
- #75 (shared renderer) is what lets the editor and monitor views degrade
  identically once the frontend consumer exists.
