/**
 * #94 — the Track Editor grid takes keyboard focus, tells you where the
 * cursor is, and lets a diagnostics-panel finding move you there.
 *
 * Before this issue there was no way to navigate the grid, paint a tile, or
 * even find out what cell a diagnostic referred to without a mouse — the
 * WCAG 2.1.1 failure the issue describes. These specs are the DOM-level
 * proof of the three layers: the canvas is actually focusable and actually
 * reachable by keyboard, a keypress reaches the same write path a click
 * does, and a diagnostic line is a real button rather than static prose.
 *
 * Modelled on `tests/e2e/track-editor-labels.spec.ts` for the stubbing
 * shape.
 */

import { expect, test, type Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

/** Every write the editor issued, so a keyboard paint's actual payload can be asserted. */
type Write = { method: string; url: string; body: unknown };

const DIAGNOSTICS = [
  { kind: 'unclassified-tile', severity: 'info', at: { x: 5, y: 7 } },
];

async function stubApis(page: Page, writes: Write[], deletes: { x: number; y: number }[] = []) {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });

  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill(json([{ id: 'layout-1', name: 'Westgate Hollow' }])),
  );

  await page.route('**://localhost:3000/api/layouts/layout-1/grid', async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      writes.push({ method: 'PUT', url: req.url(), body: req.postDataJSON() });
      return route.fulfill(json({ id: 'new', layoutId: 'layout-1', ...req.postDataJSON() }));
    }
    // No seed tiles: an empty grid is enough to exercise the cursor and the
    // write path, and keeps the coordinate maths in these tests easy to
    // predict — every paint lands on an otherwise-empty cell.
    return route.fulfill(json([]));
  });

  await page.route('**://localhost:3000/api/layouts/layout-1/grid/tile**', (route) => {
    const url = new URL(route.request().url());
    deletes.push({
      x: Number(url.searchParams.get('x')),
      y: Number(url.searchParams.get('y')),
    });
    return route.fulfill({ status: 204, body: '' });
  });

  await page.route('**://localhost:3000/api/layouts/layout-1/grid/diagnostics', (r) =>
    r.fulfill(json(DIAGNOSTICS)),
  );

  await page.route('**://localhost:3000/api/layouts/layout-1/block-ends', (r) => r.fulfill(json([])));

  for (const e of ['blocks', 'points', 'sensors', 'locos', 'edges']) {
    await page.route(`**://localhost:3000/api/layouts/layout-1/${e}`, (r) => r.fulfill(json([])));
  }
  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill(json({ valid: true, violations: [], edgeCount: 0 })),
  );
}

async function openEditor(page: Page) {
  const writes: Write[] = [];
  const deletes: { x: number; y: number }[] = [];
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page, writes, deletes);
  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();
  await expect(page.getByText(/0 tiles/)).toBeVisible();
  return { writes, deletes };
}

/** The visible cursor readout — the same string the `aria-live` region announces. */
const readout = (page: Page) => page.getByText(/^Column \d+, row \d+\./);

test('the canvas takes keyboard focus', async ({ page }) => {
  await openEditor(page);

  const canvas = page.getByRole('application', { name: /Track diagram editor grid/ });
  await expect(canvas).toBeVisible();

  // `tabIndex={0}` plus `role="application"` (#94) is what makes this
  // possible at all — before this issue the `<svg>` had no `tabIndex` and
  // could not be focused by any keyboard path.
  await canvas.focus();
  await expect(canvas).toBeFocused();
});

test('arrow keys move the cursor and the readout follows', async ({ page }) => {
  await openEditor(page);
  const canvas = page.getByRole('application', { name: /Track diagram editor grid/ });
  await canvas.focus();

  // Starts at the origin.
  await expect(readout(page)).toHaveText(/^Column 0, row 0\./);

  await canvas.press('ArrowRight');
  await canvas.press('ArrowRight');
  await canvas.press('ArrowDown');

  // One string is both the visible readout and the aria-live announcement
  // (#94) — asserting the visible text is asserting the announcement too,
  // since `describeCursor` builds only one of them.
  await expect(readout(page)).toHaveText(/^Column 2, row 1\./);
});

