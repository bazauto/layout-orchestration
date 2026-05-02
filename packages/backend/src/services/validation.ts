/**
 * Zod validation schemas for incoming payloads.
 * All payloads crossing the transport boundary (MQTT, HTTP, WebSocket) must
 * be validated here before entering the service layer.
 */

import { z } from 'zod';

export const sensorReadingSchema = z.object({
  state: z.enum(['occupied', 'clear']),
  updatedAt: z.string().optional(),
});

export const throttleCommandSchema = z.object({
  locoAddress: z.number().int().min(1).max(9999),
  speed: z.number().int().min(0).max(126),
  direction: z.enum(['fwd', 'rev', 'stop']),
});

export const pointCommandSchema = z.object({
  pointId: z.string().min(1),
  position: z.enum(['normal', 'reverse']),
  force: z.boolean().optional(),
});

export const functionCommandSchema = z.object({
  locoAddress: z.number().int().min(1).max(9999),
  fn: z.number().int().min(0).max(28),
  state: z.boolean(),
});

export const setModeSchema = z.object({
  mode: z.enum(['manual', 'auto', 'hybrid']),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('THROTTLE_COMMAND'), payload: throttleCommandSchema }),
  z.object({ type: z.literal('POINT_COMMAND'), payload: pointCommandSchema }),
  z.object({ type: z.literal('FUNCTION_COMMAND'), payload: functionCommandSchema }),
  z.object({ type: z.literal('SET_MODE'), payload: setModeSchema }),
  z.object({ type: z.literal('EMERGENCY_STOP') }),
]);
