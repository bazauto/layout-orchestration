/**
 * Login screen e2e coverage.
 *
 * Mirrors this suite's existing approach (page.route interception, no real
 * backend process — see helpers.ts) rather than a real login against a live
 * server: the design note in the issue #20 plan ("Playwright logs in once
 * and reuses storageState") assumes a real backend in the loop, but this
 * harness deliberately runs the frontend against a fully mocked network for
 * every other spec too. Exercising the real backend's login route end to
 * end is covered instead by the Vitest integration suite
 * (packages/backend/tests/integration/routes.test.ts, wsAuth.test.ts),
 * which logs in for real via Fastify inject().
 */

import { expect, test } from '@playwright/test';
import { installMockWebSocket } from './helpers';

const USERNAME = 'e2e-admin';
const PASSWORD = 'correct-horse-battery-staple';

test.describe('Login screen', () => {
  test('an unauthenticated visit shows the login screen, not the operate UI', async ({ page }) => {
    await page.route('**://localhost:3000/api/auth/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Authentication required' }) }),
    );

    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Layout Orchestrator' })).toBeVisible();
    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Operate' })).toHaveCount(0);
  });

  test('the wrong password shows an error and stays on the login screen', async ({ page }) => {
    await page.route('**://localhost:3000/api/auth/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Authentication required' }) }),
    );
    await page.route('**://localhost:3000/api/auth/login', (route) =>
      route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Invalid username or password' }),
      }),
    );

    await page.goto('/');
    await page.getByLabel('Username').fill(USERNAME);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('Invalid username or password')).toBeVisible();
    await expect(page.getByLabel('Username')).toBeVisible();
  });

  test('correct credentials reach the operate UI, and logout returns to the login screen', async ({ page }) => {
    await installMockWebSocket(page);

    // GET /api/auth/me: unauthenticated until login flips this route's
    // response, matching the real backend's session-cookie behaviour.
    let authenticated = false;
    await page.route('**://localhost:3000/api/auth/me', (route) =>
      route.fulfill(
        authenticated
          ? { status: 200, contentType: 'application/json', body: JSON.stringify({ username: USERNAME, role: 'admin' }) }
          : { status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Authentication required' }) },
      ),
    );
    await page.route('**://localhost:3000/api/auth/login', (route) => {
      authenticated = true;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ username: USERNAME, role: 'admin' }),
      });
    });
    await page.route('**://localhost:3000/api/auth/logout', (route) => {
      authenticated = false;
      return route.fulfill({ status: 204, body: '' });
    });

    await page.route('**://localhost:3000/api/layouts', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'layout-1', name: 'Test' }]) }),
    );
    for (const entity of ['blocks', 'points', 'sensors', 'locos']) {
      await page.route(`**://localhost:3000/api/layouts/layout-1/${entity}`, (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
      );
    }

    await page.goto('/');
    await page.getByLabel('Username').fill(USERNAME);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('button', { name: 'Operate' })).toBeVisible();
    await expect(page.getByText(new RegExp(USERNAME))).toBeVisible();

    await page.getByRole('button', { name: 'Log out' }).click();

    await expect(page.getByLabel('Username')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Operate' })).toHaveCount(0);
  });
});
