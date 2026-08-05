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
    repo = new DrizzleRepository(dbPath, MIGRATIONS_FOLDER);

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
      lengthMm: 500,
    });

    expect(created.id).toBeTruthy();
    expect(created).toMatchObject({
      layoutId,
      fromBlockId: blockAId,
      fromEnd: 'east',
      toBlockId: blockBId,
      toEnd: 'west',
      pointConditions: [],
      lengthMm: 500,
    });

    const listed = await repo.listBlockEdges(layoutId);
    expect(listed.map((e) => e.id)).toContain(created.id);

    const fetched = await repo.getBlockEdge(created.id);
    expect(fetched).toEqual(created);

    const updated = await repo.updateBlockEdge(created.id, { lengthMm: 750 });
    expect(updated.lengthMm).toBe(750);
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
      lengthMm: null,
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
        `INSERT INTO block_edges (id, layout_id, from_block_id, from_end, to_block_id, to_end, point_conditions, length_mm)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(badId, layoutId, blockAId, 'North', blockBId, 'south', '[]', null);

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
      lengthMm: null,
    });
    const incoming = await repo.createBlockEdge({
      layoutId,
      fromBlockId: spoke.id,
      fromEnd: 'west',
      toBlockId: hub.id,
      toEnd: 'east',
      pointConditions: [],
      lengthMm: null,
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
});
