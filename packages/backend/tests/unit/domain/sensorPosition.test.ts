/**
 * #77 — sub-block sensor position. See `docs/sensor-position.md` (D1–D12).
 *
 * The claims worth pinning here are all about what the system *declines* to
 * conclude: a fix is only ever taken from a rising edge, it decays to nothing
 * on its own, and every way of not having one — unmeasured, faulted, out of
 * service, anchored at the wrong neighbour, anchored ambiguously — resolves to
 * zero credited distance rather than to a guess or a refusal.
 */

import { describe, it, expect } from 'vitest';
import {
  MAX_CREDIBLE_SPEED_MM_PER_S,
  berthingBeamIn,
  creditedDistanceMm,
  isAnchorUnambiguous,
  leadDistanceMm,
  positionFixFrom,
  sensorPositionOf,
} from '../../../src/domain/sensorPosition';
import { buildTrackGraph } from '../../../src/domain/graph';
import { BlockEdge, SensorObservation } from '../../../src/domain/types';

const LAYOUT = 'layout-1';
const AT = new Date('2026-08-16T12:00:00.000Z');

function edge(overrides: Partial<BlockEdge> & Pick<BlockEdge, 'id'>): BlockEdge {
  return {
    layoutId: LAYOUT,
    fromBlockId: 'b1',
    fromEnd: 'east',
    toBlockId: 'b2',
    toEnd: 'west',
    pointConditions: [],
    ...overrides,
  };
}

/** b1 <-> b2 <-> b3, one row per direction, as the compiler emits them. */
function chain(): BlockEdge[] {
  return [
    edge({ id: 'e1', fromBlockId: 'b1', toBlockId: 'b2' }),
    edge({ id: 'e1r', fromBlockId: 'b2', toBlockId: 'b1', fromEnd: 'west', toEnd: 'east' }),
    edge({ id: 'e2', fromBlockId: 'b2', toBlockId: 'b3' }),
    edge({ id: 'e2r', fromBlockId: 'b3', toBlockId: 'b2', fromEnd: 'west', toEnd: 'east' }),
  ];
}

const graph = () => buildTrackGraph(LAYOUT, chain());

function observation(overrides: Partial<SensorObservation> = {}): SensorObservation {
  return {
    sensorId: 's1',
    blockId: 'b1',
    type: 'ir_position',
    inService: true,
    faulted: false,
    trusted: true,
    lastReading: 'occupied',
    lastReadingAt: AT,
    lastLiveReadingAt: AT,
    position: { towardBlockId: 'b2', offsetMm: 400 },
    lastRisingEdgeAt: AT,
    ...overrides,
  };
}

/** `AT` plus `seconds`, for readable decay assertions. */
const after = (seconds: number) => new Date(AT.getTime() + seconds * 1000);

// ─── sensorPositionOf (D5) ─────────────────────────────────────────────────────

describe('sensorPositionOf', () => {
  it('builds a position when both halves are present', () => {
    expect(sensorPositionOf('b2', 400)).toEqual({ towardBlockId: 'b2', offsetMm: 400 });
  });

  it('reads a HALF-SET pair as unmeasured, not as corruption', () => {
    // `ON DELETE SET NULL` on the anchor makes a stranded offset a legitimate
    // row, and the fail-safe reading of one is "we no longer know where this
    // is" — never "the database is broken".
    expect(sensorPositionOf(null, 400)).toBeNull();
    expect(sensorPositionOf('b2', null)).toBeNull();
    expect(sensorPositionOf(null, null)).toBeNull();
  });

  it('treats undefined exactly as null — every way of not having a measurement means the same thing', () => {
    expect(sensorPositionOf(undefined, undefined)).toBeNull();
    expect(sensorPositionOf('b2', undefined)).toBeNull();
  });
});

// ─── positionFixFrom (D6, D9) ──────────────────────────────────────────────────

describe('positionFixFrom', () => {
  it('builds a fix from a measured, contributing sensor that has seen a rising edge', () => {
    expect(positionFixFrom(observation())).toEqual({
      sensorId: 's1',
      blockId: 'b1',
      towardBlockId: 'b2',
      offsetMm: 400,
      at: AT,
    });
  });

  it('is null for an unmeasured sensor', () => {
    expect(positionFixFrom(observation({ position: null }))).toBeNull();
  });

  it('is null for a sensor that has never gone clear -> occupied', () => {
    expect(positionFixFrom(observation({ lastRisingEdgeAt: null }))).toBeNull();
  });

  it('is null for a sensor with no block — there is nothing for the offset to be within', () => {
    expect(positionFixFrom(observation({ blockId: null }))).toBeNull();
  });

  it('is null for a sensor the system has stopped trusting for occupancy (D9)', () => {
    // Exactly `isContributingSensor`'s rule, not a second one: a sensor whose
    // readings are discarded for occupancy must not still be crediting braking
    // distance.
    expect(positionFixFrom(observation({ inService: false }))).toBeNull();
    expect(positionFixFrom(observation({ faulted: true }))).toBeNull();
    expect(positionFixFrom(observation({ lastReading: null }))).toBeNull();
  });

  it('still yields a fix once the beam has gone clear again — the train passing is only elapsed time', () => {
    const fix = positionFixFrom(observation({ lastReading: 'clear', lastReadingAt: after(5) }));
    expect(fix?.at).toEqual(AT);
  });
});

