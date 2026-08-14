# Monitor role and the live mimic — plan (#63, #75, #82, #61)

Wave 3 of `#80`'s running order. Four issues land as one stack because they are
one feature seen from four sides: a role that may only watch, a renderer that
can be pointed at live state, a display that admits when it has stopped being
live, and a nav that stops advertising authority nobody has.

| PR | Issue | What it is |
|---|---|---|
| A | #61 | Operator UI scope — implement the decision `docs/auth.md` already recorded |
| B | #63, #82 | `monitor` role, WebSocket capability gate, application-level heartbeat |
| C | #75 | Extract `TrackDiagram` from `GridEditor`; no behaviour change |
| D | #63, #75, #82 | The monitor view itself: live overlay, connection health, role-scoped nav |

## Decisions

Every open question carried by the four issues, resolved. Where a resolution
departs from the issue's own leaning, the reasoning is given — those are the
ones a later reader will want to re-litigate.

### M1 — The monitor view is a new tab, and the Operate tables stay

`#75` open question 1 asks whether the mimic replaces the Operate pane's
tables. It does not. The tables are precise and greppable; a diagram is fast
and imprecise. They answer different questions, and the failure mode of a
mimic — trusted at a glance — is exactly the one a table does not have.
Both, with the diagram primary for the role that has nothing else.

### M2 — The Track Editor never shows live state

`#75` open question 2, leaning no, and the leaning is right. The editor is a
config surface. Mixing a control surface into it would mean a drawing whose
appearance changes under the operator's hands for reasons unrelated to their
edit, and it would put a live feed behind the one screen with a write path.
`TrackDiagram` takes live state as an option; `GridEditor` passes none.

### M3 — Operator and admin both get the monitor view; only admin gets the
authoring screens

`docs/auth.md`'s "Operator UI scope" says an operator sees *the Operate screen
and nothing else* — written before this view existed. Its own reasoning
resolves the ambiguity: it rejects a read-only Configure and a read-only track
view on the grounds that what an operator actually wants is "a purpose-built
situational-awareness view … tracked separately as the `monitor` role, issue
#63". This is that view. Withholding it from the operator would honour the
letter of that sentence against its argument.

So the nav is:

| Role | Tabs |
|---|---|
| `admin` | Operate, Monitor, Track Editor, Configure |
| `operator` | Operate, Monitor |
| `monitor` | Monitor |

Hiding a tab remains affordance, not authorisation (`docs/auth.md`). The
backend gate is D2 in `docs/liveness.md`/`docs/auth.md`, not this table.

### M4 — Liveness is a property of the connection, not of an entity

`#82` item 2 asks for per-entity staleness from the `lastUpdated` values
already on the wire, then undercuts it in its own caveat: on a quiet layout
nothing changes for long periods and that is normal. Entity age therefore
carries no information about whether this browser is still receiving — a
block last updated four minutes ago is indistinguishable from a block nobody
has driven through. The heartbeat carries all of the signal. One threshold,
tied to the heartbeat interval, applied to the whole display.

Rejecting per-entity age is recorded rather than merely omitted, because it
looks like an unfinished feature and is not.

### M5 — A stale diagram degrades visibly, and degradation is not a colour

When the heartbeat lapses, the whole canvas is marked stale — not a badge in
a corner. The failure this addresses is that a frozen mimic looks exactly like
a quiet layout, so the marking has to be impossible to read past. Per `#81`
and `docs/diagram-encoding.md`, it carries a pattern and a word, not a tint.

Safe-Stop gets the same treatment for the same reason (`#82` item 4): it is
the one state where nothing is allowed to move, and a small badge under-sells
it.

### M6 — Commanded is not confirmed, and the diagram says so once

`#63` item 5. There is no point-position feedback channel until `#25`, so
every point position the mimic can draw is commanded. Rather than decorate
each point with a qualifier that would become noise, the view states it once,
persistently, as a property of the display. When `#25` lands, the per-point
distinction becomes real and moves onto the points themselves.

### M7 — The occupant model is a list, not a loco address

`#75` and `#80` both make this a hard forward-compatibility requirement, and
it costs nothing now: `BlockState.locoAddress` is the only occupant the
system has, but an occupied block with a `null` address — a rake of coaches
in a siding — is a real and common state, and `#39` (RFID vehicle identity)
is the route to more. The renderer takes a set of observed vehicles so that
`#39` populates it rather than reshaping the component.

Loco position stays block-granular. No interpolation, no animation along a
run: `docs/braking.md` B7 records that the model is open-loop dead reckoning
with no loco feedback, and drawing a train at a *spot* would assert a
precision the system does not have — the same failure as drawing a commanded
point as if it were confirmed.

### M8 — `#75` does not unify the backend↔frontend duplicates

`CLAUDE.md`'s open limit lists three hand-maintained duplicates across the
wire (`findBlockRuns`, `TILE_LEGS`/`DRAWN_LEGS`, `EDGE_OFFSET`) as "all for
#75 to unify". That conflates two different problems. `#75` is the
editor↔monitor seam *inside* the frontend; the duplicates are backend↔frontend
and need a shared workspace package spanning a CommonJS backend and an ESM
frontend. Landing `#75` does not close them, and the limit is retargeted
rather than quietly marked done.
