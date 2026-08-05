import { FastifyInstance } from 'fastify';
import { LayoutService } from '../../../services/LayoutService';
import { TopologyService } from '../../../services/TopologyService';

export async function topologyRoutes(
  fastify: FastifyInstance,
  layoutService: LayoutService,
  topologyService: TopologyService,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/topology',
    async (req) => {
      return topologyService.getStatus(req.params.layoutId);
    },
  );

  // Re-runs the load path (validate + rebuild TrackGraph) for the running
  // layout and applies Safe-Stop if it comes back invalid — the same path
  // `LayoutService` runs on startup and after any edge mutation. An operator
  // action, not a query, hence POST.
  fastify.post<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/topology/revalidate',
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
}