test('Enter paints at the cursor without a mouse', async ({ page }) => {
  const { writes } = await openEditor(page);
  const canvas = page.getByRole('application', { name: /Track diagram editor grid/ });
  await canvas.focus();

  await canvas.press('ArrowRight');
  await canvas.press('ArrowRight');
  await canvas.press('ArrowRight');
  await canvas.press('ArrowDown');

  await canvas.press('Enter');

  // The keyboard path (`paintAt` called from `onCanvasKeyDown`) reaches
  // exactly the same PUT the mouse path sends — no second, parallel write
  // mechanism for the keyboard case.
  await expect.poll(() => writes.length).toBeGreaterThan(0);
  const write = writes[0];
  expect(write.method).toBe('PUT');
  expect((write.body as { x: number; y: number }).x).toBe(3);
  expect((write.body as { x: number; y: number }).y).toBe(1);
});

test('Delete erases at the cursor without a mouse', async ({ page }) => {
  const { deletes } = await openEditor(page);
  const canvas = page.getByRole('application', { name: /Track diagram editor grid/ });
  await canvas.focus();

  await canvas.press('ArrowDown');
  await canvas.press('Delete');

  // Erasing an empty cell still issues the DELETE — the point of this test
  // is that the keypress reaches the write path at all, matching what a
  // right-click on the same empty cell already does.
  await expect.poll(() => deletes.length).toBeGreaterThan(0);
  expect(deletes[0]).toEqual({ x: 0, y: 1 });
});

test('Escape returns focus to the toolbar', async ({ page }) => {
  await openEditor(page);
  const canvas = page.getByRole('application', { name: /Track diagram editor grid/ });
  await canvas.focus();
  await expect(canvas).toBeFocused();

  await canvas.press('Escape');

  // `role="application"` takes the arrow keys away from the screen reader's
  // own navigation, so there has to be an obvious way out (#94) — Escape is
  // that way out, and it must actually move focus, not just be handled.
  await expect(canvas).not.toBeFocused();
});

test('a diagnostic line click moves the cursor to its cell', async ({ page }) => {
  await openEditor(page);

  await page.getByTitle(/disagree about/).click();
  const panel = page.getByRole('region', { name: 'Grid diagnostics' });
  const line = panel.getByRole('button', { name: /neither tagged to a block nor marked decorative/ });
  await expect(line).toBeVisible();

  await line.click();

  // (5, 7) is the coordinate the stubbed `unclassified-tile` diagnostic
  // carries — the cursor landing there is the "jump to" button doing its
  // job, read structurally via `diagnosticCoordinate` rather than parsed
  // back out of the prose `describeDiagnostic` renders.
  await expect(readout(page)).toHaveText(/^Column 5, row 7\./);
});

test('a diagnostic with no coordinate renders as plain text, not a button', async ({ page }) => {
  // `buffer-contradicted-by-edge` names a block opening, not a cell — #94
  // requires this NOT become a button that would have nowhere to jump to. An
  // opening spans boundaries and its label sits wherever the compiler put it,
  // so any coordinate here would be arbitrary.
  //
  // Used to be `block-without-detection`, which named a block and is now a
  // compile gap rather than a diagnostic (#103 PR 7). The property under test
  // is the same one; only the last coordinate-less kind changed.
  const writes: Write[] = [];
  await installMockWebSocket(page);
  await installMockAuth(page);
  await stubApis(page, writes);
  await page.route('**://localhost:3000/api/layouts/layout-1/grid/diagnostics', (r) =>
    r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          kind: 'buffer-contradicted-by-edge',
          severity: 'warning',
          blockId: 'b1',
          label: 'east',
          edgeIds: ['edge-1'],
        },
      ]),
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Track Editor' }).click();
  await expect(page.getByText(/0 tiles/)).toBeVisible();

  await page.getByTitle(/disagree about/).click();
  const panel = page.getByRole('region', { name: 'Grid diagnostics' });
  await expect(panel).toContainText('has a buffer stop');
  await expect(panel.getByRole('button')).toHaveCount(0);
});
