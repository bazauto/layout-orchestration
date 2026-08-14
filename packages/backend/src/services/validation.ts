/**
 * Zod validation schemas for incoming payloads.
 * All payloads crossing the transport boundary (MQTT, HTTP, WebSocket) must
 * be validated here before entering the service layer.
 */

import { z } from 'zod';
import {
  ANNOTATION_ENTITY_TYPES,
  BlockEdge,
  GridTileMetadata,
  MAX_TILE_ANNOTATIONS,
  PointCondition,
  RouteHold,
  RoutePathStep,
  RouteReservation,
  TILE_EDGES,
  TILE_ROTATIONS,
  TILE_TRACK_ROLES,
  TILE_TYPES,
  TileRotation,
} from '../domain/types';
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
  };
}

function extractRowId(row: unknown): string {
  if (typeof row === 'object' && row !== null && 'id' in row && typeof (row as { id: unknown }).id === 'string') {
    return (row as { id: string }).id;
  }
  return 'unknown';
}

/*
 * `edgeCreateSchema` / `edgeUpdateSchema` were here, and went with the manual
 * edge write path (#103 PR 5, OQ1). There is no body to validate any more: the
 * only thing that writes `block_edges` is the compile apply below, whose body
 * is a fingerprint. A compiled row is built by `trackGraphCompiler` in-process
 * and never crosses the wire, so it is guarded by the type system rather than
 * by Zod — `NamedCompiledEdge` cannot hold a null end.
 *
 * `blockEndLabelSchema` above stays: it is still the shape of
 * `block_edges.fromEnd`/`toEnd` on read, and `routeCreateSchema` still accepts
 * a `startExitEnd`.
 */

/**
 * Write schema for `POST .../topology/compile/apply` (#103, D10).
 *
 * **A fingerprint and nothing else.** There is deliberately no `edges` field:
 * the apply recompiles from the drawing, and a body that could carry rows would
 * be a second authoring path wearing the compiler's name — the exact bypass D1
 * and D3 are built to make impossible. `.strict()` means a body that tries is a
 * 400 rather than a silently ignored field, which matters more here than
 * anywhere else in this file.
 */
export const compileApplySchema = z.object({ fingerprint: z.string().min(1) }).strict();

export type CompileApplyInput = z.infer<typeof compileApplySchema>;

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
    /**
     * Measured length in mm, or `null` for unmeasured. Not defaulted to a
     * number: unmeasured must refuse a braked run rather than brake on a figure
     * nobody took a tape to (`docs/braking.md` B4).
     */
    lengthMm: z.number().int().positive().nullable().default(null),
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

/**
 * Write schema for `POST .../sensors/:sensorId/simulate-reading` (#65 R5).
 * One route, one discriminated body — the four operator actions differ only
 * in the bytes published and share lookup/in-service/logging/response, so
 * four routes would mean four copies of the 404/409 mapping.
 *
 * Strictly validated even though `malformed`'s PUBLISHED bytes are
 * deliberately invalid on purpose: the variant is selected BY NAME from a
 * server-side table (D5), never client-supplied bytes, so a bad REQUEST body
 * here is an ordinary 400 (CLAUDE.md's "a malformed operator UI request is a
 * 400, not a layout halt" rule) — a wholly different boundary from the
 * malformed payload that later round-trips through MQTT and correctly
 * Safe-Stops.
 *
 * `clear-retained` carries NO `retain` field, and `.strict()` rejects one — a
 * non-retained zero-byte publish clears nothing, so accepting `retain: false`
 * there would be a silent no-op. `retain` defaults to `true` elsewhere (D6),
 * matching `sensor/*\/reading`'s contract retention.
 */
export const simulateReadingSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('reading'),
      state: z.enum(['occupied', 'clear']),
      retain: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('malformed'),
      variant: z.enum(['bad-enum', 'missing-field', 'not-an-object']),
      retain: z.boolean().default(true),
    })
    .strict(),
  z.object({ action: z.literal('clear-retained') }).strict(),
]);

export type SimulateReadingInput = z.infer<typeof simulateReadingSchema>;

// ─── Grid Tiles (#70, see docs/track-grid.md) ──────────────────────────────
//
// Posture: a malformed grid write is an ordinary **400**. This is an admin
// config surface, not a sensor or control topic — CLAUDE.md's Traps section
// already records that turning a bad UI request into a layout halt would
// itself be a bug. Nothing here routes through `SystemHealth`.

export const tileTypeSchema = z.enum(TILE_TYPES);

