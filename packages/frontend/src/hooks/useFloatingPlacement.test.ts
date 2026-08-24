/**
 * What a stored placement is allowed to be (#165).
 *
 * The hook's drag and clamp need a laid-out DOM to mean anything and are
 * covered where they are used; this is the part that has to survive whatever
 * is actually in localStorage — including the bare `'open'`/`'closed'` string
 * the point key wrote before it could be placed, which is the one entry a real
 * operator's browser is most likely to be holding.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_PLACEMENT, parsePlacement } from './useFloatingPlacement';

describe('parsePlacement', () => {
  it('reads a placed, open panel', () => {
    expect(parsePlacement('{"open":true,"at":{"x":40,"y":90}}')).toEqual({
      open: true,
      at: { x: 40, y: 90 },
    });
  });

  it('reads a collapsed panel', () => {
    expect(parsePlacement('{"open":false,"at":null}')).toEqual({ open: false, at: null });
  });

  it('defaults to open and unplaced when there is nothing stored', () => {
    expect(parsePlacement(null)).toEqual(DEFAULT_PLACEMENT);
  });

  it('still understands the bare open/closed string the point key used to write', () => {
    expect(parsePlacement('open')).toEqual({ open: true, at: null });
    expect(parsePlacement('closed')).toEqual({ open: false, at: null });
  });

  it('falls back rather than throwing on anything corrupt', () => {
    // A full disk, a truncated write, a hand-edited entry. None of these may
    // stop the control plane rendering — it is the one view that has to come
    // up unattended.
    expect(parsePlacement('{"open":true,')).toEqual(DEFAULT_PLACEMENT);
    expect(parsePlacement('null')).toEqual(DEFAULT_PLACEMENT);
    expect(parsePlacement('[]')).toEqual({ open: true, at: null });
  });

  it('drops a position that is not two finite numbers, keeping the open state', () => {
    // Half a coordinate is not a position. The panel comes back at its default
    // corner rather than at NaN, where it would be unreachable and undraggable.
    expect(parsePlacement('{"open":false,"at":{"x":10}}')).toEqual({ open: false, at: null });
    expect(parsePlacement('{"open":true,"at":{"x":null,"y":4}}')).toEqual({ open: true, at: null });
  });
});
