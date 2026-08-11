/**
 * #69 — canvas extent derived from content, undo, and fit-to-content.
 *
 * The two problems this covers were both found by laying out Westgate Hollow
 * for real: the canvas was hard-coded at 30x20 and silently dropped any paint
 * beyond it (the layout already reached column 29), and a stray right-drag
 * erased a run of tiles with no undo and no confirmation, on a config surface
 * representing an afternoon of authoring.
 */

import { expect, test, type Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

type StoredTile = {
  id: string;
  layoutId: string;
  x: number;
  y: number;
  tileType: string;
  metadata: string;
};

/**
 * A read/write grid stub, unlike the read-only ones elsewhere: undo replays
 * inverse writes, so the backend has to actually remember them for the
 * assertions to mean anything.
 */
async function stubApis(page: Page, seed: { x: number; y: number }[] = []) {
  const tiles = new Map<string, StoredTile>(
    seed.map((t) => [
      `${t.x},${t.y}`,
      {
        id: `t-${t.x}-${t.y}`,
        layoutId: 'layout-1',
        x: t.x,
        y: t.y,
        tileType: 'straight-h',
        metadata: '{"rotation":0}',
      },
    ]),
  );

  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'layout-1', name: 'Westgate Hollow' }]),
    }),
  );

  await page.route('**://localhost:3000/api/layouts/layout-1/grid', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([...tiles.values()]),
      });
    }
    if (method === 'PUT') {
      const { x, y, tileType, metadata } = route.request().postDataJSON();
      const stored: StoredTile = {
        id: `t-${x}-${y}`,
        layoutId: 'layout-1',
        x,
        y,
        tileType,
        metadata: JSON.stringify(metadata ?? {}),
      };
      tiles.set(`${x},${y}`, stored);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stored),
      });
    }
    return route.continue();
  });

  await page.route('**://localhost:3000/api/layouts/layout-1/grid/tile**', (route) => {
    const url = new URL(route.request().url());
    tiles.delete(`${url.searchParams.get('x')},${url.searchParams.get('y')}`);
    return route.fulfill({ status: 204, body: '' });
  });

  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  for (const e of ['blocks', 'points', 'sensors', 'locos', 'edges']) {
    await page.route(`**://localhost:3000/api/layouts/layout-1/${e}`, (r) => r.fulfill(json([])));
  }
  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill(json({ valid: true, violations: [], edgeCount: 0 })),
  );

  return tiles;
}

async function openEditor(page: Page) {
  await installMockWebSocket(page);
  await installMockAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();
  return page.locator('svg').first();
}

const tileCount = (page: Page) => page.locator('text=/\\d+ tiles?/').first();

test('the canvas grows past the old fixed 30x20 rather than silently dropping paint', async ({
  page,
}) => {
  // A tile at column 34 — beyond the old GRID_COLS of 30, which would have
  // rendered nothing and refused any further paint out there.
  await stubApis(page, [{ x: 34, y: 2 }]);
  await openEditor(page);

  await expect(tileCount(page)).toHaveText(/1 tile\b/);
  // The reported canvas is now derived from the content plus a margin.
  await expect(page.getByText(/Canvas: 4[0-9]×/)).toBeVisible();
});

test('an empty layout still gets a usable canvas', async ({ page }) => {
  await stubApis(page);
  await openEditor(page);

  await expect(page.getByText(/Canvas: 30×20/)).toBeVisible();
});

test('undo restores an erased tile', async ({ page }) => {
  await stubApis(page, [{ x: 3, y: 3 }]);
  const canvas = await openEditor(page);
  await expect(tileCount(page)).toHaveText(/1 tile\b/);

  // Erase it (tile 3,3 centre is 140,140 at zoom 1 with no pan).
  await canvas.click({ position: { x: 140, y: 140 }, button: 'right' });
  await expect(tileCount(page)).toHaveText(/0 tiles/);

  await page.getByTitle(/Undo last change/).click();

  await expect(tileCount(page)).toHaveText(/1 tile\b/);
});

test('undo removes a painted tile', async ({ page }) => {
  await stubApis(page);
  const canvas = await openEditor(page);

  await canvas.click({ position: { x: 220, y: 180 } });
  await expect(tileCount(page)).toHaveText(/1 tile\b/);

  await page.getByTitle(/Undo last change/).click();

  await expect(tileCount(page)).toHaveText(/0 tiles/);
});

// The motivating case: a stray right-drag deletes a run, one DELETE per tile.
// Undoing that one tile at a time would be no use, so a drag is one stroke.
test('undo restores an entire drag-erased run in one step', async ({ page }) => {
  await stubApis(page, [
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 4, y: 3 },
    { x: 5, y: 3 },
  ]);
  const canvas = await openEditor(page);
  await expect(tileCount(page)).toHaveText(/4 tiles/);

  // Raw mouse events take page coordinates, so the canvas origin has to be
  // added — the tile positions used elsewhere are element-relative.
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 100, box.y + 140);
  await page.mouse.down({ button: 'right' });
  for (const dx of [140, 180, 220]) await page.mouse.move(box.x + dx, box.y + 140);
  await page.mouse.up({ button: 'right' });

  await expect(tileCount(page)).toHaveText(/0 tiles/);

  await page.getByTitle(/Undo last change/).click();

  await expect(tileCount(page)).toHaveText(/4 tiles/);
});

test('the undo control is disabled when there is nothing to undo', async ({ page }) => {
  await stubApis(page);
  await openEditor(page);

  await expect(page.getByTitle('Nothing to undo')).toBeDisabled();
});

test('Ctrl+Z undoes without touching the toolbar', async ({ page }) => {
  await stubApis(page);
  const canvas = await openEditor(page);

  await canvas.click({ position: { x: 220, y: 180 } });
  await expect(tileCount(page)).toHaveText(/1 tile\b/);

  await page.keyboard.press('Control+z');

  await expect(tileCount(page)).toHaveText(/0 tiles/);
});

// `⌂` used to reset to zoom 1 at the origin, which on a layout drawn away from
// the origin leaves the canvas apparently blank.
test('fit-to-content brings a far-off drawing into view', async ({ page }) => {
  await stubApis(page, [
    { x: 40, y: 30 },
    { x: 41, y: 30 },
    { x: 42, y: 30 },
  ]);
  const canvas = await openEditor(page);
  await expect(tileCount(page)).toHaveText(/3 tiles/);

  const before = await canvas.locator('g').first().getAttribute('transform');
  await page.getByTitle('Fit to content').click();
  const after = await canvas.locator('g').first().getAttribute('transform');

  expect(after).not.toBe(before);
  // The drawing sits at x=40 (1600px unscaled); a view still at the origin
  // would leave it off screen entirely.
  expect(after).not.toContain('translate(0,0)');
});

test('pan and zoom are restored when the tab is reopened', async ({ page }) => {
  await stubApis(page, [{ x: 3, y: 3 }]);
  const canvas = await openEditor(page);

  await page.getByTitle('Zoom in').click();
  await page.getByTitle('Zoom in').click();
  const zoomed = await canvas.locator('g').first().getAttribute('transform');

  await page.getByRole('button', { name: 'Configure' }).click();
  await page.getByRole('button', { name: 'Track Editor' }).click();

  // Polled: the restore runs in an effect after the remount's first paint, so
  // reading the attribute once races it.
  await expect
    .poll(() => page.locator('svg').first().locator('g').first().getAttribute('transform'))
    .toBe(zoomed);
});
