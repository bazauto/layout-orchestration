/**
 * CompileService — reading the drawing and reporting the graph it implies
 * (#103, `docs/track-graph-compilation.md` D1, D10).
 *
 * Read-only, end to end. Nothing here writes `block_edges` and nothing here
 * writes `compiled_graphs`: the apply is a separate, guarded transaction
 * through `TopologyService`, which stays the only writer of the track graph
 * (D-D). What this class provides is the thing an operator reviews *before*
 * that — a candidate graph, the gaps in it, and a diff against what the
 * pathfinder is planning on today.
 *
 * Assembled exactly like `GridService.diagnose`: read the rows, parse the
 * metadata tolerantly, hand plain data to pure functions. **This service owns
 * no policy.** Every judgement — what counts as a gap, what a connection costs
 * in point conditions, what the fingerprint covers — lives in
 * `trackGraphCompiler.ts` where it can be tested against a hand-built tile
 * array with no repository at all.
 *
 * ## `parseTileMetadata` never throws, and getting that wrong is silent
 *
 * A corrupt blob comes back as `{ metadata: {}, ok: false }`
 * (`docs/track-grid.md` D10). So `unreadable` is built from `ok === false`,
 * never from a `try`/`catch` that will never fire. Build it from a catch and
 * every tile parses, every block reads as untagged, and the compiler returns an
 * empty graph with **no gaps at all** — a confident statement that the railway
 * has no connections. That failure mode is the reason D9 insists an unreadable
 * tile is a gap in its own right rather than an empty cell.
 *
 * ## Nothing here can Safe-Stop
 *
 * A compile reads a drawing. `LayoutNotFoundError` is a 404 and a drawing that
 * compiles to nothing but gaps is a 200 with gaps in it — the same posture as
 * the grid diagnostics, and for the same reason: an authoring surface that can
 * halt the layout is a worse bug than anything it might report (D9).
 */

import { ILayoutRepository } from '../ports/ILayoutRepository';
import { BlockEdge, LayoutId, PointCondition } from '../domain/types';
import { parseTileMetadata } from './validation';
import { Coordinate, CompiledOpening, GeometryTile, compileOpenings } from './gridGeometry';
import { LayoutNotFoundError } from './GridService';
import { TopologyService } from './TopologyService';
import {
  CompileInput,
  CompileReport,
  NamedCompiledEdge,
  compileTrackGraph,
  conditionKey,
} from './trackGraphCompiler';

/** Where the live graph stands against the drawing it claims to describe (D10). */
export interface CompiledGraphStatus {
  /** ISO 8601, or `null` when this layout's graph has never been compiled. */
  compiledAt: string | null;
  /** The drawing the live graph came from, or `null` if never compiled. */
  compiledFingerprint: string | null;
  /** The drawing as it stands now. */
  drawingFingerprint: string;
  /**
   * The graph is behind the drawing — never compiled, or compiled from a
   * different one. **A warning, never a gate:** gating on this would stop an
   * operator moving a platform tile while a train is running.
   */
  stale: boolean;
  /** Gaps in the *candidate* graph. What gates `auto` (D6), once PR 4 wires the gate. */
  gapCount: number;
}

/**
 * How the candidate graph differs from the live one.
 *
 * Matched in two passes (D-J), because the two questions an operator asks of a
 * diff are different questions:
 *
 * 1. **exact ends** — same `(fromBlockId, fromEnd, toBlockId, toEnd)`. Equal
 *    conditions is `unchanged`; different conditions is `changed`, which is the
 *    safety-relevant one: the same two openings, now requiring different blades.
 * 2. **the physical connection** — whatever is left, matched on
 *    `(fromBlockId, toBlockId, conditionKey)` and paired in sorted-by-end
 *    order. A pair here is `relabelled`: the same connection wearing a
 *    different disposable name.
 *
 * Pass 2 is what stops a redraw that renames `east` to `east-1` reading as
 * "every edge removed, every edge added" — useless for review, and review is
 * the entire safety argument for compiling (D1). Anything unpaired after both
 * passes is genuinely `added` or `removed`.
 */
