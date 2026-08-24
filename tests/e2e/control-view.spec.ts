/**
 * The control view (#63, #82, #129, #165) - what it draws, read back off the
 * SVG, and which controls each role is offered over it.
 *
 * The drawing below is Westgate Hollow's Engine / Goods Transfer corner,
 * because that is the shape every one of these tests is about: a 45 degree
 * staircase of a block, reached through two connective cells that belong to no
 * block, with a point *inside* the destination block whose other road leads
 * somewhere the train is not going.
 */
import { expect, test, type Page } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

const BLOCKS = [
  { id: 'es1', layoutId: 'layout-1', name: 'Engine Shed 1' },
  { id: 'es2', layoutId: 'layout-1', name: 'Engine Shed 2' },
  { id: 'egt', layoutId: 'layout-1', name: 'Engine / Goods Transfer' },
  { id: 'gs', layoutId: 'layout-1', name: 'Goods Shed' },
  { id: 'fy1', layoutId: 'layout-1', name: 'Fiddle Yard 1' },
];
const POINTS = [
  { id: 'p5', layoutId: 'layout-1', name: 'P5 - Goods Shed', dccAddress: 5, blockId: null },
  { id: 'p6', layoutId: 'layout-1', name: 'P6 - Engine Shed', dccAddress: 6, blockId: null },
  // #165: a point NO route holds, and deliberately one with no tile on this
  // drawing — the key is built from the roster union the snapshot, so an
  // undrawn point still gets a row. It is here because both of the points
  // above are held by the fixture's route, which makes them the wrong half of
  // the control assertion: they prove buttons are withheld, and nothing proves
  // they are ever offered.
  { id: 'p7', layoutId: 'layout-1', name: 'P7 - Yard Neck', dccAddress: 7, blockId: null },
];
const LOCOS = [
  { address: 3, layoutId: 'layout-1', name: 'Jinty' },
  { address: 4, layoutId: 'layout-1', name: 'Pannier' },
];

type T = { x: number; y: number; tileType: string; rotation?: number; meta?: object };
const TILES: T[] = [
  { x: 13, y: 4, tileType: 'straight-45', rotation: 90, meta: { blockId: 'egt' } },
  { x: 14, y: 4, tileType: 'straight-45', rotation: 270, meta: { blockId: 'egt' } },
  { x: 14, y: 5, tileType: 'straight-45', rotation: 90, meta: { blockId: 'egt' } },
  { x: 15, y: 5, tileType: 'straight-45', rotation: 270, meta: { blockId: 'egt' } },
  { x: 15, y: 6, tileType: 'straight-45', rotation: 90, meta: { blockId: 'egt' } },
  { x: 16, y: 6, tileType: 'straight-45', rotation: 270, meta: { blockId: 'egt' } },
  { x: 16, y: 7, tileType: 'straight-45', rotation: 90, meta: { blockId: 'egt' } },
  { x: 17, y: 7, tileType: 'straight-45', rotation: 270, meta: { blockId: 'egt' } },
  { x: 17, y: 8, tileType: 'straight-45', rotation: 90, meta: { blockId: 'egt' } },
  {
    x: 18,
    y: 8,
    tileType: 'point-right',
    meta: {
      blockId: 'egt',
      pointId: 'p5',
      pointRoads: [
        { when: [{ pointId: 'p5', position: 'normal' }], legs: ['w', 'e'] },
        { when: [{ pointId: 'p5', position: 'reverse' }], legs: ['w', 's'] },
      ],
    },
  },
  { x: 18, y: 9, tileType: 'straight-45', rotation: 90, meta: { blockId: 'egt' } },
  { x: 19, y: 9, tileType: 'straight-45', rotation: 270, meta: { blockId: 'egt' } },
  { x: 19, y: 10, tileType: 'straight-45', rotation: 90, meta: { blockId: 'egt' } },
  { x: 19, y: 7, tileType: 'straight-45', rotation: 180, meta: { trackRole: 'decorative' } },
  {
    x: 19,
    y: 8,
    tileType: 'point-left',
    meta: {
      trackRole: 'decorative',
      pointId: 'p6',
      pointRoads: [
        { when: [{ pointId: 'p6', position: 'normal' }], legs: ['w', 'e'] },
        { when: [{ pointId: 'p6', position: 'reverse' }], legs: ['w', 'n'] },
      ],
    },
  },
  { x: 20, y: 10, tileType: 'straight-h', meta: { blockId: 'gs' } },
  { x: 21, y: 10, tileType: 'straight-h', meta: { blockId: 'gs' } },
  { x: 22, y: 10, tileType: 'straight-h', meta: { blockId: 'gs' } },
  { x: 23, y: 10, tileType: 'buffer', meta: { blockId: 'gs' } },
  // #76: a beam placed on Fiddle Yard 1 — plain track, away from every
  // point/route fixture above, so its title is unambiguous in the readback.
  {
    x: 12,
    y: 3,
    tileType: 'straight-h',
    meta: { blockId: 'fy1', annotations: [{ entityType: 'sensor', entityId: 'sBeam' }] },
  },
  { x: 11, y: 3, tileType: 'straight-h', meta: { blockId: 'fy1' } },
  { x: 10, y: 3, tileType: 'straight-h', meta: { blockId: 'fy1' } },
  { x: 9, y: 3, tileType: 'buffer', rotation: 180, meta: { blockId: 'fy1' } },
];
for (let x = 20; x <= 25; x++)
  TILES.push({ x, y: 7, tileType: 'straight-h', meta: { blockId: 'es1' } });