/**
 * Upper bound on a tile coordinate. Not a canvas size — #69 makes the drawn
 * extent derive from content, so the editor has no fixed edge to validate
 * against. This is admission control against an absurd coordinate (a fat
 * finger, or `1e9` from a script) creating a row nothing can ever scroll to,
 * in the same spirit as `MAX_EDGES_PER_LAYOUT`. A layout ~1000 tiles across
 * is already far beyond anything a physical railway needs.
 */
export const MAX_TILE_COORDINATE = 999;

const tileCoordinateSchema = z.number().int().min(0).max(MAX_TILE_COORDINATE);

const tileRotationSchema = z
  .number()
  .int()
  .refine((r): r is TileRotation => (TILE_ROTATIONS as readonly number[]).includes(r), {
    message: `Rotation must be one of ${TILE_ROTATIONS.join(', ')}`,
  });

/**
 * One placed entity (#74). `.strict()` like everything else on this path, and
 * `entityType` is a closed enum so an annotation always resolves to a table —
 * an id alone cannot.
 */
export const tileAnnotationSchema = z
  .object({
    entityType: z.enum(ANNOTATION_ENTITY_TYPES),
    entityId: z.string().min(1),
    orientation: tileRotationSchema.optional(),
  })
  .strict();

/**
 * One road through a point tile (#73).
 *
 * `when` is a **list** and `legs` is a pair of distinct tile edges. Both
 * shapes come straight from #83: a `normalLeg` naming one of two legs
 * forecloses three-way points, and keying on a single point's position
 * forecloses slips. Costing nothing extra now is the entire argument — the
 * retrofit is a migration plus revisiting every point tile by hand.
 *
 * No two conditions in one `when` may name the same point: "normal AND
 * reverse" is unsatisfiable and "normal AND normal" is a duplicate.
 */
export const tilePointRoadSchema = z
  .object({
    when: z
      .array(
        z
          .object({
            pointId: z.string().min(1),
            position: z.enum(['normal', 'reverse']),
          })
          .strict(),
      )
      .min(1, 'A road needs at least one point condition')
      .max(4)
      .superRefine((when, ctx) => {
        const seen = new Set<string>();
        for (const c of when) {
          if (seen.has(c.pointId)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `Point ${c.pointId} appears twice in one road condition`,
            });
          }
          seen.add(c.pointId);
        }
      }),
    legs: z
      .tuple([z.enum(TILE_EDGES), z.enum(TILE_EDGES)])
      .refine(([a, b]) => a !== b, { message: 'A road must join two different tile edges' }),
  })
  .strict();

/** Canonical, order-independent key for a road's `when` tuple — two roads selected by the same conditions are ambiguous. */
function roadConditionKey(when: readonly { pointId: string; position: string }[]): string {
  return [...when]
    .map((c) => `${c.pointId}:${c.position}`)
    .sort()
    .join('|');
}

/**
 * Closed schema for a tile's `metadata` blob — `.strict()`, not passthrough.
 *
 * The blob was a free-form JSON string stringified verbatim from the request
 * body. Closing it in #70 is what made wave 2 cheap: #71's classification,
 * #74's annotations and #73's point roads all land in this object, and a
 * passthrough schema cannot distinguish a key a future feature will add from
 * a key a client misspelled today. Every new field is added here and to
 * `GridTileMetadata` together.
 *
 * `rotation` is an enum of the eight 45° steps rather than `number % 45`,
 * because that is exactly what the editor can author and a closed set gives a
 * better rejection message than a modulo refinement.
 *
 * The cross-field checks below are the ones a per-field schema cannot express.
 * Note what is *not* here: whether `blockId`, `pointId` or an annotation's
 * `entityId` resolve to records **in this layout** is a referential question,
 * and `GridService` owns it (D6).
 */
export const gridTileMetadataSchema = z
  .object({
    rotation: tileRotationSchema.optional(),
    blockId: z.string().min(1).optional(),
    pointId: z.string().min(1).optional(),
    trackRole: z.enum(TILE_TRACK_ROLES).optional(),
    annotations: z.array(tileAnnotationSchema).max(MAX_TILE_ANNOTATIONS).optional(),
    pointRoads: z.array(tilePointRoadSchema).max(8).optional(),
  })
  .strict()
  .superRefine((meta, ctx) => {
    // #71: "deliberately not part of any block" and "part of this block" are
    // contradictory assertions, and a tile carrying both would classify
    // differently depending on which check ran first. Refuse rather than pick.
    if (meta.trackRole === 'decorative' && meta.blockId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trackRole'],
        message: 'A decorative tile cannot also carry a blockId',
      });
    }

    if (meta.annotations) {
      const seen = new Set<string>();
      for (const a of meta.annotations) {
        const k = `${a.entityType}:${a.entityId}`;
        if (seen.has(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['annotations'],
            message: `${a.entityType} ${a.entityId} is annotated twice on the same tile`,
          });
        }
        seen.add(k);
      }
    }

    if (meta.pointRoads) {
      const seen = new Set<string>();
      for (const road of meta.pointRoads) {
        const k = roadConditionKey(road.when);
        if (seen.has(k)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['pointRoads'],
            message: 'Two roads are selected by the same point positions',
          });
        }
        seen.add(k);
      }
    }
  });

