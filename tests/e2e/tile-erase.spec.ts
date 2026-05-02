import { expect, test } from '@playwright/test';
import { installMockWebSocket } from './helpers';

/** Intercept API calls with minimal stubs to get the editor visible. */
async function stubApis(page: import('@playwright/test').Page) {
  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'layout-1', name: 'Test' }]) }),
  );

  const tiles: Record<string, { id: string; x: number; y: number; tileType: string; metadata: string }> = {};

  await page.route('**://localhost:3000/api/layouts/layout-1/grid', async (route) => {
    const method = route.request().method();
    if (method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.values(tiles)) });
    }
    if (method === 'PUT') {
      const { x, y, tileType, metadata } = route.request().postDataJSON() as { x: number; y: number; tileType: string; metadata: unknown };
      const key = `${x},${y}`;
      tiles[key] = { id: key, x, y, tileType, metadata: JSON.stringify(metadata ?? {}) };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tiles[key]) });
    }
    return route.continue();
  });

  await page.route('**://localhost:3000/api/layouts/layout-1/grid/tile**', async (route) => {
    const url = new URL(route.request().url());
    const key = `${url.searchParams.get('x')},${url.searchParams.get('y')}`;
    delete tiles[key];
    return route.fulfill({ status: 204, body: '' });
  });

  for (const entity of ['blocks', 'points', 'sensors', 'locos']) {
    await page.route(`**://localhost:3000/api/layouts/layout-1/${entity}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
  }
}

test('right-click erases a placed tile', async ({ page }) => {
  await installMockWebSocket(page);

  await stubApis(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();

  const canvas = page.locator('svg').first();

  // Place a tile with left-click
  await canvas.click({ position: { x: 120, y: 120 } });
  await expect(page.getByText(/1 tile\b/i)).toBeVisible();

  // Erase it with right-click (same cell)
  await canvas.click({ position: { x: 120, y: 120 }, button: 'right' });
  await expect(page.getByText(/0 tiles/i)).toBeVisible();
});