TILES.push({ x: 26, y: 7, tileType: 'buffer', meta: { blockId: 'es1' } });
for (let x = 20; x <= 25; x++)
  TILES.push({ x, y: 8, tileType: 'straight-h', meta: { blockId: 'es2' } });
TILES.push({ x: 26, y: 8, tileType: 'buffer', meta: { blockId: 'es2' } });

const ROUTE = {
  id: 'r1',
  layoutId: 'layout-1',
  locoAddress: 3,
  authority: 'manual',
  status: 'active',
  path: [
    { edgeId: null, blockId: 'es1', entryEnd: null, exitEnd: 'west' },
    { edgeId: 'e1', blockId: 'egt', entryEnd: 'southeast-1', exitEnd: null },
  ],
  holds: [
    {
      kind: 'point',
      targetId: 'p5',
      requiredPosition: 'normal',
      releaseAfterIndex: 1,
      released: false,
    },
    {
      kind: 'point',
      targetId: 'p6',
      requiredPosition: 'reverse',
      releaseAfterIndex: 1,
      released: false,
    },
  ],
  confirmedIndex: 0,
  reason: null,
  createdAt: '',
  updatedAt: '',
};

const SNAPSHOT = {
  systemStatus: 'online',
  systemMode: 'manual',
  safeStopReason: null,
  // #149. Present because the real snapshot always carries it — `dccLink` is
  // not optional on `StateSnapshot`, and the view reads `mainPowerOn` off it to
  // draw the track-power badge. A fixture missing it is a fixture that does not
  // resemble the wire.
  dccLink: {
    responsive: true,
    reason: null,
    fault: null,
    mainPowerOn: true,
    progPowerOn: true,
    identity: null,
    restartCount: 0,
    lastResponseAt: null,
  },
  blocks: {
    es1: {
      blockId: 'es1',
      layoutId: 'layout-1',
      occupancy: 'occupied',
      locoAddress: 3,
      lockedByRoute: 'r1',
    },
    es2: {
      blockId: 'es2',
      layoutId: 'layout-1',
      occupancy: 'clear',
      locoAddress: null,
      lockedByRoute: null,
    },
    egt: {
      blockId: 'egt',
      layoutId: 'layout-1',
      occupancy: 'clear',
      locoAddress: null,
      lockedByRoute: 'r1',
    },
    gs: {
      blockId: 'gs',
      layoutId: 'layout-1',
      occupancy: 'unknown',
      locoAddress: null,
      lockedByRoute: null,
    },
    fy1: {
      blockId: 'fy1',
      layoutId: 'layout-1',
      occupancy: 'clear',
      locoAddress: null,
      lockedByRoute: null,
    },
  },
  points: {
    p5: {
      pointId: 'p5',
      layoutId: 'layout-1',
      commandedPosition: 'normal',
      confirmedPosition: 'normal',
      confirmation: 'confirmed',
      positionFeedback: 'none',
      awaitingSince: null,
      lastReadingAt: null,
      locked: true,
      lockedByRoute: 'r1',
      lastUpdated: '',
    },
    p6: {
      pointId: 'p6',
      layoutId: 'layout-1',
      commandedPosition: 'reverse',
      confirmedPosition: 'reverse',
      confirmation: 'confirmed',
      positionFeedback: 'none',
      awaitingSince: null,
      lastReadingAt: null,
      locked: true,
      lockedByRoute: 'r1',
      lastUpdated: '',
    },
    p7: {
      pointId: 'p7',
      layoutId: 'layout-1',
      commandedPosition: 'normal',
      confirmedPosition: 'normal',
      confirmation: 'confirmed',
      positionFeedback: 'none',
      awaitingSince: null,
      lastReadingAt: null,
      locked: false,
      lockedByRoute: null,
      lastUpdated: '',
    },
  },
  locos: {},
  routes: { r1: ROUTE },
  // #76: one observation, on the beam placed at (12,3) / Fiddle Yard 1 above.
  sensors: {
    sBeam: {
      sensorId: 'sBeam',
      blockId: 'fy1',
      type: 'block_detection',
      lastReading: 'occupied',
      trusted: true,
      inService: true,
      faulted: false,
      lastReadingAt: '2026-08-08T00:00:00.000Z',
      source: 'live',
    },
  },
  sensorFaults: [],
  pointFaults: [],
  routeFaults: [],
  brakingFaults: [],
  automationRuns: [],
};

