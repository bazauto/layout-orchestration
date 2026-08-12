import { FastifyInstance, FastifyReply } from 'fastify';
import { ProposalLimitExceededError } from '../../../services/edgeProposals';
import {
  GridService,
  LayoutNotFoundError,
  TileReferenceError,
} from '../../../services/GridService';
import {
  gridTileCoordinateQuerySchema,
  gridTileWriteSchema,
} from '../../../services/validation';
import { requireAdmin } from '../auth/hook';

/**
 * Track Editor grid routes.
 *
 * Parse, validate, delegate — no decision is taken here (CLAUDE.md safety
 * rule 2). The `Body: unknown` + `safeParse` pairing is the same one every
 * other config route uses and is the point: a Fastify `Body` generic is
 * erased at compile time and validates nothing at runtime, so the Zod schema
 * is the only real gate (#70, the gap #36 left behind when it closed the same
 * hole on blocks and sensors).
 *
 * Every rejection below is a 4xx. A malformed grid write is an ordinary 400,
 * never a Safe-Stop — this is an admin config surface, not a sensor or control
 * topic (CLAUDE.md Traps).
 *
 * The success shapes are unchanged: 200 + the tile on upsert, 204 on both
 * deletes. #70 closes a validation hole; it does not renegotiate the contract
 * the editor and its e2e specs are written against.
 */
export async function gridRoutes(
  fastify: FastifyInstance,
  gridService: GridService,
): Promise<void> {
  // GET all tiles for a layout
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/grid',
    async (req) => gridService.listTiles(req.params.layoutId),
  );

  // Everything the drawing and the track graph disagree about (#71, #73, #74,
  // #83, #84). Read-only and advisory: nothing here refuses a write, and an
  // unfinished layout reports `info`, not `warning` — a to-do list styled as
  // errors trains the operator to ignore it. Not admin-gated, for the same
  // reason the grid read is not.
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/grid/diagnostics',
    async (req, reply) => {
      try {
        return await gridService.diagnose(req.params.layoutId);
      } catch (err) {
        return mapGridError(err, reply);
      }
    },
  );

  // Candidate `block_edges` the drawing implies (#78). A **GET**, and that is
  // the structural guarantee: there is no accept endpoint, so accepting a
  // proposal can only be an ordinary `POST .../edges` through the same
  // validation a hand-authored edge gets. No bypass can exist here.
  //
  // Not admin-gated, for the same reason the diagnostics read is not — the
  // write is what is gated.
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/grid/edge-proposals',
    async (req, reply) => {
      try {
        return await gridService.proposeEdges(req.params.layoutId);
      } catch (err) {
        return mapGridError(err, reply);
      }
    },
  );

  // PUT (upsert) a single tile — track editing is config, admin-only.
  fastify.put<{ Params: { layoutId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/grid',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = gridTileWriteSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid grid tile payload', details: parsed.error.flatten() });
      }

      try {
        const tile = await gridService.upsertTile(req.params.layoutId, parsed.data);
        return reply.status(200).send(tile);
      } catch (err) {
        return mapGridError(err, reply);
      }
    },
  );

  // DELETE a single tile by position.
  //
  // Erasing a cell that holds no tile stays a 204, not a 404: right-drag
  // erase sweeps across cells that may or may not hold one, and answering
  // 404 to half a drag would turn ordinary authoring into a stream of errors
  // the operator must dismiss. A *malformed* coordinate is different, and is
  // a 400 — `?x=abc` previously reached `parseInt`, became `NaN`, matched no
  // tile, and was reported as a successful delete.
  fastify.delete<{
    Params: { layoutId: string };
    Querystring: unknown;
  }>(
    '/api/layouts/:layoutId/grid/tile',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = gridTileCoordinateQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid tile coordinate', details: parsed.error.flatten() });
      }

      try {
        await gridService.deleteTileAt(req.params.layoutId, parsed.data.x, parsed.data.y);
        return reply.status(204).send();
      } catch (err) {
        return mapGridError(err, reply);
      }
    },
  );

  // DELETE entire grid for a layout
  fastify.delete<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/grid',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        await gridService.clearGrid(req.params.layoutId);
        return reply.status(204).send();
      } catch (err) {
        return mapGridError(err, reply);
      }
    },
  );
}

/**
 * Maps a `GridService` rejection to its status code.
 *
 * A `TileReferenceError` is a 400 rather than a 422 deliberately: 422 in this
 * codebase means the topology graph refused a proposal
 * (`TopologyRejectedError`, carrying `violations` the operator can act on). A
 * tile naming a block that is not there is just a bad field in a config write.
 *
 * A `ProposalLimitExceededError` is a **409**, mirroring `EdgeLimitExceeded-
 * Error` on `POST .../edges` byte-for-byte in shape: the request was
 * well-formed, and it is the state of the drawing that conflicts with what
 * this surface will render. It was previously unmapped and reached Fastify's
 * default handler as a bare 500 — which is the one outcome #78's design
 * argues against everywhere else, since "no connection found" and "I gave up"
 * must never look the same from outside.
 */
function mapGridError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof LayoutNotFoundError) {
    return reply.status(404).send({ error: err.message });
  }
  if (err instanceof TileReferenceError) {
    return reply.status(400).send({ error: err.message });
  }
  if (err instanceof ProposalLimitExceededError) {
    return reply.status(409).send({ error: err.message, limit: err.limit, found: err.found });
  }
  throw err;
}
