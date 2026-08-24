# The DCC command-station link

**Issue:** #148 (the read path), with #150's `setFunction` guard landing alongside it.
**Firmware counterpart:** `bazauto/PicoDCC` — the `#43`/`#44`/`#47`/`#49` stack, bench
build `1e7bb6d`.

Everything the orchestrator knows about the command station, and what it does about it.
`docs/mqtt-contract.md` governs the sensor and point legs; this governs the DCC leg. They
are deliberately not the same document, because they are not the same kind of link — one
is a broker with many devices behind it, the other is a single serial line to a single
device that answers in order.

---

## The problem this closes

`SerialDccAdapter` was write-only. It opened the port, wrote commands, and never attached a
`data` handler, so `isConnected()` reported on a **USB device node** and nothing else.

The two come apart in every way that matters:

| What happens | What the device node said |
|---|---|
| Firmware cuts track power on a timing violation | open, healthy |
| Station enters `LAYOUT_MAINTENANCE` and discards every command | open, healthy |
| Station reboots (brownout, watchdog) | open, healthy — a USB-serial adapter on GP0/GP1 never drops |
| Accessory address out of range, command dropped | open, healthy |
| Station acknowledges a throttle command against the wrong loco | open, healthy |

`CLAUDE.md` safety rule 1 says uncertainty must Safe-Stop. Before #148 the DCC leg could
not *become* uncertain: it reported healthy right up to the point where the layout was dark
and every train had stopped by itself. That is the whole issue.

---

## D1 — The link is a different fact from the port, and gets its own field

`SystemHealth.dccConnected` keeps exactly the meaning it always had: the serial device node
is open. `SystemHealth.dccLink.responsive` is new and means: the thing on the other end is
answering.

Both Safe-Stop, and `dccConnected` is checked first — a closed port is the more systemic
failure and the more actionable message. Keeping them separate rather than folding
responsiveness into `dccConnected` matters for the operator reading the reason: "DCC
controller disconnected" and "DCC command station has not answered for 16s" send you to
different places with different tools.

## D2 — `<s>` is the probe, on a 5 s interval, lost after three misses

`<s>` because its reply is three facts in one round trip:

```
<iDCC-EX V-5.0.0 / PICODCC / BUILD 2026-08-22 G-1e7bb6d><p1 MAIN><p1 PROG>
```

identity (carrying the git hash of the running image), main track power, programming track
power. Nothing else has to be asked separately, and the identity doubles as the restart
detector (D7).

Three missed replies rather than one, matching `domain/liveness.ts`'s
`STALE_AFTER_MISSED_HEARTBEATS`: one missed reply is a scheduling hiccup, three is a
pattern. The constant is **duplicated rather than imported** — the WebSocket heartbeat and
the DCC probe answer to different hardware and will want to diverge, and sharing the number
would make one of them change by accident.

**Any frame counts as evidence of life**, not just a probe reply. The probe exists to
*provoke* evidence on an idle layout, not to be the only thing that qualifies.

## D3 — Silence Safe-Stops. There is no partial degrade for this leg

`docs/sensor-trust.md` D9/D10 draws a careful line: a **stale** sensor degrades only its own
blocks, while a **malformed** one Safe-Stops the layout — silence is a device dying, a
malformed payload is a device lying, and a dying detector only makes *its* track unknown.

That reasoning does not transfer, and it is worth being explicit about why rather than
copying the shape. A sensor is one of many, each covering specific blocks, so "degrade only
what this device was evidence for" is a real option. The command station is the **sole path
to every train on the layout**. There is no subset of the railway that a silent station
leaves commandable.

Note what this Safe-Stop is *about*. Since sensors run over MQTT and not through the command
station, a dead DCC link does **not** make train positions unknown — occupancy keeps
updating perfectly well. What is lost is the ability to *act*: to stop a train, to brake a
run, to set a road. That is enough on its own. A system that can watch a train it cannot
stop must not be granting it new track.

