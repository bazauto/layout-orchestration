/**
 * Zod schema for an inbound `point/{pointId}/reading` MQTT payload (#25, D1,
 * docs/mqtt-contract.md). Sibling of `sensorPayload.ts` — the ingestion
 * boundary's shape check, kept in `domain/` because it is domain vocabulary
 * every transport-side ingestion path must agree on, not a transport
 * concern itself.
 */

import { z } from 'zod';

/**
 * `.strict()`, same posture as every inbound control-topic schema in this
 * repository: an unexpected field is a malformed payload, not a silently
 * ignored one. `position` admits `'unknown'` — unlike a `point/*\/command`,
 * a reading MAY report that the controller cannot determine the position.
 */
export const pointReadingSchema = z
  .object({
    pointId: z.string().min(1),
    position: z.enum(['normal', 'reverse', 'unknown']),
    source: z.enum(['sensor', 'driver']),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();

export type PointReadingPayload = z.infer<typeof pointReadingSchema>;
