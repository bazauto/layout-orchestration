/**
 * Naming block ends by hand, in the Track Editor (#72's manual override).
 *
 * `BlockEndService` has had create/rename/delete since #72 and nothing in the
 * browser could reach any of them: the editor's only end control was
 * `Ends ⟳`, which regenerates. That left the one case the generator explicitly
 * refuses — two openings of a block facing the same way, reported as
 * `end-label-collision` — with no resolution at all, because a collision emits
 * no end row to rename.
 *
 * The invariant these specs defend is the one the whole feature rests on: **a
 * label an edge already references is never renamed and never deleted.** The
 * backend refuses with a 409 whose body names the offending edges, and the
 * only thing that makes that refusal useful is the message reaching the
 * operator intact rather than as a bare "HTTP 409".
 */

import { expect, test, type Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

const BLOCKS = [
  { id: 'b1', layoutId: 'layout-1', name: 'Engine / Goods Transfer' },
  { id: 'b2', layoutId: 'layout-1', name: 'Goods Shed' },
];

const TILES = [
  { x: 2, y: 3, tileType: 'straight-h', metadata: { blockId: 'b1' } },
  { x: 3, y: 3, tileType: 'straight-h', metadata: { blockId: 'b1' } },
];

/**
 * One generated end that the drawing places, and one pinned end it does not —
 * the state a hand-named collision leaves behind, which the panel has to show
 * without dressing it up as an error.
 */
const BLOCK_ENDS = [
  {
    id: 'end-1',
    layoutId: 'layout-1',
    blockId: 'b1',
    label: 'northwest',
    pinned: false,
    geometry: { x: 2, y: 3, terminated: false },
  },
  {
    id: 'end-2',
    layoutId: 'layout-1',
    blockId: 'b1',
    label: 'southeast',
    pinned: true,
    geometry: null,
  },
];

type Write = { method: string; url: string; body: unknown };

async function stubApis(
  page: Page,
  writes: Write[],
  options: { refuseWrites?: { status: number; body: unknown } } = {},
) {
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill(json([{ id: 'layout-1', name: 'Westgate Hollow' }])),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/blocks', (r) => r.fulfill(json(BLOCKS)));
  await page.route('**://localhost:3000/api/layouts/layout-1/points', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/sensors', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/locos', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/edges', (r) => r.fulfill(json([])));
  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill(json({ valid: true, violations: [], edgeCount: 0 })),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/grid/diagnostics', (r) =>
    r.fulfill(json([])),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/grid', (r) =>
    r.fulfill(
      json(
        TILES.map((t, i) => ({
          id: `t${i}`,
          layoutId: 'layout-1',
          x: t.x,
          y: t.y,
          tileType: t.tileType,
          metadata: JSON.stringify(t.metadata),
        })),
      ),
    ),
  );

  // The collection route: GET the list, POST a new end.
  await page.route('**://localhost:3000/api/layouts/layout-1/block-ends', async (r) => {
    const req = r.request();
    if (req.method() === 'POST') {
      writes.push({ method: 'POST', url: req.url(), body: req.postDataJSON() });
      if (options.refuseWrites) {
        return r.fulfill(json(options.refuseWrites.body, options.refuseWrites.status));
      }
      return r.fulfill(json({ id: 'end-3', layoutId: 'layout-1', ...req.postDataJSON() }, 201));
    }
    return r.fulfill(json(BLOCK_ENDS));
  });

  // The item route: PUT to rename, DELETE to remove.
  await page.route('**://localhost:3000/api/layouts/layout-1/block-ends/*', async (r) => {
    const req = r.request();
    if (req.url().endsWith('/generate')) {
      return r.fulfill(json({ adopted: [], created: [], removed: [], collisions: [] }));
    }
    writes.push({
      method: req.method(),
      url: req.url(),
      body: req.method() === 'PUT' ? req.postDataJSON() : null,
    });
    if (options.refuseWrites) {
      return r.fulfill(json(options.refuseWrites.body, options.refuseWrites.status));
    }
    if (req.method() === 'DELETE') return r.fulfill({ status: 204, body: '' });
    return r.fulfill(json({ id: 'end-1', layoutId: 'layout-1', blockId: 'b1', pinned: true, ...req.postDataJSON() }));
  });
}

async function openEndsPanel(page: Page, writes: Write[]) {
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page, writes);
  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();
  await page.getByRole('button', { name: /Ends ✎/ }).click();
  await expect(page.getByRole('region', { name: 'Block ends' })).toBeVisible();
}

