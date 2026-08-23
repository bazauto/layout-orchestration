/**
 * The DCC link's pure logic (#148, `docs/dcc-link.md`).
 *
 * `dccResponse.ts` turns bytes into responses. This module decides what a
 * response *means* against the commands we sent: which command a reply belongs
 * to, whether the station decoded that command the way we meant it, and whether
 * the link is still alive. It holds no state and touches no clock — every
 * function takes the state and the time it needs.
 *
 * ## Why correlation needs a queue at all
 *
 * `<X>` names nothing. It is DCC-EX's generic rejection and carries no cab, no
 * address, and no reference to the command that caused it. `<O>` is the same for
 * accessories. So the only way to say *which* command was refused is position:
 * the serial link is a FIFO, the station answers in order, and on the bench
 * firmware (`1e7bb6d`) every command we are willing to send draws exactly one
 * verdict.
 *
 * That last clause is doing real work, and it is why #150's `setFunction` guard
 * belongs with this change. `<F>` is the one command that succeeds *silently* —
 * validated, accepted, and then dropped into an empty `updateFunct()`. While an
 * `<F>` can be in flight, an `<X>` cannot be attributed to anything with
 * confidence, because the rejection might belong to the command after the one
 * that quietly worked. Refusing to send `<F>` at all is what makes this queue
 * sound.
 *
 * ## Why `<l>` is matched by position and not by cab
 *
 * The obvious matching rule — find the outstanding throttle whose cab equals the
 * reply's cab — quietly destroys the thing most worth catching. If the station
 * decodes a command against the wrong loco, that rule finds no match and files
 * the reply as unsolicited chatter. #147 was exactly that failure, and it ran
 * for months. So `<l>` pairs with the oldest outstanding throttle *regardless of
 * cab*, and the cab is then **verified**. A disagreement is the finding, not a
 * reason to look elsewhere.
 */

import { DccResponse } from './dccResponse';
import { encodeSpeedByte } from './dccResponse';
import { DccLinkHealth, DccLinkView, Direction, LocoAddress, PointId, RouteId } from './types';

/**
 * How often the station is asked `<s>`.
 *
 * `<s>` is the right probe because its reply is three facts in one round trip:
 * identity (including the running git hash), main track power, and programming
 * track power. Nothing else has to be asked separately.
 */
export const DCC_PROBE_INTERVAL_MS = 5000;

/**
 * Missed probes before the link is declared lost — the same three-strikes rule
 * as `domain/liveness.ts`'s `STALE_AFTER_MISSED_HEARTBEATS`, and for the same
 * reason: one missed reply is a scheduling hiccup, three is a pattern.
 *
 * Deliberately a separate constant rather than an import. The WebSocket
 * heartbeat and the DCC probe answer to different hardware and will want to
 * diverge; sharing the number would make one of them change by accident.
 */
export const DCC_PROBE_MISSES_BEFORE_LOST = 3;

export const DCC_LINK_TIMEOUT_MS = DCC_PROBE_INTERVAL_MS * DCC_PROBE_MISSES_BEFORE_LOST;

/**
 * How long a command may sit without a verdict before it is dropped from the
 * queue.
 *
 * Generous on purpose. It exists to stop the queue growing without bound and to
 * keep a lost reply from mis-attributing every later `<X>`; it is **not** a
 * fault detector. Silence is caught by the probe, which is the mechanism that
 * can tell "this one reply went missing" from "the station has stopped talking".
 */
export const DCC_VERDICT_TIMEOUT_MS = 3000;

/** What kind of thing we sent, which determines what reply would settle it. */
export type DccCommandKind = 'throttle' | 'accessory' | 'power' | 'probe' | 'emergency-stop';

/** The context a command carries so a rejection can name what it broke. */
export interface DccCommandContext {
  kind: DccCommandKind;
  /** The exact bytes, for the log line an operator will read. */
  command: string;
  locoAddress: LocoAddress | null;
  /** For a throttle: the step and direction we asked for, so the reply can be checked against them. */
  speedStep: number | null;
  direction: Direction | null;
  pointId: PointId | null;
  /** The route this command was issued on behalf of, if any. What turns a rejection into a `RouteFault`. */
  routeId: RouteId | null;
}

export interface OutstandingCommand extends DccCommandContext {
  seq: number;
  sentAt: Date;
}