`<X>` is treated as the other half of that distinction (D5): a rejection is the station
*disagreeing* with one command, not the station dying, and it is scoped accordingly.

## D4 — One sub-object, not a fifth keyed collection

`sensorFaults`, `pointFaults`, `routeFaults` and `brakingFaults` are keyed collections for
one reason: acknowledging the fault an operator can see must never silently clear one they
were never told about. That argument has nothing to bite on here — there is one command
station, and a second fault on it is not a second thing to acknowledge.

So `SystemHealth.dccLink` is a `DccLinkHealth` object holding `responsive`, its `reason`, a
single latched `fault`, both track power states, the station identity and a restart count.
The alternative — five more top-level scalars on `SystemHealth` — would scatter one device's
state across a structure whose other members are all per-entity collections.

The latch behaves like every other latch in that structure: **first cause wins**, nothing
clears itself, and only `LayoutService.acknowledgeDccLinkFault` (`POST
/api/layouts/:layoutId/dcc-link/acknowledge-fault`, any authenticated role) clears it.

There is deliberately **no arming threshold**, and for a sharper reason than the
route-fault equivalent: `responsive` is re-evaluated on every sweep, so acknowledging a
`link-lost` fault while the station is still silent clears the latch and leaves Safe-Stop
standing on the live evidence. The acknowledgement cannot outrun the world.

## D5 — A rejection faults the route that issued the command

`<X>` is DCC-EX's generic rejection. On the bench firmware it now fires at four sites:
validation failure, unterminated framing, a `LAYOUT_MAINTENANCE` discard, and a throttle
refused because the loco collection is full.

Where the rejected command was issued **on behalf of a route**, that route is faulted and
the link is not:

| Rejected command | Fault |
|---|---|
| Throttle, on a route | `RouteFault` `dcc-command-rejected` |
| Accessory, on a route | `RouteFault` `point-command-rejected` — that is precisely what it is |
| Anything with no route (manual throttle, manual point, probe) | `DccLinkFault` `command-rejected` |
| `<X>` with nothing outstanding | `DccLinkFault` `unattributed-rejection` |

Both paths Safe-Stop; the difference is what the operator is told, and a route fault names
the movement that is now invalid rather than the wire that carried it.

`unattributed-rejection` is deliberately not swallowed. It means either something else is
talking to the station, or a frame we sent was garbled beyond recognition — both worth
knowing, neither common.

## D6 — `<l>` is checked strictly on the cab and advisorily on the speed

The station answers a throttle command with `<l cab reg speedByte functMap>`, reporting what
it decoded. That is the only channel in the system that could have caught #147 — a command
addressed to loco 3 acknowledged as loco 1 — on the first hardware run instead of by reading
firmware source months later.

- **Cab mismatch → `cab-mismatch`, Safe-Stop.** Unambiguous: something is moving that we did
  not command.
- **Speed or direction mismatch → a logged warning, no latch.**

The second is a dated judgement, not a permanent one. The speed byte's encoding changed in
`PicoDCC#49` (it had been subtracting one instead of adding one, reporting every moving
speed two steps low and making step 1 indistinguishable from an emergency stop);
`PicoDCC#48` — speed 0 encoding as an emergency stop on the rails — is open; and #151 will
introduce a per-loco 28/128-step mode. A strict check today would Safe-Stop a live layout
over a firmware version skew rather than over a train doing the wrong thing.

**Revisit when `PicoDCC#48` and #151 have landed.** The comparison is already implemented
and already runs; promoting it is changing one `severity`.

## D7 — An unprompted identity banner is the restart signal

The station sends its banner unprompted exactly once: at boot. So an identity that arrives
without a probe outstanding **is** a reboot, and a solicited banner carrying a different
commit says the image changed underneath us. Either latches `station-restarted` and
Safe-Stops.

It matters because a restarted station has forgotten every loco in its reminder table, and
`PicoDccTrack`'s constructor brings both tracks up **powered off**. The layout is dark and
the station's model of it is empty, while the orchestrator's model is not.

