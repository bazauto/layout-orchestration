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
  LocoRecord,
  PointCondition,
  PointRecord,
  SensorRecord,
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

/** Best-effort extraction of the `error` field from a JSON error body. */
async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const err = (body as { error: unknown }).error;
      if (typeof err === 'string') return err;
    }
  } catch {
    // Non-JSON error body — fall back below.
  }
  return `HTTP ${res.status}`;
}

/**
 * Result of a mutation that must surface a non-2xx response to the caller
 * rather than swallow it — used by the edge mutations, which (unlike the
 * block/point/sensor/loco mutations below) can be rejected with a 422 the
 * operator needs to see (`TopologyRejectedError` → `violations`).
 */
export interface MutationResult<T = void> {
  ok: boolean;
  status: number;
  data?: T;
  message?: string;
  violations?: TopologyViolation[];
}

async function mutate<T = void>(path: string, init: RequestInit): Promise<MutationResult<T>> {
  // Must go through apiFetch, not bare fetch: these are cross-origin in dev,
  // so the session cookie would be dropped, and a 401 here needs to reach
  // the app's central unauthorized handler like every other call site.
  const res = await apiFetch(path, init);
  if (res.ok) {
    const data = res.status === 204 ? undefined : ((await res.json()) as T);
    return { ok: true, status: res.status, data };
  }

  let message = `HTTP ${res.status}`;
  let violations: TopologyViolation[] | undefined;
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      if ('error' in body && typeof (body as { error: unknown }).error === 'string') {
        message = (body as { error: string }).error;
      }
      if ('violations' in body) {
        violations = (body as { violations: TopologyViolation[] }).violations;
      }
    }
  } catch {
    // Non-JSON error body — fall back to the status-derived message.
  }
  return { ok: false, status: res.status, message, violations };
}

export interface EdgeWriteInput {
  fromBlockId: string;
  fromEnd: string;
  toBlockId: string;
  toEnd: string;
  pointConditions?: PointCondition[];
  lengthMm?: number | null;
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

  const createBlock = async (name: string) => {
    await apiFetch(`/api/layouts/${layoutId}/blocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await refresh();
  };

  const updateBlock = async (id: string, name: string) => {
    await apiFetch(`/api/layouts/${layoutId}/blocks/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await refresh();
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

  const createPoint = async (name: string, dccAddress: number, blockId: string | null) => {
    await apiFetch(`/api/layouts/${layoutId}/points`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, dccAddress, blockId }),
    });
    await refresh();
  };

  const updatePoint = async (
    id: string,
    data: { name?: string; dccAddress?: number; blockId?: string | null },
  ) => {
    await apiFetch(`/api/layouts/${layoutId}/points/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    await refresh();
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
  ) => {
    await apiFetch(`/api/layouts/${layoutId}/sensors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, type, blockId, mqttTopic }),
    });
    await refresh();
  };

  const updateSensor = async (
    id: string,
    data: { name?: string; type?: 'block_detection' | 'ir_position'; blockId?: string | null; mqttTopic?: string },
  ) => {
    await apiFetch(`/api/layouts/${layoutId}/sensors/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    await refresh();
  };

  const deleteSensor = async (id: string) => {
    await apiFetch(`/api/layouts/${layoutId}/sensors/${id}`, { method: 'DELETE' });
    await refresh();
  };

  const createLoco = async (
    name: string,
    address: number,
    type: string,
    maxSpeed: number,
    brakingFactor: number,
  ) => {
    await apiFetch(`/api/layouts/${layoutId}/locos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, address, type, maxSpeed, brakingFactor }),
    });
    await refresh();
  };

  const updateLoco = async (
    id: string,
    data: { name?: string; address?: number; type?: string; maxSpeed?: number; brakingFactor?: number },
  ) => {
    await apiFetch(`/api/layouts/${layoutId}/locos/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    await refresh();
  };

  const deleteLoco = async (id: string) => {
    await apiFetch(`/api/layouts/${layoutId}/locos/${id}`, { method: 'DELETE' });
    await refresh();
  };

  // Edge mutations use `mutate()` so a 422 (topology rejected) or 400/404
  // reaches the caller with its `violations`/`message` intact, rather than
  // being swallowed like the mutations above — see EdgesTab, which renders
  // `violations` inline without clearing the operator's form.
  const createEdge = async (data: EdgeWriteInput): Promise<MutationResult<BlockEdgeRecord>> => {
    const result = await mutate<BlockEdgeRecord>(`/api/layouts/${layoutId}/edges`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (result.ok) await refresh();
    return result;
  };

  const updateEdge = async (
    id: string,
    data: Partial<EdgeWriteInput>,
  ): Promise<MutationResult<BlockEdgeRecord>> => {
    const result = await mutate<BlockEdgeRecord>(`/api/layouts/${layoutId}/edges/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (result.ok) await refresh();
    return result;
  };

  const deleteEdge = async (id: string): Promise<MutationResult<void>> => {
    const result = await mutate<void>(`/api/layouts/${layoutId}/edges/${id}`, {
      method: 'DELETE',
    });
    if (result.ok) await refresh();
    return result;
  };

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
    createLoco,
    updateLoco,
    deleteLoco,
    createEdge,
    updateEdge,
    deleteEdge,
  };
}
