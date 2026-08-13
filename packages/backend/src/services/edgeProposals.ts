/**
 * Proposing candidate `block_edges` from the drawing (#78).
 *
 * ## What a proposal is, and what it is not
 *
 * A **candidate row**, for an operator to accept or reject. Nothing here writes.
 * Accepting a proposal means posting it to the ordinary `POST .../edges`, which
 * `TopologyService` validates exactly as it validates a hand-authored edge —
 * there is deliberately no accept endpoint, so no bypass can exist by
 * construction.
 *
 * This does not make the track graph derived. `block_edges` remains authored;
 * this feature only stops the authoring being transcription. The drawing already
 * describes the railway, and typing it out a second time by hand is where the
 * two representations drift apart.
 *
 * ## Why it can only exist after #91
 *
 * The walk moves over tile **ports** — `(x, y, edge)` on a shared boundary — and
 * couples two tiles only when *both* have a leg endpoint there. Under the old
 * adjacency model two yard roads drawn on adjacent rows touched along their
 * whole length, so a cell-based walk would have proposed an edge between every
 * pair of parallel sidings on the layout. A port walk proposes none, because
 * neither tile draws anything across that boundary.
 *
 * ## What is never derived
 *
 * `lengthMm`. Tile count bears no relation to physical extent, so the field is
 * typed as the literal `null` rather than `number | null` — a later change that
 * tries to compute a distance from geometry fails to compile instead of shipping
 * a number the braking model would believe (`docs/topology.md`,
 * `docs/braking.md` B4).
 *
 * ## What is refused rather than guessed
 *
 * A point tile with no leg mapping, a leg no road covers, an unclassified tile,
 * and an opening a buffer has terminated. Each stops the walk and emits a note
 * naming the cell. Silence and refusal look identical from the outside — "no
 * connection found" — so the note is the whole difference between a to-do and a
 * mystery.
 *
 * ## Departing a block and arriving at one are different questions (#104)
 *
 * Both directions of a connection are found by the walk itself, and neither is
 * synthesised from the other, because **they do not cost the same**. Crossing a
 * point tile that carries a `blockId` is asymmetric: leaving the block through
 * it means you came from the block's interior, so the road must join the
 * boundary to a leg leading back into the block; arriving at it means you are in
 * the block the moment you are on the tile, so any road along the arriving leg
 * will do.
 *
 * Treating those as the same question is what made a point tinted as one of its
 * neighbouring blocks delete edges — on Westgate Hollow, three blocks lost their
 * entire connectivity with only cell-level notes to show for it. Mirroring one
 * direction into the other is the same mistake wearing the opposite sign: it
 * manufactures a departure the drawing refuses, which is an edge a route would
 * plan over and a train would run through the blades of.
 *
 * The leg mapping itself is unverifiable authored data (`docs/track-grid.md`
 * D9). Nothing can check which way round a physical point is wired, and a
 * proposal inherits that uncertainty exactly. This feature does not make point
 * wiring checkable; it makes the drawing and the graph state the same thing
 * rather than two different things.
 */

import { BlockEdge, BlockEnd, BlockId, PointCondition, PointId, TileEdge } from '../domain/types';
import { BlockOpening, Coordinate, GeometryTile } from './gridGeometry';
import { compileConnections } from './trackGraphCompiler';

/** A single path may cross this many tiles before the branch is abandoned. */
export const MAX_PROPOSAL_PATH_TILES = 32;

/** Live branches from one opening. A fan of points multiplies quickly; this bounds it. */
export const MAX_BRANCHES_PER_OPENING = 64;

/**
 * Admission control on the whole run, in the spirit of `MAX_EDGES_PER_LAYOUT`.
 * A drawing that produces more than this is not one an operator can review, so
 * the honest answer is to refuse rather than render a wall of candidates.
 */
export const MAX_EDGE_PROPOSALS = 200;

export type EdgeProposalStatus = 'new' | 'needs-end-label' | 'existing' | 'conflicting';

export interface EdgeProposal {
  /** Stable within one response; pairs the two directions of one physical connection. */
  pairId: string;
  fromBlockId: BlockId;
  /** `null` when no `block_ends` row names this opening. Never a guessed label. */
  fromEnd: string | null;
  toBlockId: BlockId;
  toEnd: string | null;
  pointConditions: PointCondition[];
  /** Always `null`. The literal type is the guard: geometry can never supply distance. */
  lengthMm: null;
  /** Cells crossed between the two blocks, in walk order, so the operator can find it on the drawing. */
  via: Coordinate[];
  /** The path crosses a plain diamond, whose route conflicts are not detected (#26). */
  crossesDiamond: boolean;
  status: EdgeProposalStatus;
  existingEdgeId?: string;
}

/** Why a connection that looks drawn produced no proposal. Each names a cell to go and look at. */
export type ProposalNote =
  | { kind: 'blocked-by-unclassified'; at: Coordinate }
  | { kind: 'blocked-by-unmapped-point'; at: Coordinate; pointId: PointId }
  | { kind: 'stopped-in-own-block'; blockId: BlockId; at: Coordinate }
  /**
   * The tile draws track on this side, but none of its authored roads use that
   * leg — so the walk cannot say which point position selects it. An incomplete
   * mapping rather than a missing one, which is why it is not
   * `blocked-by-unmapped-point`.
   */
  | { kind: 'leg-not-covered-by-road'; at: Coordinate; edge: TileEdge }
  /**
   * The point offers no road from inside this block out through this boundary
   * (#104). The way in may still exist: arriving is a different question, and a
   * one-way connection is a real thing to report rather than to mirror.
   */
  | { kind: 'no-road-out-of-block'; at: Coordinate; blockId: BlockId; edge: TileEdge }
  | { kind: 'search-truncated'; blockId: BlockId; at: Coordinate };

