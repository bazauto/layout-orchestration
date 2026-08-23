/**
 * What the command station says back, as pure functions (#148).
 *
 * `domain/dccWireFormat.ts` is the outbound half of the same contract; this is
 * the inbound half. Framing and shape only — nothing here decides anything, and
 * nothing here throws. A frame this module cannot recognise comes back as
 * `unrecognised`, because the station legitimately emits messages we do not
 * model (`<e SAVED>`, JMRI-oriented replies, anything a later firmware adds),
 * and refusing to run the layout over an unfamiliar diagnostic string would be
 * absurd.
 *
 * That is the one asymmetry with sensor ingestion worth stating plainly: a
 * malformed *sensor* payload Safe-Stops on the first message (`docs/sensor-trust.md`
 * D10), because a sensor speaks one schema and a device sending something else
 * is lying about occupancy. The command station speaks a whole protocol of which
 * we implement a subset, so "I do not know this frame" is the normal case, not a
 * fault. What *is* a fault is the station disagreeing with a command we sent, and
 * that is `domain/dccLink.ts`'s business, not this file's.
 *
 * Reference: the bench firmware at `bazauto/PicoDCC` commit `1e7bb6d` — the
 * `#43`/`#44`/`#47`/`#49` stack. Every reply below was read out of that source.
 */

import { z } from 'zod';

/**
 * The longest run of characters we will hold waiting for a closing `>`.
 *
 * The station applies the same rule at 100 characters on its side (`pico_dccex.cpp`):
 * a `<` with no terminator swallows everything typed after it, so both ends need
 * a length at which they give up rather than buffering forever. Ours is larger
 * because the identity banner is the longest legitimate frame and we would
 * rather drop a truncated one than a real one.
 */
export const MAX_FRAME_LENGTH = 256;

/** One pass of the framer: complete frames, plus whatever tail is still accumulating. */
export interface FramingResult {
  /** Frame bodies, brackets stripped, in arrival order. */
  frames: string[];
  /** The unterminated tail to carry into the next read. Never longer than `MAX_FRAME_LENGTH`. */
  rest: string;
  /**
   * Characters thrown away: bytes outside any frame (line noise, a stray `\n`)
   * and any over-long unterminated run. Non-zero is worth logging — it is the
   * signature of a garbled link — but is not itself a fault.
   */
  discarded: number;
}

/**
 * Splits `<…>` frames out of a rolling buffer.
 *
 * Deliberately tolerant in one direction only: anything *between* frames is
 * discarded silently, because the station's UART is shared with nothing but is
 * still a physical wire. Anything *inside* a frame is preserved verbatim and
 * handed to the parser, which is where strictness belongs.
 *
 * A nested `<` abandons the frame in progress — a new start marker is better
 * evidence of where a frame begins than a `<` we have been holding since before
 * whatever corrupted the stream.
 */
export function extractFrames(buffer: string): FramingResult {
  const frames: string[] = [];
  let discarded = 0;
  let rest = '';

  let i = 0;
  while (i < buffer.length) {
    const start = buffer.indexOf('<', i);
    if (start === -1) {
      discarded += buffer.length - i;
      break;
    }
    discarded += start - i;

    // A '<' inside the candidate frame restarts it; the earlier one was noise.
    let end = -1;
    let scan = start + 1;
    while (scan < buffer.length) {
      const ch = buffer[scan];
      if (ch === '>') {
        end = scan;
        break;
      }
      if (ch === '<') {
        discarded += scan - start;
        break;
      }
      scan++;
    }

    if (end === -1) {
      if (scan < buffer.length && buffer[scan] === '<') {
        i = scan;
        continue;
      }
      const tail = buffer.slice(start);
      if (tail.length > MAX_FRAME_LENGTH) {
        discarded += tail.length;
      } else {
        rest = tail;
      }
      break;
    }

    frames.push(buffer.slice(start + 1, end));
    i = end + 1;
  }

  return { frames, rest, discarded };
}

// ─── The responses we model ───────────────────────────────────────────────────

/** Which track a `<p…>` reply is about. `all` is the reply to a bare `<1>`/`<0>`, which names no track. */
export type DccTrack = 'main' | 'prog' | 'join' | 'all';

