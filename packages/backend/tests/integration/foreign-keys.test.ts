/**
 * Foreign Key Enforcement Integration Test
 *
 * #18: `openDatabase` now sets `PRAGMA foreign_keys = ON` explicitly, after
 * `migrate()`, rather than resting on the better-sqlite3 driver default. This
 * exercises that guarantee through the same connection and repository path
 * production code uses — a dangling FK insert must be rejected — so a future
 * driver-default change (or a driver swap) is caught here in CI rather than
 * surfacing as a live data-integrity hole.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { DrizzleRepository } from '../../src/adapters/db/repository';
import { openDatabase } from '../../src/adapters/db/connection';

const MIGRATIONS_FOLDER = join(__dirname, '../../migrations');

describe('foreign key enforcement', () => {
  let tempDir: string;
  let dbPath: string;
  let repo: DrizzleRepository;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'layout-orchestrator-fk-'));
    dbPath = join(tempDir, `${randomUUID()}.db`);
    repo = new DrizzleRepository(openDatabase(dbPath, MIGRATIONS_FOLDER));
  });

  afterAll(() => {
    // DrizzleRepository does not expose a close() method — best-effort
    // cleanup only, same rationale as migrations.test.ts.
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore — OS temp directory, cleaned up eventually regardless
    }
  });

  it('rejects a block insert whose layout_id does not reference an existing layout', async () => {
    await expect(
      repo.createBlock({ layoutId: randomUUID(), name: 'Dangling Block' }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });

  it('rejects with the specific SQLITE_CONSTRAINT_FOREIGNKEY code, not just any error', async () => {
    let caught: unknown;
    try {
      await repo.createSensor({
        layoutId: randomUUID(),
        name: 'Dangling Sensor',
        type: 'block_detection',
        blockId: null,
        mqttTopic: 'layout/sensor/dangling',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
  });

  it('still allows the same insert once the referenced layout actually exists', async () => {
    const layout = await repo.createLayout({ name: 'Real Layout', description: null });
    await expect(
      repo.createBlock({ layoutId: layout.id, name: 'Real Block' }),
    ).resolves.toMatchObject({ layoutId: layout.id, name: 'Real Block' });
  });
});
