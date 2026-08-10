/**
 * `GET /api/capabilities` integration tests (#65 D3/R3).
 *
 * Uses `routes.test.ts`'s un-started `buildTestServer` shape — this endpoint
 * needs no live `LayoutService` state, unlike `sensors.test.ts`'s started
 * one.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildServer } from '../../src/transport/http/server';
import { LayoutService } from '../../src/services/LayoutService';
import { TopologyService } from '../../src/services/TopologyService';
import { ReservationService } from '../../src/services/ReservationService';
import { SensorSimulationService } from '../../src/services/SensorSimulationService';
import { NameBookCache } from '../../src/services/nameBook';
import { LayoutStateManager } from '../../src/domain/layoutState';
import { SimulatedDccAdapter } from '../../src/adapters/dcc/SimulatedDccAdapter';
import { SimulatedMqttAdapter } from '../../src/adapters/mqtt/SimulatedMqttAdapter';
import { ILayoutRepository } from '../../src/ports/ILayoutRepository';
import { authenticateAsOperator, makeTestAuthService, TEST_AUTH_CONFIG } from './testAuthHelpers';

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const LAYOUT_ID = 'layout-1';

function makeRepo(): ILayoutRepository {
  return {
    listLayouts: vi.fn().mockResolvedValue([]),
    getLayout: vi.fn().mockResolvedValue(null),
    createLayout: vi.fn(),
    deleteLayout: vi.fn(),
    listLocos: vi.fn().mockResolvedValue([]),
    getLoco: vi.fn().mockResolvedValue(null),
    createLoco: vi.fn(),
    updateLoco: vi.fn(),
    deleteLoco: vi.fn(),
    listBlocks: vi.fn().mockResolvedValue([]),
    createBlock: vi.fn(),
    updateBlock: vi.fn(),
    deleteBlock: vi.fn(),
    listPoints: vi.fn().mockResolvedValue([]),
    createPoint: vi.fn(),
    updatePoint: vi.fn(),
    deletePoint: vi.fn(),
    listSensors: vi.fn().mockResolvedValue([]),
    createSensor: vi.fn(),
    updateSensor: vi.fn(),
    deleteSensor: vi.fn(),
    listGridTiles: vi.fn().mockResolvedValue([]),
    upsertGridTile: vi.fn(),
    deleteTile: vi.fn(),
    clearGrid: vi.fn(),
    listBlockEdges: vi.fn().mockResolvedValue([]),
    getBlockEdge: vi.fn().mockResolvedValue(null),
    createBlockEdge: vi.fn(),
    updateBlockEdge: vi.fn(),
    deleteBlockEdge: vi.fn(),
    listReservations: vi.fn().mockResolvedValue([]),
    getReservation: vi.fn().mockResolvedValue(null),
    createReservation: vi.fn(),
    updateReservation: vi.fn(),
    markHoldsReleased: vi.fn(),
  };
}

async function buildTestServer(sensorSimulation?: SensorSimulationService) {
  const repo = makeRepo();
  const dcc = new SimulatedDccAdapter(silentLogger);
  const mqtt = new SimulatedMqttAdapter();
  const state = new LayoutStateManager(LAYOUT_ID);
  const nameBook = new NameBookCache(repo, LAYOUT_ID);
  const reservations = new ReservationService(repo, state, silentLogger, nameBook);
  const service = new LayoutService(dcc, mqtt, repo, state, reservations, silentLogger, undefined, nameBook);
  await service.start(LAYOUT_ID);
  const topologyService = new TopologyService(repo, () => Promise.resolve(), silentLogger, reservations, nameBook);
  const authService = await makeTestAuthService();
  const app = await buildServer(
    service,
    repo,
    'silent',
    topologyService,
    authService,
    TEST_AUTH_CONFIG,
    nameBook,
    sensorSimulation,
  );
  return { app, repo, mqtt };
}

describe('GET /api/capabilities (#65 D3)', () => {
  it('an unauthenticated request is rejected with 401', async () => {
    const { app } = await buildTestServer();
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    expect(res.statusCode).toBe(401);
  });

  it('reports { sensorSimulation: false } when the server is built without the service', async () => {
    const { app } = await buildTestServer();
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sensorSimulation: false });
  });

  it('reports { sensorSimulation: true } when the server is built with it', async () => {
    const repo = makeRepo();
    const mqtt = new SimulatedMqttAdapter();
    const sensorSimulation = new SensorSimulationService(mqtt, repo, silentLogger, LAYOUT_ID);
    const { app } = await buildTestServer(sensorSimulation);
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sensorSimulation: true });
  });

  it('an operator (non-admin) may read it', async () => {
    const { app } = await buildTestServer();
    await authenticateAsOperator(app);
    const res = await app.inject({ method: 'GET', url: '/api/capabilities' });
    expect(res.statusCode).toBe(200);
  });
});
