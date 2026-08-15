/**
 * Pure safety functions for the Layout Orchestrator.
 *
 * All functions here are stateless and side-effect free, making them trivially
 * testable and safe to call from anywhere in the domain layer without coupling
 * to any transport or infrastructure concerns.
 */

import {
  Occupancy,
  PointFault,
  PointId,
  RouteFault,
  RouteId,
  SensorFault,
  SensorId,
  SystemMode,
  SystemStatus,
} from './types';

// ─── Connection Health ────────────────────────────────────────────────────────

export interface ConnectionHealth {
  mqttConnected: boolean;
  dccConnected: boolean;
}

/**
 * Connection health plus topology health. `topologyValid` is required, not
 * optional-defaulting-to-true — an unset field must never be read as safe,
 * per the fail-safe rule. `topologyReason` carries the Safe-Stop reason
 * (from `describeViolations`) when `topologyValid` is false.
 *
 * `sensorFaults` is a keyed collection — one `SensorFault` per faulted
 * sensor (D2, docs/sensor-fault-recovery.md), required, not
 * optional-defaulting-to-`{}` — and latched — nothing in this module clears
 * an entry once set. A scalar cannot express "sensor A faulted, sensor B is
 * fine": acknowledging what the operator can see must not silently clear a
 * fault on a sensor they were never told about, so the system stays in
 * Safe-Stop until every entry is individually resolved (`LayoutService`'s
 * `acknowledgeSensorFault`, or a sensor going out of service — see D1/D5).
 *
 * `pointFaults` is a keyed collection of the same shape (#25, D4,
 * docs/point-feedback.md) — one latched `PointFault` per point that failed
 * to confirm, required, not optional-defaulting-to-`{}`, latched the same
 * way: nothing in this module clears an entry, only `LayoutService`'s
 * `acknowledgePointFault`, or flipping the point back to `positionFeedback:
 * 'none'` (D4's escape hatch).
 *
 * `recoveredRouteCount` is likewise required, not optional (same posture as
 * `topologyValid`): the number of route reservations that survived a
 * restart and still await an operator's explicit cancel or resume (D9). It
 * is folded into `evaluateSystemSafeStop` LAST — after sensor faults, point
 * faults, and route faults — and — like the topology and fault latches —
 * does not clear on its own: `LayoutService` decrements it only as
 * `ReservationService` reports each recovered route resolved.
 */
export interface SystemHealth extends ConnectionHealth {
  topologyValid: boolean;
  topologyReason: string | null;
  sensorFaults: Record<SensorId, SensorFault>;
  pointFaults: Record<PointId, PointFault>;
  /**
   * Latched faults against granted routes (#4, see docs/pathfinding.md P8),
   * keyed by route id for the same reason `sensorFaults` is keyed by sensor.
   * Required, not optional-defaulting-to-`{}`, same posture as the fields
   * above.
   *
   * This field is why the route-violation path is now safe. Before #4, a
   * violation called `LayoutStateManager.enterSafeStop` directly rather than
   * going through `SystemHealth`, so it left no latch: the next unrelated
   * health evaluation — an MQTT reconnect, a sensor-fault acknowledge —
   * found nothing wrong and cleared the Safe-Stop that a train being
   * somewhere it should not be had caused. Routing every Safe-Stop through
   * this one structure is the same correction #27 made for sensor faults.
   */
  routeFaults: Record<RouteId, RouteFault>;
  recoveredRouteCount: number;
}

/**
 * The first cause (D2). Earliest `faultedAt` wins; ties resolve to
 * insertion order — `Object.values` walks a string-keyed object in
 * insertion order, and `<` (strictly less than) leaves the earliest-seen
 * fault in place on a tie rather than letting a later one overwrite it.
 */
export function oldestSensorFault(faults: Record<SensorId, SensorFault>): SensorFault | null {
  return oldestFault(faults);
}

/** The first cause among latched point faults, by the same rule as `oldestSensorFault` (#25, D4). */
export function oldestPointFault(faults: Record<PointId, PointFault>): PointFault | null {
  return oldestFault(faults);
}

/** The first cause among latched route faults, by the same rule as `oldestSensorFault`. */
export function oldestRouteFault(faults: Record<RouteId, RouteFault>): RouteFault | null {
  return oldestFault(faults);
}

function oldestFault<T extends { faultedAt: Date }>(faults: Record<string, T>): T | null {
  const all = Object.values(faults);
  if (all.length === 0) return null;
  return all.reduce((oldest, candidate) =>
    candidate.faultedAt.getTime() < oldest.faultedAt.getTime() ? candidate : oldest,
  );
}

/**
 * Determines whether a Safe-Stop should be triggered based on connection health.
 * Safe-Stop is triggered if either the MQTT broker or DCC controller is disconnected.
 */
export function evaluateSafeStop(health: ConnectionHealth): {
  shouldStop: boolean;
  reason: string | null;
} {
  if (!health.mqttConnected) {
    return { shouldStop: true, reason: 'MQTT broker disconnected' };
  }
  if (!health.dccConnected) {
    return { shouldStop: true, reason: 'DCC controller disconnected' };
  }
  return { shouldStop: false, reason: null };
}

