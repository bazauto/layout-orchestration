import { expect, test, Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

interface EdgeBody {
  fromBlockId: string;
  fromEnd: string;
  toBlockId: string;
  toEnd: string;
  pointConditions: Array<{ pointId: string; requiredPosition: string }>;
  lengthMm: number | null;
}

const BLOCKS = [
  { id: 'block-a', layoutId: 'layout-1', name: 'Block A' },
  { id: 'block-b', layoutId: 'layout-1', name: 'Block B' },
];

const POINTS = [{ id: 'point-1', layoutId: 'layout-1', name: 'Point 1', dccAddress: 1, blockId: null }];

/**
 * Stubs the layout list and the config-fetching endpoints `useLayoutConfig`
 * calls on every `refresh()`. `edges` and `topology` are backed by a mutable
 * array/status object so POST/DELETE against `/edges` are reflected on the
 * next `GET` — the same way the real API behaves.
 */
async function stubApis(
  page: Page,
  options: {
    initialEdges?: unknown[];
    topologyOverride?: unknown;
    onCreateEdge?: (route: import('@playwright/test').Route, body: EdgeBody) => Promise<boolean>;
  } = {},
) {
  const edges: unknown[] = [...(options.initialEdges ?? [])];
  let nextId = 1;

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
  await page.route('**://localhost:3000/api/layouts/layout-1/points', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POINTS) }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/sensors', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/locos', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(options.topologyOverride ?? { valid: true, violations: [], edgeCount: edges.length }),
    }),
  );

  await page.route('**://localhost:3000/api/layouts/layout-1/edges', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(edges) });
      return;
    }
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as EdgeBody;
      if (options.onCreateEdge) {
        const handled = await options.onCreateEdge(route, body);
        if (handled) return;
      }
      const created = { id: `edge-${nextId++}`, layoutId: 'layout-1', ...body };
      edges.push(created);
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(created) });
      return;
    }
    await route.continue();
  });

  return { edges };
}

async function openEdgesTab(page: Page) {
  // The UI is now gated behind a session, so every spec that isn't testing
  // the login flow itself must mock GET /api/auth/me before navigating —
  // otherwise the app renders LoginScreen and nothing below is reachable.
  await installMockAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Configure' }).click();
  await page.getByRole('button', { name: /^Edges/ }).click();
}

test('authors a two-block edge with one point condition end to end', async ({ page }) => {
  await installMockWebSocket(page);
  const posted: EdgeBody[] = [];
  await stubApis(page, {
    onCreateEdge: async (route, body) => {
      posted.push(body);
      return false; // let the default handler fulfill and push into `edges`
    },
  });

  await openEdgesTab(page);

  await page.getByLabel('From block').selectOption('block-a');
  await page.getByPlaceholder('From end').fill('North');
  await page.getByLabel('To block').selectOption('block-b');
  await page.getByPlaceholder('To end').fill('South');
  await page.getByPlaceholder('Length (mm)').fill('250');

  await page.getByText('+ point condition').click();
  await page.getByLabel('Point').selectOption('point-1');
  await page.getByLabel('Required position').selectOption('reverse');

  await page.getByRole('button', { name: 'Add' }).click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toEqual({
    fromBlockId: 'block-a',
    fromEnd: 'north',
    toBlockId: 'block-b',
    toEnd: 'south',
    pointConditions: [{ pointId: 'point-1', requiredPosition: 'reverse' }],
    lengthMm: 250,
  });

  await expect(page.getByText('Block A:north → Block B:south')).toBeVisible();
  await expect(page.getByText('Point 1=reverse')).toBeVisible();
});

test('the "also create reverse edge" checkbox issues a second POST with ends swapped', async ({ page }) => {
  await installMockWebSocket(page);
  const posted: EdgeBody[] = [];
  await stubApis(page, {
    onCreateEdge: async (_route, body) => {
      posted.push(body);
      return false;
    },
  });

  await openEdgesTab(page);

  await page.getByLabel('From block').selectOption('block-a');
  await page.getByPlaceholder('From end').fill('north');
  await page.getByLabel('To block').selectOption('block-b');
  await page.getByPlaceholder('To end').fill('south');

  await page.getByRole('checkbox', { name: 'also create reverse edge' }).check();
  await page.getByRole('button', { name: 'Add' }).click();

  await expect.poll(() => posted.length).toBe(2);
  expect(posted[0].fromBlockId).toBe('block-a');
  expect(posted[0].fromEnd).toBe('north');
  expect(posted[0].toBlockId).toBe('block-b');
  expect(posted[0].toEnd).toBe('south');

  expect(posted[1].fromBlockId).toBe('block-b');
  expect(posted[1].fromEnd).toBe('south');
  expect(posted[1].toBlockId).toBe('block-a');
  expect(posted[1].toEnd).toBe('north');
});

test('a stubbed 422 renders the violation and leaves the form populated', async ({ page }) => {
  await installMockWebSocket(page);
  await stubApis(page, {
    onCreateEdge: async (route) => {
      await route.fulfill({
        status: 422,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'Topology rejected: 1 violation(s)',
          violations: [{ kind: 'self-loop', edgeId: '__pending__', blockId: 'block-a' }],
        }),
      });
      return true;
    },
  });

  await openEdgesTab(page);

  await page.getByLabel('From block').selectOption('block-a');
  await page.getByPlaceholder('From end').fill('north');
  await page.getByLabel('To block').selectOption('block-b');
  await page.getByPlaceholder('To end').fill('south');

  await page.getByRole('button', { name: 'Add' }).click();

  await expect(page.getByText(/self-loop on block block-a/)).toBeVisible();

  // The operator's input must survive the rejection.
  await expect(page.getByLabel('From block')).toHaveValue('block-a');
  await expect(page.getByPlaceholder('From end')).toHaveValue('north');
  await expect(page.getByLabel('To block')).toHaveValue('block-b');
  await expect(page.getByPlaceholder('To end')).toHaveValue('south');
});

test('a stubbed invalid topology renders the violation banner', async ({ page }) => {
  await installMockWebSocket(page);
  await stubApis(page, {
    topologyOverride: {
      valid: false,
      violations: [{ kind: 'unknown-block', edgeId: 'edge-x', blockId: 'block-ghost' }],
      edgeCount: 1,
    },
  });

  await openEdgesTab(page);

  await expect(page.getByText(/edge edge-x references unknown block block-ghost/)).toBeVisible();
});
