/**
 * `diagram/cursorAnnouncement` — the one sentence that is both the visible
 * cursor readout and the `aria-live` announcement (#94).
 *
 * Because it is a single implementation for two audiences, a bug here is a
 * bug in what a screen reader user is told, not just a cosmetic one — these
 * tests read as if checking prose because that prose is the accessibility
 * surface.
 */

import { describe, expect, it } from 'vitest';
import { describeCursor } from './cursorAnnouncement';
import { DiagnosticNames } from './diagnostics';

const NAMES: DiagnosticNames = {
  blocks: new Map([['b1', 'Fiddle Yard 1']]),
  points: new Map([['p1', 'Yard Throat']]),
  sensors: new Map([['s1', 'Platform Beam']]),
};

describe('describeCursor', () => {
  it('announces an empty cell as empty, not as silence', () => {
    // The whole point of #94: a hover-only readout that says nothing when
    // there is nothing painted is indistinguishable from a broken readout.
    // "Empty" is itself the useful answer.
    expect(describeCursor({ x: 4, y: 9 }, null, NAMES)).toBe('Column 4, row 9. Empty.');
  });

  it('names a block tile by its block, not its raw id, when the name is known', () => {
    expect(
      describeCursor(
        { x: 2, y: 3 },
        { tileType: 'straight-h', metadata: { blockId: 'b1' }, ends: [] },
        NAMES,
      ),
    ).toBe('Column 2, row 3. Straight tile, block Fiddle Yard 1.');
  });

  it('falls back to the raw id when a block name is not resolvable (docs/naming.md D8)', () => {
    // The same degradation contract as `describeDiagnostic` — the id must
    // never be swallowed just because the NameBook does not have it yet.
    expect(
      describeCursor(
        { x: 2, y: 3 },
        { tileType: 'straight-h', metadata: { blockId: 'unknown-block' }, ends: [] },
        NAMES,
      ),
    ).toBe('Column 2, row 3. Straight tile, block unknown-block.');
  });

  it('names a point tile by its point, ahead of its block', () => {
    expect(
      describeCursor(
        { x: 5, y: 3 },
        { tileType: 'point-left', metadata: { blockId: 'b1', pointId: 'p1' }, ends: [] },
        NAMES,
      ),
    ).toBe('Column 5, row 3. Point tile, Yard Throat, block Fiddle Yard 1.');
  });

  it('says decorative rather than block, for track deliberately outside the block model (#71)', () => {
    expect(
      describeCursor(
        { x: 6, y: 3 },
        { tileType: 'straight-h', metadata: { trackRole: 'decorative' }, ends: [] },
        NAMES,
      ),
    ).toBe('Column 6, row 3. Straight tile, decorative.');
  });

  it('says not classified for a tile that is neither — the #71 distinction the diagram warns about', () => {
    // Silence here would be indistinguishable from a tile that has been
    // explicitly reviewed and found to need nothing — exactly the ambiguity
    // #71 exists to remove, and the cursor readout must not reintroduce it.
    expect(
      describeCursor({ x: 7, y: 3 }, { tileType: 'straight-h', metadata: {}, ends: [] }, NAMES),
    ).toBe('Column 7, row 3. Straight tile, not classified.');
  });

  it('names a placed sensor annotation by its name', () => {
    expect(
      describeCursor(
        { x: 8, y: 3 },
        {
          tileType: 'straight-h',
          metadata: { blockId: 'b1', annotations: [{ entityType: 'sensor', entityId: 's1' }] },
          ends: [],
        },
        NAMES,
      ),
    ).toBe('Column 8, row 3. Straight tile, block Fiddle Yard 1, sensor Platform Beam.');
  });

  it('marks a pinned end in brackets, matching exactly how it is drawn on the tile (#72)', () => {
    // The readout asserting a different pinned/generated state than the
    // diagram draws would be worse than saying nothing — two disagreeing
    // sources of truth for something the operator cannot verify by eye.
    expect(
      describeCursor(
        { x: 9, y: 3 },
        {
          tileType: 'buffer',
          metadata: { blockId: 'b1' },
          ends: [{ label: 'yard-3', pinned: true, terminated: true }],
        },
        NAMES,
      ),
    ).toBe('Column 9, row 3. Buffer tile, block Fiddle Yard 1, end [yard-3] (buffer).');
  });

  it('reads an unpinned, non-terminated end plainly', () => {
    expect(
      describeCursor(
        { x: 2, y: 3 },
        {
          tileType: 'straight-h',
          metadata: { blockId: 'b1' },
          ends: [{ label: 'west', pinned: false, terminated: false }],
        },
        NAMES,
      ),
    ).toBe('Column 2, row 3. Straight tile, block Fiddle Yard 1, end west.');
  });
});
