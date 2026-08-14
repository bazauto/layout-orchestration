import { describe, expect, it } from 'vitest';
import {
  BlockEdgeRecord,
  CompiledEdge,
  GridTileRecord,
  LocoRecord,
  RouteReservation,
} from '../types';
import { LiveBlock } from './liveState';
import { buildRouteLines, routeSegmentsAtCell } from './routePaths';

const SIZE = 40;

function tile(
  x: number,
  y: number,
  tileType: string,
  metadata: Record<string, unknown> = {},
): GridTileRecord {
  return {
    id: `t-${x}-${y}`,
    layoutId: 'layout-1',
    x,
    y,
    tileType: tileType as GridTileRecord['tileType'],
    metadata: JSON.stringify(metadata),
  };
}

function build(tiles: GridTileRecord[]) {
  const grid = new Map(tiles.map((t) => [`${t.x},${t.y}`, t]));
  const parsedMeta = new Map(
    tiles.map((t) => [`${t.x},${t.y}`, JSON.parse(t.metadata) as Record<string, unknown>]),
  );
  return { grid, parsedMeta };
}

function liveBlocks(entries: Record<string, string | null>): Map<string, LiveBlock> {
  return new Map(
    Object.entries(entries).map(([blockId, lockedByRoute]) => [
      blockId,
      { occupancy: 'clear' as const, lockedByRoute, occupants: [] },
    ]),
  );
}

function route(over: Partial<RouteReservation> = {}): RouteReservation {
  return {
    id: 'r1',
    layoutId: 'layout-1',
    locoAddress: 3,
    authority: 'manual',
    status: 'active',
    path: [
      { edgeId: null, blockId: 'b1', entryEnd: null, exitEnd: 'east' },
      { edgeId: 'e1', blockId: 'b2', entryEnd: 'west', exitEnd: null },
    ],
    holds: [],
    confirmedIndex: 0,
    reason: null,
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    ...over,
  };
}

const EDGE: BlockEdgeRecord = {
  id: 'e1',
  layoutId: 'layout-1',
  fromBlockId: 'b1',
  fromEnd: 'east',
  toBlockId: 'b2',
  toEnd: 'west',
  pointConditions: [],
};

function compiled(over: Partial<CompiledEdge> = {}): CompiledEdge {
  return {
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [],
    via: [{ x: 1, y: 0 }],
    crossesDiamond: false,
    ...over,
  };
}

const LOCOS: LocoRecord[] = [
  { address: 3, layoutId: 'layout-1', name: 'Jinty' } as unknown as LocoRecord,
];

/** b1 at (0,0), a decorative connector at (1,0), b2 at (2,0). */
const TILES = [
  tile(0, 0, 'straight-h', { blockId: 'b1' }),
  tile(1, 0, 'straight-h', { trackRole: 'decorative' }),
  tile(2, 0, 'straight-h', { blockId: 'b2' }),
];

