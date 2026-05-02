import { FastifyInstance } from 'fastify';
import { ILayoutRepository } from '../../../ports/ILayoutRepository';

export async function gridRoutes(
  fastify: FastifyInstance,
  repo: ILayoutRepository,
): Promise<void> {
  // GET all tiles for a layout
  fastify.get<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/grid',
    async (req) => repo.listGridTiles(req.params.layoutId),
  );

  // PUT (upsert) a single tile
  fastify.put<{
    Params: { layoutId: string };
    Body: { x: number; y: number; tileType: string; metadata?: Record<string, unknown> };
  }>('/api/layouts/:layoutId/grid', async (req, reply) => {
    const tile = await repo.upsertGridTile({
      layoutId: req.params.layoutId,
      x: req.body.x,
      y: req.body.y,
      tileType: req.body.tileType,
      metadata: JSON.stringify(req.body.metadata ?? {}),
    });
    return reply.status(200).send(tile);
  });

  // DELETE a single tile by position
  fastify.delete<{
    Params: { layoutId: string };
    Querystring: { x: string; y: string };
  }>('/api/layouts/:layoutId/grid/tile', async (req, reply) => {
    const x = parseInt(req.query.x, 10);
    const y = parseInt(req.query.y, 10);
    const tiles = await repo.listGridTiles(req.params.layoutId);
    const tile = tiles.find((t) => t.x === x && t.y === y);
    if (tile) await repo.deleteTile(tile.id);
    return reply.status(204).send();
  });

  // DELETE entire grid for a layout
  fastify.delete<{ Params: { layoutId: string } }>(
    '/api/layouts/:layoutId/grid',
    async (req, reply) => {
      await repo.clearGrid(req.params.layoutId);
      return reply.status(204).send();
    },
  );
}
