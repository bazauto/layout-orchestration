/**
 * `DccLinkService` — the stateful half of #148 (`docs/dcc-link.md`).
 *
 * The pure decisions are tested in `tests/unit/domain/dccLink.test.ts`. What is
 * tested here is the bookkeeping those decisions run on: what latches, what
 * merely warns, what a rejection is attributed to, and — the case that cost a
 * debugging round — that a routine probe reply is not mistaken for a station
 * reboot.
 */

import { describe, expect, it } from 'vitest';
import { DccLinkService } from '../../../src/services/DccLinkService';
import { DccCommandContext, DCC_LINK_TIMEOUT_MS } from '../../../src/domain/dccLink';
import { DccResponse } from '../../../src/domain/dccResponse';

const T0 = new Date('2026-08-23T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

const throttle = (overrides: Partial<DccCommandContext> = {}): DccCommandContext => ({
  kind: 'throttle',
  command: '<t 3 50 1>',
  locoAddress: 3,
  speedStep: 50,
  direction: 'fwd',
  pointId: null,
  routeId: null,
  ...overrides,
});

const probe = (): DccCommandContext => ({
  kind: 'probe',
  command: '<s>',
  locoAddress: null,
  speedStep: null,
  direction: null,
  pointId: null,
  routeId: null,
});

const identity = (commit: string): DccResponse => ({
  kind: 'identity',
  version: '5.0.0',
  product: 'PICODCC',
  commit,
  raw: `<iDCC-EX V-5.0.0 / PICODCC / G-${commit}>`,
});

const cab = (cabAddress: number, speedByte: number): DccResponse => ({
  kind: 'cab',
  cab: cabAddress,
  register: 0,
  speedByte,
  speed: { step: (speedByte & 0x7f) - 1 },
  direction: (speedByte & 0x80) === 0x80 ? 'fwd' : 'rev',
  functionMap: 0,
});

/** Drives one probe/reply round trip, the way `LayoutService`'s sweep does. */
function probeAndAnswer(service: DccLinkService, ms: number, commit = 'abc1234') {
  service.recordCommand(probe(), at(ms));
  return service.handleResponse(identity(commit), at(ms));
}

describe('DccLinkService — acknowledgements', () => {
  it('settles a throttle command and reports nothing when the reply matches', () => {
    const service = new DccLinkService();
    service.recordCommand(throttle(), T0);
    const effects = service.handleResponse(cab(3, 179), T0);

    expect(service.outstandingCount()).toBe(0);
    expect(effects.warnings).toEqual([]);
    expect(effects.routeFaults).toEqual([]);
    expect(service.getHealth().fault).toBeNull();
  });

  it('latches a cab mismatch and Safe-Stop-bearing health change', () => {
    const service = new DccLinkService();
    service.recordCommand(throttle(), T0);
    const effects = service.handleResponse(cab(1, 179), T0);

    expect(effects.healthChanged).toBe(true);
    expect(service.getHealth().fault).toMatchObject({ kind: 'cab-mismatch', locoAddress: 3 });
  });

  it('warns but does not latch on a speed disagreement (D6)', () => {
    const service = new DccLinkService();
    service.recordCommand(throttle(), T0);
    const effects = service.handleResponse(cab(3, 177), T0);

    expect(service.getHealth().fault).toBeNull();
    expect(effects.warnings).toHaveLength(1);
    expect(effects.warnings[0].data).toMatchObject({ field: 'speed' });
  });
});

describe('DccLinkService — rejections', () => {
  it('faults the route a rejected throttle command belonged to, and latches nothing on the link', () => {
    const service = new DccLinkService();
    service.recordCommand(throttle({ routeId: 'r1' }), T0);
    const effects = service.handleResponse({ kind: 'rejected' }, T0);

    expect(effects.routeFaults).toEqual([
      {
        routeId: 'r1',
        kind: 'dcc-command-rejected',
        reason: expect.stringContaining('<t 3 50 1>'),
        locoAddress: 3,
        pointId: null,
      },
    ]);
    expect(service.getHealth().fault).toBeNull();
  });

  it('reports a rejected point command as point-command-rejected — that is exactly what it is', () => {
    const service = new DccLinkService();
    service.recordCommand(
      throttle({
        kind: 'accessory',
        command: '<a 12 0 1>',
        pointId: 'p1',
        routeId: 'r1',
        locoAddress: 9,
      }),
      T0,
    );
    const effects = service.handleResponse({ kind: 'rejected' }, T0);
    expect(effects.routeFaults[0]).toMatchObject({ kind: 'point-command-rejected', pointId: 'p1' });
  });

  it('latches on the link when a rejected command has no route behind it', () => {
    const service = new DccLinkService();
    service.recordCommand(throttle(), T0);
    service.handleResponse({ kind: 'rejected' }, T0);
    expect(service.getHealth().fault).toMatchObject({ kind: 'command-rejected', locoAddress: 3 });
  });

  it('latches an unattributed rejection rather than swallowing it', () => {
    const service = new DccLinkService();
    service.handleResponse({ kind: 'rejected' }, T0);
    expect(service.getHealth().fault).toMatchObject({ kind: 'unattributed-rejection' });
  });

  it('keeps the FIRST cause when a second fault follows', () => {
    const service = new DccLinkService();
    service.handleResponse({ kind: 'rejected' }, T0);
    service.recordCommand(throttle(), at(10));
    service.handleResponse(cab(1, 179), at(10));
    expect(service.getHealth().fault).toMatchObject({ kind: 'unattributed-rejection' });
  });
});

describe('DccLinkService — liveness', () => {
  it('declares the link lost after the timeout and latches it', () => {
    const service = new DccLinkService();
    probeAndAnswer(service, 0);

    service.recordCommand(probe(), at(DCC_LINK_TIMEOUT_MS));
    const effects = service.sweep(at(DCC_LINK_TIMEOUT_MS + 1));

    expect(effects.healthChanged).toBe(true);
    expect(service.getHealth().responsive).toBe(false);
    expect(service.getHealth().fault).toMatchObject({ kind: 'link-lost' });
  });

  it('recovers responsiveness the moment anything arrives — any frame is evidence of life', () => {
    const service = new DccLinkService();
    service.recordCommand(probe(), T0);
    service.sweep(at(DCC_LINK_TIMEOUT_MS + 1));
    expect(service.getHealth().responsive).toBe(false);

    const effects = service.handleResponse({ kind: 'accessory-ok' }, at(DCC_LINK_TIMEOUT_MS + 2));
    expect(effects.healthChanged).toBe(true);
    expect(service.getHealth().responsive).toBe(true);
    // The latch survives the recovery — that is what a latch is for.
    expect(service.getHealth().fault).toMatchObject({ kind: 'link-lost' });
  });

  it('expires a command that never got a verdict, with a warning and no fault', () => {
    const service = new DccLinkService();
    service.recordCommand(throttle(), T0);
    const effects = service.sweep(at(4000));

    expect(service.outstandingCount()).toBe(0);
    expect(effects.warnings).toHaveLength(1);
    expect(service.getHealth().fault).toBeNull();
  });
});

describe('DccLinkService — identity and restarts', () => {
  it('does not mistake a routine probe reply for a restart', () => {
    // The regression this test exists for: the settled probe is removed from
    // the queue before the identity is examined, so asking the queue whether
    // the banner was solicited reported every probe reply as a reboot — a
    // Safe-Stop every five seconds.
    const service = new DccLinkService();
    probeAndAnswer(service, 0);
    probeAndAnswer(service, 5000);
    probeAndAnswer(service, 10_000);

    expect(service.getHealth().fault).toBeNull();
    expect(service.getHealth().restartCount).toBe(0);
  });

  it('latches a restart on an unprompted banner', () => {
    const service = new DccLinkService();
    probeAndAnswer(service, 0);

    service.handleResponse(identity('abc1234'), at(3000));

    expect(service.getHealth().restartCount).toBe(1);
    expect(service.getHealth().fault).toMatchObject({ kind: 'station-restarted' });
  });

  it('latches a restart when a solicited banner reports a different build', () => {
    const service = new DccLinkService();
    probeAndAnswer(service, 0, 'aaaaaaa');
    probeAndAnswer(service, 5000, 'bbbbbbb');

    expect(service.getHealth().fault).toMatchObject({ kind: 'station-restarted' });
    expect(service.getHealth().fault?.reason).toMatch(/bbbbbbb.*aaaaaaa/);
  });

  it('records the identity without faulting the first time it is seen', () => {
    const service = new DccLinkService();
    probeAndAnswer(service, 0, 'abc1234');
    expect(service.getHealth().identity).toMatchObject({ commit: 'abc1234' });
    expect(service.getHealth().fault).toBeNull();
  });
});

describe('DccLinkService — power observation', () => {
  it('records both track power states and warns when the main track goes dark', () => {
    const service = new DccLinkService();
    const effects = service.handleResponse({ kind: 'power', track: 'main', on: false }, T0);

    expect(service.getHealth().mainPowerOn).toBe(false);
    expect(effects.warnings[0].message).toMatch(/Main track power is off/);
  });

  it('does not make a dark track unresponsive — that gating is #149, not this issue', () => {
    const service = new DccLinkService();
    service.handleResponse({ kind: 'power', track: 'main', on: false }, T0);
    expect(service.getHealth().responsive).toBe(true);
    expect(service.getHealth().fault).toBeNull();
  });

  it('starts with both power states null — never observed is not the same as off', () => {
    const health = new DccLinkService().getHealth();
    expect(health.mainPowerOn).toBeNull();
    expect(health.progPowerOn).toBeNull();
  });
});

describe('DccLinkService — acknowledge', () => {
  it('clears the latch and reports what was cleared', () => {
    const service = new DccLinkService();
    service.handleResponse({ kind: 'rejected' }, T0);

    expect(service.acknowledgeFault()).toMatchObject({ kind: 'unattributed-rejection' });
    expect(service.getHealth().fault).toBeNull();
  });

  it('answers null when there is nothing latched', () => {
    expect(new DccLinkService().acknowledgeFault()).toBeNull();
  });

  it('cannot outrun the evidence: acknowledging a lost link re-latches on the next sweep', () => {
    const service = new DccLinkService();
    service.recordCommand(probe(), T0);
    service.sweep(at(DCC_LINK_TIMEOUT_MS + 1));
    service.acknowledgeFault();

    service.sweep(at(DCC_LINK_TIMEOUT_MS + 2));
    // Still silent, so `responsive` is still false and Safe-Stop still holds —
    // even though the latch itself was not re-raised (it re-raises on the
    // transition, and the link never became responsive in between).
    expect(service.getHealth().responsive).toBe(false);
  });
});

describe('DccLinkService — emergency stop', () => {
  it('clears the queue, so a stale command cannot absorb the next rejection', () => {
    const service = new DccLinkService();
    service.recordCommand(throttle({ routeId: 'r1' }), T0);
    service.noteEmergencyStop(at(10));

    const effects = service.handleResponse({ kind: 'rejected' }, at(20));
    expect(effects.routeFaults).toEqual([]);
    expect(service.getHealth().fault).toMatchObject({ kind: 'command-rejected' });
  });
});
