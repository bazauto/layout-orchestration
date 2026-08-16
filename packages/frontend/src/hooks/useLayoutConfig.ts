/**
 * useLayoutConfig
 *
 * Fetches and mutates layout topology (blocks, sensors, points, locos, edges)
 * via the REST API. Notifies the LayoutService so it re-subscribes to
 * sensor topics without a restart.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import {
  BlockEdgeRecord,
  BlockRecord,
  BrakingFaultView,
  LocoRecord,
  PointFaultView,
  PointFeedbackMode,
  PointRecord,
  RouteFaultView,
  RouteReservation,
  SensorFaultView,
  SensorRecord,
  SimulateReadingRequest,
  SimulateReadingResponse,
  SystemStatus,
  TopologyStatus,
  TopologyViolation,
} from '../types';

export interface LayoutConfig {
  layoutId: string;
  blocks: BlockRecord[];
  points: PointRecord[];
  sensors: SensorRecord[];
  locos: LocoRecord[];
  edges: BlockEdgeRecord[];
  topology: TopologyStatus;
}

const EMPTY_TOPOLOGY: TopologyStatus = { valid: true, violations: [], edgeCount: 0 };

const EMPTY: LayoutConfig = {
  layoutId: '',
  blocks: [],
  points: [],
  sensors: [],
  locos: [],
  edges: [],
  topology: EMPTY_TOPOLOGY,
};

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Best-effort extraction of a human-readable message from a JSON error body.
 *
 * A Zod rejection is sent as `{ error, details: parsed.error.flatten() }`,
 * where `error` is a generic label ("Invalid user payload") and `details`
 * holds the only part that tells the operator what to fix. Returning `error`
 * alone — which this did until a short password on the Users tab surfaced as
 * a bare "Invalid user payload" — throws that away at the last step. The
 * field errors win when present, since they are strictly more specific.
 *
 * Fields are named in the output because not every schema's messages
 * self-describe: `Password must be at least 8 characters` reads fine alone,
 * but a bare `Required` or `Expected number, received string` from the block
 * and sensor schemas does not.
 */
function flattenDetails(details: unknown): string[] {
  if (!details || typeof details !== 'object') return [];
  const { formErrors, fieldErrors } = details as {
    formErrors?: unknown;
    fieldErrors?: unknown;
  };
  const out: string[] = [];

  if (Array.isArray(formErrors)) {
    out.push(...formErrors.filter((m): m is string => typeof m === 'string'));
  }

  if (fieldErrors && typeof fieldErrors === 'object') {
    for (const [field, messages] of Object.entries(fieldErrors as Record<string, unknown>)) {
      if (!Array.isArray(messages)) continue;
      for (const m of messages) {
        if (typeof m === 'string') out.push(`${field}: ${m}`);
      }
    }
  }

  return out;
}

/**
 * Reads a non-2xx body **once** and derives everything callers need from it.
 *
 * `mutate()` previously inlined its own copy of this extraction while
 * `extractErrorMessage` sat right above it — which is why the Users tab
 * (#53, built on `mutate`) could not be fixed by changing the helper alone.
 * A `Response` body can only be consumed once, so message and violations
 * must come out of the same parse.
 */
async function readErrorBody(
  res: Response,
): Promise<{ message: string; violations?: TopologyViolation[] }> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const violations =
        'violations' in body ? (body as { violations: TopologyViolation[] }).violations : undefined;

      const detail = flattenDetails((body as { details?: unknown }).details);
      if (detail.length > 0) return { message: detail.join('; '), violations };

      if ('error' in body) {
        const err = (body as { error: unknown }).error;
        if (typeof err === 'string') return { message: err, violations };
      }
      return { message: `HTTP ${res.status}`, violations };
    }
  } catch {
    // Non-JSON error body — fall back below.
  }
  return { message: `HTTP ${res.status}` };
}

async function extractErrorMessage(res: Response): Promise<string> {
  return (await readErrorBody(res)).message;
}