/**
 * A speed as the station reports having decoded it. `'estop'` is a distinct
 * member rather than a magic step, because the 128-step byte distinguishes a
 * controlled stop (low bits `0`) from an emergency stop (low bits `1`) and the
 * whole point of reading the reply back is to notice when those two diverge.
 */
export type DecodedSpeed = { step: number } | { estop: true };

export type DccResponse =
  /** `<iDCC-EX V-5.0.0 / PICODCC / BUILD 2026-08-22 G-1e7bb6d>` — sent unprompted at boot, and in reply to `<s>`. */
  | {
      kind: 'identity';
      version: string | null;
      product: string | null;
      /** Git hash of the running image, from the `G-` field. The only reliable "which build is on the board" signal we get. */
      commit: string | null;
      raw: string;
    }
  /** `<p1 MAIN>` / `<p0 PROG>` / `<p1>`. Also arrives **unsolicited** when an operator uses the station's own LCD (`lvgl_renderer.cpp`). */
  | { kind: 'power'; track: DccTrack; on: boolean }
  /** `<l cab reg speedByte functionMap>` — the acknowledgement of a throttle command, carrying what the station decoded. */
  | {
      kind: 'cab';
      cab: number;
      register: number;
      speedByte: number;
      speed: DecodedSpeed;
      direction: 'fwd' | 'rev';
      functionMap: number;
    }
  /** `<O>` — accessory command accepted. Carries no address, so it identifies nothing by itself. */
  | { kind: 'accessory-ok' }
  /** `<X>` — command rejected. Carries no reference to *which* command; `domain/dccLink.ts` attributes it. */
  | { kind: 'rejected' }
  /** `<# n>` — number of locos the station is currently reminding. */
  | { kind: 'loco-count'; count: number }
  /** Anything else the station says. Not a fault — see the module comment. */
  | { kind: 'unrecognised'; raw: string };

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * `.strict()` on every schema, matching the posture of `sensorPayload.ts` and
 * `pointPayload.ts`. The difference is what a failure *means*: there, a
 * validation failure is a device lying and Safe-Stops; here it demotes the frame
 * to `unrecognised` and the layout carries on. A text protocol we implement a
 * subset of cannot treat "unparsed" as "hostile".
 */
const cabFieldsSchema = z
  .object({
    cab: z.number().int().min(0).max(10239),
    register: z.number().int().min(0),
    speedByte: z.number().int().min(0).max(255),
    functionMap: z.number().int().min(0),
  })
  .strict();

const locoCountFieldsSchema = z.object({ count: z.number().int().min(0) }).strict();

const CAB_PATTERN = /^l\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/;
const POWER_PATTERN = /^p([01])(?:\s+(MAIN|PROG|JOIN))?$/;
const LOCO_COUNT_PATTERN = /^#\s*(\d+)$/;
const IDENTITY_VERSION = /V-([^\s/]+)/;
const IDENTITY_COMMIT = /G-([0-9a-fA-F]+)/;

/**
 * Decodes the DCC 128-step speed byte the `<l>` reply carries: bit 7 is
 * direction, and the low 7 bits are `0` = stop, `1` = emergency stop, `2`–`127`
 * = steps 1–126. So a commanded step of N is reported as N + 1.
 *
 * That off-by-one is not cosmetic and is worth knowing before trusting any
 * comparison against it: the firmware subtracted one here until `PicoDCC#49`,
 * which reported every moving speed two steps low and made step 1 —
 * the slowest crawl — indistinguishable from an emergency stop.
 */
export function decodeSpeedByte(speedByte: number): {
  speed: DecodedSpeed;
  direction: 'fwd' | 'rev';
} {
  const direction = (speedByte & 0x80) === 0x80 ? 'fwd' : 'rev';
  const low = speedByte & 0x7f;
  if (low === 1) return { speed: { estop: true }, direction };
  return { speed: { step: low === 0 ? 0 : low - 1 }, direction };
}

/** The inverse of `decodeSpeedByte` for a commanded step — what we expect the station to echo. */
export function encodeSpeedByte(step: number, direction: 'fwd' | 'rev'): number {
  const low = step === 0 ? 0 : step + 1;
  return direction === 'fwd' ? low | 0x80 : low;
}

/**
 * Parses one frame body (brackets already stripped) into a response.
 *
 * Total: every input produces a response, `unrecognised` in the worst case.
 * Nothing here throws, because this runs on a transport callback and the rule
 * about transport callbacks not making decisions includes not making the
 * decision to crash.
 */