/**
 * Determines whether a Safe-Stop should be triggered based on connection
 * health, topology health, sensor-payload health, point-confirmation health,
 * route health, and restart-recovered routes. Check order is MQTT, then DCC,
 * then topology, then the oldest latched sensor fault, then the oldest
 * latched point fault, then the oldest latched route fault, then recovered
 * routes — a connection failure reason always wins over a topology reason,
 * which wins over a sensor fault, and so on down to the recovered-route
 * reason, so an operator investigating a Safe-Stop sees the more systemic,
 * more actionable cause first. With several faults latched at once, only the
 * oldest's reason is reported here (D2 — "the first cause"); the rest are
 * visible via `LayoutService.getSensorFaults()` / `getPointFaults()` /
 * `getRouteFaults()` and their `GET` routes.
 *
 * Point faults sit below sensor faults (#25, D4) because a sensor fault is
 * the more systemic failure — an entire class of block-detection evidence
 * going untrustworthy, versus one point — and above route faults on
 * cause-before-symptom: a point that failed to confirm is *why* a route
 * gets suspended (PR B), not a peer fact.
 *
 * Route faults sit *below* sensor faults (and point faults) because a
 * sensor fault is usually the cause and the route fault the symptom: a
 * detector that stopped reporting is what made a route's block
 * undeterminable. Naming the sensor first points the operator at the thing
 * to fix.
 */
export function evaluateSystemSafeStop(health: SystemHealth): {
  shouldStop: boolean;
  reason: string | null;
} {
  const connectionResult = evaluateSafeStop(health);
  if (connectionResult.shouldStop) {
    return connectionResult;
  }
  if (!health.topologyValid) {
    return { shouldStop: true, reason: health.topologyReason };
  }
  const oldest = oldestSensorFault(health.sensorFaults);
  if (oldest) {
    return { shouldStop: true, reason: oldest.reason };
  }
  const oldestPoint = oldestPointFault(health.pointFaults);
  if (oldestPoint) {
    return { shouldStop: true, reason: oldestPoint.reason };
  }
  const oldestRoute = oldestRouteFault(health.routeFaults);
  if (oldestRoute) {
    return { shouldStop: true, reason: oldestRoute.reason };
  }
  if (health.recoveredRouteCount > 0) {
    return {
      shouldStop: true,
      reason: `${health.recoveredRouteCount} route reservation(s) survived a restart and must be cleared`,
    };
  }
  return { shouldStop: false, reason: null };
}

// ─── Command Authorization ────────────────────────────────────────────────────

/**
 * Whether the automation engine may issue a command.
 * Auto commands require both online status AND an auto-capable mode.
 */
export function canIssueAutoCommand(status: SystemStatus, mode: SystemMode): boolean {
  return status === 'online' && (mode === 'auto' || mode === 'hybrid');
}

/**
 * Whether a manual operator command may be issued.
 * Manual commands are permitted even in safe-stop to allow operator recovery,
 * but not when the system is fully offline (no connection to DCC controller).
 */
export function canIssueManualCommand(status: SystemStatus): boolean {
  return status !== 'offline';
}

/**
 * Whether a route may be granted. Independent of `SystemMode` (D7) — a
 * reservation in `manual` mode is a pure interlocking (points set and
 * locked, blocks reserved, operator drives it), which is useful before
 * automation exists and costs nothing. Only system status gates it: a route
 * must never be granted while Safe-Stopped or offline.
 */
export function canGrantRoute(status: SystemStatus): boolean {
  return status === 'online';
}

/**
 * Whether an operator's `force: true` point override is permitted (D6).
 * Refused outright in `auto` mode — there is no manual authority in auto,
 * codifying the existing `PointCommand.force` doc comment — and refused
 * when the system is `offline` (no DCC connection to issue the command on).
 * Permitted in `safe-stop` for operator recovery, same posture as
 * `canIssueManualCommand`. A permitted override still cancels the route
 * holding the point (D6) — that is enforced by the caller, not this
 * predicate, which only answers "is the override itself allowed".
 */
export function canForcePointOverride(status: SystemStatus, mode: SystemMode): boolean {
  return mode !== 'auto' && status !== 'offline';
}

// ─── Block Safety ─────────────────────────────────────────────────────────────

/**
 * Whether a block should be treated as occupied for routing and collision purposes.
 * 'unknown' is treated as occupied — this is the core fail-safe rule.
 * A block must be positively confirmed as clear before a train may enter.
 */
export function isBlockEffectivelyOccupied(occupancy: Occupancy): boolean {
  return occupancy !== 'clear';
}

/**
 * Validates a DCC speed value.
 */
export function isValidSpeed(speed: number): boolean {
  return Number.isInteger(speed) && speed >= 0 && speed <= 126;
}

/**
 * Validates a DCC loco address.
 */
export function isValidLocoAddress(address: number): boolean {
  return Number.isInteger(address) && address >= 1 && address <= 9999;
}