export interface CompileDiff {
  added: NamedCompiledEdge[];
  removed: BlockEdge[];
  unchanged: BlockEdge[];
  /** Same ends, different point conditions. */
  changed: Array<{ live: BlockEdge; proposed: NamedCompiledEdge }>;
  /** Same connection and conditions, different disposable label (D8). */
  relabelled: Array<{ live: BlockEdge; proposed: NamedCompiledEdge }>;
}

export interface CompileView {
  report: CompileReport;
  status: CompiledGraphStatus;
  diff: CompileDiff;
}

/**
 * Thrown when the drawing has moved since the compile the caller reviewed
 * (D10). Mapped to 409.
 *
 * This is the time-of-check/time-of-use guard, and it is the reason the design
 * needs no draft table: you cannot review one graph and apply another. Without
 * it, "review then apply" is exactly the shape #103 exists to eliminate —
 * an operator approves a picture and a *different* graph reaches the
 * pathfinder.
 */
export class CompileFingerprintMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super('The drawing has changed since this compile was produced; review it again');
    this.name = 'CompileFingerprintMismatchError';
  }
}

export class CompileService {
  /**
   * `TopologyService` is here for the apply and nothing else: it owns edge
   * validation, the route-lock guard and `onTopologyChanged`, and it stays the
   * **only** writer of `block_edges`. This service compiles and diffs; it has
   * no write of its own, which is what makes a bypass structurally impossible
   * rather than merely absent (D-D).
   */
  constructor(
    private readonly repo: ILayoutRepository,
    private readonly topology: TopologyService,
  ) {}

  /** The candidate graph, where it stands against the live one, and the diff between them. */
  async compile(layoutId: LayoutId): Promise<CompileView> {
    const { report, live } = await this.run(layoutId);
    return {
      report,
      status: await this.statusOf(layoutId, report),
      diff: diffGraph(live, report.edges),
    };
  }

  /**
   * Applies the compiled graph, if the drawing still matches the one reviewed.
   *
   * **Recompiles rather than trusting the caller's edges.** The request carries
   * a fingerprint, never a graph: an apply that took its rows from the body
   * would be a second authoring path wearing a compiler's name, and the whole
   * safety argument for compiling is that no human hand is between the drawing
   * and the graph. What the operator approves is *that drawing*, and the
   * fingerprint is how they say so.
   *
   * So the sequence is: compile the drawing as it stands now, refuse if that
   * differs from what was reviewed, hand the result to `TopologyService`. Every
   * refusal precedes the write (D9).
   *
   * Gaps do **not** refuse the apply (D6). A partial graph is legitimate — it
   * is how a layout is actually built up, one corner at a time — and it is
   * `SystemMode: auto` that a gap gates, not the compile. Refusing here would
   * leave an operator with an empty graph and no way to make it less empty.
   *
   * Returns the post-apply view, whose `diff` is empty and whose `status.stale`
   * is false. That is D10's idempotence, observable rather than asserted.
   */
  async apply(layoutId: LayoutId, fingerprint: string): Promise<CompileView> {
    const { report } = await this.run(layoutId);

    if (report.fingerprint !== fingerprint) {
      throw new CompileFingerprintMismatchError(fingerprint, report.fingerprint);
    }

    await this.topology.replaceGraph(
      layoutId,
      report.edges.map((e) => ({
        fromBlockId: e.fromBlockId,
        fromEnd: e.fromEnd,
        toBlockId: e.toBlockId,
        toEnd: e.toEnd,
        pointConditions: e.pointConditions,
      })),
      report.fingerprint,
    );

    // Re-read rather than construct: the returned view must describe what is
    // actually stored, not what this method believes it just stored.
    return this.compile(layoutId);
  }