export function parseDccResponse(frame: string): DccResponse {
  const body = frame.trim();
  if (body.length === 0) return { kind: 'unrecognised', raw: frame };

  if (body === 'X') return { kind: 'rejected' };
  if (body === 'O') return { kind: 'accessory-ok' };

  if (body.startsWith('i')) {
    const raw = body;
    const version = IDENTITY_VERSION.exec(raw)?.[1] ?? null;
    const commit = IDENTITY_COMMIT.exec(raw)?.[1] ?? null;
    // "iDCC-EX V-5.0.0 / PICODCC / BUILD …" — the product is the second
    // slash-separated segment. Absent on a banner shaped differently; the
    // commit is the field that actually matters and is matched independently.
    const product = raw.split('/')[1]?.trim() ?? null;
    return { kind: 'identity', version, product, commit, raw };
  }

  const cab = CAB_PATTERN.exec(body);
  if (cab) {
    const fields = cabFieldsSchema.safeParse({
      cab: Number(cab[1]),
      register: Number(cab[2]),
      speedByte: Number(cab[3]),
      functionMap: Number(cab[4]),
    });
    if (!fields.success) return { kind: 'unrecognised', raw: frame };
    const { speed, direction } = decodeSpeedByte(fields.data.speedByte);
    return { kind: 'cab', ...fields.data, speed, direction };
  }

  const power = POWER_PATTERN.exec(body);
  if (power) {
    const track = power[2];
    return {
      kind: 'power',
      on: power[1] === '1',
      track:
        track === 'MAIN' ? 'main' : track === 'PROG' ? 'prog' : track === 'JOIN' ? 'join' : 'all',
    };
  }

  const count = LOCO_COUNT_PATTERN.exec(body);
  if (count) {
    const fields = locoCountFieldsSchema.safeParse({ count: Number(count[1]) });
    if (!fields.success) return { kind: 'unrecognised', raw: frame };
    return { kind: 'loco-count', count: fields.data.count };
  }

  return { kind: 'unrecognised', raw: frame };
}

/**
 * Convenience for the adapter: frame a chunk and parse everything complete in it.
 *
 * `frames` comes back alongside `responses` — same length, same order — because
 * parsing drops the text it came from for every kind but `unrecognised`, and
 * that text is what an operator watching journald needs when a reply and a
 * command disagree. Carrying it here rather than adding a `raw` field to every
 * variant keeps `DccResponse` to fields something actually decides on.
 */
export function readResponses(buffer: string): {
  responses: DccResponse[];
  /** The frame body each response was parsed from, brackets stripped. Parallel to `responses`. */
  frames: string[];
  rest: string;
  discarded: number;
} {
  const { frames, rest, discarded } = extractFrames(buffer);
  return { responses: frames.map(parseDccResponse), frames, rest, discarded };
}

/**
 * Flattens a response into log fields.
 *
 * Exists because an `<l 3 0 8 0>` acknowledgement logged as `{"response":"cab"}`
 * says that *something* was acknowledged and nothing about what — which cab,
 * which speed, which direction — and reading the link back (#148) is only worth
 * doing if an operator can see the station disagreeing with us.
 *
 * Pure, total, and nameless: the adapter holds no `NameBook`, and `cab` stays
 * the station's word for the address it decoded rather than ours for the loco we
 * meant. Pairing an address with a name is the service layer's job, and the
 * point of this line is what came off the wire.
 */
export function describeDccResponse(response: DccResponse): Record<string, unknown> {
  switch (response.kind) {
    case 'identity':
      return {
        kind: response.kind,
        version: response.version,
        product: response.product,
        commit: response.commit,
      };
    case 'power':
      return { kind: response.kind, track: response.track, on: response.on };
    case 'cab':
      return {
        kind: response.kind,
        cab: response.cab,
        register: response.register,
        speedByte: response.speedByte,
        decodedSpeed: 'estop' in response.speed ? 'estop' : response.speed.step,
        direction: response.direction,
        functionMap: response.functionMap,
      };
    case 'loco-count':
      return { kind: response.kind, count: response.count };
    case 'accessory-ok':
    case 'rejected':
      return { kind: response.kind };
    case 'unrecognised':
      return { kind: response.kind };
  }
}
