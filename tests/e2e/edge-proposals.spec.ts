/**
 * The edge-proposal review panel (#78) on the Configure → Edges tab.
 *
 * What these specs defend is the property the whole feature rests on:
 * **accepting a proposal is an ordinary `POST .../edges` and nothing else.**
 * There is no accept endpoint on the server, so the only way a bypass could
 * appear is if the browser grew one — which is why the assertions below are on
 * the request bodies rather than on the rendered table.
 *
 * The second thing they defend is that the panel refuses to post what it
 * cannot post. A proposal whose opening has no `block_ends` row carries a
 * `null` end, and posting that is a 400 the operator can do nothing about;
 * `isAcceptable` narrows it away, and this asserts there is no button.
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

/**
 * One acceptable proposal, one with an unnamed end, one already authored, and
 * one note — the four states the panel has to tell apart on a real
 * part-authored layout.
 */
const REPORT = {
  proposals: [
    {
      pairId: 'pair-1',
      fromBlockId: 'b-fy1',
      fromEnd: 'east',
      toBlockId: 'b-s1',
      toEnd: 'west',
      pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
      lengthMm: null,
      via: [
        { x: 12, y: 3 },
        { x: 13, y: 3 },
      ],
      crossesDiamond: false,
      status: 'new',
    },
    {
      pairId: 'pair-1',
      fromBlockId: 'b-s1',
      fromEnd: 'west',
      toBlockId: 'b-fy1',
      toEnd: 'east',
      pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
      lengthMm: null,
      via: [
        { x: 13, y: 3 },
        { x: 12, y: 3 },
      ],
      crossesDiamond: false,
      status: 'new',
    },
    {
      pairId: 'pair-2',
      fromBlockId: 'b-fy1',
      fromEnd: 'east',
      toBlockId: 'b-s2',
      toEnd: null,
      pointConditions: [],
      lengthMm: null,
      via: [],
      crossesDiamond: true,
      status: 'needs-end-label',
    },
  ],
  notes: [{ kind: 'blocked-by-unclassified', at: { x: 19, y: 5 } }],
};

type EdgeBody = {
  fromBlockId: string;
  fromEnd: string;
  toBlockId: string;
  toEnd: string;
  pointConditions: Array<{ pointId: string; requiredPosition: string }>;
  lengthMm?: number | null;
};

async function stubApis(
  page: Page,
  posted: EdgeBody[],
  options: { refuseFirstPost?: boolean } = {},
) {
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  const edges: unknown[] = [];
  let nextId = 1;
  let refusedYet = false;

  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill(json([{ id: 'layout-1', name: 'Westgate Hollow' }])),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/blocks', (r) => r.fulfill(json(BLOCKS)));
  await page.route('**://localhost:3000/api/layouts/layout-1/points', (r) => r.fulfill(json(POINTS)));
  await page.route('**://localhost:3000/api/layouts/layout-1/sensors', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/locos', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/block-ends', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill(json({ valid: true, violations: [], edgeCount: edges.length })),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/grid/edge-proposals', (r) =>
    r.fulfill(json(REPORT)),
  );

  await page.route('**://localhost:3000/api/layouts/layout-1/edges', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill(json(edges));
    if (req.method() === 'POST') {
      const body = req.postDataJSON() as EdgeBody;
      posted.push(body);
      if (options.refuseFirstPost && !refusedYet) {
        refusedYet = true;
        return route.fulfill(
          json(
            {
              error: 'Topology invalid: 1 violation',
              violations: [{ kind: 'self-loop', edgeId: '__pending__', blockId: body.fromBlockId }],
            },
            422,
          ),
        );
      }
      const created = { id: `edge-${nextId++}`, layoutId: 'layout-1', ...body };
      edges.push(created);
      return route.fulfill(json(created, 201));
    }
    return route.continue();
  });
}

async function openPanel(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Configure' }).click();
  await page.getByRole('button', { name: /^Edges/ }).click();
  await page.getByRole('button', { name: /Propose edges from the drawing/ }).click();
  await expect(page.getByText(/3 candidates/)).toBeVisible();
}

