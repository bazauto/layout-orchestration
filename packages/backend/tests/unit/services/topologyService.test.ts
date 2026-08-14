import { describe, it, expect, vi } from 'vitest';
import {
  TopologyService,
  TopologyRejectedError,
  RecordNotFoundError,
  EdgeLimitExceededError,
  LockedByRouteError,
} from '../../../src/services/TopologyService';
import { MAX_EDGES_PER_LAYOUT } from '../../../src/domain/topology';
import { EMPTY_NAME_BOOK } from '../../../src/domain/naming';
import { BlockEdge, LayoutId, NameBook } from '../../../src/domain/types';
import { ILayoutRepository } from '../../../src/ports/ILayoutRepository';
import { IRouteLockView } from '../../../src/ports/IRouteLockView';
import { INameBook } from '../../../src/ports/INameBook';

/** A fixed INameBook — no repository, no refresh — for tests asserting on a rendered name. */
function staticNameBook(book: NameBook): INameBook {
  return { get: () => book, refresh: async (_layoutId: LayoutId) => {} };
}

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A lock view reporting everything unheld — the default for tests that don't exercise D10's guard. */
const noLocks: IRouteLockView = {
  findRouteHoldingBlock: () => null,
  findRouteHoldingPoint: () => null,
  findRouteHoldingEdge: () => null,
  findAnyHeldRoute: () => null,
};

const LAYOUT = 'layout-1';

function edge(overrides: Partial<BlockEdge> = {}): BlockEdge {
  return {
    id: 'e1',
    layoutId: LAYOUT,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [],
    lengthMm: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<ILayoutRepository> = {}): ILayoutRepository {
  return {
    listLayouts: vi.fn(),
    getLayout: vi.fn(),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn(),
    getLoco: vi.fn(),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([
      { id: 'b1', layoutId: LAYOUT, name: 'Block 1' },
      { id: 'b2', layoutId: LAYOUT, name: 'Block 2' },
      { id: 'b3', layoutId: LAYOUT, name: 'Block 3' },
    ]),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn().mockResolvedValue([{ id: 'p1', layoutId: LAYOUT, name: 'Point 1', dccAddress: 1, blockId: null }]),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn(),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),
    listGridTiles: vi.fn(),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn(),
    clearGrid: vi.fn(),
    listBlockEdges: vi.fn().mockResolvedValue([]),
    getBlockEdge: vi.fn().mockResolvedValue(null),
    createBlockEdge: vi.fn().mockImplementation(async (data) => ({ id: 'new-edge', ...data })),
    updateBlockEdge: vi.fn().mockImplementation(async (id, data) => ({ ...edge(), id, ...data })),
    deleteBlockEdge: vi.fn().mockResolvedValue(undefined),
    getCompiledGraph: vi.fn().mockResolvedValue(null),
    replaceBlockEdges: vi
      .fn()
      .mockImplementation(async (layoutId, edges) =>
        edges.map((e: Omit<BlockEdge, 'id' | 'layoutId'>, i: number) => ({
          id: `compiled-${i}`,
          layoutId,
          ...e,
        })),
      ),
    ...overrides,
  };
}