/**
 * Result of a mutation that must surface a non-2xx response to the caller
 * rather than swallow it. Originally introduced for the edge mutations,
 * which can be rejected with a 422 the operator needs to see
 * (`TopologyRejectedError` → `violations`); every block/point/sensor/loco
 * create/update/delete below (#22) is now built on this same helper, so a
 * failed save is always `{ ok: false, message }` rather than a response the
 * caller never looked at. `deleteBlock`/`deletePoint` predate this and keep
 * their own narrower result shapes (`DeleteBlockResult`/`DeletePointResult`)
 * below, since their bodies (`removedEdges`, a bare 204) don't fit `data: T`
 * — they already surface failures, just not through `mutate()`.
 */
export interface MutationResult<T = void> {
  ok: boolean;
  status: number;
  data?: T;
  message?: string;
  violations?: TopologyViolation[];
}

/**
 * Exported so `useUsers.ts` (#53) can share this exact `{ ok, message }`
 * shape and error-extraction behaviour rather than re-implementing it —
 * `/api/users` isn't part of `LayoutConfig`, but the mutation posture (a
 * non-2xx must reach the caller, never be swallowed) is identical.
 */
export async function mutate<T = void>(path: string, init: RequestInit): Promise<MutationResult<T>> {
  // Must go through apiFetch, not bare fetch: these are cross-origin in dev,
  // so the session cookie would be dropped, and a 401 here needs to reach
  // the app's central unauthorized handler like every other call site.
  const res = await apiFetch(path, init);
  if (res.ok) {
    const data = res.status === 204 ? undefined : ((await res.json()) as T);
    return { ok: true, status: res.status, data };
  }

  const { message, violations } = await readErrorBody(res);
  return { ok: false, status: res.status, message, violations };
}

/** Response of `DELETE /blocks/:id` — no longer a bare 204, see docs/mqtt-contract.md-adjacent PR A notes. */
export interface DeleteBlockResult {
  ok: boolean;
  removedEdges?: number;
  message?: string;
}

/** Response of `DELETE /points/:id` — can now be refused (422) while an edge still references the point. */
export interface DeletePointResult {
  ok: boolean;
  message?: string;
}

/** Response of `POST /routes/:routeId/acknowledge-fault` (#4) — see `docs/pathfinding.md` P8. */
export interface AcknowledgeRouteFaultResponse {
  routeId: string;
  cleared: true;
  systemStatus: SystemStatus;
  safeStopReason: string | null;
  faults: RouteFaultView[];
}

/** Response of `POST /sensors/:id/acknowledge-fault` (#34) — see `docs/sensor-fault-recovery.md` D1/D5. */
export interface AcknowledgeFaultResponse {
  sensorId: string;
  cleared: true;
  systemStatus: SystemStatus;
  safeStopReason: string | null;
  faults: SensorFaultView[];
}

/**
 * Response of `POST .../points/:id/acknowledge-fault` (#25) — mirrors
 * `AcknowledgeFaultResponse` above exactly, same posture as
 * `docs/point-feedback.md` D4 mirrors `docs/sensor-fault-recovery.md` D1/D5.
 */
export interface AcknowledgePointFaultResponse {
  pointId: string;
  cleared: true;
  systemStatus: SystemStatus;
  safeStopReason: string | null;
  faults: PointFaultView[];
}

/**
 * Response of `POST .../locos/:address/acknowledge-fault` (#6) — mirrors the
 * three above. Keyed by DCC address, not roster row id: a braking fault is
 * about a train on the track (docs/braking.md B10).
 */
export interface AcknowledgeBrakingFaultResponse {
  locoAddress: number;
  cleared: true;
  systemStatus: SystemStatus;
  safeStopReason: string | null;
  faults: BrakingFaultView[];
}

/** Response of `POST .../locos/:address/brake` (#6) — B8's standard stop, returning the schedule now running. */
export interface BrakeLocoResponse {
  schedule: {
    locoAddress: number;
    steps: Array<{ atOffsetMs: number; speedStep: number; direction: 'fwd' | 'rev' | 'stop' }>;
    estimatedStoppingDistanceMm: number;
    requiredDistanceMm: number;
    totalDurationMs: number;
  };
}

