/**
 * #68 — one block label per contiguous run, and point tiles that carry a name.
 *
 * The drawing below is shaped like the complaint that produced the issue: long
 * adjacent blocks whose per-tile labels overlapped into `Fiddle Yard 2iddle
 * Yard 2`, and point tiles that rendered no name at all because the render
 * loop only ever resolved `metadata.blockId`.
 */

import { expect, test, type Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

const BLOCKS = [
  { id: 'b1', layoutId: 'layout-1', name: 'Down Platform' },
  { id: 'b2', layoutId: 'layout-1', name: 'Up Platform' },
  { id: 'b3', layoutId: 'layout-1', name: 'Fiddle Yard 2' },
];
const POINTS = [
  { id: 'p1', layoutId: 'layout-1', name: 'Yard Throat', dccAddress: 7, blockId: null },
];

type Tile = { x: number; y: number; tileType: string; blockId?: string; pointId?: string };

const TILES: Tile[] = [];
// Two ten-tile blocks meeting end to end on one row, plus a third on the next.
for (let x = 2; x <= 11; x++) TILES.push({ x, y: 3, tileType: 'straight-h', blockId: 'b1' });
for (let x = 12; x <= 20; x++) TILES.push({ x, y: 3, tileType: 'straight-h', blockId: 'b2' });
for (let x = 2; x <= 10; x++) TILES.push({ x, y: 5, tileType: 'straight-h', blockId: 'b3' });
TILES.push({ x: 11, y: 4, tileType: 'point-left', blockId: 'b1', pointId: 'p1' });
// #93 — the companion tile. A point is drawn as two cells, the point tile plus
// the diagonal carrying its divergent road to the next row, and both are tagged
// with the same point. That is what used to render the name twice.
TILES.push({ x: 11, y: 5, tileType: 'straight-45', blockId: 'b3', pointId: 'p1' });

async function stubApis(page: Page) {
  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'layout-1', name: 'Westgate Hollow' }]),
    }),
  );

  await page.route('**://localhost:3000/api/layouts/layout-1/grid', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        TILES.map((t, i) => ({
          id: `t${i}`,
          layoutId: 'layout-1',
          x: t.x,
          y: t.y,
          tileType: t.tileType,
          metadata: JSON.stringify({
            rotation: 0,
            ...(t.blockId ? { blockId: t.blockId } : {}),
            ...(t.pointId ? { pointId: t.pointId } : {}),
          }),
        })),
      ),
    }),
  );

  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**://localhost:3000/api/layouts/layout-1/blocks', (r) => r.fulfill(json(BLOCKS)));
  await page.route('**://localhost:3000/api/layouts/layout-1/points', (r) => r.fulfill(json(POINTS)));
  await page.route('**://localhost:3000/api/layouts/layout-1/sensors', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/locos', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/edges', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill(json({ valid: true, violations: [], edgeCount: 0 })),
  );
}

async function openEditor(page: Page) {
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();
  await expect(page.getByText(/30 tiles/)).toBeVisible();
}

/**
 * Every `<text>` the *drawing* carries — block/point/end labels — which is
 * what the label-density control (#68 item 4) governs.
 *
 * Excludes the ruler gutters' column/row numbers (#94): those are a
 * persistent spatial reference outside the pan/zoom `<g>`, always drawn
 * regardless of `labelDensity`, and marked `aria-hidden="true"` as the
 * decorative chrome they are — not part of what "Labels: off" hides.
 */
async function svgTexts(page: Page): Promise<string[]> {
  return page.locator('svg text').evaluateAll((nodes) =>
    nodes
      .filter((n) => !n.closest('[aria-hidden="true"]'))
      .map((n) => n.textContent ?? ''),
  );
}

test('a ten-tile block draws its name once, not once per tile', async ({ page }) => {
  await openEditor(page);

  const texts = await svgTexts(page);

  expect(texts.filter((t) => t === 'Down Platform')).toHaveLength(1);
  expect(texts.filter((t) => t === 'Up Platform')).toHaveLength(1);
  expect(texts.filter((t) => t === 'Fiddle Yard 2')).toHaveLength(1);
});

test('a point carries its name once, abbreviated to fit its tile', async ({ page }) => {
  await openEditor(page);

  const texts = await svgTexts(page);

  // #93. `Yard Throat` does not follow the layout's `P1 - …` convention, so it
  // truncates rather than being assumed to have an identifier. What matters is
  // that it fits its cell: the full name at this font size is most of two tiles
  // wide, which is how two adjacent points ran together into one unreadable
  // string on the real layout.
  expect(texts).toContain('Yard Th…');

  // Once, not once per tagged tile — p1 is drawn on both (11,4) and (11,5).
  expect(texts.filter((t) => t === 'Yard Th…')).toHaveLength(1);
});

test('the full point name stays reachable as a title', async ({ page }) => {
  await openEditor(page);

  // Abbreviating must not lose the name: `<title>` is both the hover tooltip
  // and what assistive technology reads, so it is one mechanism for both. It
  // sits on the wrapping `<g>`, not inside the `<text>` — as a child of `<text>`
  // it would join that element's `textContent` and un-abbreviate the label.
  const titles = await page
    .locator('svg g > title')
    .evaluateAll((nodes) => nodes.map((n) => n.textContent));

  expect(titles).toContain('Yard Throat');
});

test('adjacent blocks never share a tint, so the boundary is visible', async ({ page }) => {
  await openEditor(page);

  // b1 and b2 meet at x=11/12 on row 3; b1 also touches b3's row via the point
  // tile. Each tinted tile carries its block's tint as a fill.
  const fills = await page
    .locator('svg rect[opacity]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('fill')));

  // At least two distinct tints are in use — a single-tint drawing would mean
  // the graph colouring collapsed and every boundary vanished.
  expect(new Set(fills.filter(Boolean)).size).toBeGreaterThan(1);
});

test('label density off hides the labels but keeps the drawing', async ({ page }) => {
  await openEditor(page);
  expect((await svgTexts(page)).length).toBeGreaterThan(0);

  await page.getByRole('combobox', { name: /labels/i }).selectOption('off');

  expect(await svgTexts(page)).toHaveLength(0);
  // The track itself is untouched — this hides text, not tiles.
  await expect(page.getByText(/30 tiles/)).toBeVisible();
});