One implementation note, because it cost a debugging round and is entirely
non-obvious: solicited-ness must come from the **resolution** of the response, not from
re-inspecting the outstanding queue. By the time the identity is examined, the probe that
asked for it has already been settled and removed — so a queue check reports every routine
probe reply as a reboot, which is a Safe-Stop every five seconds, for ever.

## D8 — Correlation is positional, and #150 is what makes it sound

`<X>` names nothing. `<O>` names nothing. The only way to say *which* command was refused is
position: the serial link is a FIFO and the station answers in order.

So `domain/dccLink.ts` keeps a queue of outstanding commands, recorded immediately **before**
each write, and resolves each response against it. A command settled out of order drops the
unanswered commands ahead of it, because the station replies in order and an earlier command
that is still unsettled never will be.

Two consequences worth stating:

**`<l>` is matched by position, not by cab.** The obvious rule — find the outstanding
throttle whose cab equals the reply's — quietly destroys the one thing most worth catching:
if the station decodes against the wrong loco, that rule finds no match and files the reply
as unsolicited chatter. #147 was exactly that failure. So the reply pairs with the oldest
outstanding throttle regardless of cab, and the cab is then *verified*.

**This is why #150 belongs in the same change.** `<F>` is the one command that succeeds
*silently* — validated, accepted, and dropped into an empty `updateFunct()`. While an `<F>`
can be in flight, an `<X>` cannot be attributed with confidence, because the rejection might
belong to the command after the one that quietly worked. `SerialDccAdapter.setFunction`
therefore throws (`DccFunctionUnsupportedError`) rather than writing. `SimulatedDccAdapter`
is unaffected: this is a hardware limit, not a model limit.

An emergency stop **clears the queue**, because the station clears its own on `<!>` and then
emits one `<l>` per loco it was reminding. Those replies belong to no throttle command, and
verifying them would report a mismatch on every one.

## D9 — An unrecognised frame is not a fault

A malformed *sensor* payload Safe-Stops on the first message (`docs/sensor-trust.md` D10). A
frame the DCC parser does not recognise is logged and ignored — through the same RX line as
every other frame (D13), which #161 moved to `debug`.

The asymmetry is deliberate. A sensor speaks one schema, and a device sending something else
is lying about occupancy. The command station speaks a whole protocol of which we implement
a subset — `<e SAVED>`, `<# n>`, JMRI-oriented replies, whatever a later firmware adds — so
"I do not know this frame" is the ordinary case. What *is* a fault is the station
contradicting a command we sent, and that is D5 and D6.

The framer applies the same discipline in the other direction: bytes outside any frame are
counted and discarded, and an unterminated `<` is dropped once it exceeds `MAX_FRAME_LENGTH`
(the station gives up at 100 characters on its side, for the same reason).

## D10 — Track power is observed here, and gated as of #149

`<p1 MAIN>` / `<p0 MAIN>` are parsed and recorded in `dccLink.mainPowerOn` / `progPowerOn`.
#148 observed them and gated nothing; #149 acts on them. `null` still means **never
observed**, which is not the same as off, and the distinction is load-bearing everywhere
below.

**Track power off is not a Safe-Stop.** The layout is already stopped, and by the most
complete means available — there is no current on the rails. Calling that an emergency would
mean an operator who switched power off for two minutes to re-rail a wagon came back to a
Safe-Stopped system needing an acknowledgement. It latches nothing and clears itself the
moment `<p1 MAIN>` arrives.

What it does do:

- **Refuses new routes**, with its own `RouteRejection` kind, `track-power-off`. Refused in
  `LayoutService.requestRoute`, never inside `ReservationService`, which has no
  `SystemHealth` access and must not gain any — the boundary `docs/route-locking.md` draws
  and #25's resume precondition already respects.
- **Abandons automation and any braking ramp in flight**, and gates the automation sweep.
  Both halves are needed, for different reasons — see D15.