test('accepting a proposal posts it as an ordinary edge, with no length', async ({ page }) => {
  await installMockWebSocket(page);
  await installMockAuth(page);
  const posted: EdgeBody[] = [];
  await stubApis(page, posted);

  await openPanel(page);

  await expect(page.getByText('Fiddle Yard 1 : east → Siding 1 : west')).toBeVisible();
  // Both directions of the pair carry the condition, so this is deliberately
  // not a strict single match.
  await expect(page.getByText('P1 - Fiddle Yard = normal').first()).toBeVisible();

  await page
    .getByTestId('proposal-b-fy1-b-s1')
    .getByRole('button', { name: 'Accept' })
    .click();

  await expect.poll(() => posted.length).toBe(1);
  expect(posted[0]).toEqual({
    fromBlockId: 'b-fy1',
    fromEnd: 'east',
    toBlockId: 'b-s1',
    toEnd: 'west',
    pointConditions: [{ pointId: 'p1', requiredPosition: 'normal' }],
  });
  // Geometry can never supply a distance (`docs/braking.md` B4), so the field
  // is omitted rather than sent as an explicit null.
  expect('lengthMm' in posted[0]).toBe(false);

  // The edge lands in the table below, which is the same list a hand-authored
  // one lands in — there is only one write path.
  await expect(page.getByText('Fiddle Yard 1:east → Siding 1:west')).toBeVisible();
});

test('a proposal whose opening has no block end offers no accept button', async ({ page }) => {
  await installMockWebSocket(page);
  await installMockAuth(page);
  const posted: EdgeBody[] = [];
  await stubApis(page, posted);

  await openPanel(page);

  const row = page.getByTestId('proposal-b-fy1-b-s2');
  await expect(row).toContainText('NO END');
  await expect(row.getByRole('button', { name: 'Accept' })).toHaveCount(0);

  // #26's blind spot travels with the proposal rather than being discovered
  // after the edge is authored.
  await expect(row).toContainText('crosses a diamond');
});

test('a note names the cell that stopped the walk', async ({ page }) => {
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page, []);

  await openPanel(page);

  // Under-proposing silently is indistinguishable from "there is no
  // connection here" — the note is the whole difference.
  await expect(page.getByText(/The walk stopped at \(19, 5\)/)).toBeVisible();
});

test('accept-all continues past a refusal and reports both counts', async ({ page }) => {
  await installMockWebSocket(page);
  await installMockAuth(page);
  const posted: EdgeBody[] = [];
  await stubApis(page, posted, { refuseFirstPost: true });

  await openPanel(page);

  await page.getByRole('button', { name: /Accept all 2 new/ }).click();

  // Both were attempted. Stopping at the first refusal would leave a partly
  // applied batch with no indication of which rows were even tried.
  await expect.poll(() => posted.length).toBe(2);
  await expect(page.getByText(/1 authored, 1 refused/)).toBeVisible();

  // The refusal is attached to the row it belongs to, not to the panel.
  await expect(page.getByTestId('proposal-b-fy1-b-s1')).toContainText('Topology invalid');
});

test('the panel does not walk the drawing until it is opened', async ({ page }) => {
  await installMockWebSocket(page);
  await installMockAuth(page);

  await stubApis(page, []);

  // Registered *after* `stubApis`, because Playwright matches routes in
  // reverse registration order — the later handler wins, and this one has to.
  let walks = 0;
  await page.route('**://localhost:3000/api/layouts/layout-1/grid/edge-proposals', (r) => {
    walks += 1;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REPORT) });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Configure' }).click();
  await page.getByRole('button', { name: /^Edges/ }).click();
  await expect(page.getByPlaceholder('From end')).toBeVisible();

  // A port walk over the whole grid from every opening is not something to do
  // on every visit to the Edges tab.
  expect(walks).toBe(0);

  await page.getByRole('button', { name: /Propose edges from the drawing/ }).click();
  await expect.poll(() => walks).toBe(1);
});
