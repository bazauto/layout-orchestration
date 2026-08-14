# Track Topology — Decision Record

This document records the design decisions behind `block_edges` and the topology
validation/Safe-Stop machinery built on top of it (`src/domain/topology.ts`,
`src/domain/graph.ts`, `src/services/topologyLoader.ts`, `src/services/TopologyService.ts`).
It is not binding in the way `docs/mqtt-contract.md` is — there is no hardware on
the other end of it — but it explains *why* the schema and validation are shaped
the way they are, so the next change doesn't accidentally undo a deliberate
choice.

## The edge model

A `BlockEdge` is a directed connection from one named end of one block to a
named end of another block:

```
{ id, layoutId, fromBlockId, fromEnd, toBlockId, toEnd, pointConditions }
```

**No length.** An edge is the joint between two detected sections, and a joint
is treated as zero (D5, `docs/track-graph-compilation.md`). Distance lives on
`blocks.length_mm`, because the edge convention did not decompose and overshot
by the destination block — #105, and `docs/braking.md` B4 for the arithmetic.

A bidirectional physical connection between two blocks is represented as two
rows, one in each direction — edge direction is purely geometric and unrelated
to a loco's direction of travel.

### Block-end labels

`fromEnd`/`toEnd` are free-text labels ('north', 'yard-3', ...) naming a
physical opening of a block. They only need to be used consistently for a
given block. They are checked against `blockEndLabelSchema`:

```
/^[a-z0-9][a-z0-9_-]*$/, length 1–64
```