/**
 * Write schema for `PUT .../grid` (upsert one tile).
 *
 * `.strict()` for the same reason as every sibling: `id` and `layoutId` are
 * path/server-owned, and a body carrying either is a 400 rather than a
 * silently ignored field. `metadata` defaults to `{}` — the editor omits it
 * for an untagged tile, and that is legitimate (#68: an untagged tile is not
 * a warning).
 *
 * Shape only. Whether `blockId`/`pointId` resolve to records **in this
 * layout** is a referential question this schema cannot answer; `GridService`
 * owns that.
 */
export const gridTileWriteSchema = z
  .object({
    x: tileCoordinateSchema,
    y: tileCoordinateSchema,
    tileType: tileTypeSchema,
    metadata: gridTileMetadataSchema.default({}),
  })
  .strict();

export type GridTileWriteInput = z.infer<typeof gridTileWriteSchema>;

/**
 * Reads a persisted tile's `metadata` column — and **degrades instead of
 * throwing**, which is the opposite of every other row parser in this file.
 *
 * That is deliberate, and the reason is the boundary the grid sits on. A bad
 * `block_edges` row throws because the pathfinder plans on it: a route granted
 * over a misread edge moves a train onto track that is not there, so the load
 * path turns it into a Safe-Stop. A tile decides nothing. Its worst outcome is
 * a picture that does not match the railway (`docs/track-grid.md`), and
 * refusing to open the Track Editor because one legacy cell carries a key the
 * schema no longer accepts would take away the only tool that can fix it.
 *
 * So an unreadable blob reads as `{}` — the tile still draws, still occupies
 * its cell, and is reported as `tile-metadata-unreadable` by the diagnostics
 * rather than silently swallowed. Rows written since #70 cannot reach this
 * path; rows authored before it can.
 */
export function parseTileMetadata(json: string): { metadata: GridTileMetadata; ok: boolean } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { metadata: {}, ok: false };
  }

  const parsed = gridTileMetadataSchema.safeParse(raw);
  return parsed.success ? { metadata: parsed.data, ok: true } : { metadata: {}, ok: false };
}

/**
 * A single coordinate as it arrives in a querystring: matched as digits
 * first, converted second.
 *
 * Deliberately **not** `z.coerce.number()`, and deliberately not `parseInt`.
 * A querystring value is always a string, and every numeric conversion in
 * JavaScript is lenient in a different direction: `parseInt('3abc')` is `3`,
 * `parseInt('')` is `NaN`, and `Number('')` is `0` — a valid coordinate
 * conjured out of an absent one. The route previously used `parseInt` and
 * compared the result against every tile, so all three silently matched
 * nothing and answered 204: a delete that reported success and deleted
 * nothing. Matching `/^\d+$/` before converting is the only form with no such
 * corner.
 */
const tileCoordinateQueryValueSchema = z
  .string()
  .regex(/^\d+$/, 'Coordinate must be a non-negative integer')
  .transform(Number)
  .pipe(z.number().int().min(0).max(MAX_TILE_COORDINATE));

/** Query schema for `DELETE .../grid/tile?x=&y=`. */
export const gridTileCoordinateQuerySchema = z
  .object({
    x: tileCoordinateQueryValueSchema,
    y: tileCoordinateQueryValueSchema,
  })
  .strict();

/*
 * `blockEndRowSchema`, `parseBlockEndRow`, `BlockEndRowInvalidError`,
 * `blockEndCreateSchema` and `blockEndUpdateSchema` were here, and went with
 * the table (#103 PR 7).
 *
 * `blockEndLabelSchema` above **stays**. It is still the shape of
 * `block_edges.fromEnd`/`toEnd` on read, `routeCreateSchema` still accepts a
 * `startExitEnd`, and it is what makes the compiler's disambiguated
 * `southeast-1` a legal label rather than a lucky one.
 *
 * Nothing replaces the row parser: there is no row. A label is produced by
 * `compileOpenings` from the drawing, validated by the type system on the way
 * into `replaceGraph`, and re-derived on the next compile.
 */

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

const roleSchema = z.enum(['admin', 'operator', 'monitor']);

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
