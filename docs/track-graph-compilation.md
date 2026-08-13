# Compiling the track graph from the drawing

**Status: accepted 2026-08-13. Part built.**

| Decision | State |
|---|---|
| D4, D5 — length on blocks, joints zero | **shipped** (#105) |
| D6, D7 — partial graph, completeness contract | **shipped**, and now gating: a gap refuses `auto` **and `hybrid`**, and drops an automatic mode to `manual` when the graph changes underneath it. Staleness warns and never gates |
| D8 — disposable end labels | **shipped** in `compileOpenings`; `block_ends` still exists alongside |
| D9 — a compile cannot Safe-Stop | **shipped**: refuse-then-write in `replaceGraph`, asserted at unit, integration and scenario level |
| D10 — fingerprint | **shipped**: `compiled_graphs`, `GET .../topology/compile`, and the apply's mismatch 409 |
| D3 — the compiler owns the edge set | **shipped** as a mechanism: `replaceGraph` is a whole-set replace. The manual write path still exists and is deleted in PR 5 |
| D1 — compile under operator review | **partly**: the compile, the diff and the apply exist; the review UI does not, so the diff is read over HTTP rather than looked at |
| D2 — `block_ends` deleted | **not started** |

This document records a design decision, not shipped behaviour. Everything it
describes supersedes parts of #72 (block ends) and #78 (edge proposals), both of
which *are* shipped and are still described accurately by `docs/topology.md`.
Read this before extending either of them — building further on the model it
replaces is the specific waste it exists to prevent.

Tracking issue: **#103**.

---

## The problem this replaces

The system describes one railway twice, by hand: the **drawing** (`grid_tiles`)
and the **track graph** (`block_edges`). Everything between them —
`gridGeometry`'s opening derivation, `BlockEndService`'s generation and pinning
and adoption, `edgeProposals`' walk, the grid diagnostics reconciler, plus the
duplicated `findBlockRuns` and `TILE_LEGS` — exists to keep those two
descriptions in agreement. Forever. There is no end state in which that
machinery is finished.

Underneath that sits a sharper fault. **`block_ends.label` does two
incompatible jobs at once:**

- it is the **join key** — `block_edges.fromEnd`/`toEnd` are free text matched by
  string equality, so the label *is* the identity of an opening as far as the
  track graph is concerned;
- it is a **derived description** — generated from geometry, meant to track the
  drawing.

An identifier must be stable. A description must change when the thing it
describes changes. Every wart in this area is that collision surfacing:

| Symptom | What it actually is |
|---|---|
| "A block end called `north` can end up pointing east" | the description lying, because the identifier froze it |
| A rename is a 409 | identity stability defeating description correctness |
| `pinned` | a per-row switch between "this is an identifier" and "this is a description" |
| Adoption on first `generate` | retrofitting identity onto rows that were descriptions |
| `end-label-collision` | the description cannot be computed — and because the label *is* identity, a real, drawn, trafficable opening becomes unreferenceable. **Naming failed, so routing failed.** |
| `end-not-on-diagram` | a row doing the identifier job with nothing behind it |

The last two are the serious ones. They are the reason `Engine / Goods
Transfer`'s two south-east openings cannot be connected to anything, and no
amount of better naming fixes them, because naming was never the problem.

---

## D1 — The drawing compiles to the track graph, under operator review

`block_edges` stops being hand-authored. A **compile** reads the drawing, emits
a candidate graph, and presents a diff; the operator reviews and applies it.

**Why this is safer, not merely cheaper.** Transcription puts the human in the
loop at the point they are worst at — typing a slug into a field where a typo
produces a valid-looking edge naming an end that does not exist, which the
pathfinder will then plan on. A compile diff puts them in the loop at the point
they are best at: comparing a picture to a list. The drawing is a visual
artefact, and its correctness is checkable by eye in a way a table of UUID pairs
is not.

**What does not change.** `domain/` still imports nothing from adapters and
still never reads a tile. The compiler reads tiles; the operator approves; the
domain plans on the approved graph. The import boundary and the Safe-Stop story
are untouched — see D9.

**The invariant that weakens, honestly stated.** Today, "every edge was typed by
a human" is trivially auditable. It becomes "one process writes `block_edges`,
only when an operator presses a button, having reviewed the diff, and only if
the whole graph validates". That is weaker, and it is the same class of
operation as `Ends ⟳`, which already bulk-writes `block_ends` today.

## D2 — The edge is the durable object; an opening is compiler output

`block_ends` is **deleted**.

The compiler walks tile ports, so it knows structurally which opening is which
at the moment it emits an edge. It does not need a table to remember them
between runs, because nothing an operator owns is attached to one (D4, D5).

Every consumer of an end label in the backend, checked:

| Site | What it does |
|---|---|
| `pathfinding.ts:141` | `if (entryEnd !== null && edge.fromEnd === entryEnd) continue` — the no-reversal rule |
| `graph.ts:129` | the same rule in `neighboursOf` |
| `routeLocking.ts:277-288` | copies `fromEnd`/`toEnd` into `RoutePathStep` |
| `route_reservations.path` | a JSON blob of those steps, "trusted as-is" |
| `naming.ts` | display |

The load-bearing use needs **string equality and nothing else**. It never parses
a label, never compares bearings, never asks which way `east` points. Identity
and name were only ever the same string by accident.

## D3 — The compiler owns the whole edge set

A recompile is a *replace*, not a merge. There are no hand-authored edges.

A mixed graph would reintroduce the two-representations problem at a different
seam: an authored edge that nothing ever checks against the picture, forever.
Confirmed against the railway rather than assumed — Westgate Hollow's diagram
represents all trackwork, because automated control requires it to, and the
fiddle yards are off-*scene* rather than off-diagram.

If the drawing cannot express a connection you need, that is a gap in what the
drawing can express, and the fix belongs there.

## D4 — Length belongs to blocks, not edges — **shipped**

`docs/braking.md` B4 currently states: *"Blocks themselves carry no length; edges
carry all distance, so there is no double-counting."* That was forced by there
being nowhere else to put it, and **it does not decompose.**

A train going from block *c* to block *t* covers:

```
J(c,c+1) + L(c+1) + J(c+1,c+2) + L(c+2) + … + L(t-1) + J(t-1,t)
```

`t-c` joints, `t-c-1` block lengths, summed over `t-c` edges. For that to close,
every edge would have to be *joint + destination block* — **except the last**,
which must be joint only, because B4's target is the *entry boundary* of step
`t`. An edge cannot know whether it is the last one. Under the natural reading
the sum overshoots by the destination block's own length, and overshooting is
the direction that causes an overrun. Filed as **#105**.

So: **`lengthMm` moves to `blocks`.** Two consequences beyond correctness.

**It dissolves the hardest problem in this design.** A block is an authored row
the compiler never touches; block ids are stable UUIDs surviving any amount of
redrawing. There is no "carry operator-owned data across a recompile" problem,
because the only operator-owned datum does not live on a compiled object.

**The failure asymmetry inverts usefully.** A missing *block* length must refuse
the braked run (`unmeasured-track`), exactly as B4 says today. A missing *joint*
length can be treated as zero, which underestimates available distance, which
brakes early — the safe direction.

Measurement cost drops from ~40 edges to 10 blocks on Westgate Hollow, with no
redundancy and no way for two edges to disagree about the same block.

**As shipped.** `blocks.length_mm` added and `block_edges.length_mm` dropped in
migration `0008`. `TrackGraph.blockLengthsMm` carries the measured blocks to
both consumers, and an absent key is the only spelling of "unmeasured" — the
pathfinder costs it `DEFAULT_BLOCK_LENGTH_MM`, the braking model refuses
`unmeasured-track` naming the block. Two things went differently from the plan
and are recorded where they bite: the new column has **no CHECK constraint**
(DD9's reasoning — `blocks` is the most-FK-referenced table and a CHECK forces a
rebuild; `docs/braking.md` B9), and a braked run to the immediately next block
now yields zero distance and is refused (`docs/braking.md` B4).

## D5 — Joints carry no length — **shipped**

The undetected trackwork between two detected sections is treated as zero.
Nothing an operator owns lives on an edge.

Not because the physics says zero, but because on this railway the error is
small and always in the safe direction, and it buys a clean invariant worth more
than a few centimetres of braking accuracy. A nullable `jointLengthMm`
defaulting to zero is additive and can be introduced later without redesigning
anything.

**Recorded honestly: this is "conservative until the real layout says
otherwise", not "correct".** The braking model as a whole is expected to need
revision once it runs against physical track (#6).

## D6 — A partial graph is legitimate; gaps gate automation

The compiler emits what it is confident about and records the rest as **gaps**.
It does not refuse wholesale, and it never emits an edge it is unsure of — an
uncertain edge in the graph is precisely what this design exists to prevent, so
uncertainty lives outside the graph rather than inside it wearing a badge.

A graph with known holes is fine for manual operation and is how a layout is
actually built up, one corner at a time. It must refuse `SystemMode: auto`.

Note the inversion this creates against the grid diagnostics, and that it is
deliberate: **diagnostics are advisory and can never gate anything, because a
tile decides nothing. A compile gap is a statement about the graph the domain
plans on, and can legitimately gate.** They are different objects.

`end-label-collision` disappears into this. Two openings the walk cannot resolve
are a plain compile gap — same information, no phantom rows, nothing to name.

## D7 — The completeness contract is stated over the graph, not the walk

The compiler asserts, over its own output:

- every drawn block appears in at least one edge;
- every opening the geometry found produced an edge, or is terminated by a
  buffer, or is a named gap;
- the graph has one connected component, or its components are named;
- **every block in the graph has in-service detection** — see D9 for why this
  one is load-bearing rather than tidy.

A dead-end siding satisfies all of these: the assertion is *at least one edge*,
not *at least two*.

**Why graph-level assertions are primary and per-cell notes are supporting
evidence.** #78's notes are local — they say where a walk stopped. That is
necessary and not sufficient. A walk can stop somewhere harmless, and a walk can
succeed everywhere while a block still ends up isolated. When P1's tile was
tinted `Fiddle Yard 1`, the walk emitted three cell-level notes and *no*
statement that Fiddle Yard 2, Engine Shed 1 and Siding 3 had become unreachable.
(That particular cause is fixed — #104 — but the *shape* of the failure is what
this clause is against, and fixing one cause does not retire it.)
"No road into block at (11,3), south side" reads as wave-2 authoring noise;
"Fiddle Yard 2 has no connections" does not.

This is the third instance in this design of a local check standing in for a
global property, after the label-as-join-key and the bearing collision. The
pattern is what the design is built against, not any one instance.

## D8 — An end label is disposable compiler output

`block_edges.fromEnd`/`toEnd` stay **human-readable 8-point cardinals**, matching
`TileEdge`'s vocabulary. What changes is everything around them:

- nothing references them — `block_ends` is gone, and the compiler emits both
  sides of an edge in one pass, controlling both strings;
- nobody edits them — they are regenerated wholesale on every compile;
- **so the compiler may guess freely.**

That last point is the whole resolution. The bearing generator's refusal to name
two colliding openings existed solely because a guessed identifier could be
typed wrong into an edge later. There is no later. `southeast-1` /
`southeast-2` is a perfectly good pair when the only cost of being slightly
wrong is cosmetic.

The generator gets *less* clever, not more. No 16-point scale — that would break
the correspondence with `TileEdge`, which is the drawing's own vocabulary. No
anchor coordinates. No `pinned`.

`docs/naming.md` is satisfied for free: log lines read `Siding 2 : west` with no
NameBook lookup, and `RoutePathStep.entryEnd` stays a readable string.

**Accepted consequence.** A compile renames things — redraw a corner and `east`
may become `east-1`. Nothing can be holding a stale string when it happens,
because `TopologyService` already refuses a topology write against anything an
active or suspended route holds, and a whole-graph replace touches everything.
Historical log lines from before a redraw may not match current names, which is
honest: the railway changed.

## D9 — "A tile decides nothing" survives, with two additions

The Trap holds. At runtime the domain still never reads a tile; the compiler
reads tiles and the operator approves the output. `parseTileMetadata`'s
tolerance, tile writes as ordinary 400s, and diagnostics-as-advisory all stay.

**Two additions.**

**A compile must never be able to cause a Safe-Stop.** `reloadTopology()`
applies Safe-Stop on a fatal violation when loading edges. If a compile could
write rows and *then* have them rejected on reload, an authoring action would
halt the layout. The apply validates the entire proposed graph first and is
all-or-nothing: refuse the apply, never write-then-discover.

**An unreadable tile is a gap, not an empty one.** `parseTileMetadata` returning
`{}` makes a corrupt tile indistinguishable from an untagged one. Both block the
walk, so both fail safe — but one is a to-do and the other is corruption.
`tile-metadata-unreadable` must count as a compile gap and gate `auto`.

**What is deliberately not hardened: tile write validation.** It is already a
closed schema (#70). The risk is not malformed writes but well-formed drawings
that are semantically wrong.

### The unverifiable mapping, and why review is enough

`pointRoads` is unverifiable authored data (`docs/track-grid.md` D9). A backwards
mapping produces a valid compiled edge asserting `P1 = reverse` reaches Fiddle
Yard 2 when reverse physically reaches Fiddle Yard 1. No schema check and no
diff review catches it — a reviewer reads `Fiddle Yard 2 : east ← P1 = reverse`
and has no way to know.

The system catches it on **first movement**: the train arrives in the wrong
block, derived occupancy disagrees with the reservation, `unexpected-occupancy`
latches a route fault and Safe-Stops. Accepted as the verification strategy,
because it is a commissioning-time problem that is self-correcting — the first
failure identifies the mapping, it is fixed, and it stays fixed.

**That argument depends entirely on the wrong block being detected.** A
mis-mapped point sending a train into an undetected section produces no first
failure, just a train somewhere the system believes is empty. Which is why
`block-without-detection` is promoted from `info` to a hard clause of D7's
completeness contract rather than left as advice.

An explicit proving step — command each point condition, operator confirms the
blades visually, edge marked verified — was considered and rejected as
disproportionate for a layout of this size. Revisit if commissioning proves
painful.

## D10 — Compile is a transaction guarded by a drawing fingerprint

`GET .../compile` returns the proposed graph, its gaps, and a diff against what
is live. `POST .../compile/apply` validates and replaces. No draft table, no
version history.

Stored with the compiled graph is a **fingerprint of the drawing it came from** —
a hash over everything the walk reads (tile type, rotation, `blockId`,
`trackRole`, `pointId`, `pointRoads`) and nothing it does not. `apply` carries
the fingerprint that was reviewed and is refused if the drawing has moved.

One field, three properties:

- **A staged draft's real benefit without the table.** You cannot review one
  graph and apply another. Review-then-apply is exactly the
  time-of-check/time-of-use shape this design exists to eliminate.
- **Staleness.** Live fingerprint ≠ drawing fingerprint means the graph is
  behind the drawing — a first-class state, resolved by compiling and looking at
  the diff, which may well be empty. A **warning, not a gate**: gating `auto` on
  any drawing edit would stop you moving a platform tile.
- **Idempotence.** Same fingerprint, same output; re-apply is provably a no-op.

**Version history rejected.** The drawing is the source and the compile is
deterministic, so the previous graph is whatever the previous drawing produced.
The thing genuinely lacking history is `grid_tiles` — the Track Editor's undo is
per-session and explicitly not persisted (`docs/track-editor.md` D2). If undo on
a live layout is wanted, it belongs there, not on a derived artefact. Noted as a
separate question.

---

## What this deletes

- `block_ends`, and `BlockEndService` entirely
- generation, `pinned`, edge-label adoption, the rename/delete 409
- `end-label-collision` as a refusal, and the manual-override apparatus it
  demanded
- `end-not-on-diagram`, `pinned-end-not-on-diagram`, `end-unfinished`
- the edge-proposal *review* surface as a separate concept — it becomes the
  compile diff
- the Track Editor's `Ends ⟳` and `Ends ✎`, and `docs/track-editor.md` D12/D13
- the end-label datalist on the Edges tab (D13), along with the manual edge form
  it serves

## What we deliberately did not do

- **A 16-point bearing scale.** It happens to separate Westgate Hollow's two
  colliding openings (118.5° and 134.7°) and that is not a design argument. It
  also breaks the correspondence between end labels and `TileEdge`, which is the
  drawing's own eight-way vocabulary.
- **An anchor coordinate on `block_ends`** (#97). The right answer to a question
  that stops being asked.
- **Forbidding a block tint on a point tile.** Tempting, because tinting a point
  as a neighbouring block is what silently dropped half the graph — but P5 at
  (18,8) is a point *inside* the `Engine / Goods Transfer` run, and
  `findBlockRuns` only walks block-classified tiles, so making it decorative
  would split the block and invent openings. A point genuinely can be inside a
  block. The tint is not the problem; see #104.
- **Per-edge speed limits, gradients, direction restrictions.** Confirmed not
  wanted; `lengthMm` stays the only operator-owned per-edge datum, and D4 moves
  even that off the edge.

## Bugs this design surfaced, fixable independently

Both are now fixed, and neither depended on this design landing.

- **#104 — fixed.** `pointTransitConditions` treated arrival and departure as the
  same question. They are not: departing block X through a point tile of X
  requires the other leg to lead into X, but *arriving* at X's point tile means
  you are in X the moment you are on the tile. Tinting a point tile as a
  neighbouring block silently deleted edges. The fix splits the two tests and
  **stops `assemble` synthesising the reverse of a connection** — mirroring an
  arrival into a departure manufactures exactly the edge the departure test
  refuses. The compiler inherits both: it walks the same ports, and D3's
  whole-graph replace makes a mirrored false edge more dangerous, not less,
  since no per-row operator judgement stands between it and `block_edges`.
- **#105 — fixed.** `docs/braking.md` B4's edge-length convention did not
  decompose, and the natural reading overshot by the destination block's
  length. D4/D5 above are the fix, and shipped with it.
