/**
 * The compile review panel (#103 PR 5) on the Configure → Edges tab.
 *
 * What these specs defend is the property the whole design rests on: **the
 * operator approves a drawing, and the thing applied is that same drawing.**
 * The apply carries a fingerprint and nothing else, so the assertions below are
 * on the request body rather than on the rendered table — a panel that posted
 * rows would be a second authoring path wearing the compiler's name, and it
 * would look identical on screen.
 *
 * The second is the failure path, which is the reason the guard exists at all:
 * the drawing moving between the review and the apply must produce a sentence
 * and a button, never an automatic retry. An automatic retry is a machine doing
 * exactly what the fingerprint exists to stop a human doing.
 */

import { expect, test, type Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

const BLOCKS = [
  { id: 'b-fy1', layoutId: 'layout-1', name: 'Fiddle Yard 1' },
  { id: 'b-s1', layoutId: 'layout-1', name: 'Siding 1' },
  { id: 'b-s2', layoutId: 'layout-1', name: 'Siding 2' },
];

const POINTS = [
  { id: 'p1', layoutId: 'layout-1', name: 'P1 - Fiddle Yard', dccAddress: 1, blockId: null },
];

const FINGERPRINT = 'fp-reviewed';

const EDGE_FY1_S1 = {
  fromBlockId: 'b-fy1',
  fromEnd: 'east',
  toBlockId: 'b-s1',
  toEnd: 'west',
  pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
  via: [
    { x: 12, y: 3 },
    { x: 13, y: 3 },
  ],
  crossesDiamond: false,
};

const EDGE_S1_FY1 = {
  fromBlockId: 'b-s1',
  fromEnd: 'west',
  toBlockId: 'b-fy1',
  toEnd: 'east',
  pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
  via: [
    { x: 13, y: 3 },
    { x: 12, y: 3 },
  ],
  crossesDiamond: false,
};

/** Two connections to add, one block nothing reaches, and the evidence for it. */
const REPORT = {
  report: {
    fingerprint: FINGERPRINT,
    edges: [EDGE_FY1_S1, EDGE_S1_FY1],
    gaps: [
      { kind: 'blocked-by-unclassified', at: { x: 19, y: 5 } },
      { kind: 'block-not-in-graph', blockId: 'b-s2' },
    ],
    components: [['b-fy1', 'b-s1']],
  },
  status: {
    compiledAt: null,
    compiledFingerprint: null,
    drawingFingerprint: FINGERPRINT,
    stale: true,
    gapCount: 2,
  },
  diff: {
    added: [EDGE_FY1_S1, EDGE_S1_FY1],
    removed: [],
    unchanged: [],
    changed: [],
    relabelled: [],
  },
};

/** What the server returns after a successful apply: an empty diff, not stale. */
const APPLIED = {
  ...REPORT,
  status: {
    compiledAt: '2026-08-14T06:00:00.000Z',
    compiledFingerprint: FINGERPRINT,
    drawingFingerprint: FINGERPRINT,
    stale: false,
    gapCount: 2,
  },
  diff: {
    added: [],
    removed: [],
    unchanged: [
      { id: 'e1', layoutId: 'layout-1', ...EDGE_FY1_S1 },
      { id: 'e2', layoutId: 'layout-1', ...EDGE_S1_FY1 },
    ],
    changed: [],
    relabelled: [],
  },
};

type ApplyBody = { fingerprint: string; edges?: unknown };

async function stubApis(
  page: Page,
  posted: ApplyBody[],
  options: { applyRefusesStale?: boolean } = {},
) {
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  let edges: unknown[] = [];

  await page.route('**/api/layouts', (r) =>
    r.fulfill(json([{ id: 'layout-1', name: 'Westgate Hollow' }])),
  );
  await page.route('**/api/layouts/layout-1/blocks', (r) => r.fulfill(json(BLOCKS)));
  await page.route('**/api/layouts/layout-1/points', (r) => r.fulfill(json(POINTS)));
  await page.route('**/api/layouts/layout-1/sensors', (r) => r.fulfill(json([])));
  await page.route('**/api/layouts/layout-1/locos', (r) => r.fulfill(json([])));
  await page.route('**/api/layouts/layout-1/topology', (r) =>
    r.fulfill(json({ valid: true, violations: [], edgeCount: edges.length })),
  );
  await page.route('**/api/layouts/layout-1/edges', (r) => r.fulfill(json(edges)));

  await page.route('**/api/layouts/layout-1/topology/compile', (r) =>
    r.fulfill(json(REPORT)),
  );

  await page.route(
    '**/api/layouts/layout-1/topology/compile/apply',
    async (route) => {
      posted.push(route.request().postDataJSON() as ApplyBody);

      if (options.applyRefusesStale) {
        return route.fulfill(
          json(
            {
              error: 'The drawing has changed since this compile was produced; review it again',
              expected: FINGERPRINT,
              actual: 'fp-moved',
            },
            409,
          ),
        );
      }

      edges = APPLIED.diff.unchanged;
      return route.fulfill(json(APPLIED));
    },
  );
}

async function openPanel(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Configure' }).click();
  await page.getByRole('button', { name: /^Edges/ }).click();
  await page.getByRole('button', { name: /Compile the graph from the drawing/ }).click();
  await expect(page.getByText(/2 connections in the compiled graph/)).toBeVisible();
}

test('applying posts the reviewed fingerprint and nothing else', async ({ page }) => {
  await installMockWebSocket(page);
  await installMockAuth(page);
  const posted: ApplyBody[] = [];
  await stubApis(page, posted);

  await openPanel(page);

  await expect(page.getByText('Fiddle Yard 1 : east → Siding 1 : west')).toBeVisible();
  // Both directions carry the condition, so this is deliberately not a strict
  // single match.
  await expect(page.getByText('P1 - Fiddle Yard = normal').first()).toBeVisible();

  await page.getByRole('button', { name: 'Apply' }).click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0].fingerprint).toBe(FINGERPRINT);
  // A body carrying rows would be a second authoring path. The server rejects
  // one with a 400; the client must never send one in the first place.
  expect(Object.keys(posted[0])).toEqual(['fingerprint']);

  await expect(page.getByText(/Applied\./)).toBeVisible();
  // The edge table underneath is re-read, not patched — an apply replaces the
  // whole set, so anything less than a re-read is a guess.
  await expect(page.getByText('Fiddle Yard 1:east → Siding 1:west')).toBeVisible();
});