const EDGES = [
  {
    id: 'e1',
    layoutId: 'layout-1',
    fromBlockId: 'es1',
    fromEnd: 'west',
    toBlockId: 'egt',
    toEnd: 'southeast-1',
    pointConditions: [],
  },
];

const COMPILE = {
  report: {
    fingerprint: 'f',
    edges: [
      {
        fromBlockId: 'es1',
        fromEnd: 'west',
        toBlockId: 'egt',
        toEnd: 'southeast-1',
        pointConditions: [],
        via: [
          { x: 19, y: 7 },
          { x: 19, y: 8 },
        ],
        crossesDiamond: false,
      },
    ],
    gaps: [],
    components: [],
  },
  status: { state: 'current', fingerprint: 'f', compiledAt: null },
  diff: { added: [], removed: [], unchanged: [], changed: [], relabelled: [] },
};

async function stub(page: Page) {
  const json = (body: unknown) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('**/api/layouts', (r) =>
    r.fulfill(json([{ id: 'layout-1', name: 'Westgate Hollow' }])),
  );
  await page.route('**/api/layouts/layout-1/grid', (r) =>
    r.fulfill(
      json(
        TILES.map((t, i) => ({
          id: `t${i}`,
          layoutId: 'layout-1',
          x: t.x,
          y: t.y,
          tileType: t.tileType,
          metadata: JSON.stringify({ rotation: t.rotation ?? 0, ...(t.meta ?? {}) }),
        })),
      ),
    ),
  );
  await page.route('**/api/layouts/layout-1/blocks', (r) => r.fulfill(json(BLOCKS)));
  await page.route('**/api/layouts/layout-1/points', (r) => r.fulfill(json(POINTS)));
  await page.route('**/api/layouts/layout-1/sensors', (r) =>
    r.fulfill(
      json([
        {
          id: 'sBeam',
          layoutId: 'layout-1',
          name: 'Beam 1',
          type: 'block_detection',
          blockId: 'fy1',
          mqttTopic: 'layout/layout-1/sensor/sBeam/reading',
          inService: true,
        },
      ]),
    ),
  );
  await page.route('**/api/layouts/layout-1/locos', (r) => r.fulfill(json(LOCOS)));
  await page.route('**/api/layouts/layout-1/edges', (r) => r.fulfill(json(EDGES)));
  await page.route('**/api/layouts/layout-1/topology/compile', (r) => r.fulfill(json(COMPILE)));
  await page.route('**/api/layouts/layout-1/grid/openings', (r) => r.fulfill(json([])));
  await page.route('**/api/layouts/layout-1/grid/diagnostics', (r) => r.fulfill(json([])));
  await page.route('**/api/layouts/layout-1/topology', (r) =>
    r.fulfill(json({ valid: true, violations: [], edgeCount: 1 })),
  );
  await page.route('**/api/capabilities', (r) => r.fulfill(json({ sensorSimulation: false })));
}

