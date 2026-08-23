/**
 * The Edges tab as a **read** (#103 PR 5).
 *
 * The three authoring specs that used to live here — filling the form, the
 * "also create reverse edge" shortcut, and a 422 leaving the form populated —
 * went with the form. `block_edges` is written by the compile apply and by
 * nothing else, and `POST .../edges` no longer exists; `compile.spec.ts` covers
 * the surface that replaced them.
 *
 * What survives is the violation banner, which is about *reading* a graph that
 * is already wrong. That case is worth keeping precisely because a compiled
 * apply cannot produce it — `replaceGraph` validates before writing — so the
 * only way to see it is a graph that went invalid underneath the UI, which is
 * exactly when the banner has to work.
 */

import { expect, test, Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

const BLOCKS = [
  { id: 'block-a', layoutId: 'layout-1', name: 'Block A', lengthMm: null },
  { id: 'block-b', layoutId: 'layout-1', name: 'Block B', lengthMm: 1200 },
];

const POINTS = [{ id: 'point-1', layoutId: 'layout-1', name: 'Point 1', dccAddress: 1, blockId: null }];

/**
 * Stubs the layout list and the config-fetching endpoints `useLayoutConfig`
 * calls on every `refresh()`.
 */
async function stubApis(
  page: Page,
  options: { initialEdges?: unknown[]; topologyOverride?: unknown } = {},
) {
  const edges: unknown[] = [...(options.initialEdges ?? [])];

  await page.route('**/api/layouts', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ id: 'layout-1', name: 'Test Layout' }]),
    }),
  );

  await page.route('**/api/layouts/layout-1/blocks', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(BLOCKS) }),
  );
  await page.route('**/api/layouts/layout-1/points', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(POINTS) }),
  );
  await page.route('**/api/layouts/layout-1/sensors', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**/api/layouts/layout-1/locos', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );

  await page.route('**/api/layouts/layout-1/topology', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        options.topologyOverride ?? { valid: true, violations: [], edgeCount: edges.length },
      ),
    }),
  );

  await page.route('**/api/layouts/layout-1/edges', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(edges) }),
  );
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

test('a stubbed invalid topology renders the violation banner', async ({ page }) => {
  await installMockWebSocket(page);
  await stubApis(page, {
    // edge-x is in the edges fixture (so it renders as a derived label) and
    // references block-ghost, which is NOT in BLOCKS — the client-side
    // degradation path (#54/D8): a raw id fallback in the middle of an
    // otherwise-named string, worth asserting explicitly.
    initialEdges: [
      {
        id: 'edge-x',
        layoutId: 'layout-1',
        fromBlockId: 'block-a',
        fromEnd: 'east',
        toBlockId: 'block-ghost',
        toEnd: 'west',
        pointConditions: [],
      },
    ],
    topologyOverride: {
      valid: false,
      violations: [{ kind: 'unknown-block', edgeId: 'edge-x', blockId: 'block-ghost' }],
      edgeCount: 1,
    },
  });

  await openEdgesTab(page);

  await expect(
    page.getByText(/edge "Block A:east → block-ghost:west" \(edge-x\) references unknown block block-ghost/),
  ).toBeVisible();
});

test('the tab offers no way to author an edge by hand', async ({ page }) => {
  // The structural claim of #103 PR 5, asserted at the surface an operator
  // actually touches: there is no form, no delete button, and no second way
  // into `block_edges`. The compile panel is the only write.
  await installMockWebSocket(page);
  await stubApis(page, {
    initialEdges: [
      {
        id: 'edge-1',
        layoutId: 'layout-1',
        fromBlockId: 'block-a',
        fromEnd: 'east',
        toBlockId: 'block-b',
        toEnd: 'west',
        pointConditions: [],
      },
    ],
  });

  await openEdgesTab(page);

  await expect(page.getByText('Block A:east → Block B:west')).toBeVisible();

  await expect(page.getByPlaceholder('From end')).toHaveCount(0);
  await expect(page.getByPlaceholder('To end')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add' })).toHaveCount(0);
  await expect(page.getByText('+ point condition')).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'also create reverse edge' })).toHaveCount(0);

  // And the one control that is offered.
  await expect(
    page.getByRole('button', { name: /Compile the graph from the drawing/ }),
  ).toBeVisible();
});