export function useLayoutConfig(layoutId: string | null) {
  const [config, setConfig] = useState<LayoutConfig>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!layoutId) return;
    setLoading(true);
    setError(null);
    try {
      const [blocks, points, sensors, locos, edges, topology] = await Promise.all([
        apiFetch(`/api/layouts/${layoutId}/blocks`).then((r) => json<BlockRecord[]>(r)),
        apiFetch(`/api/layouts/${layoutId}/points`).then((r) => json<PointRecord[]>(r)),
        apiFetch(`/api/layouts/${layoutId}/sensors`).then((r) => json<SensorRecord[]>(r)),
        apiFetch(`/api/layouts/${layoutId}/locos`).then((r) => json<LocoRecord[]>(r)),
        apiFetch(`/api/layouts/${layoutId}/edges`).then((r) => json<BlockEdgeRecord[]>(r)),
        apiFetch(`/api/layouts/${layoutId}/topology`).then((r) => json<TopologyStatus>(r)),
      ]);
      setConfig({ layoutId, blocks, points, sensors, locos, edges, topology });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [layoutId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ── Mutations ─────────────────────────────────────────────────────────────────
  //
  // All mutations below route through `mutate()` so a non-2xx reaches the
  // caller as `{ ok: false, message }` instead of being discarded — see
  // issue #22. Only a successful mutation triggers `refresh()`; a failed one
  // must leave the form and the table exactly as they were.

  /**
   * `lengthMm` is **omitted** when not supplied rather than sent as `null`, the
   * same call `EdgeProposalsPanel` makes about a field geometry cannot fill:
   * the schema defaults it to `null` anyway, and omitting it is the honest
   * statement that nobody measured, not an assertion that it is unmeasured.
   */
  const createBlock = async (
    name: string,
    lengthMm?: number | null,
  ): Promise<MutationResult<BlockRecord>> => {
    const result = await mutate<BlockRecord>(`/api/layouts/${layoutId}/blocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(lengthMm === undefined ? { name } : { name, lengthMm }),
    });
    if (result.ok) await refresh();
    return result;
  };

  const updateBlock = async (
    id: string,
    patch: { name?: string; lengthMm?: number | null },
  ): Promise<MutationResult<BlockRecord>> => {
    const result = await mutate<BlockRecord>(`/api/layouts/${layoutId}/blocks/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (result.ok) await refresh();
    return result;
  };

  // A block delete now returns 200 with { removedEdges } (a block delete
  // cascades to every edge that referenced it) instead of a bare 204, and
  // can 404 if the block doesn't belong to this layout. Both are surfaced to
  // the caller rather than swallowed.
  const deleteBlock = async (id: string): Promise<DeleteBlockResult> => {
    const res = await apiFetch(`/api/layouts/${layoutId}/blocks/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      return { ok: false, message: await extractErrorMessage(res) };
    }
    const body = (await res.json()) as { removedEdges: number };
    await refresh();
    return { ok: true, removedEdges: body.removedEdges };
  };

  const createPoint = async (
    name: string,
    dccAddress: number,
    blockId: string | null,
  ): Promise<MutationResult<PointRecord>> => {
    const result = await mutate<PointRecord>(`/api/layouts/${layoutId}/points`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, dccAddress, blockId }),
    });
    if (result.ok) await refresh();
    return result;
  };

  const updatePoint = async (
    id: string,
    data: {
      name?: string;
      dccAddress?: number;
      blockId?: string | null;
      positionFeedback?: PointFeedbackMode;
    },
  ): Promise<MutationResult<PointRecord>> => {
    const result = await mutate<PointRecord>(`/api/layouts/${layoutId}/points/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (result.ok) await refresh();
    return result;
  };

  // A point delete can now be refused with 422 while an edge's
  // pointConditions still reference it, and can 404. Both are surfaced
  // rather than swallowed.
  const deletePoint = async (id: string): Promise<DeletePointResult> => {
    const res = await apiFetch(`/api/layouts/${layoutId}/points/${id}`, { method: 'DELETE' });
    if (res.status !== 204) {
      return { ok: false, message: await extractErrorMessage(res) };
    }
    await refresh();
    return { ok: true };
  };

  const createSensor = async (
    name: string,
    type: 'block_detection' | 'ir_position',
    blockId: string | null,
    mqttTopic: string,
  ): Promise<MutationResult<SensorRecord>> => {
    const result = await mutate<SensorRecord>(`/api/layouts/${layoutId}/sensors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, type, blockId, mqttTopic }),
    });
    if (result.ok) await refresh();
    return result;
  };

  const updateSensor = async (
    id: string,
    data: {
      name?: string;
      type?: 'block_detection' | 'ir_position';
      blockId?: string | null;
      mqttTopic?: string;
      inService?: boolean;
    },
  ): Promise<MutationResult<SensorRecord>> => {
    const result = await mutate<SensorRecord>(`/api/layouts/${layoutId}/sensors/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (result.ok) await refresh();
    return result;
  };

  const deleteSensor = async (id: string): Promise<MutationResult<void>> => {
    const result = await mutate<void>(`/api/layouts/${layoutId}/sensors/${id}`, { method: 'DELETE' });
    if (result.ok) await refresh();
    return result;
  };

  // Deliberately does NOT call `refresh()` on success — a fault is not
  // config, and the authoritative update arrives over the WS `SENSOR_FAULTS`
  // frame (#34). `mutate()` already surfaces the 409 body's `error` as
  // `message`, which is exactly what the operator must see when the fault
  // isn't armed yet or has already been cleared.
  const acknowledgeSensorFault = async (sensorId: string): Promise<MutationResult<AcknowledgeFaultResponse>> =>
    mutate<AcknowledgeFaultResponse>(`/api/layouts/${layoutId}/sensors/${sensorId}/acknowledge-fault`, {
      method: 'POST',
    });

  // Same posture as acknowledgeSensorFault above: no refresh() on success — a
  // fault is not config, and the authoritative update arrives over the WS
  // POINT_FAULTS frame (#25).
  const acknowledgePointFault = async (pointId: string): Promise<MutationResult<AcknowledgePointFaultResponse>> =>
    mutate<AcknowledgePointFaultResponse>(`/api/layouts/${layoutId}/points/${pointId}/acknowledge-fault`, {
      method: 'POST',
    });

  // #65: bench-testing tool, gated on `capabilities.sensorSimulation` at the
  // App level — this hook doesn't know or care whether the flag is on.
  // Deliberately does NOT call `refresh()` on success: the effect of an
  // injection (a block/sensor-fault change) arrives over the WebSocket, and
  // a config refresh here would only race it, same posture as
  // `acknowledgeSensorFault` above.
  const simulateSensorReading = async (
    sensorId: string,
    body: SimulateReadingRequest,
  ): Promise<MutationResult<SimulateReadingResponse>> =>
    mutate<SimulateReadingResponse>(`/api/layouts/${layoutId}/sensors/${sensorId}/simulate-reading`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // ── Routes (#4, see docs/pathfinding.md) ────────────────────────────────
  //
  // No `refresh()` on success: route state arrives over the WebSocket
  // (`ROUTE_STATE` / `ROUTE_FAULTS`), which is authoritative and live. Re-
  // fetching config here would do nothing useful and would race the socket.
  // These are here rather than in a separate hook only because `mutate`'s
  // error extraction — which surfaces the backend's rendered
  // `describeRejections` string — is exactly what a refused grant needs.

  /** `POST .../routes` with a destination; the backend searches for the path (P6). */
  const requestRoute = async (req: {
    locoAddress: number;
    startBlockId: string;
    destinationBlockId: string;
  }): Promise<MutationResult<RouteReservation>> =>
    mutate<RouteReservation>(`/api/layouts/${layoutId}/routes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...req, authority: 'manual' }),
    });

  const cancelRoute = async (routeId: string): Promise<MutationResult<null>> =>
    mutate<null>(`/api/layouts/${layoutId}/routes/${routeId}`, { method: 'DELETE' });

  const resumeRoute = async (routeId: string): Promise<MutationResult<RouteReservation>> =>
    mutate<RouteReservation>(`/api/layouts/${layoutId}/routes/${routeId}/resume`, {
      method: 'POST',
    });

  const acknowledgeRouteFault = async (
    routeId: string,
  ): Promise<MutationResult<AcknowledgeRouteFaultResponse>> =>
    mutate<AcknowledgeRouteFaultResponse>(
      `/api/layouts/${layoutId}/routes/${routeId}/acknowledge-fault`,
      { method: 'POST' },
    );

  // ── Braking (#6, see docs/braking.md) ───────────────────────────────────
  //
  // Same posture as the fault acknowledges above: no `refresh()`, because
  // neither a braking fault nor a running ramp is config — the authoritative
  // updates arrive over the WebSocket as `BRAKING_FAULTS` and a stream of
  // `LOCO_STATE` frames, one per ramp step.

  const acknowledgeBrakingFault = async (
    locoAddress: number,
  ): Promise<MutationResult<AcknowledgeBrakingFaultResponse>> =>
    mutate<AcknowledgeBrakingFaultResponse>(
      `/api/layouts/${layoutId}/locos/${locoAddress}/acknowledge-fault`,
      { method: 'POST' },
    );

  /**
   * B8's standard stop: the calibration ramp, from whatever speed the loco is
   * commanded at. A 409 body's `error` surfaces through `mutate` as `message`
   * — which is exactly what an operator needs when the refusal is
   * "already stopped" or "system is safe-stop".
   */
  const brakeLoco = async (locoAddress: number): Promise<MutationResult<BrakeLocoResponse>> =>
    mutate<BrakeLocoResponse>(`/api/layouts/${layoutId}/locos/${locoAddress}/brake`, {
      method: 'POST',
    });

  const createLoco = async (
    name: string,
    address: number,
    type: string,
    maxSpeed: number,
    brakingFactor: number,
  ): Promise<MutationResult<LocoRecord>> => {
    const result = await mutate<LocoRecord>(`/api/layouts/${layoutId}/locos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, address, type, maxSpeed, brakingFactor }),
    });
    if (result.ok) await refresh();
    return result;
  };

  const updateLoco = async (
    id: string,
    data: { name?: string; address?: number; type?: string; maxSpeed?: number; brakingFactor?: number },
  ): Promise<MutationResult<LocoRecord>> => {
    const result = await mutate<LocoRecord>(`/api/layouts/${layoutId}/locos/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (result.ok) await refresh();
    return result;
  };

  const deleteLoco = async (id: string): Promise<MutationResult<void>> => {
    const result = await mutate<void>(`/api/layouts/${layoutId}/locos/${id}`, { method: 'DELETE' });
    if (result.ok) await refresh();
    return result;
  };

  // `createEdge` / `updateEdge` / `deleteEdge` were here and are gone with the
  // routes they called (#103 PR 5, OQ1). `block_edges` is written by the
  // compile apply and by nothing else — `useCompile` owns that one call, and it
  // posts a fingerprint rather than rows, so there is nothing edge-shaped for
  // this hook to send. `edges` stays in the fetch above: reading the graph was
  // never the problem.

  return {
    config,
    loading,
    error,
    refresh,
    createBlock,
    updateBlock,
    deleteBlock,
    createPoint,
    updatePoint,
    deletePoint,
    createSensor,
    updateSensor,
    deleteSensor,
    acknowledgeSensorFault,
    acknowledgePointFault,
    simulateSensorReading,
    requestRoute,
    cancelRoute,
    resumeRoute,
    acknowledgeRouteFault,
    acknowledgeBrakingFault,
    brakeLoco,
    createLoco,
    updateLoco,
    deleteLoco,
  };
}
