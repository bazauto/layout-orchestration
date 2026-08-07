import { describe, it, expect, vi } from 'vitest';
import {
  TopologyService,
  TopologyRejectedError,
  EdgeNotFoundError,
  RecordNotFoundError,
  EdgeLimitExceededError,
  LockedByRouteError,
} from '../../../src/services/TopologyService';
import { MAX_EDGES_PER_LAYOUT } from '../../../src/domain/topology';
import { BlockEdge } from '../../../src/domain/types';
import { ILayoutRepository } from '../../../src/ports/ILayoutRepository';
import { IRouteLockView } from '../../../src/ports/IRouteLockView';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** A lock view reporting everything unheld — the default for tests that don't exercise D10's guard. */
const noLocks: IRouteLockView = {
  findRouteHoldingBlock: () => null,
  findRouteHoldingPoint: () => null,
  findRouteHoldingEdge: () => null,
};

const LAYOUT = 'layout-1';
const OTHER_LAYOUT = 'layout-2';

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

describe('TopologyService — createEdge', () => {
  it('rejects an edge whose fromBlockId belongs to another layout (unknown-block in this layout)', async () => {
    const repo = makeRepo();
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(
      service.createEdge(LAYOUT, {
        fromBlockId: 'ghost-block-from-other-layout',
        fromEnd: 'east',
        toBlockId: 'b2',
        toEnd: 'west',
        pointConditions: [],
        lengthMm: null,
      }),
    ).rejects.toThrow(TopologyRejectedError);

    expect(repo.createBlockEdge).not.toHaveBeenCalled();
    expect(onTopologyChanged).not.toHaveBeenCalled();
  });

  it('rejects an edge whose point condition references a point from another layout (unknown-point)', async () => {
    const repo = makeRepo();
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(
      service.createEdge(LAYOUT, {
        fromBlockId: 'b1',
        fromEnd: 'east',
        toBlockId: 'b2',
        toEnd: 'west',
        pointConditions: [{ pointId: 'ghost-point-from-other-layout', requiredPosition: 'normal' }],
        lengthMm: null,
      }),
    ).rejects.toThrow(TopologyRejectedError);

    expect(repo.createBlockEdge).not.toHaveBeenCalled();
    expect(onTopologyChanged).not.toHaveBeenCalled();
  });

  it('rejects a self-loop', async () => {
    const repo = makeRepo();
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(
      service.createEdge(LAYOUT, {
        fromBlockId: 'b1',
        fromEnd: 'east',
        toBlockId: 'b1',
        toEnd: 'west',
        pointConditions: [],
        lengthMm: null,
      }),
    ).rejects.toThrow(TopologyRejectedError);

    expect(onTopologyChanged).not.toHaveBeenCalled();
  });

  it('rejects a duplicate connection (same tuple as an existing edge)', async () => {
    const repo = makeRepo({
      listBlockEdges: vi.fn().mockResolvedValue([edge({ id: 'existing', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' })]),
    });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(
      service.createEdge(LAYOUT, {
        fromBlockId: 'b1',
        fromEnd: 'east',
        toBlockId: 'b2',
        toEnd: 'west',
        pointConditions: [],
        lengthMm: null,
      }),
    ).rejects.toThrow(TopologyRejectedError);

    expect(onTopologyChanged).not.toHaveBeenCalled();
  });

  it('persists and calls onTopologyChanged exactly once on a valid create', async () => {
    const repo = makeRepo();
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    const created = await service.createEdge(LAYOUT, {
      fromBlockId: 'b1',
      fromEnd: 'east',
      toBlockId: 'b2',
      toEnd: 'west',
      pointConditions: [],
      lengthMm: null,
    });

    expect(created.id).toBe('new-edge');
    expect(repo.createBlockEdge).toHaveBeenCalledTimes(1);
    expect(onTopologyChanged).toHaveBeenCalledTimes(1);
  });

  it('calls onTopologyChanged zero times on a rejected create', async () => {
    const repo = makeRepo();
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(
      service.createEdge(LAYOUT, {
        fromBlockId: 'b1',
        fromEnd: 'east',
        toBlockId: 'b1',
        toEnd: 'west',
        pointConditions: [],
        lengthMm: null,
      }),
    ).rejects.toThrow(TopologyRejectedError);

    expect(onTopologyChanged).toHaveBeenCalledTimes(0);
  });

  it('rejects a create at the edge cap with EdgeLimitExceededError, and never persists or notifies (a cap that rejects after persisting is worse than no cap)', async () => {
    const atCap = Array.from({ length: MAX_EDGES_PER_LAYOUT }, (_, i) =>
      edge({ id: `e${i}`, fromBlockId: 'b1', toBlockId: 'b2', fromEnd: `east-${i}`, toEnd: `west-${i}` }),
    );
    const repo = makeRepo({ listBlockEdges: vi.fn().mockResolvedValue(atCap) });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(
      service.createEdge(LAYOUT, {
        fromBlockId: 'b1',
        fromEnd: 'north',
        toBlockId: 'b2',
        toEnd: 'south',
        pointConditions: [],
        lengthMm: null,
      }),
    ).rejects.toThrow(EdgeLimitExceededError);

    expect(repo.createBlockEdge).not.toHaveBeenCalled();
    expect(onTopologyChanged).not.toHaveBeenCalled();
  });

  it('allows a create one below the cap (the off-by-one-prone boundary)', async () => {
    const belowCap = Array.from({ length: MAX_EDGES_PER_LAYOUT - 1 }, (_, i) =>
      edge({ id: `e${i}`, fromBlockId: 'b1', toBlockId: 'b2', fromEnd: `east-${i}`, toEnd: `west-${i}` }),
    );
    const repo = makeRepo({ listBlockEdges: vi.fn().mockResolvedValue(belowCap) });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    const created = await service.createEdge(LAYOUT, {
      fromBlockId: 'b1',
      fromEnd: 'north',
      toBlockId: 'b2',
      toEnd: 'south',
      pointConditions: [],
      lengthMm: null,
    });

    expect(created.id).toBe('new-edge');
    expect(repo.createBlockEdge).toHaveBeenCalledTimes(1);
    expect(onTopologyChanged).toHaveBeenCalledTimes(1);
  });
});

describe('TopologyService — updateEdge', () => {
  it('rejects an update that would create a self-loop, and never calls repo.updateBlockEdge', async () => {
    const existing = edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'b2' });
    const repo = makeRepo({
      getBlockEdge: vi.fn().mockResolvedValue(existing),
      listBlockEdges: vi.fn().mockResolvedValue([existing]),
    });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(service.updateEdge(LAYOUT, 'e1', { toBlockId: 'b1' })).rejects.toThrow(
      TopologyRejectedError,
    );

    expect(repo.updateBlockEdge).not.toHaveBeenCalled();
    expect(onTopologyChanged).not.toHaveBeenCalled();
  });

  it('throws EdgeNotFoundError when the edge belongs to a different layout', async () => {
    const existing = edge({ id: 'e1', layoutId: OTHER_LAYOUT });
    const repo = makeRepo({ getBlockEdge: vi.fn().mockResolvedValue(existing) });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(service.updateEdge(LAYOUT, 'e1', { lengthMm: 100 })).rejects.toThrow(
      EdgeNotFoundError,
    );
    expect(repo.updateBlockEdge).not.toHaveBeenCalled();
  });

  it('throws EdgeNotFoundError when the edge does not exist at all', async () => {
    const repo = makeRepo({ getBlockEdge: vi.fn().mockResolvedValue(null) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    await expect(service.updateEdge(LAYOUT, 'missing', { lengthMm: 100 })).rejects.toThrow(
      EdgeNotFoundError,
    );
  });

  it('validates the merged edge, not the bare patch, and succeeds when the merge is valid', async () => {
    const existing = edge({ id: 'e1', fromBlockId: 'b1', fromEnd: 'east', toBlockId: 'b2', toEnd: 'west' });
    const repo = makeRepo({
      getBlockEdge: vi.fn().mockResolvedValue(existing),
      listBlockEdges: vi.fn().mockResolvedValue([existing]),
    });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    const updated = await service.updateEdge(LAYOUT, 'e1', { toBlockId: 'b3' });

    expect(repo.updateBlockEdge).toHaveBeenCalledWith('e1', { toBlockId: 'b3' });
    expect(updated.toBlockId).toBe('b3');
    expect(onTopologyChanged).toHaveBeenCalledTimes(1);
  });
});

describe('TopologyService — deleteEdge', () => {
  it('throws EdgeNotFoundError for a cross-layout id and does not delete', async () => {
    const repo = makeRepo({ getBlockEdge: vi.fn().mockResolvedValue(edge({ layoutId: OTHER_LAYOUT })) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, noLocks);

    await expect(service.deleteEdge(LAYOUT, 'e1')).rejects.toThrow(EdgeNotFoundError);
    expect(repo.deleteBlockEdge).not.toHaveBeenCalled();
  });

  it('deletes and calls onTopologyChanged once', async () => {
    const repo = makeRepo({ getBlockEdge: vi.fn().mockResolvedValue(edge()) });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await service.deleteEdge(LAYOUT, 'e1');

    expect(repo.deleteBlockEdge).toHaveBeenCalledWith('e1');
    expect(onTopologyChanged).toHaveBeenCalledTimes(1);
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

describe('TopologyService — route-lock write-guard (D10)', () => {
  function lockViewHolding(kind: 'block' | 'point' | 'edge', targetId: string, routeId = 'route-99'): IRouteLockView {
    return {
      findRouteHoldingBlock: (_layoutId, blockId) => (kind === 'block' && blockId === targetId ? routeId : null),
      findRouteHoldingPoint: (_layoutId, pointId) => (kind === 'point' && pointId === targetId ? routeId : null),
      findRouteHoldingEdge: (_layoutId, edgeId) => (kind === 'edge' && edgeId === targetId ? routeId : null),
    };
  }

  it('refuses updateEdge when the edge is held by an active route', async () => {
    const existing = edge({ id: 'e1' });
    const repo = makeRepo({
      getBlockEdge: vi.fn().mockResolvedValue(existing),
      listBlockEdges: vi.fn().mockResolvedValue([existing]),
    });
    const service = new TopologyService(repo, vi.fn(), silentLogger, lockViewHolding('edge', 'e1'));

    await expect(service.updateEdge(LAYOUT, 'e1', { lengthMm: 100 })).rejects.toThrow(LockedByRouteError);
    expect(repo.updateBlockEdge).not.toHaveBeenCalled();
  });

  it('refuses deleteEdge when the edge is held', async () => {
    const repo = makeRepo({ getBlockEdge: vi.fn().mockResolvedValue(edge({ id: 'e1' })) });
    const service = new TopologyService(repo, vi.fn(), silentLogger, lockViewHolding('edge', 'e1'));

    await expect(service.deleteEdge(LAYOUT, 'e1')).rejects.toThrow(LockedByRouteError);
    expect(repo.deleteBlockEdge).not.toHaveBeenCalled();
  });

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

  it('does NOT guard createEdge — a new edge is always permitted regardless of what is held', async () => {
    const repo = makeRepo();
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, lockViewHolding('block', 'b1'));

    await expect(
      service.createEdge(LAYOUT, {
        fromBlockId: 'b1',
        fromEnd: 'east',
        toBlockId: 'b2',
        toEnd: 'west',
        pointConditions: [],
        lengthMm: null,
      }),
    ).resolves.toMatchObject({ fromBlockId: 'b1', toBlockId: 'b2' });
  });

  it('does not fire when the lock view reports no holder (released/cancelled routes hold nothing)', async () => {
    const existing = edge({ id: 'e1' });
    const repo = makeRepo({
      getBlockEdge: vi.fn().mockResolvedValue(existing),
      listBlockEdges: vi.fn().mockResolvedValue([existing]),
    });
    const onTopologyChanged = vi.fn().mockResolvedValue(undefined);
    const service = new TopologyService(repo, onTopologyChanged, silentLogger, noLocks);

    await expect(service.deleteEdge(LAYOUT, 'e1')).resolves.toBeUndefined();
    expect(repo.deleteBlockEdge).toHaveBeenCalledWith('e1');
  });
});
