/**
 * `diagram/pointLabels` — one name per point, abbreviated to fit its tile (#93).
 *
 * The two failures these defend are both from the live Westgate Hollow drawing:
 * `P1 - Fiddle Yard` rendered twice, once on the point tile and once on the
 * `straight-45` companion directly beneath it; and `P5 - Goods Shed` beside
 * `P6 - Engine Shed`, one cell apart, running together into a single unreadable
 * string.
 */

import { describe, expect, it } from 'vitest';
import { MAX_POINT_LABEL_CHARS, pointLabelAnchors, shortPointLabel } from './pointLabels';

describe('shortPointLabel', () => {
  it('draws the identifier from the layout’s naming convention', () => {
    expect(shortPointLabel('P1 - Fiddle Yard')).toBe('P1');
    expect(shortPointLabel('P6 - Engine Shed')).toBe('P6');
    expect(shortPointLabel('P2 - Layout Entry')).toBe('P2');
  });

  it('keeps a short name that does not follow the convention', () => {
    expect(shortPointLabel('Throat')).toBe('Throat');
  });

  it('truncates a long name rather than letting it overflow its tile', () => {
    const out = shortPointLabel('Yard Throat');
    expect(out).toBe('Yard Th…');
    expect(out.length).toBeLessThanOrEqual(MAX_POINT_LABEL_CHARS);
  });

  it('truncates an over-wide identifier too, not just the fallback', () => {
    expect(shortPointLabel('Down Yard Throat - Siding 3')).toBe('Down Ya…');
  });

  it('does not mistake a hyphenated word for the separator', () => {
    // `Cross-over` is one word; splitting on a bare hyphen would render `Cross`.
    expect(shortPointLabel('Cross-over')).toBe('Cross-o…');
  });

  it('ignores surrounding whitespace', () => {
    expect(shortPointLabel('  P4 - Siding 2  ')).toBe('P4');
  });
});

describe('pointLabelAnchors', () => {
  it('names one tile per point, so a two-tile point is not labelled twice', () => {
    // Exactly P1 on the live layout: the point tile at (11,3) and its
    // `straight-45` companion at (11,4).
    const anchors = pointLabelAnchors([
      { x: 11, y: 3, tileType: 'point-left', pointId: 'p1' },
      { x: 11, y: 4, tileType: 'straight-45', pointId: 'p1' },
    ]);

    expect([...anchors]).toEqual([['11,3', 'p1']]);
  });

  it('prefers the point tile even when the companion is drawn above it', () => {
    // P6 on the live layout is the other way up: companion at (19,7), point
    // tile at (19,8). Lowest-y must not win over "actually depicts a point".
    const anchors = pointLabelAnchors([
      { x: 19, y: 7, tileType: 'straight-45', pointId: 'p6' },
      { x: 19, y: 8, tileType: 'point-left', pointId: 'p6' },
    ]);

    expect([...anchors]).toEqual([['19,8', 'p6']]);
  });

  it('falls back to the topmost, leftmost tile when none depicts a point', () => {
    const anchors = pointLabelAnchors([
      { x: 5, y: 4, tileType: 'straight-45', pointId: 'p9' },
      { x: 4, y: 4, tileType: 'straight-45', pointId: 'p9' },
      { x: 4, y: 3, tileType: 'straight-h', pointId: 'p9' },
    ]);

    expect([...anchors]).toEqual([['4,3', 'p9']]);
  });

  it('keeps points apart', () => {
    const anchors = pointLabelAnchors([
      { x: 18, y: 8, tileType: 'point-right', pointId: 'p5' },
      { x: 19, y: 8, tileType: 'point-left', pointId: 'p6' },
    ]);

    expect(anchors.get('18,8')).toBe('p5');
    expect(anchors.get('19,8')).toBe('p6');
  });

  it('is stable regardless of the order tiles arrive in', () => {
    const tiles = [
      { x: 11, y: 4, tileType: 'straight-45' as const, pointId: 'p1' },
      { x: 11, y: 3, tileType: 'point-left' as const, pointId: 'p1' },
    ];

    expect([...pointLabelAnchors(tiles)]).toEqual([...pointLabelAnchors([...tiles].reverse())]);
  });

  it('returns nothing for a drawing with no points on it', () => {
    expect(pointLabelAnchors([]).size).toBe(0);
  });
});
