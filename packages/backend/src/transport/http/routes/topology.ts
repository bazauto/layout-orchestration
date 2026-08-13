import { FastifyInstance } from 'fastify';
import { LayoutService } from '../../../services/LayoutService';
import { TopologyService } from '../../../services/TopologyService';
import { CompileService } from '../../../services/CompileService';
import { LayoutNotFoundError } from '../../../services/GridService';
import { CompileLimitExceededError } from '../../../services/trackGraphCompiler';
import { requireAdmin } from '../auth/hook';

export async function topologyRoutes(
  fastify: FastifyInstance,
  layoutService: LayoutService,
  topologyService: TopologyService,
  compileService: CompileService,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/topology',
    async (req) => {
      return topologyService.getStatus(req.params.layoutId);
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
        if (err instanceof LayoutNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        // 409, mirroring `EdgeLimitExceededError` on `POST .../edges`: the
        // request was well-formed and it is the state of the drawing that
        // conflicts with what this surface will render. Never a bare 500 —
        // "no connections found" and "I gave up" must not look the same.
        if (err instanceof CompileLimitExceededError) {
          return reply
            .status(409)
            .send({ error: err.message, limit: err.limit, found: err.found });
        }
        throw err;
      }
    },
  );
}