test('lists every end, whether the drawing places it or not', async ({ page }) => {
  const writes: Write[] = [];
  await openEndsPanel(page, writes);

  const placed = page.getByTestId('block-end-end-1');
  await expect(placed).toContainText('northwest');
  await expect(placed).toContainText('generated');
  await expect(placed.getByRole('button', { name: /\(2, 3\)/ })).toBeVisible();

  // A pinned end with no opening is a legitimate work order, not an error —
  // the diagnostics decide whether it has become a problem.
  const unplaced = page.getByTestId('block-end-end-2');
  await expect(unplaced).toContainText('southeast');
  await expect(unplaced).toContainText('pinned');
  await expect(unplaced).toContainText('not placed');
});

test('adds an end by hand, normalised to the label shape the schema stores', async ({ page }) => {
  const writes: Write[] = [];
  await openEndsPanel(page, writes);

  await page.getByLabel('Block for new end').selectOption('b1');
  await page.getByLabel('Label for new end').fill('  Yard-3  ');
  await page.getByRole('button', { name: 'Add end' }).click();

  await expect.poll(() => writes.filter((w) => w.method === 'POST').length).toBe(1);
  // Trimmed and lower-cased client-side to match the server's own
  // normalisation, so the operator sees the value that will be persisted
  // rather than a silent rewrite.
  expect(writes[0].body).toEqual({ blockId: 'b1', label: 'yard-3' });
});

test('renaming an end an edge references is refused, and the refusal names the edges', async ({
  page,
}) => {
  const writes: Write[] = [];
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page, writes, {
    refuseWrites: {
      status: 409,
      body: {
        error: "Block end 'northwest' is referenced by 2 edge(s); edit or remove them first",
        edgeIds: ['edge-1', 'edge-2'],
      },
    },
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();
  await page.getByRole('button', { name: /Ends ✎/ }).click();

  await page.getByTestId('block-end-end-1').getByRole('button', { name: 'Rename' }).click();
  await page.getByLabel('New label for northwest').fill('north');
  await page.getByRole('button', { name: 'Save' }).click();

  // The backend's message, not "HTTP 409". Renaming a referenced end would
  // rewrite the track graph as a side effect of a naming action, and the only
  // way an operator can act on the refusal is by being told which edges.
  await expect(page.getByText(/referenced by 2 edge\(s\)/)).toBeVisible();

  // The row stays in edit mode so the typed label is not lost.
  await expect(page.getByLabel('New label for northwest')).toHaveValue('north');
});

test('saving a generated label unchanged is how you pin it', async ({ page }) => {
  const writes: Write[] = [];
  await openEndsPanel(page, writes);

  await page.getByTestId('block-end-end-1').getByRole('button', { name: 'Rename' }).click();
  await page.getByRole('button', { name: 'Save' }).click();

  const put = writes.find((w) => w.method === 'PUT')!;
  // A no-op rename still pins — it is how an operator says "this generated
  // name is right, stop regenerating it".
  expect(put.body).toEqual({ label: 'northwest' });
});

test('deletes an end', async ({ page }) => {
  const writes: Write[] = [];
  await openEndsPanel(page, writes);

  await page.getByRole('button', { name: 'Delete end southeast' }).click();

  await expect.poll(() => writes.filter((w) => w.method === 'DELETE').length).toBe(1);
  expect(writes.find((w) => w.method === 'DELETE')!.url).toContain('/block-ends/end-2');
});

test('jumping to an end moves the editor cursor to its cell', async ({ page }) => {
  const writes: Write[] = [];
  await openEndsPanel(page, writes);

  // The cursor readout is the observable half of a jump — it is the same
  // string the `aria-live` region announces.
  await expect(page.getByText(/Column 0, row 0/)).toBeVisible();

  await page.getByRole('button', { name: /\(2, 3\)/ }).click();

  // The same jump a diagnostic takes — one implementation, so the two cannot
  // land the operator in different places.
  await expect(page.getByText(/Column 2, row 3/)).toBeVisible();
});
