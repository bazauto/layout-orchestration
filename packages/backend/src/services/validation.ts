/**
 * Zod validation schemas for incoming payloads.
 * All payloads crossing the transport boundary (MQTT, HTTP, WebSocket) must
 * be validated here before entering the service layer.
 */

import { z } from 'zod';
import { BlockEdge, PointCondition, RouteHold, RoutePathStep, RouteReservation } from '../domain/types';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../domain/auth';
import { SessionRecord, UserRecord } from '../ports/IAuthRepository';
import { SensorRecord } from '../ports/ILayoutRepository';

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

// ─── Blocks ─────────────────────────────────────────────────────────────

/**
 * Write schema for creating a block (`POST .../blocks`). A block row is only
 * a name, but it is the substrate the topology graph and — since #4 — route
 * reservation are built on, so it gets the same `.strict()` posture as its
 * siblings: `id` and `layoutId` are path/server-owned and a body carrying
 * either is a 400, not a silently ignored field.
 */
export const blockCreateSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();

export type BlockCreateInput = z.infer<typeof blockCreateSchema>;

/** Write schema for a partial block update. Same `.strict()` posture as create. */
export const blockUpdateSchema = blockCreateSchema.partial().strict();

export type BlockUpdateInput = z.infer<typeof blockUpdateSchema>;

// ─── Points ─────────────────────────────────────────────────────────────

/**
 * Write schema for creating a point (`POST .../points`). `dccAddress` is the
 * reason this matters more than it looks: it is the accessory address a
 * physical point motor is thrown on, so the string `"3"` reaching Drizzle
 * unchecked is bad config driving real hardware.
 */
export const pointCreateSchema = z
  .object({
    name: z.string().min(1),
    dccAddress: z.number().int().positive(),
    blockId: z.string().min(1).nullable().default(null),
  })
  .strict();

export type PointCreateInput = z.infer<typeof pointCreateSchema>;

/**
 * Write schema for a point update (`PUT .../points/:id`). Every field is
 * optional — a partial update — but `.strict()` so an unexpected field (e.g.
 * a client posting `id` or `layoutId`, both path/server-owned) is a 400, not
 * a silently ignored write. Same posture as `edgeUpdateSchema`.
 *
 * Deliberately not `pointCreateSchema.partial()`: that would carry create's
 * `.default(null)` on `blockId` into the update path, turning an omitted
 * `blockId` into an explicit "unassign this point from its block".
 */