/**
 * Everything the monitor draws, read back off the rendered SVG in one pass.
 *
 * A single `evaluate` rather than a locator per assertion: the diagram is one
 * picture and the interesting facts are relationships between its layers —
 * which cells carry a route line, and at what strength the track under them is
 * drawn. Pulling them out together is what lets a test say "the road lights
 * and the spur does not" instead of counting elements.
 */
async function readDiagram(page: Page) {
  return page.evaluate(() => {
    const svg = document.querySelector('svg[role="application"]')!;
    const cellOf = (g: Element) => {
      const m = /^translate\((\d+),(\d+)\)$/.exec(g.getAttribute('transform') ?? '');
      return m ? `${Number(m[1]) / 40},${Number(m[2]) / 40}` : null;
    };

    const routeCells: string[] = [];
    const baseOpacity: Record<string, string> = {};
    // #76: every `<title>` on a sensor annotation, per cell — the mark's own
    // channel is not colour, but its `<title>` is what a test (and a screen
    // reader/tooltip) can read back without inspecting fill/stroke directly.
    const sensorTitles: Record<string, string[]> = {};

    for (const g of Array.from(svg.querySelectorAll('g'))) {
      const cell = cellOf(g);
      if (!cell) continue;

      const titles = Array.from(g.querySelectorAll('title')).map((t) => t.textContent ?? '');
      if (titles.some((t) => t.startsWith('route '))) routeCells.push(cell);

      const sTitles = titles.filter((t) => t.startsWith('sensor '));
      if (sTitles.length) sensorTitles[cell] = sTitles;

      // The track layer's rotation group — the one wrapping the tile's paths.
      const rotated = g.querySelector(':scope > g[transform^="rotate"]');
      if (rotated?.querySelector('path'))
        baseOpacity[cell] = rotated.getAttribute('opacity') ?? '1';
    }

    const labels = Array.from(svg.querySelectorAll('text')).map((t) => ({
      text: t.textContent ?? '',
      transform: t.getAttribute('transform') ?? '',
    }));

    return { routeCells: [...new Set(routeCells)].sort(), baseOpacity, labels, sensorTitles };
  });
}

async function openControl(page: Page, role: 'admin' | 'operator' | 'monitor' = 'admin') {
  await page.setViewportSize({ width: 1500, height: 900 });
  await installMockWebSocket(page, { snapshot: SNAPSHOT });
  await installMockAuth(page, { role });
  await stub(page);
  await page.goto('/');
  // One view, two honest names (#165): a `monitor` session may only watch, so
  // its tab keeps the old label rather than promising a control it does not get.
  await page.getByRole('button', { name: role === 'monitor' ? 'Monitor' : 'Control' }).click();
  await expect(page.getByRole('list', { name: 'Routes' })).toBeVisible();
}

/**
 * The shape the operator reported: a route from Engine Shed 1 into Engine /
 * Goods Transfer, whose destination block contains the point to the Goods
 * Shed. The road runs in through that point's `normal` leg, so the three tiles
 * beyond its `reverse` leg are track the train will not run over — and they
 * used to be lit, because they belong to a block the route holds.
 */
