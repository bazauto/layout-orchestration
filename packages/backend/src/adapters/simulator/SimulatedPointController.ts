/**
 * SimulatedPointController
 *
 * #25 D9: a genuine simulated twin of the ESP point controller — subscribes
 * to `point/+/query` on the `IMqttAdapter` port and publishes
 * `point/{id}/reading` after a delay on the injected `IClock`, exercising
 * the real MQTT contract end to end, the same posture every other adapter
 * in this system takes. Not bolted onto `SimulatedDccAdapter`: that adapter
 * has no MQTT connection of its own, and inventing a private confirmation
 * channel there would test nothing about the real firmware path.
 *
 * Because the backend commands points over DCC EX serial and has never
 * published `point/*\/command` over MQTT (see docs/point-feedback.md, "the
 * commanded-over-serial / confirmed-over-MQTT asymmetry"), this controller
 * has no way to learn of a command over the wire — `noteCommanded` is the
 * in-process hook `index.ts` wires from `LayoutService`'s optional
 * `onPointCommanded` callback instead, standing in for a controller that
 * receives its commands over a wire this simulator cannot see.
 *
 * Ships in the simulator binary whenever either simulator mode is active
 * (CLAUDE.md safety rule 5 — point feedback must be testable without
 * hardware too), never against real hardware.
 */

import { IMqttAdapter } from '../../ports/IMqttAdapter';
import { ClockTimer, IClock } from '../../ports/IClock';
import { LayoutId, PointId } from '../../domain/types';

/**
 * The failure modes the required scenario tests select, globally or per
 * point (D9): `silent` models a stalled servo or dead controller (exercises
 * the timeout path), `wrong-position` models a mechanical bind or crossed
 * wiring (exercises `mismatch`), `indeterminate` models both microswitches
 * reading open at once, and `driver-only` models feedback fitted in name
 * only — a controller wired with no independent sensor that always reports
 * `source: "driver"`.
 */
export type PointSimulationMode = 'confirm' | 'silent' | 'wrong-position' | 'indeterminate' | 'driver-only';

export interface SimulatedPointControllerOptions {
  /** Applied to every point with no per-point override (via `setMode`/`modes`). Defaults to `'confirm'`. */
  defaultMode?: PointSimulationMode;
  /** Per-point overrides, keyed by point id. */
  modes?: Record<string, PointSimulationMode>;
  /** D9: delay, on the injected clock, before answering a query or a command with a reading. */
  confirmDelayMs?: number;
  /**
   * D11 (#167): how often, on the injected clock, this controller re-asserts
   * every point it knows about. Defaults to the contract's 30 s. A real
   * controller is obliged to do this; a simulator that did not would make
   * every `positionFeedback: 'required'` point go `'stale'` 90 s after its
   * last command, which is a simulator defect rather than a system one.
   */
  reassertIntervalMs?: number;
}

export interface SimulatedPointControllerLogger {
  info(msg: string, data?: Record<string, unknown>): void;
}

export class SimulatedPointController {
  private defaultMode: PointSimulationMode;
  private readonly modes = new Map<PointId, PointSimulationMode>();
  private readonly confirmDelayMs: number;
  /**
   * The position most recently commanded, in-process, via `noteCommanded` —
   * this controller has no MQTT channel for commands (see the class doc
   * comment's "asymmetry" reference). A point never commanded this session
   * reports `'normal'`, a reasonable simulated stand-in for "whatever a real
   * hand-thrown point happens to be sitting at".
   */
  private readonly commanded = new Map<PointId, 'normal' | 'reverse'>();
  /**
   * Every point this controller has heard of, by command or by query — what
   * the D11 re-assert loop walks. A real controller knows its own points from
   * its pin allocation; this one learns them from traffic, which is the
   * closest a simulator with no wiring can get.
   */
  private readonly known = new Set<PointId>();
  private reassertTimer: ClockTimer | null = null;
  private readonly reassertIntervalMs: number;

  constructor(
    private readonly mqtt: IMqttAdapter,
    private readonly clock: IClock,
    private readonly layoutId: LayoutId,
    private readonly log: SimulatedPointControllerLogger,
    options: SimulatedPointControllerOptions = {},
  ) {
    this.defaultMode = options.defaultMode ?? 'confirm';
    this.confirmDelayMs = options.confirmDelayMs ?? 150;
    this.reassertIntervalMs = options.reassertIntervalMs ?? 30_000;
    for (const [pointId, mode] of Object.entries(options.modes ?? {})) {
      this.modes.set(pointId, mode);
    }
  }

