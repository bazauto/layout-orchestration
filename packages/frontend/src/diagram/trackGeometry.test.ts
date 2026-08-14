import { describe, expect, it } from 'vitest';
import { TileType } from '../types';
import { chordPath, edgeAnchor, legKey, legPath, pointLegs, trackLegs, trackStubs } from './trackGeometry';

const SIZE = 40;

describe('legKey', () => {
  it('is order-insensitive, so a road authored either way round finds one leg', () => {
    expect(legKey('w', 'n')).toBe(legKey('n', 'w'));
  });
});

describe('trackLegs', () => {
  it('gives a point tile a through leg and a divergent one', () => {
    const legs = trackLegs('point-left', SIZE);
    expect(legs.map((l) => l.legs)).toEqual([
      ['w', 'e'],
      ['w', 'n'],
    ]);
    expect(legs.filter((l) => l.divergent)).toHaveLength(1);
  });

  it('gives a buffer no leg — nothing passes through it', () => {
    expect(trackLegs('buffer', SIZE)).toEqual([]);
    expect(trackStubs('buffer', SIZE)).toEqual([{ edge: 'w', d: `M 0 20 L 20 20` }]);
  });

  it('gives a crossing two legs that do not interconnect (#26)', () => {
    expect(trackLegs('crossing', SIZE).map((l) => l.legs)).toEqual([
      ['w', 'e'],
      ['n', 's'],
    ]);
  });

  it('scales with the tile size rather than hard-coding 40', () => {
    expect(legPath('straight-h', ['w', 'e'], 80)).toBe('M 0 40 L 80 40');
  });
});

describe('legPath', () => {
  /**
   * The regression this module exists for. `TrackDiagram` drew the live road
   * overlay as a polyline through the tile centre — `(0,20) → (20,20) →
   * (20,0)` — while `TilePath` drew the same leg as a straight diagonal. One
   * leg, two shapes, in one component.
   */
  it('draws a point’s divergent leg as the diagonal the tile draws, not a right angle', () => {
    expect(legPath('point-left', ['w', 'n'], SIZE)).toBe('M 0 20 L 20 0');
    expect(legPath('point-right', ['w', 's'], SIZE)).toBe('M 0 20 L 20 40');
  });

  it('draws a point’s through leg straight across', () => {
    expect(legPath('point-left', ['w', 'e'], SIZE)).toBe('M 0 20 L 40 20');
  });

  /**
   * Why this is a per-tile table and not a formula: `w`↔`s` is a chord on one
   * tile type and a quarter-arc on another. A single geometric rule keyed on
   * the edge pair alone would have to be wrong for one of them.
   */
  it('answers the same edge pair differently for different tiles', () => {
    expect(legPath('curve', ['w', 's'], SIZE)).toBe('M 0 20 A 20 20 0 0 0 20 40');
    expect(legPath('straight-45', ['w', 'n'], SIZE)).toBe('M 0 20 L 20 0');
  });

  it('finds a leg named either way round', () => {
    expect(legPath('point-left', ['n', 'w'], SIZE)).toBe(legPath('point-left', ['w', 'n'], SIZE));
  });

  it('returns null for a leg the tile does not draw, rather than inventing one', () => {
    // Authored `pointRoads` can name a leg the tile has no track along — an
    // author remapped a point and then changed the tile type under it.
    expect(legPath('straight-h', ['n', 's'], SIZE)).toBeNull();
    expect(legPath('buffer', ['w', 'e'], SIZE)).toBeNull();
  });
});

describe('chordPath', () => {
  it('joins the two edge anchors, so a fallback lands on the boundaries it claims', () => {
    expect(chordPath(['w', 'n'], SIZE)).toBe('M 0 20 L 20 0');
  });
});

describe('pointLegs', () => {
  it('names the through and divergent legs of each point tile', () => {
    expect(pointLegs('point-left')).toEqual({ through: ['w', 'e'], divergent: ['w', 'n'] });
    expect(pointLegs('point-right')).toEqual({ through: ['w', 'e'], divergent: ['w', 's'] });
  });

  it('is undefined for anything not drawn as a point', () => {
    for (const t of ['straight-h', 'curve', 'crossing', 'buffer', 'platform'] as TileType[]) {
      expect(pointLegs(t)).toBeUndefined();
    }
  });
});

describe('edgeAnchor', () => {
  it('puts orthogonal edges at boundary midpoints and diagonals at corners', () => {
    expect(edgeAnchor('w', SIZE)).toEqual({ x: 0, y: 20 });
    expect(edgeAnchor('n', SIZE)).toEqual({ x: 20, y: 0 });
    expect(edgeAnchor('se', SIZE)).toEqual({ x: 40, y: 40 });
  });
});

/**
 * The frontend's half of a known backend↔frontend duplicate (`CLAUDE.md`,
 * "Open limits"): these pairs must equal `TILE_LEGS` in
 * `packages/backend/src/services/tileGeometry.ts`. Asserted literally here so
 * a change to one side shows up as a failing test on this side rather than as
 * a diagram that quietly disagrees with the compiler about what connects.
 */
describe('leg pairs mirror the backend TILE_LEGS', () => {
  const EXPECTED: Record<string, [string, string][]> = {
    'straight-h': [['w', 'e']],
    'straight-v': [['n', 's']],
    'straight-45': [['w', 'n']],
    curve: [['w', 's']],
    'curve-ne': [['s', 'e']],
    'curve-nw': [['s', 'w']],
    'curve-se': [['n', 'e']],
    'curve-sw': [['n', 'w']],
    'point-left': [
      ['w', 'e'],
      ['w', 'n'],
    ],
    'point-right': [
      ['w', 'e'],
      ['w', 's'],
    ],
    crossing: [
      ['w', 'e'],
      ['n', 's'],
    ],
    platform: [['w', 'e']],
    buffer: [],
  };

  for (const [type, pairs] of Object.entries(EXPECTED)) {
    it(`${type}`, () => {
      expect(trackLegs(type as TileType, SIZE).map((l) => [...l.legs])).toEqual(pairs);
    });
  }
});
