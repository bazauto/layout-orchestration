import { describe, expect, it } from 'vitest';
import { PointRecord, PointState } from '../types';
import { buildPointKey } from './pointKey';

function point(id: string, name: string): PointRecord {
  return { id, layoutId: 'layout-1', name, dccAddress: 1, blockId: null } as PointRecord;
}

function state(pointId: string, over: Partial<PointState> = {}): PointState {
  return {
    pointId,
    commandedPosition: 'normal',
    confirmedPosition: 'normal',
    confirmation: 'confirmed',
    positionFeedback: 'none',
    awaitingSince: null,
    lastReadingAt: null,
    locked: false,
    lockedByRoute: null,
    lastUpdated: '2026-08-14T00:00:00.000Z',
    ...over,
  };
}

const states = (...s: PointState[]) => new Map(s.map((x) => [x.pointId, x]));

describe('buildPointKey', () => {
  it('carries the abbreviation the diagram draws, so the two can be matched by eye', () => {
    const rows = buildPointKey([point('p1', 'P1 - Fiddle Yard')], states(state('p1')));
    expect(rows[0].short).toBe('P1');
    expect(rows[0].name).toBe('P1 - Fiddle Yard');
  });

  it('abbreviates a name that does not follow the convention the same way the tile does', () => {
    const rows = buildPointKey([point('p1', 'Yard Throat')], states(state('p1')));
    expect(rows[0].short).toBe('Yard Th…');
  });

  it('reports the effective position and the holding route', () => {
    const rows = buildPointKey(
      [point('p1', 'P1')],
      states(state('p1', { confirmedPosition: 'reverse', locked: true, lockedByRoute: 'route-7' })),
    );
    expect(rows[0].position).toBe('reverse');
    expect(rows[0].lockedByRoute).toBe('route-7');
  });

  /**
   * Absence of a position is not evidence of a position. `normal` would be a
   * guess, and the whole system's posture on an unobserved state is the
   * fail-safe reading.
   */
  it('reads a point with no live state as unknown, never as normal', () => {
    const rows = buildPointKey([point('p1', 'P1')], new Map());
    expect(rows[0].position).toBe('unknown');
    expect(rows[0].confirmation).toBe('unreported');
    expect(rows[0].positionFeedback).toBe('none');
    expect(rows[0].lockedByRoute).toBeNull();
  });

  /** #25 D7 — the row is `effectivePosition`, not the raw `confirmedPosition`. */
  it('falls back to the commanded position for a none-feedback point that never reported', () => {
    const rows = buildPointKey(
      [point('p1', 'P1')],
      states(
        state('p1', {
          positionFeedback: 'none',
          commandedPosition: 'reverse',
          confirmedPosition: 'unknown',
          confirmation: 'unreported',
        }),
      ),
    );
    expect(rows[0].position).toBe('reverse');
    expect(rows[0].confirmation).toBe('unreported');
  });

  /** #25 D7 — a required point never substitutes the commanded field, even in the key. */
  it('reports unknown for a required point that timed out, not the commanded position', () => {
    const rows = buildPointKey(
      [point('p1', 'P1')],
      states(
        state('p1', {
          positionFeedback: 'required',
          commandedPosition: 'reverse',
          confirmedPosition: 'unknown',
          confirmation: 'timed-out',
        }),
      ),
    );
    expect(rows[0].position).toBe('unknown');
    expect(rows[0].confirmation).toBe('timed-out');
    expect(rows[0].positionFeedback).toBe('required');
  });

  /** docs/naming.md D8 — degrade to the raw id, never to nothing. */
  it('still lists a live point that has no roster record, named by its id', () => {
    const rows = buildPointKey([], states(state('p-orphan', { confirmedPosition: 'reverse' })));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('p-orphan');
    expect(rows[0].position).toBe('reverse');
  });

  it('sorts numerically, so P2 precedes P10', () => {
    const rows = buildPointKey(
      [point('a', 'P10 - Yard'), point('b', 'P2 - Platform'), point('c', 'P1 - Shed')],
      new Map(),
    );
    expect(rows.map((r) => r.name)).toEqual(['P1 - Shed', 'P2 - Platform', 'P10 - Yard']);
  });

  it('does not duplicate a point present in both the roster and the snapshot', () => {
    const rows = buildPointKey([point('p1', 'P1')], states(state('p1')));
    expect(rows).toHaveLength(1);
  });
});