  /**
   * Every drawn block's openings, named (D-H).
   *
   * Its own read, and a cheap one: pure geometry with no branch search, so the
   * Track Editor can call it on every stroke end the way it already calls
   * `grid/diagnostics`. "Where does this block open" is a question about the
   * drawing; "what edges does that imply" is a review action, and paying for
   * the second every time you paint a tile is the reason they are two routes.
   */
  async openings(layoutId: LayoutId): Promise<CompiledOpening[]> {
    await this.assertLayoutExists(layoutId);
    const { tiles } = await this.readDrawing(layoutId);
    const blocks = await this.repo.listBlocks(layoutId);
    const known = new Set(blocks.map((b) => b.id));
    // Same filter the compiler applies: an opening of a block that has been
    // deleted is a dangling reference, reported as a gap by `compile`, and has
    // no business being drawn on the diagram as if it were track.
    return compileOpenings(tiles).filter((o) => known.has(o.blockId));
  }

  async status(layoutId: LayoutId): Promise<CompiledGraphStatus> {
    const { report } = await this.run(layoutId);
    return this.statusOf(layoutId, report);
  }

  /**
   * `IGraphCompletenessView` — the number the `auto` gate reads (D-C).
   *
   * Computed live rather than cached. A mode change is a rare, human-initiated
   * action and the walk is 90 tiles on this layout; a cached count is a second
   * source of truth about exactly the thing this issue exists to stop having
   * two of.
   */
  async gapCount(layoutId: LayoutId): Promise<number> {
    const { report } = await this.run(layoutId);
    return report.gaps.length;
  }

  /** One compile, plus the live edges it will be compared against. */
  private async run(layoutId: LayoutId): Promise<{ report: CompileReport; live: BlockEdge[] }> {
    await this.assertLayoutExists(layoutId);

    const [{ tiles, unreadable }, blocks, sensors, live] = await Promise.all([
      this.readDrawing(layoutId),
      this.repo.listBlocks(layoutId),
      this.repo.listSensors(layoutId),
      this.repo.listBlockEdges(layoutId),
    ]);

    const input: CompileInput = {
      tiles,
      unreadable,
      blocks: blocks.map((b) => ({ id: b.id })),
      sensors: sensors.map((s) => ({ blockId: s.blockId, inService: s.inService })),
    };

    return { report: compileTrackGraph(input), live };
  }

  private async readDrawing(
    layoutId: LayoutId,
  ): Promise<{ tiles: GeometryTile[]; unreadable: { at: Coordinate; raw: string }[] }> {
    const rows = await this.repo.listGridTiles(layoutId);

    const tiles: GeometryTile[] = [];
    const unreadable: { at: Coordinate; raw: string }[] = [];

    for (const row of rows) {
      const parsed = parseTileMetadata(row.metadata);
      // `ok`, not a catch: `parseTileMetadata` degrades rather than throwing.
      // The raw blob rides along so that repairing corruption moves the
      // fingerprint like any other edit, and so two different corruptions do
      // not hash identically (D-G).
      if (!parsed.ok) unreadable.push({ at: { x: row.x, y: row.y }, raw: row.metadata });
      tiles.push({
        x: row.x,
        y: row.y,
        tileType: row.tileType as GeometryTile['tileType'],
        metadata: parsed.metadata,
      });
    }

    return { tiles, unreadable };
  }

  private async statusOf(
    layoutId: LayoutId,
    report: CompileReport,
  ): Promise<CompiledGraphStatus> {
    const record = await this.repo.getCompiledGraph(layoutId);

    return {
      compiledAt: record?.compiledAt.toISOString() ?? null,
      compiledFingerprint: record?.drawingFingerprint ?? null,
      drawingFingerprint: report.fingerprint,
      // A missing row is "never compiled", which is behind the drawing by
      // definition — not a NULL every caller has to remember to special-case.
      stale: record === null || record.drawingFingerprint !== report.fingerprint,
      gapCount: report.gaps.length,
    };
  }

  private async assertLayoutExists(layoutId: LayoutId): Promise<void> {
    const layout = await this.repo.getLayout(layoutId);
    if (!layout) throw new LayoutNotFoundError(layoutId);
  }
}