describe('TopologyService — getStatus', () => {
  it('returns valid: true and the edge count for a healthy edge set', async () => {
    const edges = [
      edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'b2' }),
      edge({ id: 'e2', fromBlockId: 'b2', toBlockId: 'b3' }),
    ];
    const repo = makeRepo({ listBlockEdges: vi.fn().mockResolvedValue(edges) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    const status = await service.getStatus(LAYOUT);

    expect(status).toEqual({ valid: true, violations: [], edgeCount: 2 });
  });

  it('reports duplicate-edge-id for two edges sharing an id (the D8 divergence: the old flatMap open-coding missed this)', async () => {
    const edges = [
      edge({ id: 'dup', fromBlockId: 'b1', toBlockId: 'b2' }),
      edge({ id: 'dup', fromBlockId: 'b2', toBlockId: 'b3' }),
    ];
    const repo = makeRepo({ listBlockEdges: vi.fn().mockResolvedValue(edges) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    const status = await service.getStatus(LAYOUT);

    expect(status.valid).toBe(false);
    expect(status.violations).toContainEqual({ kind: 'duplicate-edge-id', edgeId: 'dup' });
  });
});

describe('TopologyService — deleteBlockWithEdges', () => {
  it('reports the number of edges removed', async () => {
    const repo = makeRepo({
      listBlockEdges: vi.fn().mockResolvedValue([
        edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'b2' }),
        edge({ id: 'e2', fromBlockId: 'b2', toBlockId: 'b1' }),
        edge({ id: 'e3', fromBlockId: 'b2', toBlockId: 'b3' }),
      ]),
    });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    const result = await service.deleteBlockWithEdges(LAYOUT, 'b1');

    expect(result).toEqual({ removedEdges: 2 });
    expect(repo.deleteBlock).toHaveBeenCalledWith(LAYOUT, 'b1');
    expect(onTopologyChanged).toHaveBeenCalledTimes(1);
  });

  it('refuses to delete a block belonging to another layout', async () => {
    // The block id is real, but not in LAYOUT. Deleting by id alone would
    // destroy the owning layout's block and cascade away its edges.
    const repo = makeRepo({
      listBlocks: vi.fn().mockResolvedValue([{ id: 'b1', layoutId: LAYOUT, name: 'Block 1' }]),
    });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(service.deleteBlockWithEdges(LAYOUT, 'foreign-block')).rejects.toThrow(
      RecordNotFoundError,
    );
    expect(repo.deleteBlock).not.toHaveBeenCalled();
    expect(onTopologyChanged).not.toHaveBeenCalled();
  });
});