describe('buildRouteLines', () => {
  const base = () => {
    const { grid, parsedMeta } = build(TILES);
    return {
      routes: { r1: route() },
      blocks: liveBlocks({ b1: 'r1', b2: 'r1' }),
      grid,
      parsedMeta,
      edges: [EDGE],
      compiledEdges: [compiled()],
      locos: LOCOS,
      size: SIZE,
    };
  };

  it('draws the blocks it holds and the decorative cells between them', () => {
    const [line] = buildRouteLines(base());
    expect(line.segments.map((s) => `${s.x},${s.y}`).sort()).toEqual(['0,0', '1,0', '2,0']);
    expect(line.hasGaps).toBe(false);
  });

  it('names the route by its loco, degrading to the address', () => {
    expect(buildRouteLines(base())[0].locoName).toBe('Jinty');
    expect(buildRouteLines({ ...base(), locos: [] })[0].locoName).toBeNull();
  });

  /**
   * The rule that makes this a replacement for the lock outline rather than a
   * second layer: the line reads exactly the field the outline read.
   */
  it('does not draw a step whose block no longer reports this route’s lock', () => {
    const [line] = buildRouteLines({ ...base(), blocks: liveBlocks({ b1: null, b2: 'r1' }) });
    expect(line.segments.map((s) => `${s.x},${s.y}`)).toEqual(['2,0']);
  });

  it('drops the via cells when either end of the join is no longer held', () => {
    // b1 released behind the train: the join it led out of is not road ahead.
    const [line] = buildRouteLines({ ...base(), blocks: liveBlocks({ b1: null, b2: 'r1' }) });
    expect(line.segments.some((s) => s.x === 1)).toBe(false);
  });

  it('does not draw a block held by a different route', () => {
    const [line] = buildRouteLines({ ...base(), blocks: liveBlocks({ b1: 'r-other', b2: 'r1' }) });
    expect(line.segments.map((s) => `${s.x},${s.y}`)).toEqual(['2,0']);
  });

  /** A gap is honest; a guessed path through the wrong decorative tiles is #91. */
  it('reports a gap and draws no via cells when the compiled graph no longer has the edge', () => {
    const [line] = buildRouteLines({ ...base(), compiledEdges: [] });
    expect(line.hasGaps).toBe(true);
    expect(line.segments.map((s) => `${s.x},${s.y}`).sort()).toEqual(['0,0', '2,0']);
  });

  it('reports a gap when the edge id is not in the applied graph', () => {
    const [line] = buildRouteLines({ ...base(), edges: [] });
    expect(line.hasGaps).toBe(true);
  });

  /** The compiler emits both directions; which one `block_edges` names is arbitrary. */
  it('matches a compiled edge recorded in the opposite direction', () => {
    const reversed = compiled({
      fromBlockId: 'b2',
      fromEnd: 'west',
      toBlockId: 'b1',
      toEnd: 'east',
    });
    const [line] = buildRouteLines({ ...base(), compiledEdges: [reversed] });
    expect(line.hasGaps).toBe(false);
    expect(line.segments.some((s) => s.x === 1)).toBe(true);
  });

  describe('status', () => {
    it('draws active and suspended routes', () => {
      const lines = buildRouteLines({
        ...base(),
        routes: {
          r1: route({ id: 'r1' }),
          r2: route({ id: 'r2', status: 'suspended' }),
        },
      });
      expect(lines.map((l) => l.status)).toEqual(['active', 'suspended']);
    });

    it('draws neither a released nor a cancelled route', () => {
      const lines = buildRouteLines({
        ...base(),
        routes: {
          r1: route({ id: 'r1', status: 'released' }),
          r2: route({ id: 'r2', status: 'cancelled' }),
        },
      });
      expect(lines).toEqual([]);
    });
  });

  describe('style assignment', () => {
    it('is by route id, so a route keeps its colour across renders', () => {
      const routes = { r2: route({ id: 'r2' }), r1: route({ id: 'r1' }) };
      const lines = buildRouteLines({ ...base(), routes });
      expect(lines.map((l) => l.routeId)).toEqual(['r1', 'r2']);
      expect(lines.map((l) => l.styleIndex)).toEqual([0, 1]);
    });
  });

  describe('point roads', () => {
    const pointTiles = [
      tile(0, 0, 'point-left', {
        blockId: 'b1',
        pointId: 'p1',
        pointRoads: [
          { when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] },
          { when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 'n'] },
        ],
      }),
    ];

    const withPoint = (requiredPosition: 'normal' | 'reverse' | null) => {
      const { grid, parsedMeta } = build(pointTiles);
      return {
        routes: {
          r1: route({
            path: [{ edgeId: null, blockId: 'b1', entryEnd: null, exitEnd: null }],
            holds: requiredPosition
              ? [
                  {
                    kind: 'point' as const,
                    targetId: 'p1',
                    requiredPosition,
                    releaseAfterIndex: 0,
                    released: false,
                  },
                ]
              : [],
          }),
        },
        blocks: liveBlocks({ b1: 'r1' }),
        grid,
        parsedMeta,
        edges: [EDGE],
        compiledEdges: [compiled()],
        locos: LOCOS,
        size: SIZE,
      };
    };

    it('lights only the leg this route’s point hold selects', () => {
      expect(buildRouteLines(withPoint('normal'))[0].segments.map((s) => s.d)).toEqual([
        'M 0 20 L 40 20',
      ]);
      expect(buildRouteLines(withPoint('reverse'))[0].segments.map((s) => s.d)).toEqual([
        'M 0 20 L 20 0',
      ]);
    });

    /**
     * The route demonstrably runs through the cell — it is in a held block —
     * so an empty cell mid-line would read as a break in the road.
     */
    it('lights every leg when no hold resolves the point', () => {
      expect(buildRouteLines(withPoint(null))[0].segments).toHaveLength(2);
    });

    it('ignores a released point hold', () => {
      const input = withPoint('reverse');
      input.routes.r1.holds[0].released = true;
      expect(buildRouteLines(input)[0].segments).toHaveLength(2);
    });
  });

  /**
   * The shape this walk exists for, taken from the live layout: a route from
   * Engine Shed 1 into Engine / Goods Transfer, whose destination block
   * contains the point to the Goods Shed. The road runs in through the point's
   * `normal` leg; the three tiles beyond its `reverse` leg are track the train
   * will not run over, and used to be lit because they belong to a held block.
   *
   *      (0,0) ES1 ── (1,0) via ── (2,0) point ── (3,0) EGT
   *                                    │
   *                                 (2,1) EGT   ← not the road
   */
  describe('a point inside a held block', () => {
    const tiles = [
      tile(0, 0, 'straight-h', { blockId: 'b1' }),
      tile(1, 0, 'straight-h', { trackRole: 'decorative' }),
      tile(2, 0, 'point-right', {
        blockId: 'b2',
        pointId: 'p1',
        pointRoads: [
          { when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] },
          { when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 's'] },
        ],
      }),
      tile(3, 0, 'straight-h', { blockId: 'b2' }),
      tile(2, 1, 'straight-v', { blockId: 'b2' }),
    ];

    const input = (requiredPosition: 'normal' | 'reverse' | null) => {
      const { grid, parsedMeta } = build(tiles);
      return {
        routes: {
          r1: route({
            holds: requiredPosition
              ? [
                  {
                    kind: 'point' as const,
                    targetId: 'p1',
                    requiredPosition,
                    releaseAfterIndex: 1,
                    released: false,
                  },
                ]
              : [],
          }),
        },
        blocks: liveBlocks({ b1: 'r1', b2: 'r1' }),
        grid,
        parsedMeta,
        edges: [EDGE],
        compiledEdges: [compiled()],
        locos: LOCOS,
        size: SIZE,
      };
    };

    it('does not light the road beyond the leg this route holds shut', () => {
      const [line] = buildRouteLines(input('normal'));
      expect(line.segments.map((s) => `${s.x},${s.y}`).sort()).toEqual([
        '0,0',
        '1,0',
        '2,0',
        '3,0',
      ]);
    });

    it('follows the other leg when the route holds the point the other way', () => {
      const [line] = buildRouteLines(input('reverse'));
      expect(line.segments.map((s) => `${s.x},${s.y}`).sort()).toEqual([
        '0,0',
        '1,0',
        '2,0',
        '2,1',
      ]);
    });

    /** Neither leg is claimed, so neither is refused — see the module header. */
    it('lights both roads out of a point no hold resolves', () => {
      const [line] = buildRouteLines(input(null));
      expect(line.segments.map((s) => `${s.x},${s.y}`).sort()).toEqual([
        '0,0',
        '1,0',
        '2,0',
        '2,0',
        '2,1',
        '3,0',
      ]);
    });
  });

  it('lights only the leg of a crossing the road runs over', () => {
    const tiles = [
      tile(0, 0, 'straight-h', { blockId: 'b1' }),
      tile(1, 0, 'crossing', { trackRole: 'decorative' }),
      tile(2, 0, 'straight-h', { blockId: 'b2' }),
      tile(1, 1, 'straight-v', {}),
    ];
    const [line] = buildRouteLines({ ...base(), ...build(tiles) });
    // `w-e`, not `n-s`: a diamond's two roads deliberately do not interconnect.
    expect(line.segments.filter((s) => s.x === 1).map((s) => s.d)).toEqual(['M 0 20 L 40 20']);
  });

  /**
   * The walk is seeded from the joins, so a block reachable from neither is
   * washed whole rather than dropped — the route does hold it.
   */
  it('washes a held block whole when no join into it resolves', () => {
    const [line] = buildRouteLines({ ...base(), compiledEdges: [] });
    expect(line.hasGaps).toBe(true);
    expect(line.segments.map((s) => `${s.x},${s.y}`).sort()).toEqual(['0,0', '2,0']);
  });

  it('walks two touching blocks with no cells between them', () => {
    const tiles = [
      tile(0, 0, 'straight-h', { blockId: 'b1' }),
      tile(1, 0, 'straight-h', { blockId: 'b2' }),
    ];
    const { grid, parsedMeta } = build(tiles);
    const [line] = buildRouteLines({
      ...base(),
      grid,
      parsedMeta,
      compiledEdges: [compiled({ via: [] })],
    });
    expect(line.hasGaps).toBe(false);
    expect(line.segments.map((s) => `${s.x},${s.y}`).sort()).toEqual(['0,0', '1,0']);
  });

  /** Nothing continues through a buffer, but a route ending at one runs up to it. */
  it('draws a buffer’s stub and stops there', () => {
    const tiles = [
      tile(0, 0, 'straight-h', { blockId: 'b1' }),
      tile(1, 0, 'straight-h', { trackRole: 'decorative' }),
      tile(2, 0, 'straight-h', { blockId: 'b2' }),
      // Unrotated: a buffer's stub reaches its **west** edge, so this one faces
      // back down the line it stops.
      tile(3, 0, 'buffer', { blockId: 'b2' }),
    ];
    const [line] = buildRouteLines({ ...base(), ...build(tiles) });
    expect(line.segments.map((s) => `${s.x},${s.y}`).sort()).toEqual(['0,0', '1,0', '2,0', '3,0']);
  });

  it('does not run out along track past the end of the road', () => {
    const tiles = [
      tile(0, 0, 'straight-h', { blockId: 'b1' }),
      tile(1, 0, 'straight-h', { trackRole: 'decorative' }),
      tile(2, 0, 'straight-h', { blockId: 'b2' }),
      // Drawn, joined, and part of neither the route's blocks nor its joins.
      tile(3, 0, 'straight-h', { trackRole: 'decorative' }),
    ];
    const [line] = buildRouteLines({ ...base(), ...build(tiles) });
    expect(line.segments.some((s) => s.x === 3)).toBe(false);
  });

  it('does not stack two strokes on a cell reached twice', () => {
    // The via cell is also tagged to a held block — one stroke, not two.
    const tiles = [
      tile(0, 0, 'straight-h', { blockId: 'b1' }),
      tile(1, 0, 'straight-h', { blockId: 'b2' }),
    ];
    const { grid, parsedMeta } = build(tiles);
    const [line] = buildRouteLines({
      ...base(),
      grid,
      parsedMeta,
      compiledEdges: [compiled({ via: [{ x: 1, y: 0 }] })],
    });
    expect(line.segments.filter((s) => s.x === 1 && s.y === 0)).toHaveLength(1);
  });
});

describe('routeSegmentsAtCell', () => {
  it('keys every segment by its cell so the tile loop never scans', () => {
    const lines = buildRouteLines({
      routes: { r1: route() },
      blocks: liveBlocks({ b1: 'r1', b2: 'r1' }),
      ...build(TILES),
      edges: [EDGE],
      compiledEdges: [compiled()],
      locos: LOCOS,
      size: SIZE,
    });
    const at = routeSegmentsAtCell(lines);
    expect(at.get('1,0')).toHaveLength(1);
    expect(at.get('1,0')![0].line.routeId).toBe('r1');
    expect(at.has('9,9')).toBe(false);
  });
});
