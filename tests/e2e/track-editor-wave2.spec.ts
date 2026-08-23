/**
 * Wave 2 authoring affordances in the Track Editor (#71, #72, #73, #74, #84).
 *
 * These are the parts that only exist as behaviour in the browser: what a
 * paint stroke actually sends, whether an annotation reaches an existing tile
 * rather than creating one, and whether the diagnostics read as a to-do list
 * or as a wall of errors.
 *
 * The request bodies are asserted directly because that is where the decisions
 * live. A decorative stroke that quietly also sent a `blockId` would be a 400
 * from the backend; one that sent neither would be indistinguishable from an
 * unfinished tile, which is the entire distinction #71 exists to draw.
 */

import { expect, test, type Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

const BLOCKS = [
  { id: 'b1', layoutId: 'layout-1', name: 'Down Platform' },
  { id: 'b2', layoutId: 'layout-1', name: 'Up Loop' },
];
const POINTS = [
  { id: 'p1', layoutId: 'layout-1', name: 'Yard Throat', dccAddress: 7, blockId: null },
];
const SENSORS = [
  {
    id: 's1',
    layoutId: 'layout-1',
    name: 'Platform Beam',
    type: 'ir_position',
    blockId: 'b1',
    mqttTopic: 'layout/sensor/s1/reading',
    inService: true,
  },
];

/**
 * `GET .../grid/openings` — pure geometry, and since #103 PR 6.2 the **only**
 * source of opening names the editor has. `block_ends` and its `pinned`/
 * `geometry` shape drove this once; they had a "pinned" concept because a
 * stored name could disagree with the drawing, and a compiled label cannot
 * (D8).
 */
const OPENINGS = [
  { blockId: 'b1', label: 'west', at: { x: 2, y: 3 }, terminated: false, ports: [{ x: 2, y: 3, edge: 'w' }] },
  { blockId: 'b1', label: 'yard-3', at: { x: 5, y: 3 }, terminated: true, ports: [] },
];

const DIAGNOSTICS = [
  { kind: 'diamond-blind-spot', severity: 'warning', at: { x: 6, y: 3 } },
  {
    kind: 'buffer-contradicted-by-edge',
    severity: 'warning',
    blockId: 'b1',
    label: 'yard-3',
    edgeIds: ['edge-1'],
  },
  { kind: 'unclassified-tile', severity: 'info', at: { x: 9, y: 3 } },
];

type Tile = { x: number; y: number; tileType: string; metadata: Record<string, unknown> };

const TILES: Tile[] = [
  { x: 2, y: 3, tileType: 'straight-h', metadata: { blockId: 'b1' } },
  { x: 3, y: 3, tileType: 'straight-h', metadata: { blockId: 'b1' } },
  { x: 4, y: 3, tileType: 'straight-h', metadata: { trackRole: 'decorative' } },
  {
    x: 5,
    y: 3,
    tileType: 'point-left',
    metadata: {
      blockId: 'b1',
      pointId: 'p1',
      pointRoads: [
        { when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] },
        { when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 'n'] },
      ],
    },
  },
  { x: 6, y: 3, tileType: 'crossing', metadata: { blockId: 'b1' } },
  {
    x: 7,
    y: 3,
    tileType: 'straight-h',
    metadata: { blockId: 'b1', annotations: [{ entityType: 'sensor', entityId: 's1' }] },
  },
  { x: 9, y: 3, tileType: 'straight-h', metadata: {} },
];

/** Every write the editor issued, so a stroke's actual payload can be asserted. */
type Write = { method: string; url: string; body: unknown };

