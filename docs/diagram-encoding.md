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
the cross-hatch: obviously different from both a flat fill and a
single-direction hatch, even in greyscale. A state that halts the railway
should not look like a milder version of "clear".

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
