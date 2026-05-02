import { expect, test } from '@playwright/test';
import { installMockWebSocket } from './helpers';

const PALETTE = [
  { key: '1', label: /straight/i },
  { key: '2', label: /corner/i },
  { key: '3', label: /point l/i },
  { key: '4', label: /point r/i },
  { key: '5', label: /crossing/i },
  { key: '6', label: /buffer/i },
  { key: '7', label: /platform/i },
];

test('keyboard shortcuts 1–7 cycle through all palette items', async ({ page }) => {
  await installMockWebSocket(page);

  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'layout-1', name: 'Test' }]) }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/grid', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  for (const entity of ['blocks', 'points', 'sensors', 'locos']) {
    await page.route(`**://localhost:3000/api/layouts/layout-1/${entity}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
  }

  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();

  // Click canvas once so the SVG has focus for keyboard events
  await page.locator('svg').first().click({ position: { x: 400, y: 400 }, button: 'right' });

  for (const { key, label } of PALETTE) {
    await page.keyboard.press(key);

    // The active palette button text should match the expected tile name
    const activeBtn = page.locator('button').filter({
      has: page.locator(`span:text-matches("${label.source}", "i")`),
    }).first();
    await expect(activeBtn).toHaveCSS('border-color', 'rgb(137, 180, 250)'); // #89b4fa = active border
  }
});

test('R rotates forward 45° per press and Shift+R rotates backward', async ({ page }) => {
  await installMockWebSocket(page);

  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'layout-1', name: 'Test' }]) }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/grid', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  for (const entity of ['blocks', 'points', 'sensors', 'locos']) {
    await page.route(`**://localhost:3000/api/layouts/layout-1/${entity}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
  }

  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();

  // Focus the canvas area
  await page.locator('svg').first().click({ position: { x: 400, y: 400 }, button: 'right' });

  const badge = page.locator('span').filter({ hasText: /^\d+°$/ });
  await expect(badge).toHaveText('0°');

  // Four forward presses → 180°
  await page.keyboard.press('r');
  await expect(badge).toHaveText('45°');
  await page.keyboard.press('r');
  await expect(badge).toHaveText('90°');
  await page.keyboard.press('r');
  await expect(badge).toHaveText('135°');
  await page.keyboard.press('r');
  await expect(badge).toHaveText('180°');

  // Shift+R should step back
  await page.keyboard.press('Shift+r');
  await expect(badge).toHaveText('135°');
});