There is no longer a write schema to normalise operator input against it:
`edgeCreateSchema` and `edgeUpdateSchema` went with the manual edge routes
(#103 PR 5), and the compiler generates labels from `CARDINAL_END_LABELS`, which
satisfy the pattern by construction. A `block_edges` row that fails it (e.g.
`'North'`, un-normalised) is therefore DB corruption — see "Safe-Stop on invalid
topology" below.

Since #72 the labels are also **generated and stored** in a `block_ends` table
— see the next section. The contract above is unchanged: `fromEnd`/`toEnd` stay
free text, stay un-FK'd, and an end label with no other referent stays legal.

## Block ends: derived by default, authored by exception (#72)

> **Superseded in design; the code is most of the way there.** This section
> describes `block_ends`, which still exists and still works. It is replaced by
> `docs/track-graph-compilation.md` (accepted 2026-08-13, tracking issue
> **#103**), which deletes it entirely: the drawing compiles to `block_edges`
> under operator review, and an end label becomes disposable compiler output that
> nothing references and nobody edits.
>
> **Shipped:** D4/D5 (length on blocks), the compiler, both read surfaces, the
> apply, the `auto` gate, and — since PR 5 — the review UI, the deletion of the
> edge-proposal surface, and the deletion of the manual edge write path. The
> compiler is now the **only** writer of `block_edges`. Still to come: PR 6.2/6.3
> and PR 7, which delete `block_ends` itself and everything below.
>
> The root fault it fixes: **`block_ends.label` is simultaneously the join key
> `block_edges` references and a geometry-derived description.** An identifier
> must be stable and a description must not be; `pinned`, the rename 409,
> adoption, and the collision refusal below are all that conflict surfacing.
>
> Read the new document before extending anything here.

### The problem

Authoring an edge meant looking at the drawing, deciding that the left-hand end
of Fiddle Yard 1 was the one you previously called `north`, and typing it
correctly — every time, for every edge, with **no feedback if you got it
wrong**. Nothing on the track diagram showed which end of a block was which.

A transposed pair produces a valid-looking edge that connects the wrong ends,
and the pathfinder plans through it happily: `(block, end entered by)` is its
search state (`domain/pathfinding.ts`) and it has no independent notion of
geometry. This is a plausible contributor to the Westgate Hollow edge set being
mostly unauthored — the task was tedious *and* unverifiable.

### The decision

**Generate end labels from the drawn geometry as 8-point cardinal directions,
with north at the top of the diagram, and let a manual override stick.**

- **Vocabulary**: `north`, `northeast`, `east`, `southeast`, `south`,
  `southwest`, `west`, `northwest` (`CARDINAL_END_LABELS`). All satisfy
  `blockEndLabelSchema`, so no contract change was needed.
- **Generated vs pinned**: `block_ends.pinned` records that a label was
  authored. Regeneration replaces unpinned rows and never touches pinned ones.
- **Existing labels are pinned on adoption.** Any label already referenced by a
  `block_edges` row is pinned the first time `generate` runs. This is why the
  feature needed **no migration and no rename machinery**: Westgate Hollow's
  authored edges protect their own labels.
- **Collisions are refused, not suffixed.** Two openings of one block that face
  the same way from different places produce a reported collision and no label
  at all. A silently suffixed `east_2` is exactly the kind of name that gets
  typed wrong later in an edge.
- **Regeneration is on demand**, never on a grid write. Redrawing a corner of
  the layout must not silently rename ends underneath the edges referencing
  them.

### Why a table, and not tile metadata

Deliberately the **opposite** call to #71's tile classification and #74's
annotations, which both landed in `grid_tiles.metadata` in the same wave. The
distinction is the point:

- A tile's classification and an entity's diagram placement are properties of
  **the drawing**.
- A block end is a property of **the block**. It is referenced as free text by
  `block_edges`, it is the anchor #79 attaches signals to and #84 resolves
  buffers against, and it survives the drawing being re-laid. Burying it in a
  tile blob would make the one thing edges depend on the least durable record
  in the system.

### No foreign key from `block_edges`, deliberately

`fromEnd`/`toEnd` are **not** FK'd to `block_ends` and must not become so:

- the existing model deliberately tolerates an end label with no other referent;
- a malformed label is DB corruption handled by the Safe-Stop path, not by
  referential integrity — an FK would change that failure mode to "write
  refused", a regression against #10;
- the adoption pass would become a chicken-and-egg problem against its own
  constraint.

`tests/integration/migrations.test.ts` asserts the absence of that FK directly.

### A rename is a track-graph change, and is refused

An end label is the **only** link between an edge and a block end, so renaming
one silently re-points every edge referencing it. `BlockEndService` therefore
answers **409** to a rename or delete of a label any edge uses, rather than
cascading. The operator edits the edges, or keeps the name.

The **Track Editor** used to be where all of this was reached, through `Ends ✎`.
That panel is gone (#103 PR 6.2) along with `Ends ⟳`, so `BlockEndService`'s
create, rename and delete are still routed and still refuse correctly, but
nothing in the browser calls them. The 409 above is now unreachable in practice
and dies with the table in PR 7.

The interaction reasoning that panel established outlived it and is recorded in
`docs/track-editor.md` D12: a list of ordinary controls rather than a click on a
label drawn on a `role="application"` canvas, and one shared `jumpToCell`.

### Known limit: an end the generator refused to name cannot be placed

Two openings of one block facing the same bearing are an `end-label-collision`:
the generator names neither, because a silently suffixed `east_2` is exactly the
kind of label that gets typed wrong later in an edge (#72). The stated
resolution is that the author names it by hand — and that half works.

A hand-created end **authors edges perfectly well**; `block_edges` needs a label
and nothing else. What it does not get is *geometry*. `generateBlockEnds` drops
both colliding clusters from `openings`, so nothing ever matches the new row
back to a cell: it lists as "not placed", reports as `pinned-end-not-on-diagram`,
and becomes the warning `end-not-on-diagram` as soon as an edge references it.
The walk also starts nothing from either opening, so that block gets no
compiled edge through those ends.

Westgate Hollow has exactly one today (`Engine / Goods Transfer`, two openings
both bearing south-east from the run centroid at 118.5° and 134.7°).

An anchor coordinate on `block_ends` — a pinned end naming a *specific opening*
rather than a bearing — was the obvious fix and was **rejected** (#97). So was
falling back to a 16-point bearing, which happens to separate those two angles
and is therefore a coincidence rather than an argument; it also breaks the
correspondence between an end label and `TileEdge`, the drawing's own eight-way
vocabulary.

Both are answers to a question that stops being asked. Under
`docs/track-graph-compilation.md` the label is disposable compiler output that
nothing references, so the generator may disambiguate freely
(`southeast-1`/`southeast-2`) and a collision becomes an ordinary compile gap.
The refusal exists *only* because a guessed identifier could be typed wrong into
an edge later, and there is no later once edges are compiled.

### Known property: a cardinal label describes the diagram, not the railway

The drawing is explicitly not to scale and its orientation is a drawing
convention (see `docs/track-grid.md`). If the diagram is re-laid or rotated, a
*generated* label regenerates to match — but a *pinned* one does not, and
neither do the `block_edges` rows referencing either.

That is the correct behaviour: an end label is a name, and once edges reference
it its meaning is frozen. But it means **a block end called `north` can end up
pointing east on the drawing.** Recorded here so nobody later "fixes" it and
rewrites the track graph as a side effect.

### An opening is drawn connectivity, not cell adjacency (#91)

**A block opens where its drawn track leaves the run** — through a tile edge the
drawing actually touches, given the tile's type and rotation. Not where a
neighbouring cell happens to belong to something else.

The distinction is the whole of #91, and the shape that exposed it is the most
ordinary one a model railway has. Two parallel roads of a yard, drawn on
adjacent rows, touch along their entire length and connect nowhere. Under the
old adjacency rule every tile of both read as an opening toward the other; they
all faced the same way and were all mutually adjacent, so the clustering fused
them into a single phantom end at the *middle* of the siding, and the two real
ends — the buffer and the throat — produced nothing at all. Seven of Westgate
Hollow's nine blocks were wrong, and the two that were right were the only two
with nothing drawn alongside them.

Connectivity is **mutual**: a tile joins its neighbour only when the neighbour's
own drawn edges include the opposite edge. Track drawn up to a boundary that
nothing meets is therefore an end, not a join — it looks continuous, so
`GET .../grid/diagnostics` reports it as `track-not-joined` rather than leaving
an unexplained end in the middle of a run.

**A buffer contributes one terminus, on its closed side**, plus a connection if
its stub joins another run. It never yields an open-air opening: the tile asserts
track ends here, so it cannot also have track leaving both ways.

**An end is a finished dead end only if *every* opening making it up is
terminated.** Aggregating with `some()` was the mechanism by which one buffer
tile marked a whole fused siding as finished — which suppressed `end-unfinished`
on a layout with zero authored edges, hiding the fact that nothing was connected
to anything. It stays wrong for a real shape: a handover face with one buffered
cell and one continuing into another block is unfinished until that edge exists.

**A throat may yield one end or two**, depending on how the bearings of its
outward legs round. Both are legitimate — `(from_block_id, from_end)` is
deliberately not unique (below), so one end may carry several edges. Do not add
a merge rule: over-merging is two openings quietly sharing one name, which is
exactly what the collision refusal above exists to prevent, and it is worse than
two names for one place.

**Where two openings of one block genuinely collide**, the generator still
refuses to name either. On Westgate Hollow the Engine / Goods Transfer opens
toward Engine Shed 2 at (18,8) and Goods Shed at (19,10), and both bear
`southeast` from the run centroid; no bearing scheme can separate them, because
the only distinguishing fact is which block is on the other side. The operator
resolves it by hand-creating two pinned ends. Such an end has no geometry to sit
on and does not draw on the diagram — #97 is the anchor coordinate that would
fix that.

### What the walk derives, and what it refuses to guess (#78, #91, #104)

> The `GET .../grid/edge-proposals` surface and the per-row accept panel that
> read it are **deleted** (#103 PR 5). The walk they were built on is not: it
> moved to `services/trackGraphCompiler.ts#compileConnections` (D-A) and is what
> the compiler runs. Everything below is a property of that walk, and survives
> the surface that first exposed it.

**The walk is over tile ports, not cells**, which is why it could only be built
after #91. Two yard roads drawn on adjacent rows touch along their whole length,
so a cell-based walk would connect every pair of parallel sidings on the layout.

**Point conditions come from the drawn `pointRoads`, at both ends of the walk.**
A throat tile is tagged to the block it serves, so a block's opening frequently
sits *on* a point — and crossing it costs whatever the road using that leg
requires. In every case a road only counts if it **uses the leg the walk is
crossing by**: without that test a point reads as "any leg reaches any other",
and Westgate Hollow produced `Fiddle Yard 1 ↔ Fiddle Yard 2`, a connection P1
cannot make since both yards hang off its diverging legs and meet only at the
toe.

**Leaving a block and arriving at one are not the same question (#104).** Beyond
using the leg, a *departure* additionally requires the road's other leg to lead
back **into the block**, because a train reaching that boundary came from the
block's interior. An *arrival* requires nothing further: a tile tinted
`Fiddle Yard 1` is part of Fiddle Yard 1, so a train that has reached it has
arrived, whatever the road's other leg does.

Treating the two as one test is what made a point tinted as a neighbouring block
delete edges — the live layout lost Fiddle Yard 2, Engine Shed 1 and Siding 3
entirely, with only cell-level notes to show for it.

**Neither direction is mirrored into the other.** Both come out of the walk, from
each block's own opening. Ordinary track is symmetric and yields the pair for
free; where it does not, the asymmetry is real and synthesising the missing half
authors an edge the drawing refuses. Mirroring the Fiddle Yard 2 → Fiddle Yard 1
arrival above produces a `Fiddle Yard 1 → Fiddle Yard 2` departure that trails
through P1's blades set against it. **A one-way connection is therefore a
statement, not a gap in the search**, and the gap beside it says which direction
is missing and why.

This matters more now than it did under #78. There, a bad row sat in a review
list with an operator's eye on it and an Accept button they could decline. Since
#103 PR 5 the compiler owns the whole edge set, so nothing stands between a
mirrored false edge and the graph the pathfinder plans on but the diff.

**It under-derives, audibly.** An unclassified tile, a point with no leg mapping
at all (`blocked-by-unmapped-point`), a drawn leg the mapping does not cover
(`leg-not-covered-by-road`), and a block with no road out through a boundary
(`no-road-out-of-block`) each stop the walk and leave a gap naming the cell. A
missing connection costs a minute of drawing; a wrong one is a route granted over
track that is not there. Silence and refusal are indistinguishable from outside,
so those gaps are the whole difference between a to-do list and a mystery.

**What it cannot check.** A point's leg mapping is unverifiable authored data
(`docs/track-grid.md` D9), and a compiled edge inherits that uncertainty exactly.
Compiling does not make point wiring checkable; it makes the drawing and the
graph the same thing instead of two different things.

### Geometry can derive connectivity; it can never supply length

`services/gridGeometry.ts` derives openings from drawn connectivity. It does
not, and must not, derive distance. Tile count bears no relation to physical
extent — the Westgate Hollow entry feeder is drawn long, is short in reality,
and is not a block at all.

This is now stronger than it was: length is not a field on the edge for a
compile to leave blank, it is on `blocks.length_mm`, which the drawing never
touches (D4/#105). The compiler owns the whole of `block_edges` and still cannot
touch the one operator-owned measurement on the railway, because it sits on an
authored row no walk writes. `NULL` still means unmeasured and still refuses a
braked run (`docs/braking.md` B4).

## Compiling the graph from the drawing (#103)

**Part built.** The design record is `docs/track-graph-compilation.md` (D1–D10)
and nothing here re-litigates it. What follows is what exists in the code.

Shipped so far: the compiler and its completeness assertions
(`services/trackGraphCompiler.ts`), the openings generator
(`gridGeometry.ts#compileOpenings`), the `compiled_graphs` provenance row, the
three surfaces below, the `auto` gate on gaps, and **the review UI**.

Since PR 5 the compiler is the **only** writer of `block_edges`:
`POST`/`PUT`/`DELETE .../edges` are gone, `TopologyService.createEdge` /
`updateEdge` / `deleteEdge` are gone, and so is `GET .../grid/edge-proposals`
with the panel that read it. `GET .../edges` stays, and the Edges tab still
lists what it returns. `block_ends` is still live and is deleted in PR 7.

### The three surfaces

| Route | Answers | Cost |
|---|---|---|
| `GET /api/layouts/:layoutId/grid/openings` | where each block opens, named | geometry only, no walk |
| `GET /api/layouts/:layoutId/topology/compile` | the whole candidate graph, its gaps, and a diff against the live one | full branch search |
| `POST /api/layouts/:layoutId/topology/compile/apply` | writes it, if the drawing still matches | full branch search + one transaction |

The two reads are separate because they answer different questions at different
prices (D-H). "Where does this block open" is a question about the drawing and
the Track Editor asks it on every stroke, the way it already asks for grid
diagnostics; "what edges does that imply" is a review action taken when the
panel is opened. Neither read is admin-gated, matching `grid/diagnostics`: the
**write** is what is gated, and an operator being able to see why the layout will
not go into `auto` is the point of the surface.

A layout that does not exist is a 404 on all three. A drawing that compiles to
more edges than the review surface will render is a 409 carrying
`{ limit, found }`, matching the shape `EdgeLimitExceededError` uses on the
apply — never a bare 500, because "no connections found" and "I gave up" must
not look the same from outside. **Nothing here can Safe-Stop**, however many gaps it
reports and whichever way the apply goes (D9).

### What the compiler asserts, and why over its own output

The walk emits per-cell notes saying where it stopped. Those are supporting
evidence and were never sufficient: a walk can stop somewhere harmless, and a
walk can succeed everywhere while a block still ends up isolated. So the
compiler asserts over the graph it emitted — every drawn block appears in at
least one edge; every opening is edged, terminated by a buffer, or a named gap;
every block in the graph has in-service detection — and those assertions are the
primary findings (D7).

`block-without-detection` is load-bearing rather than tidy. The reason a
mis-mapped point mapping is acceptable unverified data is that the first
movement over it puts a train in the wrong block, which `unexpected-occupancy`
catches. That argument collapses if the wrong block is undetected (D9).

Connected components are **reported and never gated** (D-B): two genuinely
separate railways in one layout are legal, and a gap has no acknowledge
mechanism, so gating on component count would refuse `auto` forever with nothing
for the operator to acknowledge.

### The fingerprint

`compiled_graphs` holds one row per layout — `layout_id`, `drawing_fingerprint`,
`compiled_at` — and a **missing row is the honest spelling of "never compiled"**,
not a NULL every reader must remember to check. No `edge_count`, no `gap_count`:
both are recomputable, and a stored copy is a second source of truth about
exactly the thing #103 exists to stop having two of.

`drawingFingerprint()` hashes exactly what the walk reads and nothing else:
coordinates, tile type, rotation, `blockId`, `trackRole`, `pointId` and
`pointRoads`. Coordinates are in although D10's prose omits them — the walk is
structured entirely by position (D-G). `annotations` are **out**: moving a
sensor marker must not invalidate a review someone is part-way through. An
unreadable tile contributes its raw blob, so repairing corruption moves the
fingerprint like any other edit and two different corruptions do not hash alike.

Staleness — a stored fingerprint that differs from the drawing's, or no stored
row at all — is a **warning, never a gate**. Gating on it would stop an operator
moving a platform tile.

### Applying: `POST .../topology/compile/apply`

Admin-only, and the only thing in the system that writes a compiled graph. The
body carries a **fingerprint and nothing else** — never rows. An apply that
accepted edges would be a second authoring path wearing the compiler's name,
which is precisely the bypass D1 and D3 exist to make impossible; the schema is
`.strict()`, so a body that tries is a 400.

The service recompiles the drawing as it stands, refuses if the result differs
from the fingerprint that was reviewed, and hands the edges to
`TopologyService.replaceGraph`. What the operator approves is *that drawing*,
and the fingerprint is how they say so.

**The order is load-bearing: refuse first, write second, never
write-then-discover.** `reloadTopology()` applies Safe-Stop when it loads a
graph with a fatal violation, so an apply that could write rows and *then* have
them rejected on reload would turn an authoring action into a halted railway.
Every refusal therefore precedes `replaceBlockEdges`, in this order:

1. **any route holding anything in this layout** → `LockedByRouteError`. Not a
   per-edge guard (D-E): every row is about to be deleted and rewritten with
   regenerated labels, so "is *this* edge held" has no answer worth acting on —
   the row may not survive and the label a live route recorded may not exist
   afterwards. This is what makes D8's accepted consequence safe. Cancel the
   route, then apply: an ordering requirement, not a deadlock.
2. **over `MAX_EDGES_PER_LAYOUT`** → `EdgeLimitExceededError`. Admission control
   on the whole candidate set, which is where it always belonged.
3. **`validateTopology` over the candidate graph**, with synthetic ids →
   `TopologyRejectedError`. The same full pass the load path runs, so a graph
   that passes here is one `reloadTopology` will accept.
4. `repo.replaceBlockEdges` — one transaction: old edges out, new edges in,
   fingerprint stamped. What validation cannot see is a DB constraint, and the
   rollback is the mechanism rather than a nicety: a half-written graph is a
   railway nobody authored and nobody reviewed.

| condition | status | body |
|---|---|---|
| success | 200 | `CompileView` (diff now empty, `stale` false) |
| bad body | 400 | `{ error, details }` |
| unknown layout | 404 | `{ error }` |
| fingerprint mismatch | 409 | `{ error, expected, actual }` |
| a route holds the layout | 409 | `{ error, routeId }` |
| over the cap | 409 | `{ error, limit, current }` |
| candidate graph invalid | 422 | `{ error, violations }` |

**A recompile is a replace, not a merge** (D3). On a deployment whose
`block_edges` is not empty, the first apply deletes every hand-authored edge the
compile does not reproduce. Westgate Hollow has none — verified, 0 rows — so
this is a statement about other deployments, and the diff review is the
protection. There is deliberately no merge mode.

**Gaps do not refuse an apply** (D6). A partial graph is legitimate and is how a
layout is actually built up, one corner at a time; it is `SystemMode: auto` that
a gap gates, not the compile. Refusing here would leave an operator holding an
empty graph with no way to make it less empty.

#### The unique-index conflict is caught by the pre-validation

A point tile carrying a `blockId` and reached through its toe emits one edge per
road — for a binary point, two rows differing only in `pointConditions`. Those
collide on `block_edges_connection_unq`, which excludes conditions.

This needs **no special case**: `validateTopology`'s `duplicate-connection`
check keys on exactly the same tuple as that index, so the collision surfaces as
a named 422 before anything is written, rather than as an opaque failure from
SQLite half way through a batch. Westgate Hollow does not draw this shape today,
but the design permits it (a point genuinely can sit inside a block), so it is
covered by a test rather than left to chance.

### Gaps gate automatic modes; staleness only warns

Two facts about the same graph, deliberately doing different jobs.

**A gap gates `SystemMode: auto` — and `hybrid`.** D6 names only `auto`, but
`canIssueAutoCommand` returns true for `hybrid` as well, so gating `auto` alone
would leave the automated-command path open through the side door.

The gate lives in `LayoutService.handleSetMode`, at the transition, **not** in
`canIssueAutoCommand`. That predicate is pure over two enums and runs on every
automated command; threading a gap count through it would ripple into every
caller and turn a per-layout async read into a hot path. A mode change is rare
and human-initiated, which is where the question is cheap to ask and where the
answer is useful — the operator learns when they ask for `auto`, not once a
train is moving.

The count is read live through `IGraphCompletenessView`, a one-method port
implemented by `CompileService` and injected the way `INameBook` is. **One
number crosses that boundary**, and that is the point: `LayoutService` has no
business reading a tile, and a cached count would be a second source of truth
about the very thing #103 exists to stop having two of.

`reloadTopology` applies the same rule in the other direction: if the layout is
already in an automatic mode and the graph it is now running on has gaps, the
mode drops to `manual` and auto-authority routes are **suspended, not
cancelled** — the same D7 consequence a manual mode change has, so the locks
stay held and the operator decides. This is not a Safe-Stop and not a fault
latch: nothing has gone wrong with the railway, the system simply no longer has
what it needs to drive it automatically, and D9 forbids a compile from being
able to halt anything.

The inert default gates nothing. An unwired `LayoutService` has been told
nothing about completeness, and refusing `auto` on that basis would be reporting
a limitation nobody stated. The real fail-safe is stronger and elsewhere: a
graph with holes cannot route a train through them, because the edges are not
there.

**Staleness only warns.** `GET .../topology` carries a `compiled` block
(`CompiledGraphStatus`), composed in the route rather than in `TopologyService`
— that service validates and writes `block_edges` and has no business reading a
tile, while staleness is a fact about two artefacts at once. The Edges tab
renders it in amber rather than the violation banner's red: a stale graph is a
to-do, and a to-do styled as an error teaches the operator to ignore both.

**Deliberately not on the MQTT `system/status` payload, nor the WebSocket
`SYSTEM_STATUS` event that mirrors it.** That payload is binding
(`docs/mqtt-contract.md`) and the ESP firmware is built against it. Staleness is
an authoring concern with no bearing on anything the firmware does; adding a
field there for a UI hint would be a contract change.

### The diff is matched in two passes

End labels are disposable compiler output regenerated on every compile (D8), so
a diff keyed on them reports a redraw that renames `east` to `east-1` as "every
edge removed, every edge added". That is useless for review, and review is the
whole of D1's safety argument. So (D-J, refined in the build):

1. **exact ends** — same `(fromBlockId, fromEnd, toBlockId, toEnd)`. Equal
   conditions is `unchanged`; different conditions is `changed`.
2. **the physical connection** — whatever is left, keyed on
   `(fromBlockId, toBlockId, conditionKey)` and paired in sorted-by-end order.
   A pair is `relabelled`.
3. anything unpaired is `added` or `removed`.

The plan originally described one pass on key (2) alone, which leaves `changed`
unreachable: point conditions are equal inside every such bucket by
construction. Pass 1 exists so the safety-relevant case — the same two openings,
now requiring different blades — is reported precisely instead of drowning in an
add and a remove. A row whose label *and* conditions both moved is genuinely
unlinked and falls to `added`/`removed`, which is honest: nothing connects them.

`conditionKey` is order-independent and shared with the compiler, so a reordered
`pointConditions` array cannot read as a changed edge in one place and an
identical one in another.

## Why `(from_block_id, from_end)` is NOT unique

A naive schema might make `(layout_id, from_block_id, from_end)` unique, on
the theory that "one physical opening, one edge". That's wrong for anything
with a point: a turnout, three-way point, or slip gives a single block-end
**several** outgoing edges — one per point setting — and the correct one is
selected at runtime by whichever edge's `pointConditions` are currently
satisfied (`isEdgeTraversable` in `domain/graph.ts`). A throat block's east
end might have two outgoing edges to two different platforms, discriminated
only by a point's position. Enforcing uniqueness on `(from_block_id,
from_end)` would make that layout un-representable.

What **is** unique is the full connection tuple:

```
uniqueIndex('block_edges_connection_unq')
  .on(layoutId, fromBlockId, fromEnd, toBlockId, toEnd)
```

Two edges may not describe the exact same physical connection twice — that's
data duplication, not a fan-out. `migrations/0002_bitter_jane_foster.sql` and
`tests/integration/migrations.test.ts` both assert this directly: two edges
from the same `(from_block_id, from_end)` to two *different* blocks both
succeed; the same tuple inserted twice fails.

The other two `block_edges` CHECK constraints are plainer data-integrity rules:
`from_block_id <> to_block_id` (no self-loop), and both ends must be non-blank
after trimming. Both survived the `0008` table rebuild that dropped
`length_mm`, and `tests/integration/migrations.test.ts` asserts they still bite
— a rebuild that silently loses a CHECK looks identical to one that did not.

## Violations: fatal vs non-fatal

`domain/topology.ts` defines six violation kinds. `isFatalViolation` treats
five as fatal and one as not:

| Kind | Fatal? | Why |
|---|---|---|
| `layout-mismatch` | Yes | An edge claiming a different `layoutId` than the one it was loaded under is corrupt data; nothing about it can be trusted. |
| `duplicate-edge-id` | Yes | Two edges sharing a primary key means the graph cannot be built (`Map` semantics would silently drop one). |
| `self-loop` | Yes | A block cannot connect to itself; downstream reachability logic assumes it can't. |
| `unknown-block` | Yes | An edge referencing a block that doesn't exist can't be placed in the graph at all. |
| `duplicate-connection` | Yes | Two edges describing the same physical connection is data duplication (see above) — ambiguous, must be fixed. |
| `unknown-point` | **No** | An edge referencing a point that no longer exists. |

`unknown-point` is the sole exception because of how point conditions already
fail closed. `unsatisfiedConditions` in `domain/graph.ts` treats a point that
is missing from the position map — which a deleted point always will be — as
unsatisfied. A dangling point reference therefore makes **that one edge**
permanently non-traversable; it does not corrupt the rest of the graph or
allow the domain layer to reach an unsafe conclusion about it. Refusing to
build the whole graph over one broken edge condition would be a stricter
Safe-Stop than the actual risk justifies, so the topology load path
(`services/topologyLoader.ts`) tolerates it and keeps the system online.

The normal way for this to happen is prevented at the door:
`TopologyService#deletePointIfUnreferenced` refuses to delete a point that
any edge's `pointConditions` still mention, naming the referencing edge ids.
The tolerance in `isFatalViolation` exists for defence in depth — data
predating that check, or written outside the API — not as the primary
guard rail.

Note the asymmetry with the *write* path: `TopologyService#replaceGraph`
rejects on **any** violation, including `unknown-point` — a compiled graph
carrying a dangling point reference is never written, even though the system
tolerates one it finds already sitting in the database. (It cannot arise from a
compile anyway: the walk reads `pointRoads` off tiles whose `pointId` the grid
write path resolved in this layout. The check is defence in depth against a
point deleted between the drawing and the apply.)

## Validation cost, the edge cap, and why the full pass stays

`domain/topology.ts` re-runs `validateTopology` over the *entire* edge list on
every load (`LayoutService.reloadTopology`, on startup and after every write)
rather than caching a verdict or revalidating incrementally. That was an
O(n^2) pass until #21, because `duplicate-connection` detection was an
`Array#find` scan per edge. Both halves of that — "full pass, every time" and
"O(n)" — are deliberate, not merely convenient, and worth recording so a
future change doesn't undo either by accident.

### Why a full pass, not incremental revalidation or a cache

Not every violation kind is local to the one edge that triggers it:

| Kind | Local to one edge? | Non-local effect |
|---|---|---|
| `layout-mismatch` | yes | none |
| `self-loop` | yes | none |
| `unknown-block` | no | a block delete invalidates other edges' verdicts |
| `unknown-point` | no | a point delete invalidates other edges' verdicts |
| `duplicate-connection` | **no** | inserting X makes both X *and* pre-existing Y violate; deleting one of a duplicate pair *heals* the other |
| `duplicate-edge-id` | no | set-level property |

Only two of six are genuinely local. `duplicate-connection` healing on delete
is the reason incremental revalidation with a cached verdict is rejected: an
operation that *removes* a violation (deleting one of a duplicate pair) would
have to invalidate a cached "layout is invalid" result — exactly the
direction an incremental scheme tends to get wrong. Getting it wrong
stale-invalid means a Safe-Stop that never clears; getting it wrong
stale-valid means running trains on a graph nobody has actually checked.
Either failure is worse than the cost of a full O(n) pass, so the pass stays
full and unconditional.

A cached *edge list* (as opposed to a cached verdict) is rejected for the same
underlying reason: it's a second source of truth about track geometry, and
its failure mode is a graph built from edges that no longer exist.

### The two-slot duplicate-connection index

`buildEdgeIndex` builds a `Map` from a `^@`-joined connection tuple
(`fromBlockId^@fromEnd^@toBlockId^@toEnd`) to the first and second edge ids
seen for that tuple. `^@` rather than `:` because block ids are UUIDs today
but `fromEnd`/`toEnd` are free text matching `/^[a-z0-9][a-z0-9_-]*$/` — a
separator that cannot appear in either field removes any ambiguity between,
say, `a` + `^@b` and `a^@` + `b`.

Two slots are enough. The pre-#21 check was `existingEdges.find(o => o.id !==
edge.id && sameTuple)` — the *first* edge in list order whose id isn't the one
being checked. If a bucket's first id isn't that edge's, that's the answer; if
it is, the second slot is; a third or later edge sharing the tuple was never
the answer under the old semantics either. So the two-slot index reproduces
`find`'s result exactly, including for three-or-more-way duplicates — proven
in `tests/unit/domain/topology.test.ts` and by construction in
`domain/topology.ts`'s comments, not just asserted.

`validateEdgeAgainstLayout`'s fourth parameter accepts either the raw edge
array or a prebuilt `EdgeIndex`, discriminated by `Array.isArray` (true for a
plain array and for a `Proxy` over one, so the complexity benchmark below can
wrap the array transparently). `validateTopology` builds the index once
before its loop, making the full pass O(n). Since #103 PR 5 the full pass is
the *only* caller in the write path — `replaceGraph` validates the whole
candidate set — so the single-edge shape, which paid one O(n) index build for
one O(n) check, no longer runs anywhere outside the exported function's own
tests.

### The edge cap: admission control, not an invariant

`domain/topology.ts` exports `MAX_EDGES_PER_LAYOUT = 2000`. It exists because
making the full pass O(n) doesn't bound `n`, and nothing else does: the graph
now arrives in one piece from a compile, and a drawing can be as large as
somebody has patience to paint. The
seeded Westgate Hollow layout is ~40 edges; a large club-scale layout (~200
blocks) is on the order of 1,200. 2,000 is roughly 50x that, chosen so the
*bounded* worst case stays defensible even if a future change reintroduces a
quadratic path somewhere: 2,000^2 comparisons is tens of milliseconds — bad,
but finite and detectable, not an indefinite event-loop stall.

The cap is enforced by `TopologyService.replaceGraph` only, against the whole
candidate set — which is where it always belonged, and where it moved when the
per-row create was deleted (#103 PR 5, OQ1). A cap on how much graph exists is a
statement about the graph, not about whichever row happened to arrive last.

There is a second, tighter cap upstream: `MAX_COMPILED_EDGES` (200) refuses to
*render* a diff nobody could review, which is a statement about the review, not
about storage. A drawing between the two compiles and applies fine; it just
cannot be reviewed through this surface, and D1's safety argument rests on the
diff being reviewable.

The layout cap is **not** enforced elsewhere:

- **Not the load path.** `loadTopology`/`reloadTopology` must still load a
  layout that somehow exceeds the cap — data written outside the API, or a
  cap lowered later — or the system Safe-Stops on a *policy* limit with no
  way for an operator to delete their way back under it. Deleting requires a
  loaded graph.
- **Not the database.** #11 put graph invariants at the DB level as well as
  the domain level, but the cap isn't an invariant — exceeding it is policy,
  not corruption. The only SQLite mechanism for a row-count cap is a trigger
  running `SELECT COUNT(*)` per insert, which makes every insert O(n) at the
  storage layer to defend against an O(n) cost at the domain layer, and it
  would need a hand-written migration against the "generate, don't
  hand-write" rule. Service-level only, deliberately — don't "complete" this
  with a DB constraint later.

A cap breach is a distinct `EdgeLimitExceededError` (`limit`/`current`), not a
fabricated `TopologyViolation` — the candidate edge may be perfectly valid,
it's the layout's edge count that refuses it. It maps to HTTP 409, not 422:
the payload is well-formed, it's the resource's state that refuses the write.

### Debouncing `onTopologyChanged` is rejected

`TopologyService` calls `onTopologyChanged` (→
`LayoutService.reloadTopology()`) after every successful write, synchronously
in the request path, with no coalescing. Three reasons this stays as-is:

1. Any debounce window is a window in which an invalid graph is treated as
   valid — the exact failure this validation exists to prevent.
2. `reloadTopology` is the defence-in-depth re-check after a write that
   already validated itself before persisting; delaying it delays the
   Safe-Stop that's the point of having it.
3. Once the pass is O(n) at a capped n, a reload costs microseconds (see
   below) — there's nothing expensive left to debounce.

### Measured ceiling

`tests/integration/topology-scale.test.ts` loads a layout at
`MAX_EDGES_PER_LAYOUT` (2,000 edges) end to end through `loadTopology` and
asserts it completes in well under 500ms; measured at time of writing, about
11ms on ordinary dev hardware. That's a catastrophic-regression smoke check,
not the complexity proof — `tests/unit/domain/topologyComplexity.test.ts`
is, via a deterministic proxy-counted operation count rather than wall-clock
timing, since a wall-clock ratio on CI is flaky and proves nothing about
complexity on its own.

## Safe-Stop on invalid topology

- **Trigger:** `LayoutService.reloadTopology()` calls `loadTopology`, which
  validates every edge with `validateTopology` and partitions the results
  with `isFatalViolation`. If any fatal violation remains, the graph is not
  built and `SystemHealth.topologyValid` is set to `false`. Check order in
  `evaluateSystemSafeStop` (`domain/safety.ts`) is MQTT → DCC → topology, so
  a connection failure reason always wins over a topology reason if both are
  present.
- **Reason string:** `describeViolations` produces
  `Topology invalid: N violation(s) [(first 3 shown)] — <first three,
  semicolon-separated>` — the `(first 3 shown)` suffix appears only when
  `N > 3` (#54; the old version silently dropped the rest). Each id in the
  violation list renders as `"Name" (shortid)` when a `NameBook` is
  supplied to `describeViolations` (as `LayoutService.reloadTopology` now
  does — see `docs/naming.md`) and degrades to the bare id, byte-for-byte,
  with no book. This is the same string that ends up on
  `SystemHealth.topologyReason`, the `SYSTEM_STATUS` event's `reason`
  field, and the retained `system/status.reason` MQTT field — no new topic
  or payload field was needed; `system/status.reason` is already
  documented in `docs/mqtt-contract.md` as free-text "human-readable
  reason for a safe-stop or offline status".
- **Recovery:** an operator (today: via `TopologyService`, once #2 lands: via
  the Configure UI) fixes the offending edge — typically by deleting it — and
  the write path's `onTopologyChanged` callback triggers
  `LayoutService.reloadTopology()` again. If topology is valid and
  connections are healthy, `evaluateAndApplySafeStop` clears Safe-Stop and the
  system returns to `online`.
- **Edge writes stay permitted while in Safe-Stop.** `TopologyService` does
  not check `LayoutService`'s current status before accepting a write — it
  can't recover otherwise. This mirrors `canIssueManualCommand`, which
  already permits manual commands during Safe-Stop "to allow operator
  recovery" (`domain/safety.ts`). What Safe-Stop halts is automated movement
  and new *route* reservations, not topology authoring.
- **The MQTT-reconnect latch.** Because `topologyValid` is folded into the
  same `SystemHealth` object as the connection flags, a connection recovering
  on its own (e.g. the MQTT broker reconnecting) cannot clear a Safe-Stop
  that topology caused — `evaluateSystemSafeStop` still finds
  `topologyValid: false` and keeps `shouldStop: true`. This is exercised
  directly in `tests/unit/services/layoutService.test.ts` (the "regression
  guard for #10").

## An id is not authority to delete

Every delete in `TopologyService` verifies the record belongs to the `layoutId`
in the request path before touching it. `deleteBlockWithEdges` and
`deletePointIfUnreferenced` both resolve the record first and throw
(`RecordNotFoundError` → 404) on a mismatch; `replaceGraph` is scoped to one
layout by construction, since it takes a layout and rewrites the whole of it. The
repository methods are scoped by `layoutId` in their `WHERE` clauses too, so a
mismatched layout deletes zero rows rather than another layout's records.

Two reasons this is stated rather than assumed:

- **Ids are enumerable by any logged-in user.** `GET /api/layouts` and
  `GET /api/layouts/:id/blocks` require an authenticated session (see
  `docs/auth.md`) but are not role-gated — an `operator` can read them the
  same as an `admin` — so any id in the system is discoverable by anyone who
  can log in at all. Deleting by id alone would let
  `DELETE /api/layouts/<anything>/blocks/<real-id>` destroy the owning
  layout's block — and, now that block deletes cascade to edges, its
  topology with it.
- **Ordering matters in `deletePointIfUnreferenced`.** The reference guard
  scans the *path* layout's edges. If ownership were checked after the guard, a
  point belonging to another layout would show no references there and the
  delete would be waved through, stranding the owning layout's edge conditions
  as `unknown-point`. Ownership is therefore checked **first**.

## Edge writes vs. route reservations (D10, #3)

This used to be a deferred note: `RouteId` and `lockedByRoute` existed in
`domain/types.ts` but nothing populated them, and `TopologyService` writes
were not gated by reservation state at all. Route locking (#3) closed it.
Full design record: `docs/route-locking.md` D10.

`TopologyService`'s constructor now takes a fourth argument,
`lockView: IRouteLockView`, implemented by `ReservationService` — the same
injection style as the existing `onTopologyChanged` callback, so
`TopologyService` stays testable standalone (a hand-rolled `IRouteLockView`
in tests, no real `ReservationService` needed).

- `deleteBlockWithEdges`: refused when the block itself, or any edge
  referencing it, is held.
- `deletePointIfUnreferenced`: refused when the point is held.
- `replaceGraph`: refused when **any** route holds **anything** in the layout —
  `findAnyHeldRoute`, not a per-target lookup, because every row is about to be
  deleted and every label regenerated (D-E).

`updateEdge` / `deleteEdge` were on this list and are gone with the manual write
path (#103 PR 5). `createEdge` was the one deliberate exemption — a new edge
moves no train — and that exemption has no subject any more: `replaceGraph` is
never purely additive.

Every one of those refusals is a **409 carrying `{ error, routeId }`** on the
wire. That is now true of the block and point deletes as well, which named the
error here and mapped it in neither route — the refusal reached Fastify's
default handler as a 500. See `docs/route-locking.md` D10.

The interaction with the "edge writes stay permitted during Safe-Stop"
rule above still holds, but a *suspended* reservation (not just `active`)
still blocks the write, since `IRouteLockView` reports both. The operator
cancels the route first, then edits — cancel is always available, so this
is an explicit ordering, not a deadlock.