describe('TopologyService — deletePointIfUnreferenced', () => {
  it('deletes a point referenced by no edge', async () => {
    const repo = makeRepo({ listBlockEdges: vi.fn().mockResolvedValue([edge({ pointConditions: [] })]) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    await service.deletePointIfUnreferenced(LAYOUT, 'p1');

    expect(repo.deletePoint).toHaveBeenCalledWith(LAYOUT, 'p1');
  });

  it('refuses to delete a point belonging to another layout', async () => {
    // The reference guard scans LAYOUT's edges. A point owned by another
    // layout has no references there, so without an ownership check first the
    // guard waves the delete through and strands the owner's edge conditions.
    const repo = makeRepo({
      listBlockEdges: vi.fn().mockResolvedValue([edge({ pointConditions: [] })]),
    });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    await expect(service.deletePointIfUnreferenced(LAYOUT, 'foreign-point')).rejects.toThrow(
      RecordNotFoundError,
    );
    expect(repo.deletePoint).not.toHaveBeenCalled();
  });

  it('rejects deleting a point referenced by an edge, naming the referencing edge id', async () => {
    const repo = makeRepo({
      listBlockEdges: vi.fn().mockResolvedValue([
        edge({ id: 'e1', pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }] }),
      ]),
    });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    await expect(service.deletePointIfUnreferenced(LAYOUT, 'p1')).rejects.toThrow(
      TopologyRejectedError,
    );
    await expect(service.deletePointIfUnreferenced(LAYOUT, 'p1')).rejects.toThrow(/e1/);
    expect(repo.deletePoint).not.toHaveBeenCalled();
  });

  it('#54: names the point and the referencing edges when a book is supplied', async () => {
    const book: NameBook = {
      ...EMPTY_NAME_BOOK,
      points: new Map([['p1', 'Yard Points']]),
      blocks: new Map([
        ['b1', 'Down Platform'],
        ['b2', 'Up Loop'],
      ]),
      edges: new Map([['e1', 'Down Platform:east → Up Loop:west']]),
    };
    const repo = makeRepo({
      listBlockEdges: vi.fn().mockResolvedValue([
        edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'b2', pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }] }),
      ]),
    });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks, staticNameBook(book));

    await expect(service.deletePointIfUnreferenced(LAYOUT, 'p1')).rejects.toThrow(
      'Point "Yard Points" (p1) is referenced by 1 edge: "Down Platform:east → Up Loop:west" (e1)',
    );
  });

  it('#54: shows exactly 5 referencing edges and says "(first 5 shown)" for a sixth', async () => {
    const referencingEdges = Array.from({ length: 6 }, (_, i) =>
      edge({
        id: `e${i}`,
        fromBlockId: 'b1',
        toBlockId: 'b2',
        fromEnd: `e${i}-out`,
        toEnd: `e${i}-in`,
        pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
      }),
    );
    const repo = makeRepo({ listBlockEdges: vi.fn().mockResolvedValue(referencingEdges) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    let caught: unknown;
    try {
      await service.deletePointIfUnreferenced(LAYOUT, 'p1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TopologyRejectedError);
    const message = (caught as Error).message;
    expect(message).toContain('6 edges');
    expect(message).toContain('(first 5 shown)');
    expect(message).toContain('e0');
    expect(message).toContain('e4');
    expect(message).not.toContain('e5');
  });
});

describe('TopologyService — updatePoint', () => {
  it('updates a point that exists in the layout', async () => {
    const updated = { id: 'p1', layoutId: LAYOUT, name: 'Renamed', dccAddress: 1, blockId: null };
    const repo = makeRepo({ updatePoint: vi.fn().mockResolvedValue(updated) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    const result = await service.updatePoint(LAYOUT, 'p1', { name: 'Renamed' });

    expect(result).toEqual(updated);
    expect(repo.updatePoint).toHaveBeenCalledWith('p1', { name: 'Renamed' });
  });

  it('refuses to update a point belonging to another layout', async () => {
    // Same ownership rationale as deletePointIfUnreferenced: repo.updatePoint
    // takes no layoutId, so without this check `PUT
    // /api/layouts/<any>/points/:id` could mutate a point owned by a
    // different layout by id alone. The guard scans LAYOUT's points (see
    // makeRepo's default listPoints, which only contains 'p1'), so a point id
    // it does not contain — as if it belonged to another layout — surfaces
    // the same way deletePointIfUnreferenced's equivalent test does.
    const repo = makeRepo();
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    await expect(service.updatePoint(LAYOUT, 'foreign-point', { name: 'Renamed' })).rejects.toThrow(
      RecordNotFoundError,
    );
    expect(repo.updatePoint).not.toHaveBeenCalled();
  });

  it('does not trigger a topology revalidation — a point update can never invalidate an edge condition', async () => {
    // Edge pointConditions reference a point only by its immutable id, and
    // this method cannot change a point's id or layoutId — see the doc
    // comment on TopologyService#updatePoint.
    const onTopologyChanged = vi.fn();
    const repo = makeRepo({
      updatePoint: vi.fn().mockResolvedValue({ id: 'p1', layoutId: LAYOUT, name: 'Renamed', dccAddress: 1, blockId: null }),
    });
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await service.updatePoint(LAYOUT, 'p1', { name: 'Renamed' });

    expect(onTopologyChanged).not.toHaveBeenCalled();
  });
});

// ─── D10: the topology write-guard ─────────────────────────────────────────

/**
 * The compiled-graph write (#103, D1/D3/D9).
 *
 * Every test here is about the same property: **refuse first, write second.**
 * `reloadTopology()` Safe-Stops the layout when it loads a graph with a fatal
 * violation, so an apply that could write rows and then have them rejected on
 * reload would turn an authoring action into a halted railway. That is why the
 * failure cases assert the *absence* of the repository call, not merely that
 * something threw.
 */
describe('TopologyService — replaceGraph (#103)', () => {
  const CANDIDATES = [
    { fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west', pointConditions: [] },
    { fromBlockId: 'b2', fromEnd: 'west', toBlockId: 'b1', toEnd: 'east', pointConditions: [] },
  ];

  it('replaces the whole set and notifies exactly once', async () => {
    const repo = makeRepo({ listBlockEdges: vi.fn().mockResolvedValue([edge({ id: 'old' })]) });
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onChanged, silentLogger, noLocks);

    const written = await service.replaceGraph(LAYOUT, CANDIDATES, 'fp-1');

    expect(written).toHaveLength(2);
    expect(repo.replaceBlockEdges).toHaveBeenCalledWith(LAYOUT, CANDIDATES, 'fp-1', expect.any(Date));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('applies an empty graph, because a drawing with no connections is a legitimate answer', async () => {
    // Not an error and not a no-op: erasing the drawing and applying is how a
    // layout is legitimately torn down. Refusing it would leave the graph
    // describing a railway that is no longer drawn.
    const repo = makeRepo();
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    await service.replaceGraph(LAYOUT, [], 'fp-empty');

    expect(repo.replaceBlockEdges).toHaveBeenCalledWith(LAYOUT, [], 'fp-empty', expect.any(Date));
  });

  it('refuses when any route holds anything in the layout, and writes nothing', async () => {
    // Not a per-edge guard (D-E). Every row is about to be deleted and rewritten
    // with regenerated labels, so "is this edge held" has no answer worth acting
    // on — the row may not survive and the label a live route recorded may not
    // exist afterwards.
    const repo = makeRepo();
    const held: IRouteLockView = { ...noLocks, findAnyHeldRoute: () => 'route-77' };
    const service = new TopologyService(repo, vi.fn(), silentLogger, held);

    await expect(service.replaceGraph(LAYOUT, CANDIDATES, 'fp-1')).rejects.toThrow(
      LockedByRouteError,
    );
    expect(repo.replaceBlockEdges).not.toHaveBeenCalled();
  });

  it('names the holding route on the refusal', async () => {
    const held: IRouteLockView = { ...noLocks, findAnyHeldRoute: () => 'route-77' };
    const service = new TopologyService(makeRepo(), vi.fn(), silentLogger, held);

    await expect(service.replaceGraph(LAYOUT, CANDIDATES, 'fp-1')).rejects.toMatchObject({
      kind: 'graph',
      routeId: 'route-77',
    });
  });

  it('refuses a candidate naming a block that does not exist, and writes nothing', async () => {
    // The never-write-then-discover assertion. A `unknown-block` violation is
    // fatal on reload, so writing this set and finding out afterwards would
    // Safe-Stop the layout as a result of an authoring action (D9).
    const repo = makeRepo();
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    await expect(
      service.replaceGraph(
        LAYOUT,
        [{ fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'ghost', toEnd: 'west', pointConditions: [] }],
        'fp-1',
      ),
    ).rejects.toThrow(TopologyRejectedError);
    expect(repo.replaceBlockEdges).not.toHaveBeenCalled();
  });

  it('validates the candidate set against itself, not against the live graph', async () => {
    // Two identical connections are a duplicate within the *proposal*. Checking
    // each row against what is stored would miss it, because what is stored is
    // about to be deleted.
    const repo = makeRepo({ listBlockEdges: vi.fn().mockResolvedValue([]) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    await expect(
      service.replaceGraph(LAYOUT, [CANDIDATES[0], { ...CANDIDATES[0] }], 'fp-1'),
    ).rejects.toThrow(TopologyRejectedError);
    expect(repo.replaceBlockEdges).not.toHaveBeenCalled();
  });

  it('refuses over the edge cap before validating anything', async () => {
    const repo = makeRepo();
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);
    const tooMany = Array.from({ length: MAX_EDGES_PER_LAYOUT + 1 }, (_, i) => ({
      fromBlockId: 'b1',
      fromEnd: `east-${i}`,
      toBlockId: 'b2',
      toEnd: `west-${i}`,
      pointConditions: [],
    }));

    await expect(service.replaceGraph(LAYOUT, tooMany, 'fp-1')).rejects.toThrow(
      EdgeLimitExceededError,
    );
    expect(repo.replaceBlockEdges).not.toHaveBeenCalled();
    // Admission control on the whole candidate set — which is where it always
    // belonged. A cap on how much graph exists is a statement about the graph,
    // not about whichever row happened to arrive last.
    expect(repo.listBlocks).not.toHaveBeenCalled();
  });

  it('does not notify when it refuses', async () => {
    const onChanged = vi.fn();
    const held: IRouteLockView = { ...noLocks, findAnyHeldRoute: () => 'route-77' };
    const service = new TopologyService(makeRepo(), onChanged, silentLogger, held);

    await expect(service.replaceGraph(LAYOUT, CANDIDATES, 'fp-1')).rejects.toThrow();
    expect(onChanged).not.toHaveBeenCalled();
  });
});

describe('TopologyService — route-lock write-guard (D10)', () => {
  function lockViewHolding(kind: 'block' | 'point' | 'edge', targetId: string, routeId = 'route-99'): IRouteLockView {
    return {
      findRouteHoldingBlock: (_layoutId, blockId) => (kind === 'block' && blockId === targetId ? routeId : null),
      findRouteHoldingPoint: (_layoutId, pointId) => (kind === 'point' && pointId === targetId ? routeId : null),
      findRouteHoldingEdge: (_layoutId, edgeId) => (kind === 'edge' && edgeId === targetId ? routeId : null),
      findAnyHeldRoute: () => null,
    };
  }

  it('refuses deleteBlockWithEdges when the block itself is held', async () => {
    const repo = makeRepo();
    const service = new TopologyService(repo, vi.fn(), silentLogger, lockViewHolding('block', 'b1'));

    await expect(service.deleteBlockWithEdges(LAYOUT, 'b1')).rejects.toThrow(LockedByRouteError);
    expect(repo.deleteBlock).not.toHaveBeenCalled();
  });

  it('refuses deleteBlockWithEdges when an edge referencing the block is held, even if the block itself is not', async () => {
    const repo = makeRepo({
      listBlockEdges: vi.fn().mockResolvedValue([edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'b2' })]),
    });
    const service = new TopologyService(repo, vi.fn(), silentLogger, lockViewHolding('edge', 'e1'));

    await expect(service.deleteBlockWithEdges(LAYOUT, 'b1')).rejects.toThrow(LockedByRouteError);
    expect(repo.deleteBlock).not.toHaveBeenCalled();
  });

  it('refuses deletePointIfUnreferenced when the point is held', async () => {
    const repo = makeRepo({ listBlockEdges: vi.fn().mockResolvedValue([]) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, lockViewHolding('point', 'p1'));

    await expect(service.deletePointIfUnreferenced(LAYOUT, 'p1')).rejects.toThrow(LockedByRouteError);
    expect(repo.deletePoint).not.toHaveBeenCalled();
  });

  it('does not fire when the lock view reports no holder (released/cancelled routes hold nothing)', async () => {
    // The guard must be a guard, not a blanket refusal. A `released` or
    // `cancelled` route holds nothing, `IRouteLockView` says so, and the same
    // delete that was refused above goes through.
    const repo = makeRepo({
      listBlockEdges: vi.fn().mockResolvedValue([edge({ id: 'e1', fromBlockId: 'b1' })]),
    });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(service.deleteBlockWithEdges(LAYOUT, 'b1')).resolves.toEqual({ removedEdges: 1 });
    expect(repo.deleteBlock).toHaveBeenCalledWith(LAYOUT, 'b1');
  });
});
