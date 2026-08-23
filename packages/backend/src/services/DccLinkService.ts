/**
 * DccLinkService
 *
 * Owns #148's command-station link policy as a stateful wrapper around the pure
 * functions in `domain/dccLink.ts` — the same split `PointConfirmationService`
 * draws around `domain/pointConfirmation.ts`. No serial port, no timer, and it
 * never calls back into `LayoutService`: every method returns effects, and
 * `LayoutService` is what latches route faults, re-evaluates Safe-Stop, drives
 * the `IClock.setInterval` that calls `sweep()`, and issues the `<s>` probe.
 *
 * It does own one piece of `SystemHealth` outright — `dccLink` — because a
 * latched link fault, the observed power states and the station identity are one
 * fact about one device, and splitting them across two owners would put the
 * `responsive` flag and the reason for it in different places.
 */

import {
  DccCommandContext,
  DCC_LINK_TIMEOUT_MS,
  DCC_VERDICT_TIMEOUT_MS,
  describeCommand,
  evaluateLinkLiveness,
  expireOutstanding,
  OutstandingCommand,
  resolveResponse,
} from '../domain/dccLink';
import { DccResponse } from '../domain/dccResponse';
import {
  DccLinkFault,
  DccLinkFaultKind,
  DccLinkHealth,
  LocoAddress,
  PointId,
  RouteFaultKind,
  RouteId,
} from '../domain/types';

/** A route fault for `LayoutService` to latch — this service has no `SystemHealth` access beyond its own sub-object. */
export interface DccRouteFaultEffect {
  routeId: RouteId;
  kind: RouteFaultKind;
  reason: string;
  locoAddress: LocoAddress | null;
  pointId: PointId | null;
}

/** Something worth a log line that is not, by itself, a fault. */
export interface DccLinkWarning {
  message: string;
  data: Record<string, unknown>;
}

/**
 * What one response or sweep produced. `healthChanged` is the trigger for
 * `evaluateAndApplySafeStop` — set whenever `getHealth()` would now answer
 * differently, so the caller never has to diff the health object itself.
 */
export interface DccLinkEffects {
  routeFaults: DccRouteFaultEffect[];
  warnings: DccLinkWarning[];
  healthChanged: boolean;
}

function noEffects(): DccLinkEffects {
  return { routeFaults: [], warnings: [], healthChanged: false };
}

export interface DccLinkOptions {
  /** Silence before the link is declared lost. Defaults to `DCC_LINK_TIMEOUT_MS`. */
  linkTimeoutMs?: number;
  /** How long a command waits for its verdict before being dropped. Defaults to `DCC_VERDICT_TIMEOUT_MS`. */
  verdictTimeoutMs?: number;
}

export class DccLinkService {
  private outstanding: OutstandingCommand[] = [];
  private nextSeq = 1;
  private lastResponseAt: Date | null = null;
  private lastProbeSentAt: Date | null = null;

  private responsive = true;
  private reason: string | null = null;
  private fault: DccLinkFault | null = null;
  private mainPowerOn: boolean | null = null;
  private progPowerOn: boolean | null = null;
  private identity: DccLinkHealth['identity'] = null;
  private restartCount = 0;

  private readonly linkTimeoutMs: number;
  private readonly verdictTimeoutMs: number;

  constructor(options: DccLinkOptions = {}) {
    this.linkTimeoutMs = options.linkTimeoutMs ?? DCC_LINK_TIMEOUT_MS;
    this.verdictTimeoutMs = options.verdictTimeoutMs ?? DCC_VERDICT_TIMEOUT_MS;
  }

  /**
   * Records a command as sent, so a later verdict can be attributed to it.
   *
   * **Call this immediately before the write, not after.** The queue's whole
   * basis is that it is in wire order; a command recorded after its own reply
   * has arrived would be attributed the *next* command's verdict.
   */
  recordCommand(context: DccCommandContext, now: Date): number {
    const seq = this.nextSeq++;
    this.outstanding.push({ ...context, seq, sentAt: now });
    if (context.kind === 'probe') this.lastProbeSentAt = now;
    return seq;
  }

  /**
   * An emergency stop clears the queue.
   *
   * The station does the same thing on its side — `<!>` empties both command
   * queues and forgets every loco — so a throttle command still outstanding at
   * that moment will never be answered, and leaving it in the queue would hand
   * its identity to the next `<X>` that arrives.
   */
  noteEmergencyStop(now: Date): void {
    this.outstanding = [];
    this.recordCommand(
      {
        kind: 'emergency-stop',
        command: '<!>',
        locoAddress: null,
        speedStep: null,
        direction: null,
        pointId: null,
        routeId: null,
      },
      now,
    );
  }

