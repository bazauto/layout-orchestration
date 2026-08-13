import { FastifyInstance, FastifyReply } from 'fastify';
import { LayoutService } from '../../../services/LayoutService';
import {
  EdgeLimitExceededError,
  LockedByRouteError,
  TopologyRejectedError,
  TopologyService,
} from '../../../services/TopologyService';
import {
  CompileFingerprintMismatchError,
  CompileService,
} from '../../../services/CompileService';
import { LayoutNotFoundError } from '../../../services/GridService';
import { CompileLimitExceededError } from '../../../services/trackGraphCompiler';
import { compileApplySchema } from '../../../services/validation';
import { requireAdmin } from '../auth/hook';

export async function topologyRoutes(
  fastify: FastifyInstance,
  layoutService: LayoutService,
  topologyService: TopologyService,
  compileService: CompileService,
): Promise<void> {
  // The live graph's health, plus where it stands against the drawing (#103).
  //
  // `compiled` is composed here rather than inside `TopologyService` on purpose:
  // that service validates and writes `block_edges` and has no business reading
  // a tile. Staleness is a fact about two artefacts, so the place that knows
  // about both is the route.
  //
  // **Deliberately not added to the MQTT `system/status` payload or the
  // WebSocket `SYSTEM_STATUS` event that mirrors it.** That payload is binding
  // (`docs/mqtt-contract.md`) and the ESP firmware is built against it;
  // staleness is an authoring concern with no bearing on anything the firmware
  // does. A `compiled` field there would be a contract change for a UI hint.
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/topology',
    async (req, reply) => {
      const status = await topologyService.getStatus(req.params.layoutId);
      try {
        return { ...status, compiled: await compileService.status(req.params.layoutId) };
      } catch (err) {
        // `compiled` is an addition to an endpoint that already had a contract,
        // and it must not change one. `getStatus` has never checked that the
        // layout exists — it reports on an edge set, and an empty one is a
        // truthful answer — so an unknown layout keeps answering 200 without
        // the block, rather than becoming a 404 as a side effect of adding a UI
        // hint. Anything else (the compile cap) still surfaces.
        if (err instanceof LayoutNotFoundError) return status;
        return mapCompileError(err, reply);
      }
    },
  );

  // Re-runs the load path (validate + rebuild TrackGraph) for the running
  // layout and applies Safe-Stop if it comes back invalid — the same path
  // `LayoutService` runs on startup and after any edge mutation. Topology
  // config, not a query, hence POST and admin-only.
  fastify.post<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/topology/revalidate',
    { preHandler: requireAdmin },
    async () => {
      const result = await layoutService.reloadTopology();
      return {
        valid: !result.fatal,
        violations: result.violations,
        reason: result.reason,
        edgeCount: result.edges.length,
      };
    },
  );

  // The graph the drawing implies, the gaps in it, and how it differs from the
  // one the pathfinder is planning on (#103, D1/D10).
  //
  // A **GET**, and read-only in the strictest sense: it does not even record
  // that a compile happened. Applying is a separate, guarded transaction, which
  // is what keeps "one process writes `block_edges`, only when an operator
  // presses a button, having reviewed the diff" (D1) a structural property
  // rather than a convention.
  //
  // Not admin-gated, matching `grid/diagnostics` and `grid/edge-proposals`: the
  // write is what is gated, and an operator being able to see why the layout
  // will not go into `auto` is the point of the surface.
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/topology/compile',
    async (req, reply) => {
      try {
        return await compileService.compile(req.params.layoutId);
      } catch (err) {
        return mapCompileError(err, reply);
      }
    },
  );

  // Apply the compiled graph (#103, D1/D9/D10). The write, and the one to
  // review hardest.
  //
  // The body carries a **fingerprint and nothing else** — never rows. An apply
  // that accepted edges would be a second authoring path wearing the compiler's
  // name, which is the bypass D1 and D3 exist to make impossible. The service
  // recompiles the drawing and refuses if it has moved since the review, so
  // approving one graph and applying another cannot happen.
  //
  // Admin-only: this is the write the read surfaces are deliberately not gated
  // against.
  fastify.post<{ Params: { layoutId: string }; Body: unknown }>(
    '/api/layouts/:layoutId/topology/compile/apply',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = compileApplySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid compile apply payload', details: parsed.error.flatten() });
      }

      try {
        return await compileService.apply(req.params.layoutId, parsed.data.fingerprint);
      } catch (err) {
        return mapCompileError(err, reply);
      }
    },
  );
}

/**
 * Maps a compile rejection to its status code.
 *
 * Every one of these is a refusal that happened **before** anything was
 * written — which is the property D9 turns on, and the reason none of them can
 * leave the layout in a state the next `reloadTopology` would Safe-Stop on.
 *
 * The 409s are three different conflicts and are worth telling apart in the
 * body: the drawing moved under the review, a route is holding the layout, or
 * the graph is larger than the cap. A 422 is different in kind — the request
 * was fine and the *railway it describes* is not, so it carries `violations`
 * the operator can act on, exactly as `POST .../edges` does.
 */
function mapCompileError(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof LayoutNotFoundError) {
    return reply.status(404).send({ error: err.message });
  }
  if (err instanceof CompileFingerprintMismatchError) {
    return reply
      .status(409)
      .send({ error: err.message, expected: err.expected, actual: err.actual });
  }
  if (err instanceof LockedByRouteError) {
    return reply.status(409).send({ error: err.message, routeId: err.routeId });
  }
  if (err instanceof EdgeLimitExceededError) {
    return reply.status(409).send({ error: err.message, limit: err.limit, current: err.current });
  }
  // Mirrors `EdgeLimitExceededError` on `POST .../edges` in shape: the request
  // was well-formed and it is the state of the drawing that conflicts with what
  // this surface will render. Never a bare 500 — "no connections found" and
  // "I gave up" must not look the same from outside.
  if (err instanceof CompileLimitExceededError) {
    return reply.status(409).send({ error: err.message, limit: err.limit, found: err.found });
  }
  if (err instanceof TopologyRejectedError) {
    return reply.status(422).send({ error: err.message, violations: err.violations });
  }
  throw err;
}
