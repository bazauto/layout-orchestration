/**
 * Zod validation schemas for incoming payloads.
 * All payloads crossing the transport boundary (MQTT, HTTP, WebSocket) must
 * be validated here before entering the service layer.
 */

import { z } from 'zod';
import { BlockEdge, PointCondition } from '../domain/types';

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

export const pointConditionSchema = z.object({
  pointId: z.string().min(1),
  requiredPosition: z.enum(['normal', 'reverse']),
});

export const pointConditionsSchema = z.array(pointConditionSchema);

/**
 * Parses the block_edges.point_conditions JSON column.
 * THROWS on malformed JSON or a failed schema check. It must never degrade to
 * an empty array: that would silently turn a point-gated edge into an
 * unconditionally traversable one.
 */
export function parsePointConditions(json: string): PointCondition[] {
  return pointConditionsSchema.parse(JSON.parse(json));
}

// ─── Block Edges ───────────────────────────────────────────────────────────

/**
 * A block-end label ('north', 'yard-3', ...) as stored in the DB. Lowercase
 * slug shape — writes normalise into this form (see `edgeCreateSchema`), so
 * a row failing this pattern indicates the row was written outside the
 * normal write path.
 */
export const blockEndLabelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

/**
 * Full-row schema for a `block_edges` DB row — every column, not just
 * `point_conditions`. A row that fails this (e.g. an un-normalised
 * `from_end` written outside the API) is DB corruption, not a value to
 * coerce past.
 */
export const blockEdgeRowSchema = z.object({
  id: z.string().min(1),
  layoutId: z.string().min(1),
  fromBlockId: z.string().min(1),
  fromEnd: blockEndLabelSchema,
  toBlockId: z.string().min(1),
  toEnd: blockEndLabelSchema,
  pointConditions: z.string(),
  lengthMm: z.number().int().positive().nullable(),
});

/** Thrown by `parseBlockEdgeRow` when a `block_edges` row fails validation. */
export class BlockEdgeRowInvalidError extends Error {
  readonly rowId: string;
  readonly issues: z.ZodIssue[];

  constructor(rowId: string, issues: z.ZodIssue[]) {
    super(`block_edges row ${rowId} failed validation: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'BlockEdgeRowInvalidError';
    this.rowId = rowId;
    this.issues = issues;
  }
}

/**
 * Parses a raw `block_edges` DB row into a domain `BlockEdge`.
 *
 * Deliberately NO coercion, NO defaults, and no `.catch()` fallback: unlike
 * a write-path schema, a row already in the database is either valid or it
 * is corruption, and corruption must surface as a thrown error (which the
 * topology load path turns into a Safe-Stop), never as a silently
 * substituted "safe-looking" value.
 */
export function parseBlockEdgeRow(row: unknown): BlockEdge {
  const parsed = blockEdgeRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new BlockEdgeRowInvalidError(extractRowId(row), parsed.error.issues);
  }

  let pointConditions: PointCondition[];
  try {
    pointConditions = parsePointConditions(parsed.data.pointConditions);
  } catch (err) {
    throw new BlockEdgeRowInvalidError(parsed.data.id, [
      {
        code: z.ZodIssueCode.custom,
        path: ['pointConditions'],
        message: err instanceof Error ? err.message : 'Invalid point_conditions JSON',
      },
    ]);
  }

  return {
    id: parsed.data.id,
    layoutId: parsed.data.layoutId,
    fromBlockId: parsed.data.fromBlockId,
    fromEnd: parsed.data.fromEnd,
    toBlockId: parsed.data.toBlockId,
    toEnd: parsed.data.toEnd,
    pointConditions,
    lengthMm: parsed.data.lengthMm,
  };
}

function extractRowId(row: unknown): string {
  if (typeof row === 'object' && row !== null && 'id' in row && typeof (row as { id: unknown }).id === 'string') {
    return (row as { id: string }).id;
  }
  return 'unknown';
}

/**
 * Write schema for creating an edge. `.strict()` so a body carrying `id` or
 * `layoutId` — both path/server-owned, never client-supplied — is a 400, not
 * a silently ignored field. `fromEnd`/`toEnd` are trimmed and lower-cased
 * before the slug check, so operator input like `' North '` normalises to
 * `'north'` instead of being rejected.
 */
export const edgeCreateSchema = z
  .object({
    fromBlockId: z.string().min(1),
    fromEnd: z.string().trim().toLowerCase().pipe(blockEndLabelSchema),
    toBlockId: z.string().min(1),
    toEnd: z.string().trim().toLowerCase().pipe(blockEndLabelSchema),
    pointConditions: pointConditionsSchema.default([]),
    lengthMm: z.number().int().positive().nullable().default(null),
  })
  .strict();

export type EdgeCreateInput = z.infer<typeof edgeCreateSchema>;

/** Write schema for a partial edge update. Same `.strict()` posture as create. */
export const edgeUpdateSchema = edgeCreateSchema.partial().strict();

export type EdgeUpdateInput = z.infer<typeof edgeUpdateSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('THROTTLE_COMMAND'), payload: throttleCommandSchema }),
  z.object({ type: z.literal('POINT_COMMAND'), payload: pointCommandSchema }),
  z.object({ type: z.literal('FUNCTION_COMMAND'), payload: functionCommandSchema }),
  z.object({ type: z.literal('SET_MODE'), payload: setModeSchema }),
  z.object({ type: z.literal('EMERGENCY_STOP') }),
]);
