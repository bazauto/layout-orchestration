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
import { SensorObservationView } from '../types';

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
        { tileType: 'straight-h', metadata: { blockId: 'b1' }, openings: [] },
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
        { tileType: 'straight-h', metadata: { blockId: 'unknown-block' }, openings: [] },
        NAMES,
      ),
    ).toBe('Column 2, row 3. Straight tile, block unknown-block.');
  });

  it('names a point tile by its point, ahead of its block', () => {
    expect(
      describeCursor(
        { x: 5, y: 3 },
        { tileType: 'point-left', metadata: { blockId: 'b1', pointId: 'p1' }, openings: [] },
        NAMES,
      ),
    ).toBe('Column 5, row 3. Point tile, Yard Throat, block Fiddle Yard 1.');
  });

  it('says decorative rather than block, for track deliberately outside the block model (#71)', () => {
    expect(
      describeCursor(
        { x: 6, y: 3 },
        { tileType: 'straight-h', metadata: { trackRole: 'decorative' }, openings: [] },
        NAMES,
      ),
    ).toBe('Column 6, row 3. Straight tile, decorative.');
  });

  it('says not classified for a tile that is neither — the #71 distinction the diagram warns about', () => {
    // Silence here would be indistinguishable from a tile that has been
    // explicitly reviewed and found to need nothing — exactly the ambiguity
    // #71 exists to remove, and the cursor readout must not reintroduce it.
    expect(
      describeCursor({ x: 7, y: 3 }, { tileType: 'straight-h', metadata: {}, openings: [] }, NAMES),
    ).toBe('Column 7, row 3. Straight tile, not classified.');
  });

  it('names a placed sensor annotation by its name', () => {
    expect(
      describeCursor(
        { x: 8, y: 3 },
        {
          tileType: 'straight-h',
          metadata: { blockId: 'b1', annotations: [{ entityType: 'sensor', entityId: 's1' }] },
          openings: [],
        },
        NAMES,
      ),
    ).toBe('Column 8, row 3. Straight tile, block Fiddle Yard 1, sensor Platform Beam.');
  });

  // #76: the sensor's live state is a parenthetical on the same sentence,
  // available to any caller that has one — omitted by every caller today
  // (the Track Editor draws no live state), which is exactly the "no
  // sensorState given" case above.
  describe('with a sensor observation (#76)', () => {
    function observation(overrides: Partial<SensorObservationView> = {}): SensorObservationView {
      return {
        sensorId: 's1',
        blockId: 'b1',
        type: 'ir_position',
        lastReading: 'occupied',
        trusted: true,
        inService: true,
        faulted: false,
        lastReadingAt: '2026-08-08T00:00:00.000Z',
        source: 'live',
        ...overrides,
      };
    }

    it('appends the state as a parenthetical when an observation is supplied', () => {
      expect(
        describeCursor(
          { x: 8, y: 3 },
          {
            tileType: 'straight-h',
            metadata: { blockId: 'b1', annotations: [{ entityType: 'sensor', entityId: 's1' }] },
            openings: [],
          },
          NAMES,
          new Map([['s1', observation({ lastReading: 'occupied' })]]),
        ),
      ).toBe('Column 8, row 3. Straight tile, block Fiddle Yard 1, sensor Platform Beam (occupied).');
    });

    it('says "not evidence" for an untrusted observation, never presenting it as a clear reading (D-d)', () => {
      expect(
        describeCursor(
          { x: 8, y: 3 },
          {
            tileType: 'straight-h',
            metadata: { blockId: 'b1', annotations: [{ entityType: 'sensor', entityId: 's1' }] },
            openings: [],
          },
          NAMES,
          new Map([['s1', observation({ lastReading: 'clear', trusted: false })]]),
        ),
      ).toBe('Column 8, row 3. Straight tile, block Fiddle Yard 1, sensor Platform Beam (not evidence).');
    });

    it('falls back to naming the sensor alone when no observation is supplied for it', () => {
      expect(
        describeCursor(
          { x: 8, y: 3 },
          {
            tileType: 'straight-h',
            metadata: { blockId: 'b1', annotations: [{ entityType: 'sensor', entityId: 's1' }] },
            openings: [],
          },
          NAMES,
          new Map(), // an empty map is a real "not given for this sensor", not "no map at all"
        ),
      ).toBe('Column 8, row 3. Straight tile, block Fiddle Yard 1, sensor Platform Beam.');
    });
  });

  it('names the boundary an opening crosses, not merely that one is here (#103)', () => {
    // The readout has to say the same thing the canvas draws. Step 6.1 moved
    // the visual from a word at a nearby cell to a tick on the boundary the
    // opening occupies, because the word could sit plausibly beside the wrong
    // place; a readout saying only "there is an opening here" would hand a
    // keyboard user the version of the diagram that was wrong.
    expect(
      describeCursor(
        { x: 2, y: 3 },
        {
          tileType: 'straight-h',
          metadata: { blockId: 'b1' },
          openings: [{ label: 'west', terminated: false, edges: ['w'] }],
        },
        NAMES,
      ),
    ).toBe('Column 2, row 3. Straight tile, block Fiddle Yard 1, opening west at the west boundary.');
  });

  it('says a buffered opening is buffered', () => {
    expect(
      describeCursor(
        { x: 9, y: 3 },
        {
          tileType: 'buffer',
          metadata: { blockId: 'b1' },
          openings: [{ label: 'yard-3', terminated: true, edges: ['e'] }],
        },
        NAMES,
      ),
    ).toBe(
      'Column 9, row 3. Buffer tile, block Fiddle Yard 1, opening yard-3 at the east boundary, buffered.',
    );
  });

  it('distinguishes the cell carrying the label from the cells carrying the boundary', () => {
    // An opening several cells wide has one label cell and several boundary
    // cells. Announcing them identically would tell a keyboard user that two
    // different places are the same place.
    expect(
      describeCursor(
        { x: 4, y: 3 },
        {
          tileType: 'straight-h',
          metadata: { blockId: 'b1' },
          openings: [{ label: 'north', terminated: false, edges: [] }],
        },
        NAMES,
      ),
    ).toBe('Column 4, row 3. Straight tile, block Fiddle Yard 1, opening north labelled here.');
  });

  it('pluralises when one opening crosses two of this cell’s boundaries', () => {
    expect(
      describeCursor(
        { x: 5, y: 3 },
        {
          tileType: 'straight-45',
          metadata: { blockId: 'b1' },
          openings: [{ label: 'northeast', terminated: false, edges: ['n', 'ne'] }],
        },
        NAMES,
      ),
    ).toBe(
      'Column 5, row 3. Corner tile, block Fiddle Yard 1, opening northeast at the north and north-east boundaries.',
    );
  });
});
