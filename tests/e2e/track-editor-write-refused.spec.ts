/**
 * #62 — the Track Editor must not report a refused grid write as a success.
 *
 * The existing editor specs (`track-editor-happy-path`, `tile-erase`) stub the
 * API with success responses only, so a swallowed failure was indistinguishable
 * from a real save and both stayed green throughout the bug's lifetime. This
 * spec is the missing half: every grid write is refused, and the screen must
 * say so.
 *
 * 403 is used because that is what an operator session gets on every `/grid`
 * write, but the defect had nothing to do with roles — the editor simply never
 * looked at the response. A 500 case is included to pin that.
 */

import { expect, test, type Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

const EXISTING_TILE = {
  id: 'tile-1',
  layoutId: 'layout-1',
  x: 3,
  y: 3,
  tileType: 'straight-h',
  metadata: '{}',
};

/**
 * Stubs the editor's reads as normal and refuses every write with `status`.
 * The GET keeps returning the tile throughout, which is what makes the revert
 * observable: an erase that is refused must put the tile back.
 */
async function stubRefusingApis(page: Page, status: number, body: unknown) {
  await page.route('**/api/layouts', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'layout-1', name: 'Test' }]),
    }),
  );

  await page.route('**/api/layouts/layout-1/grid', async (route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([EXISTING_TILE]),
      });
    }
    return route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.route('**/api/layouts/layout-1/grid/tile**', (route) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }),
  );

  for (const entity of ['blocks', 'points', 'sensors', 'locos']) {
    await page.route(`**/api/layouts/layout-1/${entity}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
  }
}

async function openTrackEditor(page: Page) {
  await installMockWebSocket(page);
  await installMockAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();
  return page.locator('svg').first();
}

test('a refused tile placement reports the backend message instead of vanishing silently', async ({
  page,
}) => {
  await stubRefusingApis(page, 403, { error: 'Admin role required' });
  const canvas = await openTrackEditor(page);

  await expect(page.getByText(/1 tile\b/i)).toBeVisible();

  // Paint into an empty cell. The tile appears optimistically, then reverts.
  await canvas.click({ position: { x: 240, y: 240 } });

  // The message the operator actually needs: the backend's own, not `HTTP 403`.
  await expect(page.getByRole('alert')).toContainText('Admin role required');
  // ...and the optimistic tile is gone again, so the screen agrees with the
  // server rather than asserting a save that never happened.
  await expect(page.getByText(/1 tile\b/i)).toBeVisible();
});

test('a refused erase puts the tile back and says why', async ({ page }) => {
  await stubRefusingApis(page, 403, { error: 'Admin role required' });
  const canvas = await openTrackEditor(page);

  await expect(page.getByText(/1 tile\b/i)).toBeVisible();

  // Right-click the existing tile at (3,3) — 40px tiles, so its centre is
  // (140, 140) at zoom 1 with no pan.
  await canvas.click({ position: { x: 140, y: 140 }, button: 'right' });

  await expect(page.getByRole('alert')).toContainText('Admin role required');
  // Previously the tile stayed gone on screen while the backend still had it,
  // and only a page reload revealed the divergence.
  await expect(page.getByText(/1 tile\b/i)).toBeVisible();
});

test('a 500 is surfaced too — the defect was never about roles', async ({ page }) => {
  await stubRefusingApis(page, 500, { error: 'database is locked' });
  const canvas = await openTrackEditor(page);

  await canvas.click({ position: { x: 240, y: 240 } });

  await expect(page.getByRole('alert')).toContainText('database is locked');
});