// ─── creditedDistanceMm (D7) ───────────────────────────────────────────────────

describe('creditedDistanceMm', () => {
  const fix = () => positionFixFrom(observation())!;

  it('credits the full offset at the instant of the fix', () => {
    expect(creditedDistanceMm(fix(), AT)).toBe(400);
  });

  it('subtracts a worst-case travel allowance as the fix ages', () => {
    // 0.4s at 500mm/s = 200mm of allowance against a 400mm offset.
    expect(creditedDistanceMm(fix(), after(0.4))).toBeCloseTo(200, 6);
  });

  it('decays to zero on its own — there is no expiry constant and no cliff', () => {
    const exhaustedAfter = 400 / MAX_CREDIBLE_SPEED_MM_PER_S;
    expect(creditedDistanceMm(fix(), after(exhaustedAfter))).toBe(0);
    expect(creditedDistanceMm(fix(), after(exhaustedAfter * 10))).toBe(0);
    expect(creditedDistanceMm(fix(), after(3600))).toBe(0);
  });

  it('never credits MORE than the offset, however the clocks disagree', () => {
    // A fix stamped in the future must not read as extra distance.
    expect(creditedDistanceMm(fix(), after(-10))).toBe(400);
  });
});

// ─── isAnchorUnambiguous (D5) ──────────────────────────────────────────────────

describe('isAnchorUnambiguous', () => {
  it('is true for exactly one connection, counting one direction only', () => {
    // The compiler emits a row per direction; counting both would read every
    // ordinary joint as a duplicate.
    expect(isAnchorUnambiguous(graph(), 'b1', 'b2')).toBe(true);
  });

  it('is false when the two blocks are not connected at all', () => {
    expect(isAnchorUnambiguous(graph(), 'b1', 'b3')).toBe(false);
  });

  it('is false when they are connected in more than one place — "the boundary" is then not a definite description', () => {
    const looped = buildTrackGraph(LAYOUT, [
      ...chain(),
      edge({ id: 'e3', fromBlockId: 'b1', toBlockId: 'b2', fromEnd: 'north', toEnd: 'south' }),
    ]);
    expect(isAnchorUnambiguous(looped, 'b1', 'b2')).toBe(false);
  });
});

// ─── leadDistanceMm (D9) ───────────────────────────────────────────────────────

describe('leadDistanceMm', () => {
  it('credits an applicable fix', () => {
    expect(leadDistanceMm([observation()], graph(), 'b1', 'b2', AT)).toBe(400);
  });

  it('credits nothing when the fix is measured toward a DIFFERENT exit of the block', () => {
    // A beam 400mm from the b2 boundary says nothing about the distance to the
    // boundary the train is actually about to cross.
    const towardElsewhere = observation({ position: { towardBlockId: 'b3', offsetMm: 400 } });
    expect(leadDistanceMm([towardElsewhere], graph(), 'b1', 'b2', AT)).toBe(0);
  });

  it('credits nothing for a fix in another block', () => {
    expect(leadDistanceMm([observation({ blockId: 'b3' })], graph(), 'b1', 'b2', AT)).toBe(0);
  });

  it('credits nothing when the anchor is ambiguous, even with a fresh fix', () => {
    const looped = buildTrackGraph(LAYOUT, [
      ...chain(),
      edge({ id: 'e3', fromBlockId: 'b1', toBlockId: 'b2', fromEnd: 'north', toEnd: 'south' }),
    ]);
    expect(leadDistanceMm([observation()], looped, 'b1', 'b2', AT)).toBe(0);
  });

  it('credits nothing — never refuses — when there are no observations at all', () => {
    expect(leadDistanceMm([], graph(), 'b1', 'b2', AT)).toBe(0);
  });

  it('takes the MINIMUM across several applicable fixes, not the newest', () => {
    const far = observation({ sensorId: 's-far', position: { towardBlockId: 'b2', offsetMm: 900 } });
    const near = observation({ sensorId: 's-near', position: { towardBlockId: 'b2', offsetMm: 250 } });
    expect(leadDistanceMm([far, near], graph(), 'b1', 'b2', AT)).toBe(250);
    // Order must not matter — a minimum needs no argument about which
    // observation supersedes which.
    expect(leadDistanceMm([near, far], graph(), 'b1', 'b2', AT)).toBe(250);
  });

  it('lets a stale fix fall through to zero rather than refusing', () => {
    expect(leadDistanceMm([observation()], graph(), 'b1', 'b2', after(60))).toBe(0);
  });
});

// ─── berthingBeamIn (#7, docs/automation.md A3) ────────────────────────────────