  /** Applies one response from the station. */
  handleResponse(response: DccResponse, now: Date): DccLinkEffects {
    const effects = noEffects();

    // Any frame at all is evidence of life — the probe is how we *provoke*
    // evidence, not the only thing that counts as it.
    this.lastResponseAt = now;
    if (!this.responsive) {
      this.responsive = true;
      this.reason = null;
      effects.healthChanged = true;
    }

    const resolution = resolveResponse(this.outstanding, response);
    const settled =
      resolution.outcome === 'unsolicited' || resolution.index === null
        ? null
        : this.outstanding[resolution.index];

    if (resolution.outcome !== 'unsolicited' && resolution.index !== null) {
      // Everything before the settled command is now unanswerable: the station
      // replies in order, so an earlier command that has not been settled by the
      // time a later one is will never be. Dropping them keeps a stale entry
      // from absorbing a future rejection.
      const skipped = this.outstanding.slice(0, resolution.index);
      for (const command of skipped) {
        effects.warnings.push({
          message: '[DccLink] Command settled out of order; dropping unanswered command',
          data: { command: describeCommand(command), seq: command.seq },
        });
      }
      this.outstanding = this.outstanding.slice(resolution.index + 1);
    }

    switch (resolution.outcome) {
      case 'ack': {
        const verification = resolution.verification;
        if (verification && !verification.ok) {
          if (verification.severity === 'critical') {
            this.latchFault(
              {
                kind: 'cab-mismatch',
                reason: verification.reason,
                locoAddress: settled?.locoAddress ?? null,
                pointId: null,
                faultedAt: now,
              },
              effects,
            );
          } else {
            // Advisory (D6): logged, never latched. See `CabVerification`.
            effects.warnings.push({
              message: '[DccLink] Command station decoded a throttle command differently',
              data: {
                field: verification.field,
                expected: verification.expected,
                actual: verification.actual,
                locoAddress: settled?.locoAddress ?? null,
              },
            });
          }
        }
        break;
      }

      case 'reject': {
        this.applyRejection(settled, now, effects);
        break;
      }

      case 'unsolicited':
        this.applyUnsolicited(response, now, effects);
        break;
    }

    // A power or identity report updates the record whether it was asked for or
    // not — `<s>` carries both, and so does an operator pressing the station's
    // own buttons.
    if (response.kind === 'power') this.notePower(response.track, response.on, effects);
    if (response.kind === 'identity') {
      // Solicited-ness comes from the resolution, never from re-inspecting the
      // queue: by this line the probe that asked for this banner has already
      // been settled and removed, so a queue check would report every routine
      // probe reply as an unprompted banner — that is, as a station restart,
      // every five seconds, for ever.
      this.noteIdentity(response, now, effects, resolution.outcome === 'ack');
    }

    return effects;
  }

  /**
   * The periodic tick: expire stale commands and judge liveness.
   *
   * Expiry produces no fault of its own (see `DCC_VERDICT_TIMEOUT_MS`) — a
   * missing reply is caught by the probe, which can tell one lost frame from a
   * station that has stopped talking.
   */
  sweep(now: Date): DccLinkEffects {
    const effects = noEffects();

    const { expired, remaining } = expireOutstanding(this.outstanding, now, this.verdictTimeoutMs);
    this.outstanding = remaining;
    for (const command of expired) {
      effects.warnings.push({
        message: '[DccLink] No verdict from the command station within the timeout',
        data: { command: describeCommand(command), seq: command.seq },
      });
    }

    const liveness = evaluateLinkLiveness(
      { lastResponseAt: this.lastResponseAt, lastProbeSentAt: this.lastProbeSentAt },
      now,
      this.linkTimeoutMs,
    );
    if (liveness.responsive !== this.responsive) {
      this.responsive = liveness.responsive;
      this.reason = liveness.reason;
      effects.healthChanged = true;
      if (!liveness.responsive) {
        this.latchFault(
          {
            kind: 'link-lost',
            reason: liveness.reason ?? 'DCC command station stopped answering',
            locoAddress: null,
            pointId: null,
            faultedAt: now,
          },
          effects,
        );
      }
    } else if (liveness.reason !== this.reason) {
      this.reason = liveness.reason;
      effects.healthChanged = true;
    }

    return effects;
  }

  /** The port closed. Whatever was outstanding belongs to a session that no longer exists. */
  reset(): void {
    this.outstanding = [];
    this.lastResponseAt = null;
    this.lastProbeSentAt = null;
    this.responsive = true;
    this.reason = null;
  }

  getHealth(): DccLinkHealth {
    return {
      responsive: this.responsive,
      reason: this.reason,
      fault: this.fault,
      mainPowerOn: this.mainPowerOn,
      progPowerOn: this.progPowerOn,
      identity: this.identity,
      restartCount: this.restartCount,
      lastResponseAt: this.lastResponseAt,
    };
  }

