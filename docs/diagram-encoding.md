# Diagram encoding: colour is never the sole carrier

Decision record for #81, landed with #68. A standing constraint on every layer
of the track diagram — the Track Editor, the monitor view (#75, #82, #63), and
signal aspects when #79 lands.

Implementation: `packages/frontend/src/diagram/encoding.ts` (the encodings),
`packages/frontend/src/diagram/blockRuns.ts` (run detection and tint
assignment), `packages/frontend/src/diagram/patterns.tsx` (the hatches, and the
alignment rule in `docs/track-editor.md` D18), and
`packages/frontend/src/diagram/trackGeometry.ts` (the one description of what
shape a drawn leg is — D16 there).

---

## The rule

**Every state distinction that matters must be legible with colour removed.**

Each encoding ships a `colour` *plus* at least one of a `pattern`, a `glyph`,
or a `label`, and consumers render at least one of them. Colour reinforces a
distinction that is already there; it never is the distinction.

Red/green deuteranopia and protanopia together affect roughly 8% of men, and
red-green is exactly the pairing a railway mimic reaches for first: occupied
red, clear green. A diagram whose entire purpose is being read at a glance,
encoding its two most important states in the one pairing a common condition
cannot distinguish, is a bad outcome — and it is invisible to an author who
does not have the condition.

---

## D1 — Two colour systems, kept apart: identity and state

**Decision.** Block *identity* (`BLOCK_TINTS`) and layout *state* (`OCCUPANCY`,
`POINT_POSITION`, `LOCK`, `FAULT`) are separate palettes. State colours are
reserved and are never reused for identity.

They do not share a surface today: the Track Editor shows identity and no live
state at all; the Operate pane shows state and no tints. When the monitor view
brings them together (#63, #75), **state wins the colour channel** and block
identity falls back to its label.

That is a large part of why one-label-per-run (#68) matters beyond tidiness: it
is the fallback the whole scheme rests on.

---

## D2 — Occupancy is a fill; a lock is a line along the track

**Decision.** Occupancy is carried as a fill (flat, hatched, or cross-hatched).
A route lock is carried as a **line along the road the route holds**, plus
`LOCK.glyph` on the block's run label.

**Why they must not share a channel.** Occupancy and locking are independent —
a block can be locked and clear, or occupied and unlocked — and #81 names them
as the pair most likely to be conflated if both are "a colour". A fill and a
line compose; two fills compete.

**Amended (#129): the lock used to be a dashed outline around the run.** The
composition argument above is why it was an outline rather than a second fill,
and that half stands. What changed is that an outline can only say *held*: two
concurrent routes drew two identical yellow boxes, and "held by which" is the
question an operator has. The line carries the same fact — it is drawn from
the same `lockedByRoute` field, only while the block still reports it — and
adds the route's identity. `docs/liveness.md` M8 is the full record.

**Route identity is a hue *and* a dash**, never a hue alone; `ROUTE_TINTS` is
`BLOCK_TINTS` reused, which is safe because identity gives up the colour
channel wherever state is drawn (D1), so the two palettes never share a
surface.

**The line is drawn along the road the route walked, not over the block it
holds** (operator feedback on #129). A block is not a piece of track — a destination block
containing a point has track on the far side of it that the train will not run
over, and washing the whole block drew a road the route does not have. The
segments come from a walk from the joins between held blocks, following legs
and taking only the road a point hold selects. `diagram/routePaths.ts` carries
the two fallbacks, both of which err toward drawing more rather than less.

**The renderer draws in three layers, and that is what makes the line
continuous.** Every tile paints an opaque background rect of its own, so with
one group per tile a tile's background erases whatever its already-drawn
neighbour put down. Harmless for anything that stays inside a cell; wrong for
the halo, which is 9 units wide against a 4-unit track and therefore always
crosses the boundary. On a 45° run the erased wedge showed as a waist at every
tile edge — the halo read as a chain of capsules, and the operator's word for
it was carriages.

So `TrackDiagram` makes one pass for every background and wash, one for every
route halo, and one for every piece of track and text. Nothing a later tile
draws can reach back under an earlier tile's track, and adjacent halo segments
overlap into one band.

A first attempt blamed the sleeper marks and suppressed them on route cells.
That was a wrong diagnosis of the right complaint — the breaks were the halo's
own tile boundaries, and the sleepers were doing what they are for. They are
drawn on a route cell like any other.

**`unknown` is the most visually distinct of the three occupancy states**, not a
neutral middle ground. It is a fail-safe state that refuses routes, so it gets
the cross-hatch. A state that halts the railway should not look like a milder
version of "clear".

**Amended (D10): it is now the *only* hatch.** `occupied` used to carry a
single-direction one, which made this claim about `unknown` half true at best —
the fail-safe state was competing with the ordinary one for the same channel.
`occupied` and `clear` are both flat washes now, separated without colour by
the opacity each is drawn at. D10 has the reasoning and the numbers.

---

## D3 — Point position keeps its existing non-colour encoding

**Decision.** A set road drawn solid and an unset road dimmed is already a
non-colour encoding. Keep it. `unknown` takes the cross-hatch, for the same
reason as occupancy.

**Only half of that was drawn, and the missing half was the important one.**
The overlay dimmed the *unset road it drew* — but the tile underneath still
drew both of the point's roads as ordinary solid track, so the overlay only
ever **added** a highlight to one of them. A point standing reverse showed its
normal road as connected track: the blades making a junction in two directions
at once, which is the one thing a point cannot physically do. Where there is
live state a point tile's own roads are therefore drawn faint
(`POINT_BASE_OPACITY`), and the overlay redraws the set one at full strength.
What is left faint is the road that is not set.

**Only where there is live state.** The editor is authoring the road mapping
and needs both roads legible; it has no set road to distinguish them by
anyway.

**Commanded versus confirmed now has something to distinguish, and it is
encoded away from the tile.** #25 landed the feedback channel, so a point
carries a `confirmation` (`unreported`, `pending`, `confirmed`, `mismatch`,
`indeterminate`, `timed-out`) alongside its commanded and confirmed positions.
`POINT_CONFIRMATION` in `encoding.ts` gives each of the six a glyph and a word,
so the state is never carried by colour alone — but that mark is drawn in the
**Layout panel and the point key**, not on the tile. The road a tile draws
comes from `effectivePosition` (`docs/point-feedback.md` D7), which is the one
place that decides what is trusted: a `'required'` point whose confirmation
lapsed draws **no** set road, because its position is genuinely unknown, and
that absence is the honest encoding. A fourth mark inside a 40px cell already
carrying occupancy, a lock and two labels would cost legibility for a
distinction the operator reads at the point key anyway.

---

## D4 — Block tints mark boundaries; they do not identify blocks

This is the decision that changed shape once it was measured, and it is the
important one.

**#68 asked for** per-block tinting, "stable across reloads (assigned palette,
or hash of block id)", so that "block identity reads at a glance without any
text".

**That is not achievable, and measuring it is what showed why.** Running the
candidate palettes through the dataviz skill's `validate_palette.js` against the
`#1e1e2e` tile surface, checking *all* pairs rather than adjacent ones — the
honest test, since a hash can put any two blocks side by side:

| Palette | Worst all-pairs CVD ΔE |
|---|---|
| 8 hues (Catppuccin, the existing look) | **1.7** (deutan) — indistinguishable |
| 8 hues (retuned, saturated) | 1.7 (deutan) |
| 6 hues | 5.8 (deutan) |
| 5 hues | 6.0 (protan), and normal-vision ΔE 11.6 — below the floor |
| **4 hues** | **6.8 (deutan), tritan 8.7 — all checks pass** |

A palette large enough to give every block its own colour cannot be
colour-blind-safe. And it would not help anyone anyway: nobody memorises twelve
tint→name mappings.

**Decision.** Tint does not identify a block. It marks **where one block ends
and the next begins** — which needs only enough colours that no two *adjacent*
blocks share one. That is a graph-colouring problem, and four colours are
famously plenty for a near-planar drawing.

So:

- `BLOCK_TINTS` is **four** validated colours: `#3868c6`, `#a06e00`, `#00959c`,
  `#c770c1`.
- `assignRunTints` does greedy graph colouring over spatial adjacency of runs,
  **not** a hash of the block id. A hash gives adjacent blocks the same tint
  often enough to be useless precisely where the distinction matters.
- Every run of the same block gets the same tint, so a block drawn in two
  places still reads as one block.
- The block's **name** identifies it. That is what #68's one-label-per-run
  draws, and it is not optional decoration.

**Do not add a fifth tint without re-running the validator.** It will not pass.

**The one WARN, and why it is discharged.** The 4-colour palette's worst pair
(`#c770c1` ↔ `#00959c`, ΔE 6.8 under deuteranopia) sits in the 6–8 band, which
is legal *only* with secondary encoding — direct labels, gaps, or texture. All
three are present: every run is labelled, runs are spatially separated, and the
tint is a low-opacity wash under a track drawing it does not alter. The
constraint and the feature turn out to be the same mechanism, which is why #80
was right that #81 must land with or before #68.

---

## D5 — A missing name degrades to the raw id, never to nothing

**Decision.** When a block or point record cannot be resolved, the label renders
the raw id rather than being omitted.

**Why.** This was found by looking at a screenshot of the finished work: with
the block records failing to load, the tints rendered and the labels did not —
leaving colour as the sole carrier, the exact thing this document forbids. The
fallback matches the degradation contract the `NameBook` already takes
(`docs/naming.md` D8): render raw ids byte-for-byte rather than hiding the
distinction.

---

## D6 — Label density is a control, not a constant

**Decision.** Labels can be set to `always` (default), `hover`, or `off`.

**Why.** The useful density genuinely differs between authoring — where you are
checking that every tile carries the block you meant — and reading, where the
same labels are clutter over track you already know. `always` is the default
because the Track Editor is the authoring screen.

`off` hides text only. It never hides tiles, and it is not a way to make an
unreadable diagram look tidy.

---

## D7 — Withdrawn: openings are not drawn at all

**Decided #103 step 6.1, withdrawn on operator feedback.** D7 used to specify
an opening mark: a short tick in `OPENING.colour` crossing the boundary a port
names, the `⊣` stop glyph on a terminated opening's closed side, and the
opening's label once at the tile the compiler chose. All three are gone, and
`OPENING` is deleted from `diagram/encoding.ts` with them.
`docs/track-editor.md` D15 is the record.

**What was right about it, and why it lapsed anyway.** The reasoning held: a
label at a *plausible* nearby cell hid #91's fused siding, while a mark at the
wrong boundary is visibly wrong. But that argument is about **authoring** — it
buys a check while the graph is being got right. Westgate Hollow's graph is
compiled and applied, the check now happens in the compile diff under review
before an apply, and an opening's name is disposable output nobody reads off
the diagram. Three permanent marks per opening, on cells that also carry
occupancy, locks, block names, point names and road letters, stopped being
worth their space.

**What this says about the rest of this document.** Nothing here weakens D1–D6.
Those govern **state** — what the layout is doing — which is the thing a mimic
exists to show and which earns its place on every cell it touches. D7 was the
one entry about a *derived description* rather than a state, and that is
exactly the category that has to justify its cell against everything else
competing for it. The test to apply to the next candidate: does an operator act
on this, and does it change?

---

## D8 — Sensor observation is its own channel, never the block tint (#76)

**Decision.** #74's placed-sensor glyph — a static-ink circle-and-line mark — now
draws what a sensor currently reports (`diagram/encoding.ts#SENSOR_OBSERVATION`,
`sensorGlyphStateOf`), on a channel of its own: `filled`/`dash` on that small mark,
never a share of `BLOCK_TINTS` or `OCCUPANCY`'s fill.

**Why it cannot be a fifth block tint.** D4 already fixes the count at four,
validator-checked, and re-running that validator against a candidate fifth is not
this decision's to make. But the deeper reason is D1: state and identity are
deliberately separate colour systems, and where live state is drawn (the monitor)
state wins the colour channel outright. A sensor observation is a THIRD thing
layered on a tile that can already carry an occupancy fill and a lock outline — it
was never a candidate for the tint slot, which identity gave up to state before this
decision existed.

**The real hazard, and why the answer is "subordinate", not "hidden" or "merged".**
`deriveBlockOccupancy` clause 3 (`docs/sensor-fault-recovery.md`) is precisely where
a beam and its block are allowed to disagree: an IR `clear` is a no-op, so a block
can sit at `unknown` while its own beam plainly reads `clear`. Merging the two
readings onto one channel would either lie about the block (drawing it clear because
a beam says so) or lie about the beam (suppressing its reading to match the block) —
both are the "guess a train's position" failure CLAUDE.md's fail-safe rule forbids,
approached from the display side rather than the derivation side. So the two stay
two marks: `OCCUPANCY`'s fill is the derived, trusted answer; the sensor mark beside
it is the raw evidence, visibly smaller and visibly a different kind of mark.

**Four states, matching D1–D6's non-colour rule exactly.** `occupied`/`clear` are
the sensor's own reading; `not-evidence` collapses untrusted, faulted and
out-of-service into ONE treatment — a dashed outline plus a diagonal slash — because
all three mean the same thing to an operator ("do not read this as live evidence")
and #28's own rule is that an untrusted reading is shown, never hidden, or a dead
sensor and a clear beam become indistinguishable; `no-reading` is a placed sensor
that has never reported. `occupied` alone is filled — a positive assertion gets ink,
the other three are outlines — and the dash pattern differs again between
`not-evidence` and `no-reading`, so no two states share both colour and shape.

**Reaffirming the rule this does not touch.** `BLOCK_TINTS` stays four colours,
validated, unchanged. This decision adds a consumer of the existing rule — a new
channel obeying D1–D6 — not an exception to it.

**Superseded in part by D9**: the channel is exactly as decided here; what changed is
that it is no longer optional.

---

## D9 — The sensor layer is always drawn; the "Sensors" checkbox is withdrawn

**Decision.** `ControlView` draws every sensor observation on load. The
off-by-default checkbox D8 shipped behind, and `buildLiveDiagramState`'s
`showSensors` parameter, are both gone. The sensor key is now mounted
unconditionally alongside the layer it explains.

**Why the original default did not survive contact with the layout.** D8 reasoned that
raw sensor evidence and derived occupancy can legitimately disagree
(`deriveBlockOccupancy` clause 3), and that defaulting the layer on would make that
disagreement the first thing a new operator sees. That is a real property of the
display, and it is still true — but it argues for the *subordinate mark*, which D8
also decided and which stands. It does not argue for hiding the mark. In practice the
operator wants the beams visible every time and has to remember to ask for them every
time; a diagnostic that must be switched on before it can be read is a diagnostic that
is off precisely when something unexpected happens.

**Why hiding raw evidence is the weaker default on a safety display.** #28's rule is
that an untrusted reading is *shown*, never hidden, or a dead sensor and a clear beam
become indistinguishable. A layer that defaults to off applies the opposite rule to
every reading at once. The disagreement D8 worried about is information: a block at
`unknown` beside a beam plainly reading `clear` is the system telling the operator
exactly which part of its evidence is missing — which, on the live layout today, is
the *normal* state until the firmware re-asserts (#28 D12).

**What this does not change.** The mark stays subordinate and stays its own channel:
smaller, a different kind of mark, four states, never a share of `OCCUPANCY`'s fill or
a fifth block tint. D4's four validated tints are untouched. The Track Editor still
draws no sensor observation — it passes no live state at all, which is a different
question from a control that hides one.

**The key is now permanent chrome, deliberately.** It was mounted with the layer on a
"no permanent chrome for an absent feature" argument. The feature is no longer absent,
and four glyph states that are not self-describing need their key on screen. The route
key keeps the conditional mount — what *it* explains is genuinely absent on a quiet
layout.

---

## D10 — Texture marks a fault state, not an operational one

**Decision.** `occupied` is a **flat red wash**, drawn heavier than the others;
`clear` stays a flat green wash at the ordinary tint opacity; `unknown` keeps
its cross-hatch. The `diag-occupied` hatch, and the `<pattern>` that drew it,
are gone.

Implementation: `OCCUPANCY` and `OCCUPANCY_WASH_OPACITY`
(`packages/frontend/src/diagram/encoding.ts`), consumed by `TrackDiagram`'s
wash layer.

**Why the hatch went.** Operator feedback: *"the hashing stands out a bit too
much."* It does, and D2's own reasoning is why that matters. A hatch is the
loudest non-colour mark the diagram has, and `unknown` is meant to be the most
visually assertive of the three states because it is the one that refuses
routes. Spending a hatch on `occupied` — the state a working railway sits in
most of the time — put the busiest texture on the ordinary case and left the
fail-safe state shouting over it. The rule that replaces it: **texture
separates a fault from an operational state, never one operational state from
another.** `unknown` is the only hatch on the diagram, and #71's decorative
track and #82's staleness will be measured against the same line.

**What the hatch was carrying, and what carries it now.** #81's rule is not
rhetorical for this pair. Composited over the `#1e1e2e` tile at the same
opacity, `#f38ba8` and `#a6e3a1` land 6.9 apart in RGB under simulated
deuteranopia — occupied and clear become *the same colour* for roughly 8% of
men, which is exactly the failure the whole document exists to prevent. So the
flat wash carries its own non-colour distinction: **occupied is washed at
0.55, clear and unknown at `BLOCK_TINT_OPACITY` (0.26)**. That is a 1.57:1
luminance step, and it takes the deuteranope separation to 34.8 and the
protanope to 22.3. With colour removed entirely, occupied is the *heavier*
block — which is the right direction, since it is also the one carrying a
train.

The run label's `OCCUPANCY[…].glyph` (`■ □ ?`) is unchanged and still says the
state in a mark that is not a colour at all, as does the legend on the status
strip. Weight is the second carrier, not the only one.

**Why not a deeper, more saturated red.** Tried and rejected: `#e64553` and
`#ff6b6b` both read as more emphatically red to normal vision and *worse* to
everyone else — `#ff6b6b` at 0.55 falls to 6.7 under protanopia, essentially
identical to clear. Red is intrinsically dark in luminance and green
intrinsically light, so the only way a red wash outweighs a green one is to be
a light red. `#f38ba8` was already the state palette's red (`FAULT`,
`SENSOR_OBSERVATION.occupied`), and keeping it means no new colour enters the
system.

**What this does not change.** Occupancy remains a fill and a lock remains a
line (D2). The four block tints are untouched (D4) — this changes the opacity
of a *state* wash, and identity still gives up the colour channel wherever
state is drawn (D1). The sensor observation mark keeps `OCCUPANCY.occupied`'s
hue at its own scale (D8); it is a 7px circle, never an area, so wash opacity
does not reach it.

---

## Still open, deliberately

- **Signal aspects (#79)** are the hard case, and this document does not settle
  them. Real signal aspects *are* colours, and a mimic that recolours them is
  lying about the railway. The likely answer — draw the prototypical aspect
  colour, carry the machine-readable state in the head's position/shape plus a
  label — is recorded in #81 and should be decided when #79 is actually built.
  Nothing here forecloses it.
- **Decorative track (#71)** must be obviously not-monitored without relying on
  being "a greyer colour". It gets a texture when #71 lands; the closed metadata
  schema (#70 D3) is where its classification will live.
- **Connection health and staleness (#82)** is a diagram-wide state, not a
  per-object one, and needs its own treatment.