/** `^@` for the same reason `trackGraphCompiler` uses it: it cannot occur in a block id or a label. */
const SEP = '^@';

const endsKey = (e: { fromBlockId: string; fromEnd: string; toBlockId: string; toEnd: string }) =>
  [e.fromBlockId, e.fromEnd, e.toBlockId, e.toEnd].join(SEP);

const connectionKey = (e: {
  fromBlockId: string;
  toBlockId: string;
  pointConditions: PointCondition[];
}) => [e.fromBlockId, e.toBlockId, conditionKey(e.pointConditions)].join(SEP);

const byEnds = (a: { fromEnd: string; toEnd: string }, b: { fromEnd: string; toEnd: string }) =>
  a.fromEnd.localeCompare(b.fromEnd) || a.toEnd.localeCompare(b.toEnd);

/**
 * Pairs the live graph against the candidate one. Pure — see `CompileDiff` for
 * why it takes two passes rather than D-J's single bucket.
 */
export function diffGraph(
  live: readonly BlockEdge[],
  proposed: readonly NamedCompiledEdge[],
): CompileDiff {
  const diff: CompileDiff = {
    added: [],
    removed: [],
    unchanged: [],
    changed: [],
    relabelled: [],
  };

  // ── Pass 1: the same two openings, by name ──
  const liveByEnds = new Map<string, BlockEdge>();
  for (const e of live) liveByEnds.set(endsKey(e), e);

  const unmatchedProposed: NamedCompiledEdge[] = [];
  const matchedLive = new Set<string>();

  for (const p of proposed) {
    const match = liveByEnds.get(endsKey(p));
    if (!match) {
      unmatchedProposed.push(p);
      continue;
    }
    matchedLive.add(match.id);
    if (conditionKey(match.pointConditions) === conditionKey(p.pointConditions)) {
      diff.unchanged.push(match);
    } else {
      // The one category worth interrupting a review for: the drawing now says
      // this connection needs different blades from the ones the live graph
      // plans routes over.
      diff.changed.push({ live: match, proposed: p });
    }
  }

  const unmatchedLive = live.filter((e) => !matchedLive.has(e.id));

  // ── Pass 2: the same physical connection, whatever it is now called ──
  const liveByConnection = new Map<string, BlockEdge[]>();
  for (const e of unmatchedLive) {
    const k = connectionKey(e);
    const list = liveByConnection.get(k);
    if (list) list.push(e);
    else liveByConnection.set(k, [e]);
  }
  for (const list of liveByConnection.values()) list.sort(byEnds);

  const proposedByConnection = new Map<string, NamedCompiledEdge[]>();
  for (const p of unmatchedProposed) {
    const k = connectionKey(p);
    const list = proposedByConnection.get(k);
    if (list) list.push(p);
    else proposedByConnection.set(k, [p]);
  }
  for (const list of proposedByConnection.values()) list.sort(byEnds);

  for (const [k, proposals] of proposedByConnection) {
    const candidates = liveByConnection.get(k) ?? [];
    // Sorted-order pairing, so the same drawing always pairs the same way. Two
    // parallel connections between one pair of blocks with identical conditions
    // are indistinguishable by anything but their labels, and the labels are
    // exactly what is being replaced — arbitrary but deterministic is the
    // honest answer, and both members show as `relabelled` either way.
    const paired = Math.min(candidates.length, proposals.length);
    for (let i = 0; i < paired; i++) {
      diff.relabelled.push({ live: candidates[i], proposed: proposals[i] });
    }
    diff.added.push(...proposals.slice(paired));
    liveByConnection.set(k, candidates.slice(paired));
  }

  for (const list of liveByConnection.values()) diff.removed.push(...list);

  diff.added.sort(byEnds);
  diff.removed.sort(byEnds);
  diff.unchanged.sort(byEnds);
  diff.changed.sort((a, b) => byEnds(a.proposed, b.proposed));
  diff.relabelled.sort((a, b) => byEnds(a.proposed, b.proposed));

  return diff;
}