async function stubApis(page: Page, writes: Write[]) {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**/api/layouts', (r) =>
    r.fulfill(json([{ id: 'layout-1', name: 'Westgate Hollow' }])),
  );

  await page.route('**/api/layouts/layout-1/grid', async (r) => {
    const req = r.request();
    if (req.method() === 'PUT') {
      writes.push({ method: 'PUT', url: req.url(), body: req.postDataJSON() });
      return r.fulfill(json({ id: 'new', layoutId: 'layout-1', ...req.postDataJSON() }));
    }
    return r.fulfill(
      json(
        TILES.map((t, i) => ({
          id: `t${i}`,
          layoutId: 'layout-1',
          x: t.x,
          y: t.y,
          tileType: t.tileType,
          metadata: JSON.stringify(t.metadata),
        })),
      ),
    );
  });

  await page.route('**/api/layouts/layout-1/grid/diagnostics', (r) =>
    r.fulfill(json(DIAGNOSTICS)),
  );

  await page.route('**/api/layouts/layout-1/grid/openings', (r) =>
    r.fulfill(json(OPENINGS)),
  );

  await page.route('**/api/layouts/layout-1/blocks', (r) => r.fulfill(json(BLOCKS)));
  await page.route('**/api/layouts/layout-1/points', (r) => r.fulfill(json(POINTS)));
  await page.route('**/api/layouts/layout-1/sensors', (r) => r.fulfill(json(SENSORS)));
  await page.route('**/api/layouts/layout-1/locos', (r) => r.fulfill(json([])));
  await page.route('**/api/layouts/layout-1/edges', (r) => r.fulfill(json([])));
  await page.route('**/api/layouts/layout-1/topology', (r) =>
    r.fulfill(json({ valid: true, violations: [], edgeCount: 0 })),
  );
}

async function openEditor(page: Page) {
  const writes: Write[] = [];
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page, writes);
  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();
  await expect(page.getByText(/7 tiles/)).toBeVisible();
  return writes;
}

/** Clicks the cell at grid `(x, y)` on the canvas. */
async function clickCell(page: Page, x: number, y: number) {
  const svg = page.locator('svg').first();
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + x * 40 + 20, box.y + y * 40 + 20);
  await page.mouse.down();
  await page.mouse.up();
}

test('a decorative stroke sends trackRole and no blockId', async ({ page }) => {
  const writes = await openEditor(page);

  await page.getByLabel('Block').selectOption('b1');
  await page.getByText('Decorative').click();

  // The block select is disabled while decorative is on: the two are
  // contradictory assertions and the write path refuses a tile carrying both.
  await expect(page.getByLabel('Block')).toBeDisabled();

  await clickCell(page, 12, 8);

  const write = writes.find((w) => w.method === 'PUT')!;
  expect(write.body).toMatchObject({ metadata: { trackRole: 'decorative' } });
  expect((write.body as { metadata: Record<string, unknown> }).metadata.blockId).toBeUndefined();
});

test('painting a point tile captures its leg mapping, and the toggle swaps it', async ({ page }) => {
  const writes = await openEditor(page);

  await page.getByLabel('Point').selectOption('p1');
  await page.getByTitle(/Point L/).click();
  await clickCell(page, 12, 8);

  const first = writes.find((w) => w.method === 'PUT')!.body as {
    metadata: { pointRoads: Array<{ when: unknown[]; legs: string[] }> };
  };
  // Leg-list shaped, keyed by a position tuple (#83): `when` is a list even
  // for a plain turnout, so a slip needs no migration to express.
  expect(first.metadata.pointRoads).toEqual([
    { when: [{ pointId: 'p1', position: 'normal' }], legs: ['w', 'e'] },
    { when: [{ pointId: 'p1', position: 'reverse' }], legs: ['w', 'n'] },
  ]);

  writes.length = 0;
  await page.getByText('Divergent = normal').click();
  await clickCell(page, 13, 8);

  const second = writes.find((w) => w.method === 'PUT')!.body as {
    metadata: { pointRoads: Array<{ legs: string[] }> };
  };
  expect(second.metadata.pointRoads[0].legs).toEqual(['w', 'n']);
});

test('annotate mode places a sensor on an existing tile and refuses an empty cell', async ({ page }) => {
  const writes = await openEditor(page);

  await page.getByLabel('Mode').selectOption('annotate');
  await page.getByLabel('Sensor').selectOption('s1');

  // An empty cell has nothing to annotate — and says so rather than silently
  // painting a tile the operator did not ask for.
  await clickCell(page, 12, 8);
  await expect(page.getByText(/Nothing to annotate/)).toBeVisible();
  expect(writes.filter((w) => w.method === 'PUT')).toHaveLength(0);

  await clickCell(page, 2, 3);

  const write = writes.find((w) => w.method === 'PUT')!.body as {
    tileType: string;
    metadata: { blockId?: string; annotations: unknown[] };
  };
  // The tile keeps its type and its block: an annotation changes metadata
  // only, and must not repaint what it lands on.
  expect(write.tileType).toBe('straight-h');
  expect(write.metadata.blockId).toBe('b1');
  expect(write.metadata.annotations).toEqual([{ entityType: 'sensor', entityId: 's1', orientation: 0 }]);
});

