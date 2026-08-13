/**
 * DrizzleRepository — Block Edges Integration Test
 *
 * Exercises the block_edges CRUD methods against a real temp-file SQLite
 * database (migrations applied via the DrizzleRepository constructor, as in
 * migrations.test.ts), rather than a stubbed repo — so `parseBlockEdgeRow`
 * actually runs on rows written by SQLite, not by hand-constructed fixtures.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DrizzleRepository } from '../../src/adapters/db/repository';
import { openDatabase } from '../../src/adapters/db/connection';

const MIGRATIONS_FOLDER = join(__dirname, '../../migrations');

describe('DrizzleRepository — block edges', () => {
  let tempDir: string;
  let dbPath: string;
  let repo: DrizzleRepository;
  let layoutId: string;
  let blockAId: string;
  let blockBId: string;
  let blockCId: string;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'layout-orchestrator-repo-edges-'));
    dbPath = join(tempDir, `${randomUUID()}.db`);
    repo = new DrizzleRepository(openDatabase(dbPath, MIGRATIONS_FOLDER));

    const layout = await repo.createLayout({ name: 'Test Layout', description: null });
    layoutId = layout.id;
    const blockA = await repo.createBlock({ layoutId, name: 'Block A' });
    const blockB = await repo.createBlock({ layoutId, name: 'Block B' });
    const blockC = await repo.createBlock({ layoutId, name: 'Block C' });
    blockAId = blockA.id;
    blockBId = blockB.id;
    blockCId = blockC.id;
  });

  afterAll(() => {
    // DrizzleRepository does not expose a close() method — best-effort
    // cleanup only, same rationale as migrations.test.ts.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('round-trips create → list → update → delete', async () => {
    const created = await repo.createBlockEdge({
      layoutId,
      fromBlockId: blockAId,
      fromEnd: 'east',
      toBlockId: blockBId,
      toEnd: 'west',
      pointConditions: [],
    });

    expect(created.id).toBeTruthy();
    expect(created).toMatchObject({
      layoutId,
      fromBlockId: blockAId,
      fromEnd: 'east',
      toBlockId: blockBId,
      toEnd: 'west',
      pointConditions: [],
    });

    const listed = await repo.listBlockEdges(layoutId);
    expect(listed.map((e) => e.id)).toContain(created.id);

    const fetched = await repo.getBlockEdge(created.id);
    expect(fetched).toEqual(created);

    const updated = await repo.updateBlockEdge(created.id, { toEnd: 'north' });
    expect(updated.toEnd).toBe('north');
    // Untouched fields survive a partial update.
    expect(updated.fromEnd).toBe('east');

    await repo.deleteBlockEdge(created.id);
    const afterDelete = await repo.listBlockEdges(layoutId);
    expect(afterDelete.map((e) => e.id)).not.toContain(created.id);
  });

  it('round-trips pointConditions through JSON serialisation on both create and update', async () => {
    const created = await repo.createBlockEdge({
      layoutId,
      fromBlockId: blockAId,
      fromEnd: 'north',
      toBlockId: blockCId,
      toEnd: 'south',
      pointConditions: [{ pointId: 'p1', requiredPosition: 'reverse' }],
    });

    expect(created.pointConditions).toEqual([{ pointId: 'p1', requiredPosition: 'reverse' }]);

    const updated = await repo.updateBlockEdge(created.id, {
      pointConditions: [
        { pointId: 'p1', requiredPosition: 'reverse' },
        { pointId: 'p2', requiredPosition: 'normal' },
      ],
    });
    expect(updated.pointConditions).toEqual([
      { pointId: 'p1', requiredPosition: 'reverse' },
      { pointId: 'p2', requiredPosition: 'normal' },
    ]);

    await repo.deleteBlockEdge(created.id);
  });

  it('listBlockEdges throws rather than coercing a hand-inserted row with an un-normalised from_end', async () => {
    const sqlite = new Database(dbPath);
    const badId = randomUUID();
    sqlite
      .prepare(
        `INSERT INTO block_edges (id, layout_id, from_block_id, from_end, to_block_id, to_end, point_conditions)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(badId, layoutId, blockAId, 'North', blockBId, 'south', '[]');

    await expect(repo.listBlockEdges(layoutId)).rejects.toThrow();
    await expect(repo.getBlockEdge(badId)).rejects.toThrow();

    // Clean up so this bad row doesn't poison later tests in this file,
    // which all read the same layout.
    sqlite.prepare('DELETE FROM block_edges WHERE id = ?').run(badId);
    sqlite.close();

    await expect(repo.listBlockEdges(layoutId)).resolves.toEqual([]);
  });

  it('deleteBlock removes both incoming and outgoing edges', async () => {
    const hub = await repo.createBlock({ layoutId, name: 'Hub' });
    const spoke = await repo.createBlock({ layoutId, name: 'Spoke' });

    const outgoing = await repo.createBlockEdge({
      layoutId,
      fromBlockId: hub.id,
      fromEnd: 'east',
      toBlockId: spoke.id,
      toEnd: 'west',
      pointConditions: [],
    });
    const incoming = await repo.createBlockEdge({
      layoutId,
      fromBlockId: spoke.id,
      fromEnd: 'west',
      toBlockId: hub.id,
      toEnd: 'east',
      pointConditions: [],
    });

    await repo.deleteBlock(layoutId, hub.id);

    const remaining = await repo.listBlockEdges(layoutId);
    expect(remaining.map((e) => e.id)).not.toContain(outgoing.id);
    expect(remaining.map((e) => e.id)).not.toContain(incoming.id);
  });

  it('deleteBlock scoped to the wrong layout deletes nothing', async () => {
    const block = await repo.createBlock({ layoutId, name: 'Untouched' });

    await repo.deleteBlock('some-other-layout', block.id);

    const blocks = await repo.listBlocks(layoutId);
    expect(blocks.map((b) => b.id)).toContain(block.id);
  });

  // ── replaceBlockEdges: the compiled-graph write (#103, D9/D10) ──────────────
  //
  // `TopologyService` has already validated the candidate graph in full by the
  // time this runs, so what these tests are about is the one class of failure
  // validation cannot see: a DB constraint refusing an insert half way through.
  // A non-transactional version would leave the layout describing *part* of a
  // railway — a graph nobody authored, nobody reviewed, and that Safe-Stops on
  // the next reload.

  describe('replaceBlockEdges', () => {
    /** Its own layout per test, so a rollback assertion cannot be confused by a sibling's rows. */
    async function freshLayout() {
      const layout = await repo.createLayout({ name: 'Replace Layout', description: null });
      const a = await repo.createBlock({ layoutId: layout.id, name: 'A' });
      const b = await repo.createBlock({ layoutId: layout.id, name: 'B' });
      return { layoutId: layout.id, a: a.id, b: b.id };
    }

    it('swaps the whole set and stamps the fingerprint, in one call', async () => {
      const { layoutId: lid, a, b } = await freshLayout();
      await repo.createBlockEdge({
        layoutId: lid,
        fromBlockId: a,
        fromEnd: 'old',
        toBlockId: b,
        toEnd: 'stale',
        pointConditions: [],
      });

      const compiledAt = new Date('2026-08-13T12:00:00.000Z');
      const written = await repo.replaceBlockEdges(
        lid,
        [
          { fromBlockId: a, fromEnd: 'east', toBlockId: b, toEnd: 'west', pointConditions: [] },
          { fromBlockId: b, fromEnd: 'west', toBlockId: a, toEnd: 'east', pointConditions: [] },
        ],
        'fingerprint-1',
        compiledAt,
      );

      expect(written).toHaveLength(2);
      // The hand-authored row is gone: a recompile is a replace, not a merge (D3).
      const stored = await repo.listBlockEdges(lid);
      expect(stored.map((e) => e.fromEnd).sort()).toEqual(['east', 'west']);

      const record = await repo.getCompiledGraph(lid);
      expect(record?.drawingFingerprint).toBe('fingerprint-1');
      expect(record?.compiledAt.toISOString()).toBe(compiledAt.toISOString());
    });

    it('round-trips point conditions through the JSON column', async () => {
      const { layoutId: lid, a, b } = await freshLayout();

      await repo.replaceBlockEdges(
        lid,
        [
          {
            fromBlockId: a,
            fromEnd: 'east',
            toBlockId: b,
            toEnd: 'west',
            pointConditions: [{ pointId: 'p1', requiredPosition: 'reverse' }],
          },
        ],
        'fingerprint-2',
        new Date(),
      );

      const [stored] = await repo.listBlockEdges(lid);
      expect(stored.pointConditions).toEqual([{ pointId: 'p1', requiredPosition: 'reverse' }]);
    });

    it('replaces the fingerprint on a second apply rather than colliding on the primary key', async () => {
      const { layoutId: lid, a, b } = await freshLayout();
      const edges = [
        { fromBlockId: a, fromEnd: 'east', toBlockId: b, toEnd: 'west', pointConditions: [] },
      ];

      await repo.replaceBlockEdges(lid, edges, 'fingerprint-first', new Date());
      await repo.replaceBlockEdges(lid, edges, 'fingerprint-second', new Date());

      expect((await repo.getCompiledGraph(lid))?.drawingFingerprint).toBe('fingerprint-second');
      expect(await repo.listBlockEdges(lid)).toHaveLength(1);
    });

    it('leaves the original edges intact and writes no fingerprint when an insert violates a constraint', async () => {
      // Two rows differing only in point conditions collide on
      // `block_edges_connection_unq`, which excludes `point_conditions` — the
      // latent case recorded as OQ7. Whatever the eventual answer to that, an
      // apply that hits it must leave the layout exactly as it was found.
      const { layoutId: lid, a, b } = await freshLayout();
      const original = await repo.createBlockEdge({
        layoutId: lid,
        fromBlockId: a,
        fromEnd: 'original',
        toBlockId: b,
        toEnd: 'row',
        pointConditions: [],
      });

      await expect(
        repo.replaceBlockEdges(
          lid,
          [
            {
              fromBlockId: a,
              fromEnd: 'east',
              toBlockId: b,
              toEnd: 'west',
              pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
            },
            {
              fromBlockId: a,
              fromEnd: 'east',
              toBlockId: b,
              toEnd: 'west',
              pointConditions: [{ pointId: 'p1', requiredPosition: 'reverse' }],
            },
          ],
          'fingerprint-doomed',
          new Date(),
        ),
      ).rejects.toThrow();

      // The railway the pathfinder was planning on is still there, unchanged.
      const stored = await repo.listBlockEdges(lid);
      expect(stored.map((e) => e.id)).toEqual([original.id]);
      // And no fingerprint claims a graph that never stored — the next apply
      // must not read this layout as up to date.
      await expect(repo.getCompiledGraph(lid)).resolves.toBeNull();
    });
  });
});
