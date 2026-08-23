/**
 * Correlation, verification and liveness (#148, `docs/dcc-link.md`).
 *
 * The load-bearing case in this file is `verifyCabAck`'s cab check. It is the
 * only thing in the system that can observe #147's failure — a command aimed at
 * one loco acknowledged against another — rather than reason about it, so its
 * test is written as the observation: send for loco 3, hear back about loco 1.
 */

import { describe, expect, it } from 'vitest';
import {
  DccCommandContext,
  evaluateLinkLiveness,
  expireOutstanding,
  OutstandingCommand,
  resolveResponse,
  verifyCabAck,
} from '../../../src/domain/dccLink';
import { DccResponse } from '../../../src/domain/dccResponse';

const AT = new Date('2026-08-23T10:00:00.000Z');

function command(overrides: Partial<OutstandingCommand> = {}): OutstandingCommand {
  const base: DccCommandContext = {
    kind: 'throttle',
    command: '<t 3 50 1>',
    locoAddress: 3,
    speedStep: 50,
    direction: 'fwd',
    pointId: null,
    routeId: null,
  };
  return { ...base, seq: 1, sentAt: AT, ...overrides };
}

const cabReply = (cab: number, speedByte: number): DccResponse => ({
  kind: 'cab',
  cab,
  register: 0,
  speedByte,
  speed: (speedByte & 0x7f) === 0 ? { step: 0 } : { step: (speedByte & 0x7f) - 1 },
  direction: (speedByte & 0x80) === 0x80 ? 'fwd' : 'rev',
  functionMap: 0,
});

describe('resolveResponse', () => {
  it('pairs a cab reply with the oldest outstanding throttle', () => {
    const outstanding = [command({ seq: 1 }), command({ seq: 2, locoAddress: 7 })];
    const resolution = resolveResponse(outstanding, cabReply(3, 179));
    expect(resolution).toMatchObject({ outcome: 'ack', index: 0 });
  });

  it('pairs by POSITION, not by cab — otherwise a wrong-loco reply looks like chatter', () => {
    // This is the whole point. Matching on cab would find no outstanding
    // command for loco 1, file the reply as unsolicited, and #147 would run for
    // another six months.
    const resolution = resolveResponse([command()], cabReply(1, 179));
    expect(resolution.outcome).toBe('ack');
    expect(resolution).toMatchObject({
      verification: { ok: false, severity: 'critical', field: 'cab' },
    });
  });

  it('treats a cab reply with nothing outstanding as unsolicited', () => {
    expect(resolveResponse([], cabReply(3, 179))).toEqual({ outcome: 'unsolicited' });
  });

  it('lets an outstanding emergency stop absorb the cab replies it provokes', () => {
    // `<!>` answers with one <l> per loco the station was reminding. Verifying
    // those against a throttle command would report a mismatch on every one.
    const outstanding = [
      command({ seq: 1, kind: 'emergency-stop', command: '<!>', locoAddress: null }),
      command({ seq: 2 }),
    ];
    expect(resolveResponse(outstanding, cabReply(9, 128))).toEqual({ outcome: 'unsolicited' });
  });

  it('pairs an accessory acknowledgement with the oldest outstanding accessory command', () => {
    const outstanding = [command({ seq: 1 }), command({ seq: 2, kind: 'accessory' })];
    expect(resolveResponse(outstanding, { kind: 'accessory-ok' })).toMatchObject({
      outcome: 'ack',
      index: 1,
    });
  });

  it('attributes a rejection to the oldest outstanding command of any kind', () => {
    const outstanding = [command({ seq: 1, kind: 'accessory' }), command({ seq: 2 })];
    expect(resolveResponse(outstanding, { kind: 'rejected' })).toEqual({
      outcome: 'reject',
      index: 0,
    });
  });

  it('reports a rejection with nothing outstanding as unattributable', () => {
    expect(resolveResponse([], { kind: 'rejected' })).toEqual({ outcome: 'reject', index: null });
  });

  it('treats an unprompted power report as unsolicited — the station has its own buttons', () => {
    expect(resolveResponse([], { kind: 'power', track: 'main', on: false })).toEqual({
      outcome: 'unsolicited',
    });
  });

  it('pairs an identity with an outstanding probe', () => {
    const outstanding = [command({ seq: 1, kind: 'probe', command: '<s>', locoAddress: null })];
    const identity: DccResponse = {
      kind: 'identity',
      version: '5.0.0',
      product: 'PICODCC',
      commit: 'abc',
      raw: '<i…>',
    };
    expect(resolveResponse(outstanding, identity)).toMatchObject({ outcome: 'ack', index: 0 });
  });
});

