/**
 * Pure safety functions for the Layout Orchestrator.
 *
 * All functions here are stateless and side-effect free, making them trivially
 * testable and safe to call from anywhere in the domain layer without coupling
 * to any transport or infrastructure concerns.
 */

import { Occupancy, SensorFault, SensorId, SystemMode, SystemStatus } from './types';

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
 * `recoveredRouteCount` is likewise required, not optional (same posture as
 * `topologyValid`): the number of route reservations that survived a
 * restart and still await an operator's explicit cancel or resume (D9). It
 * is folded into `evaluateSystemSafeStop` LAST — after sensor faults — and
 * — like the topology and sensor-fault latches — does not clear on its own:
 * `LayoutService` decrements it only as `ReservationService` reports each
 * recovered route resolved.
 */
export interface SystemHealth extends ConnectionHealth {
  topologyValid: boolean;
  topologyReason: string | null;
  sensorFaults: Record<SensorId, SensorFault>;
  recoveredRouteCount: number;
}

/**
 * The first cause (D2). Earliest `faultedAt` wins; ties resolve to
 * insertion order — `Object.values` walks a string-keyed object in
 * insertion order, and `<` (strictly less than) leaves the earliest-seen
 * fault in place on a tie rather than letting a later one overwrite it.
 */
export function oldestSensorFault(faults: Record<SensorId, SensorFault>): SensorFault | null {
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
 * health, topology health, sensor-payload health, and restart-recovered
 * routes. Check order is MQTT, then DCC, then topology, then the oldest
 * latched sensor fault, then recovered routes — a connection failure reason
 * always wins over a topology reason, which wins over a sensor fault, which
 * wins over a recovered-route reason, so an operator investigating a
 * Safe-Stop sees the more systemic, more actionable cause first. With
 * several sensor faults latched at once, only the oldest's reason is
 * reported here (D2 — "the first cause"); the rest are visible via
 * `LayoutService.getSensorFaults()` / `GET .../sensor-faults`.
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
