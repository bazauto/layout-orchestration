/**
 * The inbound half of the command-station contract (#148).
 *
 * Same posture as `dccWireFormat.test.ts`: assertions are on literal frames
 * copied from the bench firmware's own source (`bazauto/PicoDCC` `1e7bb6d`),
 * not on strings this file builds by the same rule the parser uses.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeSpeedByte,
  encodeSpeedByte,
  extractFrames,
  MAX_FRAME_LENGTH,
  parseDccResponse,
  readResponses,
} from '../../../src/domain/dccResponse';

describe('extractFrames', () => {
  it('splits complete frames and strips the brackets', () => {
    const { frames, rest } = extractFrames('<p1 MAIN><l 3 0 179 0>');
    expect(frames).toEqual(['p1 MAIN', 'l 3 0 179 0']);
    expect(rest).toBe('');
  });

  it('carries an unterminated tail forward instead of losing it', () => {
    const first = extractFrames('<p1 MAIN><l 3 0 ');
    expect(first.frames).toEqual(['p1 MAIN']);
    expect(first.rest).toBe('<l 3 0 ');

    const second = extractFrames(first.rest + '179 0>');
    expect(second.frames).toEqual(['l 3 0 179 0']);
    expect(second.rest).toBe('');
  });

  it('discards bytes outside any frame', () => {
    const { frames, discarded } = extractFrames('noise\r\n<X>');
    expect(frames).toEqual(['X']);
    expect(discarded).toBe(7);
  });

  it('abandons a frame in progress when a new one starts', () => {
    // A corrupted stream: the `<X` never terminated, but `<O>` is intact and
    // must not be lost with it.
    const { frames } = extractFrames('<X<O>');
    expect(frames).toEqual(['O']);
  });

  it('drops an unterminated run longer than the cap rather than buffering it for ever', () => {
    const { frames, rest, discarded } = extractFrames('<' + 'a'.repeat(MAX_FRAME_LENGTH + 10));
    expect(frames).toEqual([]);
    expect(rest).toBe('');
    expect(discarded).toBe(MAX_FRAME_LENGTH + 11);
  });

  it('keeps an unterminated run at the cap, since it may yet complete', () => {
    const partial = '<' + 'a'.repeat(MAX_FRAME_LENGTH - 1);
    expect(extractFrames(partial).rest).toBe(partial);
  });
});

describe('parseDccResponse', () => {
  it('reads a rejection and an accessory acknowledgement', () => {
    expect(parseDccResponse('X')).toEqual({ kind: 'rejected' });
    expect(parseDccResponse('O')).toEqual({ kind: 'accessory-ok' });
  });

  it('reads the identity banner, including the git hash of the running image', () => {
    const parsed = parseDccResponse('iDCC-EX V-5.0.0 / PICODCC / BUILD 2026-08-22 G-1e7bb6d');
    expect(parsed).toMatchObject({
      kind: 'identity',
      version: '5.0.0',
      product: 'PICODCC',
      commit: '1e7bb6d',
    });
  });

  it('reads a banner with fields it does not recognise, rather than rejecting it', () => {
    // Still an identity: the commit is what matters and is matched independently
    // of the shape around it.
    expect(
      parseDccResponse('iDCC-EX V-4.0.1 / MEGA / STANDARD_MOTOR_SHIELD / G-9db6d36)'),
    ).toMatchObject({
      kind: 'identity',
      commit: '9db6d36',
    });
  });

  it('reads power for each track, and for the bare form that names none', () => {
    expect(parseDccResponse('p1 MAIN')).toEqual({ kind: 'power', track: 'main', on: true });
    expect(parseDccResponse('p0 PROG')).toEqual({ kind: 'power', track: 'prog', on: false });
    expect(parseDccResponse('p1')).toEqual({ kind: 'power', track: 'all', on: true });
  });

  it('reads a cab acknowledgement and decodes its speed byte', () => {
    // The exact frame the bench firmware answers `<t 3 50 1>` with, post-#49.
    expect(parseDccResponse('l 3 0 179 0')).toEqual({
      kind: 'cab',
      cab: 3,
      register: 0,
      speedByte: 179,
      speed: { step: 50 },
      direction: 'fwd',
      functionMap: 0,
    });
  });

  it('reads the loco count', () => {
    expect(parseDccResponse('# 4')).toEqual({ kind: 'loco-count', count: 4 });
  });

  it('demotes an out-of-range cab frame to unrecognised rather than throwing', () => {
    expect(parseDccResponse('l 3 0 999 0')).toEqual({ kind: 'unrecognised', raw: 'l 3 0 999 0' });
  });

  it('calls anything it does not model unrecognised — not a fault', () => {
    // The station says these; we do not implement them, and that must not stop
    // the layout. See the module comment.
    expect(parseDccResponse('e SAVED')).toEqual({ kind: 'unrecognised', raw: 'e SAVED' });
    expect(parseDccResponse('')).toEqual({ kind: 'unrecognised', raw: '' });
  });
});

describe('decodeSpeedByte', () => {
  it('separates a controlled stop from an emergency stop', () => {
    // The distinction the whole reply exists to carry: low bits 0 is "stop",
    // low bits 1 is "emergency stop". PicoDCC#49 fixed reporting one as the
    // other for the slowest crawl.
    expect(decodeSpeedByte(0x80)).toEqual({ speed: { step: 0 }, direction: 'fwd' });
    expect(decodeSpeedByte(0x81)).toEqual({ speed: { estop: true }, direction: 'fwd' });
  });

  it('maps the 128-step byte back to the commanded step', () => {
    expect(decodeSpeedByte(130)).toEqual({ speed: { step: 1 }, direction: 'fwd' });
    expect(decodeSpeedByte(179)).toEqual({ speed: { step: 50 }, direction: 'fwd' });
    expect(decodeSpeedByte(255)).toEqual({ speed: { step: 126 }, direction: 'fwd' });
  });

  it('reads bit 7 as direction', () => {
    expect(decodeSpeedByte(51).direction).toBe('rev');
    expect(decodeSpeedByte(179).direction).toBe('fwd');
  });

  it('round-trips every commanded step through encodeSpeedByte', () => {
    for (const step of [0, 1, 2, 50, 125, 126]) {
      for (const direction of ['fwd', 'rev'] as const) {
        const decoded = decodeSpeedByte(encodeSpeedByte(step, direction));
        expect(decoded).toEqual({ speed: { step }, direction });
      }
    }
  });

  it('encodes the values the firmware documents', () => {
    expect(encodeSpeedByte(0, 'fwd')).toBe(128);
    expect(encodeSpeedByte(50, 'fwd')).toBe(179);
    expect(encodeSpeedByte(126, 'fwd')).toBe(255);
  });
});

describe('readResponses', () => {
  it('frames and parses a chunk in one pass', () => {
    const { responses, rest } = readResponses(
      '<iDCC-EX V-5.0.0 / PICODCC / G-abc123><p1 MAIN><p0 PR',
    );
    expect(responses.map((r) => r.kind)).toEqual(['identity', 'power']);
    expect(rest).toBe('<p0 PR');
  });
});