test('the route line follows the road, and stops at the point it holds shut', async ({ page }) => {
  await openControl(page);
  const { routeCells } = await readDiagram(page);

  // Engine Shed 1, the two connective cells, and the staircase up to its far end.
  expect(routeCells).toEqual([
    '13,4',
    '14,4',
    '14,5',
    '15,5',
    '15,6',
    '16,6',
    '16,7',
    '17,7',
    '17,8',
    '18,8',
    '19,7',
    '19,8',
    '20,7',
    '21,7',
    '22,7',
    '23,7',
    '24,7',
    '25,7',
    '26,7',
  ]);

  // The road to the Goods Shed, on the far side of P5. Held block, not the road.
  for (const cell of ['18,9', '19,9', '19,10']) expect(routeCells).not.toContain(cell);
});

/**
 * A point drawn with both roads solid says the blades are making a junction
 * they physically cannot. The live overlay redraws the set road at full
 * strength over this, so what is left faint is the road that is *not* set.
 */
test('a point’s own roads are drawn faint under the live overlay', async ({ page }) => {
  await openControl(page);
  const { baseOpacity } = await readDiagram(page);

  expect(baseOpacity['18,8']).toBe('0.3'); // P5
  expect(baseOpacity['19,8']).toBe('0.3'); // P6

  // Plain track either side of them is not touched.
  expect(baseOpacity['17,8']).toBe('1');
  expect(baseOpacity['20,7']).toBe('1');
});

/**
 * The editor draws decorative track faint and dashed, because the question
 * there is whether the tile is finished. The question here is where a train
 * can go, and a route crossing a feeder that belongs to no block looked like a
 * broken road.
 */
test('decorative track is drawn like any other track', async ({ page }) => {
  await openControl(page);
  const { baseOpacity } = await readDiagram(page);

  // (19,7) is decorative and carries the route between the two blocks.
  expect(baseOpacity['19,7']).toBe('1');
});

test('a held point wears the lock beside its name, not in a corner', async ({ page }) => {
  await openControl(page);
  const { labels } = await readDiagram(page);

  const p5 = labels.find((l) => l.text.startsWith('P5'));
  expect(p5?.text).toBe('P5 \u{1F512}');
});

