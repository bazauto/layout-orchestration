/**
 * The wire format is a contract with the PicoDCC command station, so these
 * assertions are deliberately on the **literal bytes**, not on a re-derivation
 * of the format. A test that builds the expected string the same way the
 * implementation does would have passed happily through the whole of #147.
 *
 * Field *order* is the thing under test. The station parses three positional
 * integers with `sscanf` and has no way to notice a fourth, so a shifted field
 * is not a parse error — it is a different, valid, wrong command.
 */

import { describe, expect, it } from 'vitest';
import {
  formatEmergencyStop,
  formatSetFunction,
  formatSetPoint,
  formatSetSpeed,
  formatStatusRequest,
  formatTrackPower,
} from '../../../src/domain/dccWireFormat';

describe('formatSetSpeed', () => {
  it('emits the three-field DCC-EX throttle form', () => {
    expect(formatSetSpeed(3, 60, 'fwd')).toBe('<t 3 60 1>');
  });

  it('does not emit the legacy four-field register form (#147)', () => {
    // The regression itself: `<t 1 3 60 1>` parses as loco 1, speed 3, reverse.
    expect(formatSetSpeed(3, 60, 'fwd')).not.toBe('<t 1 3 60 1>');
    // Exactly four tokens between the brackets: opcode, cab, speed, direction.
    expect(formatSetSpeed(3, 60, 'fwd').slice(1, -1).split(' ')).toHaveLength(4);
  });

  it('puts the address in the cab field, not the speed field', () => {
    // A four-digit address landing in the speed slot is what aborts the
    // command station (bazauto/PicoDCC#2), so this is the load-bearing case.
    expect(formatSetSpeed(1234, 60, 'fwd')).toBe('<t 1234 60 1>');
  });

  it('sends direction 0 for reverse', () => {
    expect(formatSetSpeed(3, 60, 'rev')).toBe('<t 3 60 0>');
  });

  it('sends speed 0 for stop, keeping the forward direction bit', () => {
    expect(formatSetSpeed(3, 60, 'stop')).toBe('<t 3 0 1>');
  });

  it('keeps direction forward at speed 1', () => {
    // The old bug came out forward only when the speed happened to be 1, which
    // is why "it worked on the bench once" was not evidence of anything.
    expect(formatSetSpeed(3, 1, 'fwd')).toBe('<t 3 1 1>');
  });

  it('emits the ends of the speed range unchanged', () => {
    expect(formatSetSpeed(3, 0, 'fwd')).toBe('<t 3 0 1>');
    expect(formatSetSpeed(3, 126, 'fwd')).toBe('<t 3 126 1>');
  });

  it('emits the ends of the address range unchanged', () => {
    expect(formatSetSpeed(1, 10, 'fwd')).toBe('<t 1 10 1>');
    expect(formatSetSpeed(10239, 10, 'fwd')).toBe('<t 10239 10 1>');
  });
});

describe('formatSetFunction', () => {
  it('emits the DCC-EX function form', () => {
    expect(formatSetFunction(3, 0, true)).toBe('<F 3 0 1>');
    expect(formatSetFunction(3, 2, false)).toBe('<F 3 2 0>');
  });
});

describe('formatSetPoint', () => {
  it('emits the accessory form with subaddress 0', () => {
    expect(formatSetPoint(12, 'normal')).toBe('<a 12 0 1>');
    expect(formatSetPoint(12, 'reverse')).toBe('<a 12 0 0>');
  });
});

describe('formatEmergencyStop', () => {
  it('emits the broadcast stop, with no fields', () => {
    expect(formatEmergencyStop()).toBe('<!>');
  });
});

describe('formatStatusRequest', () => {
  it('emits the status request the link liveness probe rides on (#148)', () => {
    expect(formatStatusRequest()).toBe('<s>');
  });
});

describe('formatTrackPower', () => {
  it('emits the DCC-EX power commands (#149, #180)', () => {
    expect(formatTrackPower(true)).toBe('<1 MAIN>');
    expect(formatTrackPower(false)).toBe('<0 MAIN>');
  });

  it('always names MAIN, so the programming track is never switched (#180)', () => {
    // The regression this guards: a bare <1> is DCCEX_TRACK_ALL, and PicoDCC
    // implements it as both tracks. The programming track belongs to a
    // service-mode process that does not exist here yet, and an operator
    // turning the running lines on must not switch it underneath that process.
    for (const cmd of [formatTrackPower(true), formatTrackPower(false)]) {
      expect(cmd.slice(1, -1).split(' ')[1]).toBe('MAIN');
      expect(cmd).not.toContain('PROG');
    }
  });
});