test('clicking an already-annotated tile removes the annotation', async ({ page }) => {
  const writes = await openEditor(page);

  await page.getByLabel('Mode').selectOption('annotate');
  await page.getByLabel('Sensor').selectOption('s1');
  await clickCell(page, 7, 3); // already carries s1

  const write = writes.find((w) => w.method === 'PUT')!.body as {
    metadata: { annotations?: unknown[] };
  };
  // A toggle, not an add: correcting a misplacement must not mean repainting
  // the tile and losing everything else on it.
  expect(write.metadata.annotations).toBeUndefined();
});

test('no opening label, boundary mark or stop glyph is drawn (D15)', async ({ page }) => {
  await openEditor(page);

  // This test used to assert all three were present, which is what #103 step
  // 6.1 shipped. `docs/track-editor.md` D15 records why they went: with the
  // graph compiled and applied, an opening's name is disposable output that
  // nothing on the canvas acts on, and three marks per opening were competing
  // with occupancy, locks, block names, point names and road letters for the
  // same cells.
  const texts = await page.locator('svg text').allTextContents();
  expect(texts).not.toContain('west');
  expect(texts).not.toContain('yard-3');
  expect(texts.some((t) => t.includes('⊣'))).toBe(false);

  await expect(page.locator('svg line').filter({ has: page.locator('title') })).toHaveCount(0);
});

test('the diagnostics panel separates hazards from unfinished authoring', async ({ page }) => {
  await openEditor(page);

  // Counts, not a bare coloured dot: colour is never the sole carrier (#81).
  const toggle = page.getByTitle(/disagree about/);
  await expect(toggle).toContainText('2/1');
  await toggle.click();

  const panel = page.getByRole('region', { name: 'Grid diagnostics' });
  await expect(panel).toContainText('Plain diamond crossing at (6, 3)');
  await expect(panel).toContainText('route conflicts through it are NOT detected');
  await expect(panel).toContainText('Down Platform');

  // Warnings first, then the to-do list — an unfinished layout is a normal
  // state and must not read as an error.
  const items = await panel.locator('li').allTextContents();
  expect(items[0]).toContain('WARN');
  expect(items[items.length - 1]).toContain('TODO');
  expect(items[items.length - 1]).toContain('neither tagged to a block nor marked decorative');
});

test('the toolbar offers no block-end controls, and reads no block_ends', async ({ page }) => {
  // #103 PR 6.2. `Ends ⟳` regenerated a stored table of names from the drawing
  // and `Ends ✎` patched what regeneration got wrong or refused; both existed
  // only to keep a second copy of the opening names level with the first. There
  // is one copy now, compiled on every read, so there is nothing to reconcile
  // and no name for a hand to correct.
  //
  // Counted rather than left unstubbed: Playwright passes an unrouted request
  // through to the network rather than failing the test, so an editor that
  // still asked for `block-ends` would fail quietly and this spec would pass.
  let blockEndReads = 0;
  await page.route('**/api/layouts/layout-1/block-ends**', (r) => {
    blockEndReads += 1;
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await openEditor(page);

  expect(blockEndReads).toBe(0);

  await expect(page.getByTitle(/Regenerate block end labels/)).toHaveCount(0);
  await expect(page.getByTitle(/Name, rename and remove block ends/)).toHaveCount(0);

  // The openings are still *read* — losing the controls must not lose the
  // information they were about — but they are no longer drawn (D15). What
  // survives is the keyboard readout, covered as a sentence in
  // `diagram/cursorAnnouncement.test.ts`, and the Edges tab. So the assertion
  // that belongs here is the one above: no request for a stored copy.
  const labels = await page.locator('svg text').allTextContents();
  expect(labels).not.toContain('west');
});
