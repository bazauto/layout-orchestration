/**
 * Pure safety functions for the Layout Orchestrator.
 *
 * All functions here are stateless and side-effect free, making them trivially
 * testable and safe to call from anywhere in the domain layer without coupling
 * to any transport or infrastructure concerns.
 */

import { Occupancy, SystemMode, SystemStatus } from './types';

// ─── Connection Health ────────────────────────────────────────────────────────

export interface ConnectionHealth {
  mqttConnected: boolean;
  dccConnected: boolean;
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