- **Refuses on `=== false` only.** An *observed* dark layout refuses; `null` does not. The
  never-answered case is covered from the other side, where `responsive` is false and the
  system is already Safe-Stopped, and refusing on `null` too would turn every start-up race
  into a rejection nobody could explain.

**Never auto-restore power after a fault.** A decoder that loses the DCC signal falls back to
DC, and DC on a powered main track is full speed. `<1>` on connect is a cold start with an
operator present; an automatic `<1>` in response to observing `<p0 MAIN>` is not, and nothing
in #149 sends one.

## D14 — `<1>` is sent by the service on connect, not by the adapter

The issue asked for `SerialDccAdapter.connect()` to send `<1>` after the port opens. It is
sent from `LayoutService.handleDccConnectionChange` instead, for two reasons the codebase
acquired after #149 was written:

- **"The layout should be live" is a decision**, and decisions do not live in adapters
  (CLAUDE.md safety rule 2). The adapter opens a port and writes bytes.
- **Every command must be recorded before it is written.** D8's correlation is positional, so
  a command written from inside the adapter — invisible to `recordCommand` — would leave its
  `<p1 MAIN>` reply to be attributed to whatever *was* outstanding. The write path that
  records first is `LayoutService.setTrackPower`, and connect goes through it.

`setTrackPower` also probes with `<s>` immediately afterwards, and that is the point rather
than belt and braces: the command resolving means the bytes went out, and D12's whole
argument is that a command's success is not evidence of its effect. What moves
`dccLink.mainPowerOn` is the `<p1 MAIN>` in the reply, so the operator sees the state the
**station reported**, never the state we asked for. A `<1>` that vanishes leaves the badge
where it was.

## D15 — Abandoning automation and gating the sweep are different jobs

A power loss does both, and they are not redundant.

**Abandoning** stops the run that is in flight. Without it, automation would keep issuing
speed commands into dead rails and the train would leap into motion the moment `<1>` was
sent — the ghost-movement failure in a different costume. A braking ramp would do the same,
one step at a time.

**Gating the sweep** (`permitted` in `runAutomationSweep`) stops a run *starting*. It is not
what stops an abandoned run resuming: `AutomationService`'s `adopted` set already does that,
for exactly the reason it does after an emergency stop — a route is taken at most once while
it stays `active`. What the gate covers is a route automation has never taken. Two ways that
happens: a route granted while the layout was live and not yet under way when the power went,
and — the case `adopted` structurally cannot cover, because it prunes on leaving `active` — a
**suspended route an operator resumes while the layout is dark**.

The gate is ANDed in at the call site rather than folded into `canIssueAutoCommand`, the same
placement and the same reasoning as #103's compile-gap gate on `handleSetMode`:
`canIssueAutoCommand` is a pure function of status and mode, and power is a live observation
off this link.

**An existing route keeps its locks in the dark.** The locks are what stop a second train
being routed over track this one is standing on, and that is as true unpowered as powered —
more so, since the train cannot be moved off it.

## D11 — The simulator answers

`SimulatedDccAdapter` now replies: `<l>` to a throttle command, `<O>` to an accessory
command, identity plus both power states to `<s>`. Without that, the newest safety machinery
in the system would be testable only against hardware — the exact inversion CLAUDE.md rule 5
exists to prevent.

It is a *cooperative* station by default; every failure is opt-in (`rejectNext`,
`acknowledgeNextAs`, `goSilent`, `simulateRestart`, `setSimulatedPower`, `emitResponse`), so
a test asks for the misbehaviour it asserts on and no test gets one by accident. Probes are
deliberately kept out of `commandLog` and counted in `probeCount` instead: that log means
"commands meant to move something", and a probe every five seconds would turn every existing
assertion into a hunt for the interesting entry.

## D12 — What was invisible, and is not any more

`PicoDCC#4` is closed as of `PicoDCC#59` (2026-08-24). `#47` had made **rejected commands**
answer `<X>`; what was left was the power-cutoff paths, which said nothing, because one of
them runs in `PicoDccController::dccLoop` on **core 1**, where `DCCEX_RESPONSE` is a blocking
`uart_puts` sitting in the DCC hot path.

