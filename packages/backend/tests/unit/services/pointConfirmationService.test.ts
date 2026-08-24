import { describe, it, expect, beforeEach } from 'vitest';
import { PointConfirmationService } from '../../../src/services/PointConfirmationService';
import { LayoutStateManager } from '../../../src/domain/layoutState';
import { PointConfirmationPolicy } from '../../../src/domain/pointConfirmation';
import { PointReading } from '../../../src/domain/types';

const NOW = new Date('2026-08-14T00:00:00.000Z');
const POLICY: PointConfirmationPolicy = { timeoutMs: 8000, freshnessTimeoutMs: 90_000 };

function reading(overrides: Partial<PointReading> = {}): PointReading {
  return {
    pointId: 'p1',
    position: 'normal',
    source: 'sensor',
    reportedAt: null,
    ...overrides,
  };
}

describe('PointConfirmationService', () => {
  let stateManager: LayoutStateManager;
  let service: PointConfirmationService;

  beforeEach(() => {
    stateManager = new LayoutStateManager('layout-1');
    service = new PointConfirmationService(stateManager, POLICY);
  });

  // ─── noteCommanded ──────────────────────────────────────────────────────

  describe('noteCommanded', () => {
    it("arms a deadline on a 'required' point and stores the result in state", () => {
      stateManager.registerPoint('p1', 'required', NOW);
      const result = service.noteCommanded('p1', 'reverse', NOW);
      expect(result?.commandedPosition).toBe('reverse');
      expect(result?.confirmation).toBe('pending');
      expect(stateManager.getPoint('p1')?.confirmation).toBe('pending');
    });

    it('returns null for an unregistered point id and mutates nothing', () => {
      const result = service.noteCommanded('ghost', 'normal', NOW);
      expect(result).toBeNull();
      expect(stateManager.getPoint('ghost')).toBeUndefined();
    });
  });

  // ─── noteQueried ────────────────────────────────────────────────────────

  describe('noteQueried', () => {
    it('does not arm a deadline (D6)', () => {
      stateManager.registerPoint('p1', 'required', NOW);
      const result = service.noteQueried('p1', NOW);
      expect(result?.confirmation).toBe('unreported');
      expect(result?.awaitingSince).toBeNull();
    });

    it('returns null for an unregistered point id', () => {
      expect(service.noteQueried('ghost', NOW)).toBeNull();
    });
  });

  // ─── applyReading ───────────────────────────────────────────────────────

  describe('applyReading', () => {
    it('applies a confirming reading, stores it, and reports arms: true', () => {
      stateManager.registerPoint('p1', 'required', NOW);
      service.noteCommanded('p1', 'normal', NOW);

      const outcome = service.applyReading('p1', reading({ position: 'normal' }), NOW, false);

      expect(outcome.rejection).toBeNull();
      expect(outcome.arms).toBe(true);
      expect(outcome.point).not.toBeNull();
      expect(outcome.point?.confirmation).toBe('confirmed');
      expect(stateManager.getPoint('p1')?.confirmation).toBe('confirmed');
    });

    it('applies a mismatched reading, storing the REPORTED position, and reports arms: false', () => {
      stateManager.registerPoint('p1', 'required', NOW);
      service.noteCommanded('p1', 'normal', NOW);

      const outcome = service.applyReading('p1', reading({ position: 'reverse' }), NOW, false);

      expect(outcome.rejection).toBeNull();
      expect(outcome.arms).toBe(false);
      expect(outcome.point?.confirmation).toBe('mismatch');
      expect(outcome.point?.confirmedPosition).toBe('reverse');
    });

    // ── Failure paths ──────────────────────────────────────────────────

    it('an unregistered point id returns unknown-point and mutates nothing', () => {
      const outcome = service.applyReading('ghost', reading({ pointId: 'ghost' }), NOW, false);
      expect(outcome.point).toBeNull();
      expect(outcome.rejection).toEqual({ kind: 'unknown-point', pointId: 'ghost' });
      expect(outcome.arms).toBe(false);
      expect(stateManager.getPoint('ghost')).toBeUndefined();
    });

    it('a payload/topic id mismatch updates NEITHER point', () => {
      stateManager.registerPoint('p1', 'required', NOW);
      stateManager.registerPoint('p2', 'required', NOW);
      const before1 = stateManager.getPoint('p1');
      const before2 = stateManager.getPoint('p2');

      const outcome = service.applyReading('p1', reading({ pointId: 'p2', position: 'reverse' }), NOW, false);

      expect(outcome.point).toBeNull();
      expect(outcome.rejection).toEqual({ kind: 'id-mismatch', topicPointId: 'p1', payloadPointId: 'p2' });
      expect(outcome.arms).toBe(false);
      expect(stateManager.getPoint('p1')).toEqual(before1);
      expect(stateManager.getPoint('p2')).toEqual(before2);
    });

    it('a retained reading is dropped (D1): no rejection, no state change, does not arm', () => {
      stateManager.registerPoint('p1', 'required', NOW);
      service.noteCommanded('p1', 'normal', NOW);
      const before = stateManager.getPoint('p1');

      const outcome = service.applyReading('p1', reading({ position: 'normal' }), NOW, true);

      expect(outcome.point).toBeNull();
      expect(outcome.rejection).toBeNull();
      expect(outcome.arms).toBe(false);
      expect(stateManager.getPoint('p1')).toEqual(before); // unchanged — still pending
    });

    it("an 'unknown' reading is indeterminate, is stored, and does not arm", () => {
      stateManager.registerPoint('p1', 'required', NOW);
      service.noteCommanded('p1', 'normal', NOW);

      const outcome = service.applyReading('p1', reading({ position: 'unknown' }), NOW, false);

      expect(outcome.rejection).toBeNull();
      expect(outcome.arms).toBe(false);
      expect(outcome.point?.confirmation).toBe('indeterminate');
    });

    it("a driver-sourced reading on a 'required' point is indeterminate and does not arm", () => {
      stateManager.registerPoint('p1', 'required', NOW);
      service.noteCommanded('p1', 'normal', NOW);

      const outcome = service.applyReading('p1', reading({ position: 'normal', source: 'driver' }), NOW, false);

      expect(outcome.point?.confirmation).toBe('indeterminate');
      expect(outcome.arms).toBe(false);
    });

    it("a driver-sourced reading on a 'none' point IS confirmed and arms", () => {
      stateManager.registerPoint('p1', 'none', NOW);
      service.noteCommanded('p1', 'normal', NOW);

      const outcome = service.applyReading('p1', reading({ position: 'normal', source: 'driver' }), NOW, false);

      expect(outcome.point?.confirmation).toBe('confirmed');
      expect(outcome.arms).toBe(true);
    });
  });

  // ─── sweep ──────────────────────────────────────────────────────────────

  describe('sweep', () => {
    it('returns only points that transitioned, not the whole layout', () => {
      stateManager.registerPoint('p1', 'required', NOW); // unreported — not pending
      const commanded = new Date(NOW.getTime());
      stateManager.registerPoint('p2', 'required', commanded);
      service.noteCommanded('p2', 'normal', commanded); // pending, due at +8000ms
      stateManager.registerPoint('p3', 'none', NOW); // 'none' never arms a deadline

      const early = new Date(commanded.getTime() + 1000);
      expect(service.sweep(early)).toEqual([]);

      const due = new Date(commanded.getTime() + 8000);
      const transitioned = service.sweep(due);
      expect(transitioned).toHaveLength(1);
      expect(transitioned[0].pointId).toBe('p2');
      expect(transitioned[0].confirmation).toBe('timed-out');
      expect(stateManager.getPoint('p2')?.confirmation).toBe('timed-out');
      // p1 (never commanded) and p3 ('none') are untouched.
      expect(stateManager.getPoint('p1')?.confirmation).toBe('unreported');
      expect(stateManager.getPoint('p3')?.confirmation).toBe('unreported');
    });

    it('a "none" point commanded and never reporting stays trusted — no timeout, ever (regression guard)', () => {
      stateManager.registerPoint('p1', 'none', NOW);
      service.noteCommanded('p1', 'normal', NOW);
      const farFuture = new Date(NOW.getTime() + 1_000_000);
      expect(service.sweep(farFuture)).toEqual([]);
      expect(stateManager.getPoint('p1')?.confirmation).toBe('unreported');
    });

    it('returns [] when nothing is pending', () => {
      stateManager.registerPoint('p1', 'required', NOW);
      expect(service.sweep(NOW)).toEqual([]);
    });
  });

  // ─── pointsRequiringFeedback ────────────────────────────────────────────

  describe('pointsRequiringFeedback', () => {
    it('lists only the points configured required', () => {
      stateManager.registerPoint('p1', 'required', NOW);
      stateManager.registerPoint('p2', 'none', NOW);
      stateManager.registerPoint('p3', 'required', NOW);
      expect(service.pointsRequiringFeedback().sort()).toEqual(['p1', 'p3']);
    });

    it('returns [] when no points are registered', () => {
      expect(service.pointsRequiringFeedback()).toEqual([]);
    });
  });

  // ─── awaitingSince invariant across the service's transitions ─────────────

  describe('awaitingSince invariant (awaitingSince !== null iff confirmation === pending)', () => {
    it('holds across noteCommanded -> applyReading -> sweep', () => {
      stateManager.registerPoint('p1', 'required', NOW);

      const commanded = service.noteCommanded('p1', 'normal', NOW)!;
      expect(commanded.confirmation).toBe('pending');
      expect(commanded.awaitingSince).not.toBeNull();

      const confirmed = service.applyReading('p1', reading({ position: 'normal' }), NOW, false).point!;
      expect(confirmed.confirmation).toBe('confirmed');
      expect(confirmed.awaitingSince).toBeNull();

      service.noteCommanded('p1', 'reverse', NOW);
      const timedOut = service.sweep(new Date(NOW.getTime() + 8000))[0];
      expect(timedOut.confirmation).toBe('timed-out');
      expect(timedOut.awaitingSince).toBeNull();
    });
  });
});
