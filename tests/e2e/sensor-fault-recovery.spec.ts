import { expect, test, Page, Route } from '@playwright/test';
import { installMockAuth, installMockWebSocket } from './helpers';

/**
 * Covers the frontend half of #34 (sensor-fault recovery):
 *  - the Sensors tab's new "In service" checkbox issues a PUT with
 *    `{ inService: false }` — the admin-only, persistent "out of service"
 *    path authored from Configure (`docs/sensor-fault-recovery.md` D5).
 *  - `SensorFaultBanner` renders nothing when `sensorFaults` is empty —
 *    `StateSnapshot.sensorFaults` starts `[]` and no `SENSOR_FAULTS` frame
 *    has arrived over the mocked WebSocket.
 *
 * The backend half (arming, retained-replay exclusion, acknowledge, the
 * occupancy derivation) is scenario-tested in
 * `packages/backend/tests/scenario/sensor-fault-recovery.scenario.test.ts`.
 * This suite does not run a real backend WS, so it cannot exercise a
 * `SENSOR_FAULTS` frame arriving — same constraint `edge-authoring.spec.ts`
 * and `config-mutation-errors.spec.ts` already work within.
 */

const SENSORS = [
  {
    id: 'sensor-1',
    layoutId: 'layout-1',
    name: 'Sensor 1',
    type: 'block_detection',
    blockId: null,
    mqttTopic: 'layout/layout-1/sensor/sensor-1/reading',
    inService: true,
  },
];

/** Stubs every GET `useLayoutConfig.refresh()` fires, mirroring config-mutation-errors.spec.ts's `stubApis`. */
async function stubApis(page: Page, options: { sensorsRoute: (route: Route) => Promise<void> }) {
  await page.route('**://localhost:3000/api/layouts', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'layout-1', name: 'Test Layout' }]) }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/blocks', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/points', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/sensors', options.sensorsRoute);
  await page.route('**://localhost:3000/api/layouts/layout-1/sensors/*', options.sensorsRoute);
  await page.route('**://localhost:3000/api/layouts/layout-1/locos', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/edges', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
  await page.route('**://localhost:3000/api/layouts/layout-1/topology', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, violations: [], edgeCount: 0 }) }),
  );
}

async function openSensorsTab(page: Page) {
  // Gated behind a session — see edge-authoring.spec.ts's openEdgesTab.
  await installMockAuth(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Configure' }).click();
  await page.getByRole('button', { name: /^Sensors/ }).click();
}

test('the In service checkbox issues a PUT with inService: false', async ({ page }) => {
  await installMockWebSocket(page);
  const puts: unknown[] = [];
  // Stateful on purpose. A successful mutation calls `refresh()`, which
  // re-GETs the sensor list, so a stub that always answered
  // `inService: true` would flip the checkbox straight back and the
  // assertion below would be testing the stub rather than the UI.
  let inService = true;
  await stubApis(page, {
    sensorsRoute: async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([{ ...SENSORS[0], inService }]),
        });
      }
      if (req.method() === 'PUT') {
        const body = req.postDataJSON() as { inService?: boolean };
        puts.push(body);
        if (typeof body.inService === 'boolean') inService = body.inService;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...SENSORS[0], inService }),
        });
      }
      return route.continue();
    },
  });

  await openSensorsTab(page);

  const checkbox = page.getByRole('checkbox').first();
  await expect(checkbox).toBeChecked();
  // `click()`, not `uncheck()`: this is a controlled input whose `checked`
  // only flips once the PUT and the follow-up `refresh()` have resolved, and
  // `uncheck()` verifies the new state immediately after clicking — a race it
  // loses. The retrying assertion below is what waits for the round trip.
  await checkbox.click();

  // Unchecked *and* persisted: the box reflects the value the refetch
  // returned, so this covers the round trip rather than just the click.
  await expect(checkbox).not.toBeChecked();
  await expect.poll(() => puts.length).toBe(1);
  expect(puts[0]).toEqual({ inService: false });
});

test('the sensor fault banner is absent when there are no faults', async ({ page }) => {
  await installMockWebSocket(page);
  await stubApis(page, {
    sensorsRoute: async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SENSORS) });
      }
      return route.continue();
    },
  });

  await installMockAuth(page);
  await page.goto('/');

  // StateSnapshot.sensorFaults starts empty and no SENSOR_FAULTS frame
  // arrives over the mocked WebSocket, so SensorFaultBanner must render
  // nothing at all — no Acknowledge button anywhere in the app.
  await expect(page.getByRole('button', { name: 'Acknowledge' })).toHaveCount(0);
  // Sanity: the app did render past login, so the absence above is
  // meaningful rather than an artefact of a blank page.
  await expect(page.getByRole('button', { name: 'Configure' })).toBeVisible();
});