/** How a `<l>` reply compared with the throttle command it answers. */
export type CabVerification =
  | { ok: true }
  /**
   * The station acknowledged a different loco than we addressed. Critical:
   * something is moving that we did not command, which is the whole #147 class
   * of bug.
   */
  | {
      ok: false;
      severity: 'critical';
      field: 'cab';
      expected: number;
      actual: number;
      reason: string;
    }
  /**
   * The station decoded a different speed or direction than we sent. Advisory,
   * and this is a deliberate, dated judgement (D6): the speed byte's encoding
   * changed in `PicoDCC#49`, `PicoDCC#48` (speed 0 emitting an emergency stop)
   * is open, and `#151` will change the step mode again. A strict check here
   * would Safe-Stop a live layout over a firmware version skew rather than over
   * a train doing the wrong thing. Revisit when those three are closed.
   */
  | {
      ok: false;
      severity: 'advisory';
      field: 'speed' | 'direction';
      expected: string;
      actual: string;
      reason: string;
    };

export type ResponseResolution =
  /** This response settles `outstanding[index]` affirmatively. */
  | { outcome: 'ack'; index: number; verification: CabVerification | null }
  /** A rejection. `index` is the command it belongs to, or `null` when nothing was outstanding. */
  | { outcome: 'reject'; index: number | null }
  /** Nothing was waiting for this — a status report, or the station talking to itself. */
  | { outcome: 'unsolicited' };

function firstIndexOfKind(outstanding: OutstandingCommand[], kind: DccCommandKind): number {
  return outstanding.findIndex((c) => c.kind === kind);
}

/**
 * Which outstanding command, if any, a response settles.
 *
 * The `emergency-stop` case is the one asymmetry. `<!>` makes the station emit
 * one `<l>` per loco it was reminding — a burst of zero or more replies that
 * belong to no throttle command — so while an emergency stop is the oldest
 * thing outstanding, `<l>` frames are read as status and verified against
 * nothing. Treating them as throttle acknowledgements would compare an
 * emergency-stopped loco against whatever speed we last asked for and report a
 * mismatch on every single one.
 */
export function resolveResponse(
  outstanding: OutstandingCommand[],
  response: DccResponse,
): ResponseResolution {
  switch (response.kind) {
    case 'cab': {
      const estopIndex = firstIndexOfKind(outstanding, 'emergency-stop');
      const throttleIndex = firstIndexOfKind(outstanding, 'throttle');
      if (estopIndex !== -1 && (throttleIndex === -1 || estopIndex < throttleIndex)) {
        return { outcome: 'unsolicited' };
      }
      if (throttleIndex === -1) return { outcome: 'unsolicited' };
      return {
        outcome: 'ack',
        index: throttleIndex,
        verification: verifyCabAck(outstanding[throttleIndex], response),
      };
    }

    case 'accessory-ok': {
      const index = firstIndexOfKind(outstanding, 'accessory');
      return index === -1
        ? { outcome: 'unsolicited' }
        : { outcome: 'ack', index, verification: null };
    }

    case 'rejected':
      // The oldest thing outstanding, whatever it is. Every command we send
      // draws a verdict, so the oldest unsettled one is the only candidate.
      return { outcome: 'reject', index: outstanding.length > 0 ? 0 : null };

    case 'power': {
      // A power reply settles an explicit power command; otherwise it is either
      // part of an `<s>` reply or genuinely unsolicited — the station's own LCD
      // publishes `<p1 MAIN>` when an operator presses its buttons.
      const index = firstIndexOfKind(outstanding, 'power');
      return index === -1
        ? { outcome: 'unsolicited' }
        : { outcome: 'ack', index, verification: null };
    }

    case 'identity': {
      const index = firstIndexOfKind(outstanding, 'probe');
      return index === -1
        ? { outcome: 'unsolicited' }
        : { outcome: 'ack', index, verification: null };
    }

    case 'loco-count':
    case 'unrecognised':
      return { outcome: 'unsolicited' };
  }
}

/** Renders a commanded step/direction the way the log and a mismatch message want it. */
function describeCommanded(speedStep: number | null, direction: Direction | null): string {
  if (speedStep === null || direction === null) return 'unknown';
  return direction === 'stop' ? 'step 0 (stop)' : `step ${speedStep} ${direction}`;
}

/**
 * Compares a `<l>` reply against the throttle command it answers.
 *
 * Cab first, and a cab disagreement short-circuits: once the station is talking
 * about a different loco, its speed field describes a train we did not address
 * and comparing it says nothing.
 */