The design this document guessed at — "most likely a flag core 1 latches and core 0 drains"
— is what landed. Core 1 sets two `volatile bool`s and the error LED; core 0 drains them in
`dccexLoop` and emits `<p0 MAIN>` / `<p0 PROG>`, once per cutoff rather than once per 10 ms
pass. Every path that cuts power because something is wrong now reports it: the timing
violation, either track's PIO failure, the core 1 heartbeat cutoff, and an overcurrent trip.
`PicoDCC#42` landed with it — the same cutoff used to clear its own error LED on the next
pass, leaving a dead layout showing no fault at all.

So a cutoff is now **pushed**, not merely discovered at the next `<s>` probe up to five
seconds later. *Responsive and dark* is no longer a state that has to be waited out. The
probe remains as the backstop for a station that goes dark without managing to say so —
losing its UART, for instance, which is the one case that cannot announce itself.

Also relevant, and merged: `PicoDCC#32` — `time_us_32() / 1000` wrapped every 71.6 minutes,
firing the timing-violation cutoff spuriously about once an hour and leaving both tracks
off. Much of what #148 and #149 were written against as "fault handling" was that defect
rather than a real fault rate. The design gap is unchanged; the expected frequency is not.

## D13 — The RX line carries the frame *and* the decode

The first bench run of #147's fixed throttle produced this, and only this (at `info` — #161
later moved TX/RX to `debug`, since an idle layout's `<s>` keepalive alone put a pair of
these in the journal every `DCC_PROBE_INTERVAL_MS`; the example below keeps the level it was
captured at):

```
{"level":"info","msg":"[SerialDCC] TX","cmd":"<t 3 7 1>"}
{"level":"info","msg":"[SerialDCC] RX","response":"cab"}
```

`"cab"` says something was acknowledged and nothing about *what* — not the cab, not the
speed, not the direction. That is the one thing #148 exists to make visible, so the RX line
now logs both halves: `frame` verbatim as it came off the wire, and the decoded fields from
`describeDccResponse`.

Both, not one. The frame alone would need a human to decode `<l 3 0 136 0>`; the fields
alone would hide a parser that read the frame wrongly, and a wrong decode looks exactly like
a station misbehaving. Printing them side by side is what makes the two distinguishable in
journald.

`describeDccResponse` lives in `domain/dccResponse.ts` rather than in the adapter, for the
same reason the command strings do (#147): a `switch` over the response union is the kind of
thing that silently stops covering a new variant, and the adapter is excluded from coverage.

It names no loco. The adapter holds no `NameBook`, and `cab` stays the station's word for
the address it decoded — not ours for the loco we meant. Pairing an address with a name is
the service layer's job, and this line is deliberately a record of the wire. Correlating the
reply to the command that caused it is still D8's, in `domain/dccLink.ts`.

---

## What lands where

| Concern | Where |
|---|---|
| Framing, parsing, the speed-byte decode, the log projection | `domain/dccResponse.ts` (pure) |
| Correlation, `<l>` verification, liveness, the view projection | `domain/dccLink.ts` (pure) |
| The outstanding queue, the latch, power/identity bookkeeping | `services/DccLinkService.ts` |
| The `<s>` probe timer, route faults, Safe-Stop, the acknowledge | `services/LayoutService.ts` |
| `data` handler, framing buffer, `setFunction` guard | `adapters/dcc/SerialDccAdapter.ts` |
| Synthetic replies and the failure switches | `adapters/dcc/SimulatedDccAdapter.ts` |
| `GET`/`POST .../dcc-link` | `transport/http/routes/dccLink.ts` |
| Failure-path coverage | `tests/scenario/dcc-link.scenario.test.ts` |

`SerialDccAdapter` stays excluded from coverage, and that is now a much smaller claim: it
opens a port, writes bytes, buffers what comes back, and delegates. Every decision it used
to imply lives in a tested module.