export const pointUpdateSchema = z
  .object({
    name: z.string().min(1).optional(),
    dccAddress: z.number().int().positive().optional(),
    blockId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type PointUpdateInput = z.infer<typeof pointUpdateSchema>;

// ─── Sensors (see docs/sensor-fault-recovery.md) ───────────────────────────

export const sensorTypeSchema = z.enum(['block_detection', 'ir_position']);

/**
 * Full-row schema for a `sensors` DB row — every column, matching the
 * posture of `blockEdgeRowSchema`/`userRowSchema`: `listSensors` used to do
 * a bare `as SensorRecord[]` cast, so `type` had never actually been
 * validated even though it now decides whether a `clear` reading may empty
 * a block (D3) — see DD9 in docs/sensor-fault-recovery.md.
 */
export const sensorRowSchema = z.object({
  id: z.string().min(1),
  layoutId: z.string().min(1),
  name: z.string().min(1),
  type: sensorTypeSchema,
  blockId: z.string().min(1).nullable(),
  mqttTopic: z.string().min(1),
  inService: z.boolean(),
});

/** Thrown by `parseSensorRow` when a `sensors` row fails validation. */
export class SensorRowInvalidError extends Error {
  readonly rowId: string;
  readonly issues: z.ZodIssue[];

  constructor(rowId: string, issues: z.ZodIssue[]) {
    super(`sensors row ${rowId} failed validation: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'SensorRowInvalidError';
    this.rowId = rowId;
    this.issues = issues;
  }
}

/**
 * Parses a raw `sensors` DB row into a `SensorRecord`. Same posture as
 * `parseBlockEdgeRow`/`parseUserRow`: no coercion, no defaults — a row
 * already in the database is either valid or it is corruption, and
 * corruption must throw.
 */
export function parseSensorRow(row: unknown): SensorRecord {
  const parsed = sensorRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new SensorRowInvalidError(extractRowId(row), parsed.error.issues);
  }
  return parsed.data;
}

/**
 * Write schema for creating a sensor. `.strict()` so a body carrying `id` or
 * `layoutId` — both path/server-owned — is a 400, not a silently ignored
 * field. `inService` defaults to `true` (DD9) — the create form has no
 * in-service toggle; that is set later via the update route.
 */
export const sensorCreateSchema = z
  .object({
    name: z.string().min(1),
    type: sensorTypeSchema,
    blockId: z.string().min(1).nullable().default(null),
    mqttTopic: z.string().min(1),
    inService: z.boolean().default(true),
  })
  .strict();

export type SensorCreateInput = z.infer<typeof sensorCreateSchema>;

/** Write schema for a partial sensor update. Same `.strict()` posture as create, matching `pointUpdateSchema`. */
export const sensorUpdateSchema = sensorCreateSchema.partial().strict();

export type SensorUpdateInput = z.infer<typeof sensorUpdateSchema>;

// ─── Route Reservations ────────────────────────────────────────────────────
//
// Same posture as block_edges above: full-row Zod, no coercion, no defaults,
// no `.catch()`. A `route_reservations`/`route_holds` row already in the
// database is either valid or it is corruption, and corruption must throw
// (which the reservation load path turns into Safe-Stop, per D9), never
// silently substitute a "safe-looking" value.

const authoritySchema = z.enum(['manual', 'auto']);
const routeStatusSchema = z.enum(['active', 'suspended', 'released', 'cancelled']);
const routeHoldKindSchema = z.enum(['block', 'point', 'edge']);
const requiredPositionSchema = z.enum(['normal', 'reverse']).nullable();

const routePathStepSchema = z.object({
  edgeId: z.string().min(1).nullable(),
  blockId: z.string().min(1),
  entryEnd: z.string().min(1).nullable(),
  exitEnd: z.string().min(1).nullable(),
});

/** Parses the `route_reservations.path` JSON column. THROWS on malformed JSON or a failed schema check — never degrades to `[]`, which would silently turn a real path into an empty one. */
const routePathSchema = z.array(routePathStepSchema);

/** Full-row schema for a `route_reservations` DB row. */
export const routeReservationRowSchema = z.object({
  id: z.string().min(1),
  layoutId: z.string().min(1),
  locoAddress: z.number().int().min(1).max(9999),
  authority: authoritySchema,
  status: routeStatusSchema,
  path: z.string(),
  confirmedIndex: z.number().int().min(0),
  reason: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

/** Full-row schema for a `route_holds` DB row. */
export const routeHoldRowSchema = z.object({
  id: z.string().min(1),
  routeId: z.string().min(1),
  layoutId: z.string().min(1),
  kind: routeHoldKindSchema,
  targetId: z.string().min(1),
  requiredPosition: requiredPositionSchema,
  releaseAfterIndex: z.number().int().min(0),
  released: z.boolean(),
});

/** Thrown by `parseReservationRow` when a `route_reservations`/`route_holds` row fails validation. */
export class RouteRowInvalidError extends Error {
  readonly rowId: string;
  readonly issues: z.ZodIssue[];

  constructor(rowId: string, issues: z.ZodIssue[]) {
    super(`route reservation row ${rowId} failed validation: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'RouteRowInvalidError';
    this.rowId = rowId;
    this.issues = issues;
  }
}

/**
 * Parses a raw `route_reservations` row plus its `route_holds` rows into a
 * domain `RouteReservation`. Deliberately NO coercion, NO defaults, no
 * `.catch()` fallback — same posture as `parseBlockEdgeRow`.
 */
export function parseReservationRow(row: unknown, holdRows: readonly unknown[]): RouteReservation {
  const parsedRow = routeReservationRowSchema.safeParse(row);
  if (!parsedRow.success) {
    throw new RouteRowInvalidError(extractRowId(row), parsedRow.error.issues);
  }

  let path: RoutePathStep[];
  try {
    path = routePathSchema.parse(JSON.parse(parsedRow.data.path));
  } catch (err) {
    throw new RouteRowInvalidError(parsedRow.data.id, [
      {
        code: z.ZodIssueCode.custom,
        path: ['path'],
        message: err instanceof Error ? err.message : 'Invalid path JSON',
      },
    ]);
  }

  const holds: RouteHold[] = holdRows.map((holdRow) => {
    const parsedHold = routeHoldRowSchema.safeParse(holdRow);
    if (!parsedHold.success) {
      throw new RouteRowInvalidError(extractRowId(holdRow), parsedHold.error.issues);
    }
    return {
      kind: parsedHold.data.kind,
      targetId: parsedHold.data.targetId,
      requiredPosition: parsedHold.data.requiredPosition,
      releaseAfterIndex: parsedHold.data.releaseAfterIndex,
      released: parsedHold.data.released,
    };
  });

  return {
    id: parsedRow.data.id,
    layoutId: parsedRow.data.layoutId,
    locoAddress: parsedRow.data.locoAddress,
    authority: parsedRow.data.authority,
    status: parsedRow.data.status,
    path,
    holds,
    confirmedIndex: parsedRow.data.confirmedIndex,
    reason: parsedRow.data.reason,
    createdAt: parsedRow.data.createdAt,
    updatedAt: parsedRow.data.updatedAt,
  };
}

// ─── Route Requests (transport write schemas) ──────────────────────────────
//
// `.strict()`, same posture as edgeCreateSchema — an unexpected field (e.g.
// a client posting `layoutId`, which is path/server-owned) is a 400, not a
// silently ignored field.

/**
 * `POST /api/layouts/:layoutId/routes`.
 *
 * Two mutually exclusive ways to specify the track (#4): an explicit ordered
 * `edgeIds` list (#3's original form, still first-class), or a
 * `destinationBlockId` for the pathfinder to search for. A `.refine()`
 * rather than a `z.discriminatedUnion` because there is no discriminant
 * field on the wire — the client sends one shape or the other, and adding a
 * `kind` tag purely to satisfy the parser would be API noise. The refinement
 * enforces exactly-one, so sending both (which would silently favour one) or
 * neither is a 400.
 *
 * `startExitEnd` constrains which end of the start block the train leaves
 * by. Meaningful only with `destinationBlockId` — an explicit edge list
 * already fixes the first edge — and rejected alongside `edgeIds` rather
 * than ignored.
 */
export const routeRequestSchema = z
  .object({
    locoAddress: z.number().int().min(1).max(9999),
    authority: z.enum(['manual', 'auto']),
    startBlockId: z.string().min(1),
    edgeIds: z.array(z.string().min(1)).optional(),
    destinationBlockId: z.string().min(1).optional(),
    startExitEnd: z.string().trim().toLowerCase().pipe(blockEndLabelSchema).optional(),
  })
  .strict()
  .refine((body) => (body.edgeIds === undefined) !== (body.destinationBlockId === undefined), {
    message: 'exactly one of edgeIds or destinationBlockId is required',
    path: ['edgeIds'],
  })
  .refine((body) => body.startExitEnd === undefined || body.edgeIds === undefined, {
    message: 'startExitEnd applies only to a destinationBlockId request',
    path: ['startExitEnd'],
  });

export type RouteRequestInput = z.infer<typeof routeRequestSchema>;

/** `DELETE /api/layouts/:layoutId/routes/:routeId`. `reason` is optional — a body-less DELETE defaults to a generic operator-cancel reason in the route handler. */
export const routeCancelSchema = z
  .object({
    reason: z.string().min(1).optional(),
  })
  .strict();

// ─── Auth ────────────────────────────────────────────────────────────────

const roleSchema = z.enum(['admin', 'operator']);

/**
 * Full-row schema for a `users` DB row. `passwordHash` is nullable — see the
 * doc comment on the `users` table in `schema.ts` — but if present must be a
 * non-empty argon2id-encoded string, not an empty string masquerading as
 * "no credential".
 */
export const userRowSchema = z.object({
  id: z.string().min(1),
  username: z.string().min(1),
  passwordHash: z.string().min(1).nullable(),
  role: roleSchema,
  createdAt: z.date(),
});

/** Thrown by `parseUserRow` when a `users` row fails validation. */
export class UserRowInvalidError extends Error {
  readonly rowId: string;
  readonly issues: z.ZodIssue[];

  constructor(rowId: string, issues: z.ZodIssue[]) {
    super(`users row ${rowId} failed validation: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'UserRowInvalidError';
    this.rowId = rowId;
    this.issues = issues;
  }
}

/**
 * Parses a raw `users` DB row into a `UserRecord`. Same posture as
 * `parseBlockEdgeRow`: no coercion, no defaults — a row already in the
 * database is either valid or it is corruption, and corruption must throw.
 */
export function parseUserRow(row: unknown): UserRecord {
  const parsed = userRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new UserRowInvalidError(extractRowId(row), parsed.error.issues);
  }
  return parsed.data;
}

/** Full-row schema for a `sessions` DB row. */
export const sessionRowSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  tokenHash: z.string().min(1),
  createdAt: z.date(),
  expiresAt: z.date(),
});

/** Thrown by `parseSessionRow` when a `sessions` row fails validation. */
export class SessionRowInvalidError extends Error {
  readonly rowId: string;
  readonly issues: z.ZodIssue[];

  constructor(rowId: string, issues: z.ZodIssue[]) {
    super(`sessions row ${rowId} failed validation: ${issues.map((i) => i.message).join('; ')}`);
    this.name = 'SessionRowInvalidError';
    this.rowId = rowId;
    this.issues = issues;
  }
}

/** Parses a raw `sessions` DB row into a `SessionRecord`. Same posture as `parseUserRow`. */
export function parseSessionRow(row: unknown): SessionRecord {
  const parsed = sessionRowSchema.safeParse(row);
  if (!parsed.success) {
    throw new SessionRowInvalidError(extractRowId(row), parsed.error.issues);
  }
  return parsed.data;
}

/**
 * Write schema for `POST /api/auth/login`. `.strict()` so an unexpected
 * field (e.g. a client accidentally posting `role`) is a 400, not silently
 * ignored.
 */
export const loginSchema = z
  .object({
    username: z.string().min(1),
    password: z.string().min(1),
  })
  .strict();

// ─── User management (issue #53, see docs/auth.md) ─────────────────────────
//
// `.strict()`, same posture as `edgeCreateSchema` — an unexpected field is a
// 400, not a silently ignored write.

// Every message below is written to be shown to an admin verbatim. Zod's
// defaults ("String must contain at least 8 character(s)") name the *type*,
// not the field, and reach the Users tab through `extractErrorMessage` — an
// admin needs to know how to fix the input, not what a Zod string is.
const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`);

/**
 * Write schema for `POST /api/users`. `role` is required rather than
 * defaulted, so creating an operator is an explicit act and a client that
 * forgets the field gets a 400 instead of silently inheriting the column
 * default.
 */
export const userCreateSchema = z
  .object({
    username: z
      .string()
      .trim()
      .min(1, 'Username is required')
      .max(64, 'Username must be at most 64 characters'),
    password: newPasswordSchema,
    role: roleSchema,
  })
  .strict();

export type UserCreateInput = z.infer<typeof userCreateSchema>;

/**
 * Write schema for `PATCH /api/users/:id`. Role only — a password reset is
 * its own route (`POST /api/users/:id/password`), never a field here, so a
 * credential rotation reads differently in logs from a role change.
 */
export const userRoleUpdateSchema = z
  .object({
    role: roleSchema,
  })
  .strict();

export type UserRoleUpdateInput = z.infer<typeof userRoleUpdateSchema>;

/** Write schema for `POST /api/users/:id/password` (admin reset). */
export const passwordResetSchema = z
  .object({
    password: newPasswordSchema,
  })
  .strict();

export type PasswordResetInput = z.infer<typeof passwordResetSchema>;

/** Write schema for `POST /api/auth/change-password` (self-service). */
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: newPasswordSchema,
  })
  .strict();

export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('THROTTLE_COMMAND'), payload: throttleCommandSchema }),
  z.object({ type: z.literal('POINT_COMMAND'), payload: pointCommandSchema }),
  z.object({ type: z.literal('FUNCTION_COMMAND'), payload: functionCommandSchema }),
  z.object({ type: z.literal('SET_MODE'), payload: setModeSchema }),
  z.object({ type: z.literal('EMERGENCY_STOP') }),
]);