export function verifyCabAck(
  command: OutstandingCommand,
  response: Extract<DccResponse, { kind: 'cab' }>,
): CabVerification {
  if (command.locoAddress !== null && response.cab !== command.locoAddress) {
    return {
      ok: false,
      severity: 'critical',
      field: 'cab',
      expected: command.locoAddress,
      actual: response.cab,
      reason: `Command station acknowledged loco ${response.cab} for a command addressed to loco ${command.locoAddress}`,
    };
  }

  if (command.speedStep === null || command.direction === null) return { ok: true };

  // `'stop'` is speed 0 sent with the forward bit — the same convention
  // `dccWireFormat.formatSetSpeed` puts on the wire, restated here because the
  // reply is compared against what went out, not against what was asked for.
  const commandedStep = command.direction === 'stop' ? 0 : command.speedStep;
  const commandedDirection = command.direction === 'rev' ? 'rev' : 'fwd';
  const expectedByte = encodeSpeedByte(commandedStep, commandedDirection);
  if (response.speedByte === expectedByte) return { ok: true };

  if (response.direction !== commandedDirection) {
    return {
      ok: false,
      severity: 'advisory',
      field: 'direction',
      expected: commandedDirection,
      actual: response.direction,
      reason: `Command station decoded loco ${response.cab} as ${response.direction} for a ${describeCommanded(command.speedStep, command.direction)} command`,
    };
  }

  const actual = 'estop' in response.speed ? 'emergency stop' : `step ${response.speed.step}`;
  return {
    ok: false,
    severity: 'advisory',
    field: 'speed',
    expected: describeCommanded(command.speedStep, command.direction),
    actual,
    reason: `Command station decoded loco ${response.cab} as ${actual} for a ${describeCommanded(command.speedStep, command.direction)} command`,
  };
}

/** What the liveness predicate needs to know. Supplied by the service; this module keeps none of it. */
export interface DccLinkObservation {
  /** When anything at all last arrived from the station. Any frame is evidence of life, not just a probe reply. */
  lastResponseAt: Date | null;
  /** When a probe was last sent. `null` means we have never asked, which is not the same as being ignored. */
  lastProbeSentAt: Date | null;
}

/**
 * Whether the station is still answering.
 *
 * The `lastProbeSentAt === null` case returns responsive, and that is safe
 * rather than optimistic: `SystemHealth.dccConnected` is false until the port
 * opens and already Safe-Stops on its own, so there is no window in which this
 * function's `true` lets an unconnected station look healthy. What this adds is
 * the case the device node cannot see — port open, station silent (D2).
 */
export function evaluateLinkLiveness(
  observation: DccLinkObservation,
  now: Date,
  timeoutMs: number = DCC_LINK_TIMEOUT_MS,
): { responsive: boolean; reason: string | null } {
  const { lastResponseAt, lastProbeSentAt } = observation;
  if (lastProbeSentAt === null) return { responsive: true, reason: null };

  const since = lastResponseAt ?? lastProbeSentAt;
  const silentForMs = now.getTime() - since.getTime();
  if (silentForMs <= timeoutMs) return { responsive: true, reason: null };

  const seconds = Math.round(silentForMs / 1000);
  return {
    responsive: false,
    reason: lastResponseAt
      ? `DCC command station has not answered for ${seconds}s`
      : `DCC command station has never answered (${seconds}s since the first status request)`,
  };
}

/** Drops commands that have waited past `timeoutMs` for a verdict. Order is preserved. */
export function expireOutstanding(
  outstanding: OutstandingCommand[],
  now: Date,
  timeoutMs: number = DCC_VERDICT_TIMEOUT_MS,
): { expired: OutstandingCommand[]; remaining: OutstandingCommand[] } {
  const expired: OutstandingCommand[] = [];
  const remaining: OutstandingCommand[] = [];
  for (const command of outstanding) {
    if (now.getTime() - command.sentAt.getTime() > timeoutMs) expired.push(command);
    else remaining.push(command);
  }
  return { expired, remaining };
}

/** Wire projection of `DccLinkHealth` (#148). Pure — takes no clock, mirroring `toSensorFaultView`. */
export function toDccLinkView(health: DccLinkHealth): DccLinkView {
  return {
    responsive: health.responsive,
    reason: health.reason,
    fault: health.fault
      ? { ...health.fault, faultedAt: health.fault.faultedAt.toISOString() }
      : null,
    mainPowerOn: health.mainPowerOn,
    progPowerOn: health.progPowerOn,
    identity: health.identity
      ? { ...health.identity, observedAt: health.identity.observedAt.toISOString() }
      : null,
    restartCount: health.restartCount,
    lastResponseAt: health.lastResponseAt ? health.lastResponseAt.toISOString() : null,
  };
}

/** A one-line description of a command, for a fault reason or a log line. */
export function describeCommand(command: OutstandingCommand): string {
  const parts: string[] = [command.command];
  if (command.locoAddress !== null) parts.push(`loco ${command.locoAddress}`);
  if (command.pointId !== null) parts.push(`point ${command.pointId}`);
  return parts.join(', ');
}
