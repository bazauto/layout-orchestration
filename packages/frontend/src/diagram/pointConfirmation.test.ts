import { describe, expect, it } from 'vitest';
import { effectivePosition } from './pointConfirmation';
import { PointState } from '../types';

function point(overrides: Partial<PointState> = {}): PointState {
  return {
    pointId: 'p1',
    commandedPosition: null,
    confirmedPosition: 'unknown',
    confirmation: 'unreported',
    positionFeedback: 'none',
    awaitingSince: null,
    lastReadingAt: null,
    locked: false,
    lockedByRoute: null,
    lastUpdated: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('effectivePosition', () => {
  it('a required point trusts confirmedPosition, full stop', () => {
    expect(
      effectivePosition(
        point({ positionFeedback: 'required', commandedPosition: 'reverse', confirmedPosition: 'normal', confirmation: 'mismatch' }),
      ),
    ).toBe('normal');
  });

  it('a required point that timed out is unknown even though it was commanded — commandedPosition never substitutes', () => {
    expect(
      effectivePosition(
        point({
          positionFeedback: 'required',
          commandedPosition: 'reverse',
          confirmedPosition: 'unknown',
          confirmation: 'timed-out',
        }),
      ),
    ).toBe('unknown');
  });

  it('a none point with a confirmed reading trusts it', () => {
    expect(
      effectivePosition(
        point({ positionFeedback: 'none', commandedPosition: 'normal', confirmedPosition: 'reverse', confirmation: 'confirmed' }),
      ),
    ).toBe('reverse');
  });

  it('a none point that never reported falls back to commandedPosition — the pre-#25 trust model', () => {
    expect(
      effectivePosition(
        point({ positionFeedback: 'none', commandedPosition: 'reverse', confirmedPosition: 'unknown', confirmation: 'unreported' }),
      ),
    ).toBe('reverse');
  });

  it('a none point never commanded and never reported is unknown', () => {
    expect(effectivePosition(point({ positionFeedback: 'none' }))).toBe('unknown');
  });

  it('a mismatch reports the reported position, not the commanded one', () => {
    expect(
      effectivePosition(
        point({
          positionFeedback: 'required',
          commandedPosition: 'normal',
          confirmedPosition: 'reverse',
          confirmation: 'mismatch',
        }),
      ),
    ).toBe('reverse');
  });
});
