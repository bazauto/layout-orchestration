import { describe, it, expect, vi } from 'vitest';
import { NameBookCache, buildNameBook } from '../../../src/services/nameBook';
import { BlockEdgeRowInvalidError } from '../../../src/services/validation';
import { MAX_LABEL_CHARS } from '../../../src/domain/naming';
import { BlockEdge } from '../../../src/domain/types';
import { ILayoutRepository } from '../../../src/ports/ILayoutRepository';

const LAYOUT = 'layout-1';

function edge(overrides: Partial<BlockEdge> = {}): BlockEdge {
  return {
    id: 'e1',
    layoutId: LAYOUT,
    fromBlockId: 'b1',
    fromEnd: 'north',
    toBlockId: 'b2',
    toEnd: 'south',
    pointConditions: [],
    lengthMm: null,
    ...overrides,
  };
}

describe('buildNameBook', () => {
  it('truncates a long block name to 39 characters plus an ellipsis', () => {
    const longName = 'a'.repeat(60);
    const book = buildNameBook({
      layouts: [],
      blocks: [{ id: 'b1', layoutId: LAYOUT, name: longName }],
      points: [],
      sensors: [],
      locos: [],
      edges: [],
    });
    const truncated = book.blocks.get('b1');
    expect(truncated?.length).toBe(MAX_LABEL_CHARS);
    expect(truncated).toBe(`${'a'.repeat(MAX_LABEL_CHARS - 1)}…`);
  });

  it('derives an edge label from its endpoints, falling back to the raw id for an unknown block', () => {
    const book = buildNameBook({
      layouts: [],
      blocks: [{ id: 'b1', layoutId: LAYOUT, name: 'Down Platform' }],
      points: [],
      sensors: [],
      locos: [],
      edges: [edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'block-ghost' })],
    });
    expect(book.edges.get('e1')).toBe('Down Platform:north → block-ghost:south');
  });
});

function makeRepo(overrides: Partial<ILayoutRepository> = {}): ILayoutRepository {
  return {
    listLayouts: vi.fn().mockResolvedValue([]),
    getLayout: vi.fn(),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockResolvedValue([]),
    getLoco: vi.fn(),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([{ id: 'b1', layoutId: LAYOUT, name: 'Down Platform' }]),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn().mockResolvedValue([{ id: 'p1', layoutId: LAYOUT, name: 'Yard Points', dccAddress: 1, blockId: null }]),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn().mockResolvedValue([]),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),
    listGridTiles: vi.fn(),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn(),
    clearGrid: vi.fn(),
    listBlockEdges: vi.fn().mockResolvedValue([edge()]),
    getBlockEdge: vi.fn(),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),
    listReservations: vi.fn(),
    getReservation: vi.fn(),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
    markHoldsReleased: vi.fn(),
    ...overrides,
  };
}

describe('NameBookCache', () => {
  it('is EMPTY_NAME_BOOK before the first refresh', () => {
    const cache = new NameBookCache(makeRepo(), LAYOUT);
    expect(cache.get().blocks.size).toBe(0);
  });

  it('builds a populated book from the repository on refresh', async () => {
    const cache = new NameBookCache(makeRepo(), LAYOUT);
    await cache.refresh(LAYOUT);
    expect(cache.get().blocks.get('b1')).toBe('Down Platform');
    expect(cache.get().points.get('p1')).toBe('Yard Points');
  });

  it('is a no-op for a layout id that does not match the bound layout (D5)', async () => {
    const repo = makeRepo();
    const cache = new NameBookCache(repo, LAYOUT);
    await cache.refresh('other-layout');
    expect(cache.get().blocks.size).toBe(0);
    expect(repo.listBlocks).not.toHaveBeenCalled();
  });

  it('falls back to an empty edges map, without rejecting, when listBlockEdges throws BlockEdgeRowInvalidError (D10)', async () => {
    const repo = makeRepo({
      listBlockEdges: vi.fn().mockRejectedValue(new BlockEdgeRowInvalidError('e1', [])),
    });
    const cache = new NameBookCache(repo, LAYOUT);
    await expect(cache.refresh(LAYOUT)).resolves.toBeUndefined();
    expect(cache.get().edges.size).toBe(0);
    // Everything else the refresh fetched independently still populates.
    expect(cache.get().blocks.get('b1')).toBe('Down Platform');
  });

  it('propagates a generic error from listBlocks, proving the catch stays narrow to BlockEdgeRowInvalidError only', async () => {
    const repo = makeRepo({ listBlocks: vi.fn().mockRejectedValue(new Error('db exploded')) });
    const cache = new NameBookCache(repo, LAYOUT);
    await expect(cache.refresh(LAYOUT)).rejects.toThrow('db exploded');
  });
});
