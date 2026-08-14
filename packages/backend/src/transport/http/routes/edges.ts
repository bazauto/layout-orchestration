import { FastifyInstance } from 'fastify';
import { TopologyService } from '../../../services/TopologyService';

/**
 * The track graph, read-only (#103 PR 5, OQ1).
 *
 * `POST`, `PUT` and `DELETE` are gone. Not refused — **absent**: there is no
 * route, so the answer is a 404, the same posture `sensorSimulation` takes for
 * a capability that is not present. A route that exists and refuses invites the
 * question "under what conditions would it accept", and here the answer is
 * never.
 *
 * The graph is written by exactly one thing: `POST .../topology/compile/apply`,
 * through `TopologyService.replaceGraph`. D3 makes a recompile a *replace*, so
 * a hand-authored edge is deleted by the next apply without anyone deciding it
 * should be. Keeping a second write path would keep the two-representations
 * problem #103 exists to end, at a new seam — and the compiler wins by being
 * the only writer, not by guarding against a rival.
 *
 * `GET` stays, and the Edges tab still lists what it returns. Reading the graph
 * was never the problem.
 */
export async function edgeRoutes(
  fastify: FastifyInstance,
  topologyService: TopologyService,
): Promise<void> {
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/edges',
    async (req) => {
      return topologyService.listEdges(req.params.layoutId);
    },
  );
}
