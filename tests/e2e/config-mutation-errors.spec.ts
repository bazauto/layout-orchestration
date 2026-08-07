import { expect, test, Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

/**
 * Covers #22: a failed block create/update must stay visible in the UI and
 * must not clear the operator's form, the same way EdgesTab already handles
 * a rejected edge (see edge-authoring.spec.ts). Blocks stand in for
 * points/sensors/locos here — they all share `useLayoutConfig`'s `mutate()`
 * path and the same `EditableCell`, so this exercises both the create-form
 * and inline-edit code paths without a spec per tab.
 */

const BLOCKS = [{ id: 'block-a', layoutId: 'layout-1', name: 'Block A' }];

/** Stubs every GET `useLayoutConfig.refresh()` fires, mirroring edge-authoring.spec.ts's `stubApis`. */
async function stubApis(page: Page, options: { blocksRoute: (route: import('@playwright/test').Route) => Promise<void> }) {
  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'layout-1', name: 'Test Layout' }]) }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/blocks', options.blocksRoute);
  await page.route('**://localhost:3000/api/layouts/layout-1/blocks/*', options.blocksRoute);
  await page.route('**://localhost:3000/api/layouts/layout-1/points', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/sensors', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/locos', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/edges', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, violations: [], edgeCount: 0 }) }),
  );
}

async function openBlocksTab(page: Page) {
  // Gated behind a session — see edge-authoring.spec.ts's openEdgesTab.
  await installMockAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Configure' }).click();
  await page.getByRole('button', { name: /^Blocks/ }).click();
}

test('a failed block create leaves the name in the input and shows the error', async ({ page }) => {
  await installMockWebSocket(page);
  await stubApis(page, {
    blocksRoute: async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BLOCKS) });
      }
      if (req.method() === 'POST') {
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'A block named "Block A" already exists' }),
        });
      }
      return route.continue();
    },
  });

  await openBlocksTab(page);

  await page.getByPlaceholder('Block name').fill('Block A');
  await page.getByRole('button', { name: 'Add' }).click();

  await expect(page.getByText('A block named "Block A" already exists')).toBeVisible();

  // The operator's input must survive the rejection — it must not look like the save worked.
  await expect(page.getByPlaceholder('Block name')).toHaveValue('Block A');
});

test('a failed inline block rename stays in edit mode with the draft intact', async ({ page }) => {
  await installMockWebSocket(page);
  await stubApis(page, {
    blocksRoute: async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BLOCKS) });
      }
      if (req.method() === 'PUT') {
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Internal error' }),
        });
      }
      return route.continue();
    },
  });

  await openBlocksTab(page);

  await page.getByTitle('Edit').click();
  const input = page.locator('input').last();
  await input.fill('Renamed Block');
  await page.getByRole('button', { name: '✓' }).click();

  await expect(page.getByText('Internal error')).toBeVisible();

  // A failed rename must not clear the operator's draft or silently revert to view mode.
  await expect(input).toHaveValue('Renamed Block');
  await expect(page.getByText('Block A', { exact: true })).toHaveCount(0);
});