  /**
   * Clears the latched fault. Returns the fault that was cleared, or `null` if
   * there was none — mirroring `acknowledgeSensorFault`'s posture, where
   * acknowledging nothing is an error the caller reports rather than a silent
   * success.
   *
   * No arming threshold, unlike a sensor fault: there is no stream of
   * confirming readings from a command station to count. What there is instead
   * is `responsive`, which is live — acknowledging a `link-lost` fault while the
   * station is still silent clears the latch and the sweep immediately
   * re-latches it.
   */
  acknowledgeFault(): DccLinkFault | null {
    const cleared = this.fault;
    this.fault = null;
    return cleared;
  }

  /** Number of commands still awaiting a verdict. Diagnostics and tests only. */
  outstandingCount(): number {
    return this.outstanding.length;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private applyRejection(
    settled: OutstandingCommand | null,
    now: Date,
    effects: DccLinkEffects,
  ): void {
    if (!settled) {
      this.latchFault(
        {
          kind: 'unattributed-rejection',
          reason:
            'The command station rejected a command, but nothing was outstanding to attribute it to',
          locoAddress: null,
          pointId: null,
          faultedAt: now,
        },
        effects,
      );
      return;
    }

    // A rejection against a route is that route's problem, and is reported as
    // one so the operator is told which movement is affected (D5). A rejection
    // with no route behind it has nowhere else to go and latches on the link.
    if (settled.routeId !== null) {
      effects.routeFaults.push({
        routeId: settled.routeId,
        kind: settled.kind === 'accessory' ? 'point-command-rejected' : 'dcc-command-rejected',
        reason: `Command station rejected ${describeCommand(settled)}`,
        locoAddress: settled.locoAddress,
        pointId: settled.pointId,
      });
      return;
    }

    this.latchFault(
      {
        kind: 'command-rejected',
        reason: `Command station rejected ${describeCommand(settled)}`,
        locoAddress: settled.locoAddress,
        pointId: settled.pointId,
        faultedAt: now,
      },
      effects,
    );
  }

  private applyUnsolicited(response: DccResponse, now: Date, effects: DccLinkEffects): void {
    switch (response.kind) {
      case 'rejected':
        // Unreachable in practice — `resolveResponse` reports a rejection with
        // no outstanding command as `reject` with a null index, not as
        // unsolicited — but stated rather than assumed.
        break;
      case 'unrecognised':
        effects.warnings.push({
          message: '[DccLink] Unrecognised response from the command station',
          data: { raw: response.raw },
        });
        break;
      case 'cab':
        // The `<!>` burst, or the station reporting a loco we did not just
        // command. Status, not an acknowledgement — nothing to verify against.
        break;
      default:
        break;
    }
    void now;
  }

  private notePower(track: string, on: boolean, effects: DccLinkEffects): void {
    if (track === 'main' || track === 'all') {
      if (this.mainPowerOn !== on) {
        this.mainPowerOn = on;
        effects.healthChanged = true;
        if (!on) {
          effects.warnings.push({
            message: '[DccLink] Main track power is off',
            data: { track: 'main' },
          });
        }
      }
    }
    if (track === 'prog' || track === 'all') {
      if (this.progPowerOn !== on) {
        this.progPowerOn = on;
        effects.healthChanged = true;
      }
    }
  }

  private noteIdentity(
    response: Extract<DccResponse, { kind: 'identity' }>,
    now: Date,
    effects: DccLinkEffects,
    solicited: boolean,
  ): void {
    const previous = this.identity;
    this.identity = {
      version: response.version,
      product: response.product,
      commit: response.commit,
      raw: response.raw,
      observedAt: now,
    };
    effects.healthChanged = true;

    // A restart is an identity we did not ask for. The station sends its banner
    // unprompted exactly once — at boot — so an unsolicited one *is* the reboot,
    // and a changed commit says the image changed under us as well (D7).
    const isRestart = previous !== null && (!solicited || previous.commit !== response.commit);
    if (!isRestart) return;

    this.restartCount++;
    this.latchFault(
      {
        kind: 'station-restarted',
        reason:
          previous.commit !== response.commit
            ? `Command station restarted and is now running ${response.commit ?? 'an unknown build'} (was ${previous.commit ?? 'unknown'})`
            : 'Command station restarted: it has forgotten every loco and its tracks come up unpowered',
        locoAddress: null,
        pointId: null,
        faultedAt: now,
      },
      effects,
    );
  }

  /**
   * Latches a fault. First one wins, matching every other latch in
   * `SystemHealth` (`oldestSensorFault` and siblings): the first cause is what
   * an operator needs, and a later symptom overwriting it loses the diagnosis.
   */
  private latchFault(fault: DccLinkFault, effects: DccLinkEffects): void {
    if (this.fault !== null) return;
    this.fault = fault;
    effects.healthChanged = true;
  }
}

/** The fault kinds this service can latch, for tests and documentation. */
export const DCC_LINK_FAULT_KINDS: DccLinkFaultKind[] = [
  'link-lost',
  'cab-mismatch',
  'command-rejected',
  'unattributed-rejection',
  'station-restarted',
];
