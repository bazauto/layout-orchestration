import { expect, test, Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

/**
 * Covers the frontend half of #4 (pathfinding). Two things worth an e2e test
 * rather than a unit test, both about what the operator actually sees:
 *
 *  - the Routes panel posts a **destination**, not an edge list — the whole
 *    point of the pathfinder is that the operator does not pick edges.
 *  - a refused grant (422) shows the backend's rendered reason and leaves the
 *    form populated, so the operator can fix the obstruction and retry
 *    without retyping. Same posture `edge-authoring.spec.ts` establishes for
 *    a rejected edge write.
 *
 * The routing itself — which path is chosen, what it locks, what happens when
 * a point command is rejected — is scenario-tested against the real services
 * in `packages/backend/tests/scenario/pathfinding.scenario.test.ts`. This
 * suite runs against a mocked WebSocket, so it cannot receive a `ROUTE_STATE`
 * frame; it covers the request/refusal surface only.
 */

const BLOCKS = [
  { id: 'b1', layoutId: 'layout-1', name: 'Platform 1' },
  { id: 'b2', layoutId: 'layout-1', name: 'Headshunt' },
];

const LOCOS = [
  {
    id: 'loco-1',
    layoutId: 'layout-1',
    name: 'Class 08',
    address: 3,
    type: 'diesel',
    maxSpeed: 126,
    brakingFactor: 0.5,
  },
];

async function stubApis(page: Page) {
  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'layout-1', name: 'Test Layout' }]),
    }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/blocks', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BLOCKS) }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/locos', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(LOCOS) }),
  );
  for (const path of ['points', 'sensors', 'edges']) {
    await page.route(`**://localhost:3000/api/layouts/layout-1/${path}`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
  }
  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, violations: [], edgeCount: 0 }),
    }),
  );
}

/**
 * The Operate screen's controls are disabled until the system reports itself
 * online, so the mocked socket has to deliver a snapshot saying so — the
 * throttle and point controls are gated the same way.
 */
const ONLINE_SNAPSHOT = {
  systemStatus: 'online',
  systemMode: 'manual',
  safeStopReason: null,
  blocks: {},
  points: {},
  locos: {},
  routes: {},
  sensorFaults: [],
  routeFaults: [],
};

/** Fills loco / from / to on the Routes panel. */
async function fillRouteForm(page: Page) {
  await page.getByLabel('Route loco').selectOption('3');
  await page.getByLabel('Route start block').selectOption('b1');
  await page.getByLabel('Route destination block').selectOption('b2');
}

test('requesting a route posts a destination, not an edge list', async ({ page }) => {
  await installMockWebSocket(page, { snapshot: ONLINE_SNAPSHOT });
  await installMockAuth(page);
  await stubApis(page);

  const posted: Array<Record<string, unknown>> = [];
  await page.route('**://localhost:3000/api/layouts/layout-1/routes', async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'route-1',
        layoutId: 'layout-1',
        locoAddress: 3,
        authority: 'manual',
        status: 'active',
        path: [],
        holds: [],
        confirmedIndex: 0,
        reason: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
  });

  await page.goto('/');
  await fillRouteForm(page);
  await page.getByRole('button', { name: 'Request route' }).click();

  await expect(page.getByText(/Route granted/)).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({
    locoAddress: 3,
    startBlockId: 'b1',
    destinationBlockId: 'b2',
    authority: 'manual',
  });
  // The operator picks a destination; the backend picks the road.
  expect(posted[0]).not.toHaveProperty('edgeIds');
});

test('a refused route shows the backend reason and leaves the form populated', async ({ page }) => {
  await installMockWebSocket(page, { snapshot: ONLINE_SNAPSHOT });
  await installMockAuth(page);
  await stubApis(page);

  await page.route('**://localhost:3000/api/layouts/layout-1/routes', (route) =>
    route.fulfill({
      status: 422,
      contentType: 'application/json',
      body: JSON.stringify({
        error:
          'Route rejected: 1 reason(s) — no route exists to block b2 — block b2 is occupied',
        rejections: [
          {
            kind: 'no-path',
            destinationBlockId: 'b2',
            blockers: [{ kind: 'block-not-clear', blockId: 'b2', occupancy: 'occupied' }],
          },
        ],
      }),
    }),
  );

  await page.goto('/');
  await fillRouteForm(page);
  await page.getByRole('button', { name: 'Request route' }).click();

  // The operator is told what is in the way, not just "failed".
  await expect(page.getByText(/block b2 is occupied/)).toBeVisible();

  // And the selections survive, so clearing the block and retrying is one
  // click rather than three.
  await expect(page.getByLabel('Route loco')).toHaveValue('3');
  await expect(page.getByLabel('Route start block')).toHaveValue('b1');
  await expect(page.getByLabel('Route destination block')).toHaveValue('b2');
});