export interface EdgeProposalReport {
  proposals: EdgeProposal[];
  notes: ProposalNote[];
}

export class ProposalLimitExceededError extends Error {
  constructor(
    readonly limit: number,
    readonly found: number,
  ) {
    super(`Drawing produces ${found} candidate edges, above the ${limit} this surface will render`);
    this.name = 'ProposalLimitExceededError';
  }
}

/**
 * `^@` for the same reason `domain/topology.ts` uses it: it cannot occur in a
 * block id or an end label, so a composite key cannot be forged by a name.
 */
const SEP = '^@';

const conditionKey = (conditions: readonly PointCondition[]): string =>
  conditions
    .map((c) => `${c.pointId}:${c.requiredPosition}`)
    .sort()
    .join(',');

const endKey = (blockId: string, end: string | null): string => `${blockId}${SEP}${end ?? ''}`;

/**
 * Shapes the compiler's walk (`./trackGraphCompiler`) into #78's proposal
 * vocabulary.
 *
 * The walk itself moved out (D-A). It is one piece of geometry with two
 * consumers, and this area already carries two hand-maintained duplicates —
 * `findBlockRuns` and `TILE_LEGS` — that a change to one silently leaves
 * stale in the other. A third was not worth having.
 *
 * What stays here is everything the walk has no opinion about: the review
 * statuses, the pairing of the two directions of a connection, the cap on how
 * many candidates a person will read, and the comparison against the authored
 * graph. All of it is #78's surface, and all of it is deleted when the
 * compile-diff UI replaces this panel.
 */
export function proposeEdges(input: {
  tiles: readonly GeometryTile[];
  openings: readonly BlockOpening[];
}): EdgeProposalReport {
  const { connections, notes } = compileConnections(input);

  if (connections.length > MAX_EDGE_PROPOSALS) {
    throw new ProposalLimitExceededError(MAX_EDGE_PROPOSALS, connections.length);
  }

  const proposals = connections.map((c) => ({
    fromBlockId: c.fromBlockId,
    fromEnd: c.fromEnd,
    toBlockId: c.toBlockId,
    toEnd: c.toEnd,
    pointConditions: c.pointConditions,
    // Always `null`, and the literal type is the guard: geometry can never
    // supply distance, and since #105 an edge carries none at all.
    lengthMm: null as null,
    via: c.via,
    crossesDiamond: c.crossesDiamond,
    pairId: [endKey(c.fromBlockId, c.fromEnd), endKey(c.toBlockId, c.toEnd)]
      .sort()
      .join(SEP)
      .concat(SEP, conditionKey(c.pointConditions)),
    status: 'new' as const,
  }));

  return { proposals, notes };
}

/**
 * Sets each proposal's status against the graph as it stands.
 *
 * Existing edges are **reported, not filtered out**. Silence is
 * indistinguishable from "not found", and "the graph already agrees with the
 * drawing" is the most valuable thing this surface can tell an operator about a
 * layout that is partly authored.
 *
 * Note the order: end labels with no `block_ends` row are cleared *first*, so a
 * proposal naming an end nobody has stored can never match an existing edge and
 * lands as `needs-end-label` rather than `new`.
 */
export function reconcileProposals(
  proposals: readonly EdgeProposal[],
  existingEdges: readonly BlockEdge[],
  ends: readonly BlockEnd[],
): EdgeProposal[] {
  const stored = new Set(ends.map((e) => `${e.blockId} ${e.label}`));

  const byConnection = new Map<string, BlockEdge>();
  for (const edge of existingEdges) {
    byConnection.set(
      [edge.fromBlockId, edge.fromEnd, edge.toBlockId, edge.toEnd].join(SEP),
      edge,
    );
  }

  return proposals.map((p) => {
    const fromEnd = p.fromEnd && stored.has(`${p.fromBlockId} ${p.fromEnd}`) ? p.fromEnd : null;
    const toEnd = p.toEnd && stored.has(`${p.toBlockId} ${p.toEnd}`) ? p.toEnd : null;
    const next = { ...p, fromEnd, toEnd };

    if (fromEnd === null || toEnd === null) {
      return { ...next, status: 'needs-end-label' as const };
    }

    // Keyed on the full four-part tuple, never on `(fromBlockId, fromEnd)` —
    // that pair is deliberately not unique, because one opening fans out to
    // several blocks through a point, and keying on it would collapse every
    // point fan-out into a single false conflict.
    const existing = byConnection.get([p.fromBlockId, fromEnd, p.toBlockId, toEnd].join(SEP));
    if (!existing) return { ...next, status: 'new' as const };

    const sameConditions =
      conditionKey(existing.pointConditions) === conditionKey(p.pointConditions);

    return {
      ...next,
      // Length is never part of the comparison: an authored `lengthMm` against a
      // proposal's `null` is not a disagreement, it is measurement the drawing
      // could never have supplied.
      status: sameConditions ? ('existing' as const) : ('conflicting' as const),
      existingEdgeId: existing.id,
    };
  });
}