test('a block label lies along diagonal track', async ({ page }) => {
  await openControl(page);
  const { labels } = await readDiagram(page);

  const egt = labels.find((l) => l.text.startsWith('Engine / Goods Transfer'));
  expect(egt?.transform).toMatch(/^rotate\(45,/);

  // Engine Shed 1 is a horizontal run, and stays upright.
  const es1 = labels.find((l) => l.text.startsWith('Engine Shed 1'));
  expect(es1?.transform).toBe('');
});

/**
 * #76: the sensor layer is a diagnostic overlay an operator reaches for, not
 * one competing with derived occupancy for attention by default — and once
 * on, it reads the beam's own state, not the block's.
 */
test('the sensor layer is off by default; toggling it reveals the beam state as a title', async ({
  page,
}) => {
  await openControl(page);

  const before = await readDiagram(page);
  expect(Object.keys(before.sensorTitles)).toEqual([]);

  await page.getByRole('checkbox', { name: 'Sensors' }).check();

  const after = await readDiagram(page);
  const titles = Object.values(after.sensorTitles).flat();
  expect(titles).toContain('sensor Beam 1: occupied');
});

/**
 * #165 — the control plane, in the browser.
 *
 * The command semantics (what the slider sends, when a card is armed, what a
 * point button commands) are covered where they can be asserted properly, in
 * the component tests. This mock socket's `send` is deliberately inert, and
 * the helper says why: making it echo would prove nothing about the real
 * server. So what is asserted here is the part only a browser can answer —
 * that the controls appear on the mimic, over the drawing, for the roles that
 * may use them and for no others.
 */
test('an operator can open a throttle over the drawing, and close it again', async ({ page }) => {
  await openControl(page, 'operator');

  await expect(page.getByLabel('Throttle for Jinty', { exact: true })).toHaveCount(0);

  await page.getByLabel('Add a throttle').selectOption({ label: 'Jinty' });

  const card = page.getByLabel('Throttle for Jinty', { exact: true });
  await expect(card).toBeVisible();
  await expect(card.getByRole('slider', { name: /Speed for Jinty/ })).toBeVisible();

  // Several at once is the case the Operate screen's single form cannot serve.
  await page.getByLabel('Add a throttle').selectOption({ label: 'Pannier' });
  await expect(page.getByLabel('Throttle for Pannier', { exact: true })).toBeVisible();
  await expect(card).toBeVisible();

  await card.getByRole('button', { name: 'Close the throttle for Jinty' }).click();
  await expect(card).toHaveCount(0);
  await expect(page.getByLabel('Throttle for Pannier', { exact: true })).toBeVisible();
});

test('an open throttle survives a reload', async ({ page }) => {
  await openControl(page, 'operator');
  await page.getByLabel('Add a throttle').selectOption({ label: 'Jinty' });
  await expect(page.getByLabel('Throttle for Jinty', { exact: true })).toBeVisible();

  await page.reload();
  await page.getByRole('button', { name: 'Control' }).click();

  // An operator's desk is a preference, not session state — rebuilding it
  // after every reload is the friction #165 exists to remove.
  await expect(page.getByLabel('Throttle for Jinty', { exact: true })).toBeVisible();
});

test('a point is set from its row in the key, and a held point offers no buttons', async ({
  page,
}) => {
  await openControl(page, 'operator');

  // P7 is free in this snapshot, so both positions are offered.
  await expect(page.getByRole('button', { name: /Set P7 - Yard Neck to reverse/ })).toBeVisible();

  // P5 is held by route r1, which is why it has no buttons at all: forcing it
  // would cancel the route holding it, and that belongs on the Routes panel.
  await expect(page.getByRole('button', { name: /Set P5 - Goods Shed/ })).toHaveCount(0);
});

test('a monitor gets the same mimic with none of the controls', async ({ page }) => {
  await openControl(page, 'monitor');

  // Everything it reads, unchanged.
  await expect(page.getByRole('list', { name: 'Routes' })).toBeVisible();
  await expect(page.getByLabel('Point key', { exact: true })).toBeVisible();

  // #149: it reads track power like everything else. Situational awareness is
  // exactly what this role is for, and "the rails are dead" is the most
  // situational fact there is.
  await expect(page.getByText(/Track power on/)).toBeVisible();

  // Nothing it could press. Absent, not disabled (#61's argument): a greyed
  // control still poses a question whose honest answer is "you may not".
  await expect(page.getByLabel('Add a throttle')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Set P7 - Yard Neck/ })).toHaveCount(0);
  await expect(page.getByRole('columnheader', { name: 'Set' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch track power off' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch track power on' })).toHaveCount(0);
});

test('an operator can switch track power off, and the state follows what the station reports (#149)', async ({
  page,
}) => {
  let requested: unknown = null;
  await page.route('**/api/layouts/layout-1/dcc-link/power', async (r) => {
    requested = JSON.parse(r.request().postData() ?? 'null');
    // The station answers, and its answer is what the view believes — the reply
    // is the link view, not an acknowledgement (`docs/dcc-link.md` D12).
    await r.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...SNAPSHOT.dccLink, mainPowerOn: false, progPowerOn: false }),
    });
  });

  await openControl(page, 'operator');

  // Live to begin with, so "on" is the disabled one: the button for the current
  // state stays put rather than disappearing under the pointer.
  await expect(page.getByText(/Track power on/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch track power on' })).toBeDisabled();

  await page.getByRole('button', { name: 'Switch track power off' }).click();

  expect(requested).toEqual({ on: false });
});
