import { expect, test, Page, Route } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

/**
 * Covers issue #53's Step 8: the Configure screen's admin-only Users tab,
 * and the change-password control any logged-in user can reach. Mirrors
 * config-mutation-errors.spec.ts's approach (page.route mocks, no real
 * backend process — see helpers.ts).
 */

const USERS = [
  { id: 'u-admin', username: 'e2e-admin', role: 'admin', createdAt: '2026-01-01T00:00:00.000Z', hasPassword: true },
  { id: 'u-op', username: 'op1', role: 'operator', createdAt: '2026-01-02T00:00:00.000Z', hasPassword: true },
];

/** Stubs every GET useLayoutConfig.refresh() fires, mirroring config-mutation-errors.spec.ts's stubApis. */
async function stubConfigApis(page: Page) {
  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'layout-1', name: 'Test Layout' }]) }),
  );
  for (const entity of ['blocks', 'points', 'sensors', 'locos', 'edges']) {
    await page.route(`**://localhost:3000/api/layouts/layout-1/${entity}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
  }
  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, violations: [], edgeCount: 0 }) }),
  );
}

async function openConfigureScreen(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Configure' }).click();
}

test('as admin, the Configure screen shows a Users tab, lists the mocked users, and create issues POST /api/users with the typed username/role', async ({ page }) => {
  await installMockAuth(page, { role: 'admin' });
  await installMockWebSocket(page);
  await stubConfigApis(page);

  let createRequestBody: unknown = null;
  await page.route('**://localhost:3000/api/users', async (route: Route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USERS) });
    }
    if (req.method() === 'POST') {
      createRequestBody = req.postDataJSON();
      const created = { id: 'u-new', username: 'newop', role: 'operator', createdAt: '2026-01-03T00:00:00.000Z', hasPassword: true };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
    }
    return route.continue();
  });

  await openConfigureScreen(page);
  await page.getByRole('button', { name: /^Users/ }).click();

  await expect(page.getByText('op1')).toBeVisible();

  await page.getByPlaceholder('Username').fill('newop');
  await page.getByPlaceholder('Password').fill('a-good-password');
  await page.getByPlaceholder('Username').press('Tab');
  await page.getByRole('button', { name: 'Add' }).click();

  await expect.poll(() => createRequestBody).toEqual({
    username: 'newop',
    password: 'a-good-password',
    role: 'operator',
  });
});

test('a mocked 409 on DELETE /api/users/:id renders the backend message in the UI', async ({ page }) => {
  await installMockAuth(page, { role: 'admin' });
  await installMockWebSocket(page);
  await stubConfigApis(page);

  await page.route('**://localhost:3000/api/users', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USERS) });
    }
    return route.continue();
  });
  await page.route('**://localhost:3000/api/users/u-op', (route: Route) => {
    if (route.request().method() === 'DELETE') {
      return route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Cannot remove the last admin account' }),
      });
    }
    return route.continue();
  });

  await openConfigureScreen(page);
  await page.getByRole('button', { name: /^Users/ }).click();

  await page
    .locator('tr')
    .filter({ hasText: 'op1' })
    .getByRole('button', { name: '×' })
    .click();

  await expect(page.getByText('Cannot remove the last admin account')).toBeVisible();
});

/**
 * Reported from the live layout: adding an operator with a short password
 * showed only "Invalid user payload". The actionable text is in `details`,
 * which the frontend used to discard.
 */
test('a 400 with Zod field errors renders the actionable message, not the generic label', async ({
  page,
}) => {
  await installMockAuth(page, { role: 'admin' });
  await installMockWebSocket(page);
  await stubConfigApis(page);

  await page.route('**://localhost:3000/api/users', (route: Route) => {
    if (route.request().method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(USERS) });
    }
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Invalid user payload',
          details: {
            formErrors: [],
            fieldErrors: { password: ['Password must be at least 8 characters'] },
          },
        }),
      });
    }
    return route.continue();
  });

  await openConfigureScreen(page);
  await page.getByRole('button', { name: /^Users/ }).click();

  await page.getByPlaceholder('Username').fill('shortpw');
  await page.getByPlaceholder('Password').fill('1234567');
  await page.getByRole('button', { name: 'Add' }).click();

  await expect(page.getByText(/Password must be at least 8 characters/)).toBeVisible();
  await expect(page.getByText('Invalid user payload', { exact: true })).toHaveCount(0);
});

test('as operator, the Users tab is not rendered', async ({ page }) => {
  await installMockAuth(page, { role: 'operator' });
  await installMockWebSocket(page);
  await stubConfigApis(page);

  await openConfigureScreen(page);

  await expect(page.getByRole('button', { name: /^Users/ })).toHaveCount(0);
});

test('as operator, the change-password control is reachable and a successful change returns to the login screen', async ({ page }) => {
  await installMockAuth(page, { role: 'operator' });
  await installMockWebSocket(page);
  await stubConfigApis(page);

  await page.route('**://localhost:3000/api/auth/change-password', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );
  await page.route('**://localhost:3000/api/auth/logout', (route: Route) =>
    route.fulfill({ status: 204, body: '' }),
  );

  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Operate' })).toBeVisible();

  await page.getByRole('button', { name: 'Change password' }).click();
  await page.getByLabel('Current password').fill('old-password');
  await page.getByLabel('New password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Change password' }).last().click();

  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Operate' })).toHaveCount(0);
});