test('gaps are listed above the diff, with the block-level assertion first', async ({ page }) => {
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page, []);

  await openPanel(page);

  // D7: "Siding 2 has no connections" is the sentence that matters; the cell
  // note is evidence for it and must not sit above it.
  const gaps = page.locator('li', { hasText: 'GAP' });
  await expect(gaps.first()).toContainText('Siding 2 is drawn but appears in no connection');
  await expect(gaps.nth(1)).toContainText('The walk stopped at (19, 5)');

  await expect(page.getByText(/automatic mode is refused until these are resolved/)).toBeVisible();
});

test('there is no per-row accept — the whole graph or nothing', async ({ page }) => {
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page, []);

  await openPanel(page);

  // D3 makes a recompile a replace, so accepting one row would author a graph
  // the drawing does not describe. One button, and it applies everything.
  await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Apply' })).toHaveCount(1);
});

test('failure path: the drawing moving between review and apply refuses, and does not retry', async ({
  page,
}) => {
  await installMockWebSocket(page);
  await installMockAuth(page);
  const posted: ApplyBody[] = [];
  await stubApis(page, posted, { applyRefusesStale: true });

  await openPanel(page);
  await page.getByRole('button', { name: 'Apply' }).click();

  await expect(page.getByText(/The drawing changed while you were reviewing/)).toBeVisible();
  await expect(page.getByText(/nothing was written/)).toBeVisible();

  // Exactly one attempt. An automatic re-compile-and-retry would be the client
  // approving a graph no human looked at, which is precisely what the
  // fingerprint guard exists to prevent.
  await expect.poll(() => posted.length).toBe(1);

  // Re-compile is offered instead, as a button the operator presses.
  await expect(page.getByRole('button', { name: 'Re-compile' })).toBeVisible();
});

test('the panel does not compile the drawing until it is opened', async ({ page }) => {
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page, []);

  // Registered *after* `stubApis`, because Playwright matches routes in
  // reverse registration order — the later handler wins, and this one has to.
  let compiles = 0;
  await page.route('**/api/layouts/layout-1/topology/compile', (r) => {
    compiles += 1;
    return r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(REPORT),
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Configure' }).click();
  await page.getByRole('button', { name: /^Edges/ }).click();
  await expect(
    page.getByRole('button', { name: /Compile the graph from the drawing/ }),
  ).toBeVisible();

  // A branch search over the whole grid from every opening is not something to
  // do on every visit to the Edges tab (D-H).
  expect(compiles).toBe(0);

  await page.getByRole('button', { name: /Compile the graph from the drawing/ }).click();
  await expect.poll(() => compiles).toBe(1);
});