describe('verifyCabAck', () => {
  it('passes a reply that matches the command', () => {
    expect(verifyCabAck(command(), cabReply(3, 179) as never)).toEqual({ ok: true });
  });

  it('calls a cab disagreement critical', () => {
    const result = verifyCabAck(command(), cabReply(1, 179) as never);
    expect(result).toMatchObject({ ok: false, severity: 'critical', expected: 3, actual: 1 });
    expect('reason' in result && result.reason).toMatch(/loco 1 for a command addressed to loco 3/);
  });

  it('calls a speed disagreement advisory, not critical (D6)', () => {
    // Deliberate: the speed byte's encoding changed in PicoDCC#49, #48 is open,
    // and #151 will change the step mode again. This must not Safe-Stop a live
    // layout over a firmware version skew.
    const result = verifyCabAck(command(), cabReply(3, 177) as never);
    expect(result).toMatchObject({ ok: false, severity: 'advisory', field: 'speed' });
  });

  it('calls a direction disagreement advisory too', () => {
    expect(verifyCabAck(command(), cabReply(3, 51) as never)).toMatchObject({
      ok: false,
      severity: 'advisory',
      field: 'direction',
    });
  });

  it("checks a 'stop' command against speed 0 with the forward bit, as sent", () => {
    const stopping = command({ speedStep: 40, direction: 'stop' });
    expect(verifyCabAck(stopping, cabReply(3, 128) as never)).toEqual({ ok: true });
  });

  it('checks nothing about speed when the command carried none', () => {
    const probe = command({ speedStep: null, direction: null });
    expect(verifyCabAck(probe, cabReply(3, 255) as never)).toEqual({ ok: true });
  });
});

describe('evaluateLinkLiveness', () => {
  const at = (ms: number) => new Date(AT.getTime() + ms);

  it('is responsive before anything has been asked', () => {
    // Safe rather than optimistic: `dccConnected` is false until a port opens
    // and Safe-Stops on its own, so this cannot hide an absent station.
    expect(
      evaluateLinkLiveness({ lastResponseAt: null, lastProbeSentAt: null }, at(0), 15000),
    ).toEqual({
      responsive: true,
      reason: null,
    });
  });

  it('stays responsive while replies keep arriving', () => {
    const result = evaluateLinkLiveness(
      { lastResponseAt: at(10_000), lastProbeSentAt: at(10_000) },
      at(12_000),
      15000,
    );
    expect(result.responsive).toBe(true);
  });

  it('goes unresponsive once silence passes the timeout', () => {
    const result = evaluateLinkLiveness(
      { lastResponseAt: at(0), lastProbeSentAt: at(15_000) },
      at(16_000),
      15000,
    );
    expect(result.responsive).toBe(false);
    expect(result.reason).toMatch(/has not answered for 16s/);
  });

  it('distinguishes never having answered from having stopped', () => {
    const result = evaluateLinkLiveness(
      { lastResponseAt: null, lastProbeSentAt: at(0) },
      at(20_000),
      15000,
    );
    expect(result.responsive).toBe(false);
    expect(result.reason).toMatch(/never answered/);
  });

  it('is exactly at the boundary still responsive, not one tick early', () => {
    const result = evaluateLinkLiveness(
      { lastResponseAt: at(0), lastProbeSentAt: at(0) },
      at(15_000),
      15000,
    );
    expect(result.responsive).toBe(true);
  });
});

describe('expireOutstanding', () => {
  it('drops commands past the timeout and keeps the rest, in order', () => {
    const old = command({ seq: 1, sentAt: new Date(AT.getTime() - 10_000) });
    const fresh = command({ seq: 2, sentAt: AT });
    const { expired, remaining } = expireOutstanding([old, fresh], AT, 3000);
    expect(expired.map((c) => c.seq)).toEqual([1]);
    expect(remaining.map((c) => c.seq)).toEqual([2]);
  });
});
