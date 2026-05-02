"use strict";
/**
 * Seed script — populates the default layout with a small test topology.
 *
 * Safe to run multiple times; skips creation if a record with the same name
 * already exists in the layout.
 *
 * Usage (from packages/backend):
 *   npx tsx scripts/seed.ts
 */
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = require("dotenv");
const path_1 = require("path");
(0, dotenv_1.config)({ path: (0, path_1.resolve)(__dirname, '../../../.env') });
const repository_1 = require("../src/adapters/db/repository");
async function seed() {
    const dbPath = process.env.DATABASE_PATH ?? './data/layout.db';
    const migrationsFolder = process.env.MIGRATIONS_PATH ?? './migrations';
    const repo = new repository_1.DrizzleRepository(dbPath, migrationsFolder);
    // ── Find or create the default layout ────────────────────────────────────────
    let layouts = await repo.listLayouts();
    if (layouts.length === 0) {
        layouts = [await repo.createLayout({ name: 'Default Layout', description: 'Seeded layout' })];
        console.log(`[Seed] Created layout: ${layouts[0].id}`);
    }
    const layoutId = process.env.LAYOUT_ID ?? layouts[0].id;
    console.log(`[Seed] Using layout: ${layoutId}`);
    // ── Blocks ────────────────────────────────────────────────────────────────────
    const existingBlocks = await repo.listBlocks(layoutId);
    const existingBlockNames = new Set(existingBlocks.map((b) => b.name));
    const blockDefs = [
        'Platform 1',
        'Platform 2',
        'Fiddle Yard North',
        'Fiddle Yard South',
        'Main Line East',
        'Main Line West',
    ];
    const blockMap = {};
    for (const b of existingBlocks)
        blockMap[b.name] = b.id;
    for (const name of blockDefs) {
        if (!existingBlockNames.has(name)) {
            const block = await repo.createBlock({ layoutId, name });
            blockMap[name] = block.id;
            console.log(`[Seed]   Block: ${name} (${block.id})`);
        }
        else {
            console.log(`[Seed]   Block: ${name} — already exists, skipping`);
        }
    }
    // ── Points ────────────────────────────────────────────────────────────────────
    const existingPoints = await repo.listPoints(layoutId);
    const existingPointNames = new Set(existingPoints.map((p) => p.name));
    const pointDefs = [
        { name: 'P1 — Platform Entry North', dccAddress: 11, blockName: 'Platform 1' },
        { name: 'P2 — Platform Entry South', dccAddress: 12, blockName: 'Platform 2' },
        { name: 'P3 — Fiddle Yard Throat N', dccAddress: 13, blockName: 'Fiddle Yard North' },
        { name: 'P4 — Fiddle Yard Throat S', dccAddress: 14, blockName: 'Fiddle Yard South' },
    ];
    for (const p of pointDefs) {
        if (!existingPointNames.has(p.name)) {
            const point = await repo.createPoint({
                layoutId,
                name: p.name,
                dccAddress: p.dccAddress,
                blockId: blockMap[p.blockName] ?? null,
            });
            console.log(`[Seed]   Point: ${p.name} addr=${p.dccAddress} (${point.id})`);
        }
        else {
            console.log(`[Seed]   Point: ${p.name} — already exists, skipping`);
        }
    }
    // ── Sensors ───────────────────────────────────────────────────────────────────
    const existingSensors = await repo.listSensors(layoutId);
    const existingSensorNames = new Set(existingSensors.map((s) => s.name));
    // MQTT topic convention: layout/<layoutId>/sensor/<blockName-slug>/reading
    const slug = (name) => name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
    const sensorDefs = blockDefs.map((blockName) => ({
        name: `${blockName} — Detector`,
        type: 'block_detection',
        blockName,
        mqttTopic: `layout/${layoutId}/sensor/${slug(blockName)}/reading`,
    }));
    for (const s of sensorDefs) {
        if (!existingSensorNames.has(s.name)) {
            const sensor = await repo.createSensor({
                layoutId,
                name: s.name,
                type: s.type,
                blockId: blockMap[s.blockName] ?? null,
                mqttTopic: s.mqttTopic,
            });
            console.log(`[Seed]   Sensor: ${s.name} → ${s.mqttTopic} (${sensor.id})`);
        }
        else {
            console.log(`[Seed]   Sensor: ${s.name} — already exists, skipping`);
        }
    }
    // ── Locos ─────────────────────────────────────────────────────────────────────
    const existingLocos = await repo.listLocos(layoutId);
    const existingLocoNames = new Set(existingLocos.map((l) => l.name));
    const locoDefs = [
        { name: 'Class 08 Shunter', address: 3, type: 'diesel', maxSpeed: 60, brakingFactor: 0.7 },
        { name: 'Britannia 70013', address: 7, type: 'steam', maxSpeed: 120, brakingFactor: 0.4 },
    ];
    for (const l of locoDefs) {
        if (!existingLocoNames.has(l.name)) {
            const loco = await repo.createLoco({ layoutId, ...l });
            console.log(`[Seed]   Loco: ${l.name} addr=${l.address} (${loco.id})`);
        }
        else {
            console.log(`[Seed]   Loco: ${l.name} — already exists, skipping`);
        }
    }
    console.log('[Seed] Done.');
}
seed().catch((err) => {
    console.error('[Seed] Fatal:', err);
    process.exit(1);
});
//# sourceMappingURL=seed.js.map