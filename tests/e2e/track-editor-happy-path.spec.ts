import { expect, test } from '@playwright/test';

test('track editor happy path: select tool, rotate, place tiles', async ({ page }) => {
  const placed: Array<{ x: number; y: number; tileType: string; metadata?: Record<string, unknown> }> = [];

  await page.route('**://localhost:3000/api/layouts', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'layout-1', name: 'Test Layout' }]),
    });
  });

  await page.route('**://localhost:3000/api/layouts/layout-1/grid', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
      return;
    }

    if (req.method() === 'PUT') {
      const body = req.postDataJSON() as {
        x: number;
        y: number;
        tileType: string;
        metadata?: Record<string, unknown>;
      };
      placed.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: `tile-${placed.length}`,
          layoutId: 'layout-1',
          x: body.x,
          y: body.y,
          tileType: body.tileType,
          metadata: JSON.stringify(body.metadata ?? {}),
        }),
      });
      return;
    }

    await route.continue();
  });

  await page.route('**://localhost:3000/api/layouts/layout-1/grid/tile**', async (route) => {
    await route.fulfill({ status: 204, body: '' });
  });

  await page.route('**://localhost:3000/api/layouts/layout-1/blocks', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**://localhost:3000/api/layouts/layout-1/points', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**://localhost:3000/api/layouts/layout-1/sensors', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**://localhost:3000/api/layouts/layout-1/locos', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('/');

  await page.getByRole('button', { name: 'Track Editor' }).click();

  const canvas = page.locator('svg').first();

  // Place first tile with default tool (Straight H) using shortcut 1.
  await page.keyboard.press('1');
  await canvas.click({ position: { x: 120, y: 120 } });

  // Select diagonal via shortcut 2 (now "Corner"), rotate via R, and place second tile.
  await page.keyboard.press('2');
  await page.keyboard.press('r');
  await canvas.click({ position: { x: 160, y: 120 } });

  await expect(page.getByText(/2 tiles/i)).toBeVisible();

  expect(placed.length).toBeGreaterThanOrEqual(2);
  expect(placed[0].tileType).toBe('straight-h');
  expect(placed[1].tileType).toBe('straight-45'); // "Corner"
  expect(placed[1].metadata?.rotation).toBe(45);
});