describe('berthingBeamIn', () => {
  // The train arrives in b2 from b1. b2 is 1000mm long and joins b3 at its far
  // end, so both anchor directions are expressible against one fixture.
  const g = () => buildTrackGraph(LAYOUT, chain(), new Map([['b2', 1000]]));

  /** A beam in b2. Defaults to the terminal-platform form: measured back toward b1. */
  const beam = (overrides: Partial<SensorObservation> = {}) =>
    observation({
      sensorId: 'berth',
      blockId: 'b2',
      position: { towardBlockId: 'b1', offsetMm: 800 },
      ...overrides,
    });

  it('measures a beam anchored to the block the train arrives from as its offset', () => {
    // The operator's stated case: the platform road or goods shed, whose only
    // neighbour is the block behind it.
    expect(berthingBeamIn([beam()], g(), 'b2', 'b1', 1000)).toEqual({
      sensorId: 'berth',
      offsetMm: 800,
    });
  });

  it('measures a beam anchored to the FAR end as blockLength - offset', () => {
    const farAnchored = beam({ position: { towardBlockId: 'b3', offsetMm: 200 } });
    expect(berthingBeamIn([farAnchored], g(), 'b2', 'b1', 1000)).toEqual({
      sensorId: 'berth',
      offsetMm: 800,
    });
  });

  it('declines a far-end beam when the block has no measured length', () => {
    // No DEFAULT_BLOCK_LENGTH_MM here, for B4's reason: guessing a cost steers a
    // search, guessing a stopping point is a collision.
    const farAnchored = beam({ position: { towardBlockId: 'b3', offsetMm: 200 } });
    expect(berthingBeamIn([farAnchored], g(), 'b2', 'b1', undefined)).toBeNull();
  });

  it('still resolves a near-end beam when the block has no measured length', () => {
    // The near-end form needs no length — the offset IS the answer.
    expect(berthingBeamIn([beam()], g(), 'b2', 'b1', undefined)).toEqual({
      sensorId: 'berth',
      offsetMm: 800,
    });
  });

  it('declines a beam the system has stopped trusting', () => {
    expect(berthingBeamIn([beam({ inService: false })], g(), 'b2', 'b1', 1000)).toBeNull();
    expect(berthingBeamIn([beam({ faulted: true })], g(), 'b2', 'b1', 1000)).toBeNull();
  });

  it('declines a beam that has never reported at all', () => {
    // `isContributingSensor` again: a sensor with no reading has nothing to say
    // about occupancy, and is not one to stop a train against either.
    const neverRead = beam({ lastReading: null, lastReadingAt: null, lastRisingEdgeAt: null });
    expect(berthingBeamIn([neverRead], g(), 'b2', 'b1', 1000)).toBeNull();
  });

  it('declines an unmeasured beam', () => {
    expect(berthingBeamIn([beam({ position: null })], g(), 'b2', 'b1', 1000)).toBeNull();
  });

  it('declines a beam in another block', () => {
    expect(berthingBeamIn([beam({ blockId: 'b3' })], g(), 'b2', 'b1', 1000)).toBeNull();
  });

  it('declines an ambiguous anchor', () => {
    const looped = buildTrackGraph(
      LAYOUT,
      [
        ...chain(),
        edge({ id: 'e3', fromBlockId: 'b2', toBlockId: 'b1', fromEnd: 'north', toEnd: 'south' }),
      ],
      new Map([['b2', 1000]]),
    );
    expect(berthingBeamIn([beam()], looped, 'b2', 'b1', 1000)).toBeNull();
  });

  it('declines an offset longer than the block it is in', () => {
    // The write path refuses this (#77 D4), so reaching it means the block was
    // re-measured shorter afterwards. Declining stops the train at the boundary.
    const farAnchored = beam({ position: { towardBlockId: 'b3', offsetMm: 1400 } });
    expect(berthingBeamIn([farAnchored], g(), 'b2', 'b1', 1000)).toBeNull();
  });

  it('takes the beam NEAREST the entry boundary when several qualify', () => {
    const near = beam({ sensorId: 'near', position: { towardBlockId: 'b1', offsetMm: 300 } });
    const far = beam({ sensorId: 'far', position: { towardBlockId: 'b1', offsetMm: 800 } });
    expect(berthingBeamIn([far, near], g(), 'b2', 'b1', 1000)).toEqual({
      sensorId: 'near',
      offsetMm: 300,
    });
    // Order must not matter, for the same reason it must not in leadDistanceMm.
    expect(berthingBeamIn([near, far], g(), 'b2', 'b1', 1000)).toEqual({
      sensorId: 'near',
      offsetMm: 300,
    });
  });

  it('does NOT decay — a berth is a screwed-down beam, not an observation of a moving train', () => {
    // The asymmetry with `leadDistanceMm` is the whole of A3's last paragraph,
    // so it is asserted side by side rather than assumed. Same age, same
    // fixture, opposite answers.
    expect(leadDistanceMm([observation()], graph(), 'b1', 'b2', after(600))).toBe(0);
    expect(berthingBeamIn([beam()], g(), 'b2', 'b1', 1000)).toEqual({
      sensorId: 'berth',
      offsetMm: 800,
    });
  });

  it('returns null — never a refusal — when there are no observations at all', () => {
    expect(berthingBeamIn([], g(), 'b2', 'b1', 1000)).toBeNull();
  });
});