  /** Subscribes to `point/+/query` — the only MQTT subscription this controller ever makes — and arms the D11 re-assert loop. */
  async start(): Promise<void> {
    await this.mqtt.subscribe(`layout/${this.layoutId}/point/+/query`, (_payload, topic) => {
      const pointId = topic.split('/')[3];
      this.known.add(pointId);
      this.scheduleResponse(pointId);
    });
    this.reassertTimer = this.clock.setInterval(() => {
      void this.reassertAll();
    }, this.reassertIntervalMs);
    this.log.info('[SimPointController] Subscribed to point queries', {
      layoutId: this.layoutId,
      reassertIntervalMs: this.reassertIntervalMs,
    });
  }

  /** Cancels the re-assert loop. On `IClock`, so it is the harness's `ManualClock` in tests and a real timer only in the simulator binary. */
  stop(): void {
    this.reassertTimer?.cancel();
    this.reassertTimer = null;
  }

  /**
   * D11 (#167): re-publishes every known point's current reading, unchanged,
   * on the contract's interval — the liveness assertion `evaluateStaleness`
   * measures against.
   *
   * Goes through `respond` rather than publishing directly, so a controller in
   * `'silent'` mode stays silent here too. That is the whole point of the mode:
   * `'silent'` is a dead controller, and a dead controller does not re-assert.
   * It is what lets a scenario take a point from `'confirmed'` to `'stale'`
   * simply by flipping the mode and letting the clock run.
   */
  private async reassertAll(): Promise<void> {
    for (const pointId of this.known) {
      await this.respond(pointId);
    }
  }

  /**
   * D9: the in-process hook `LayoutService`'s `onPointCommanded` calls after
   * every point command it issues (manual or route-driven) — this is what
   * lets the simulator behave like a real controller that observed the
   * point move and reports on its own, not only in response to a `query`.
   */
  noteCommanded(pointId: PointId, position: 'normal' | 'reverse'): void {
    this.commanded.set(pointId, position);
    this.known.add(pointId);
    this.scheduleResponse(pointId);
  }

  /** Sets the failure mode for one point, overriding the default. Test hook. */
  setMode(pointId: PointId, mode: PointSimulationMode): void {
    this.modes.set(pointId, mode);
  }

  /** Sets the failure mode applied to every point with no per-point override. Test hook. */
  setDefaultMode(mode: PointSimulationMode): void {
    this.defaultMode = mode;
  }

  private scheduleResponse(pointId: PointId): void {
    this.clock.setTimeout(() => {
      void this.respond(pointId);
    }, this.confirmDelayMs);
  }

  private async respond(pointId: PointId): Promise<void> {
    const mode = this.modes.get(pointId) ?? this.defaultMode;

    // 'silent' models a stalled servo or dead controller — publish nothing,
    // so the point times out on its own schedule (D5).
    if (mode === 'silent') return;

    const commandedPosition = this.commanded.get(pointId) ?? 'normal';
    const payload = this.buildReading(pointId, mode, commandedPosition);

    await this.mqtt.publish(`layout/${this.layoutId}/point/${pointId}/reading`, payload, {
      qos: 1,
      retain: false,
    });
  }

  private buildReading(
    pointId: PointId,
    mode: PointSimulationMode,
    commandedPosition: 'normal' | 'reverse',
  ): { pointId: PointId; position: 'normal' | 'reverse' | 'unknown'; source: 'sensor' | 'driver'; updatedAt: string } {
    const updatedAt = this.clock.now().toISOString();

    switch (mode) {
      case 'wrong-position':
        // A mechanical bind or crossed wiring — reports the position it did NOT drive to.
        return {
          pointId,
          position: commandedPosition === 'normal' ? 'reverse' : 'normal',
          source: 'sensor',
          updatedAt,
        };
      case 'indeterminate':
        // Both microswitches reading open at once.
        return { pointId, position: 'unknown', source: 'sensor', updatedAt };
      case 'driver-only':
        // Feedback fitted in name only — no independent sensor.
        return { pointId, position: commandedPosition, source: 'driver', updatedAt };
      case 'confirm':
      default:
        return { pointId, position: commandedPosition, source: 'sensor', updatedAt };
    }
  }
}
