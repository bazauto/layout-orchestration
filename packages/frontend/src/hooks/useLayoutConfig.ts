/**
 * useLayoutConfig
 *
 * Fetches and mutates layout topology (blocks, sensors, points, locos)
 * via the REST API. Notifies the LayoutService so it re-subscribes to
 * sensor topics without a restart.
 */

import { useCallback, useEffect, useState } from 'react';
import { BlockRecord, LocoRecord, PointRecord, SensorRecord } from '../types';

const API = 'http://localhost:3000';

export interface LayoutConfig {
  layoutId: string;
  blocks: BlockRecord[];
  points: PointRecord[];
  sensors: SensorRecord[];
  locos: LocoRecord[];
}

const EMPTY: LayoutConfig = { layoutId: '', blocks: [], points: [], sensors: [], locos: [] };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
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
      const [blocks, points, sensors, locos] = await Promise.all([
        fetch(`${API}/api/layouts/${layoutId}/blocks`).then((r) => json<BlockRecord[]>(r)),
        fetch(`${API}/api/layouts/${layoutId}/points`).then((r) => json<PointRecord[]>(r)),
        fetch(`${API}/api/layouts/${layoutId}/sensors`).then((r) => json<SensorRecord[]>(r)),
        fetch(`${API}/api/layouts/${layoutId}/locos`).then((r) => json<LocoRecord[]>(r)),
      ]);
      setConfig({ layoutId, blocks, points, sensors, locos });
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
    await fetch(`${API}/api/layouts/${layoutId}/blocks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await refresh();
  };

  const updateBlock = async (id: string, name: string) => {
    await fetch(`${API}/api/layouts/${layoutId}/blocks/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await refresh();
  };

  const deleteBlock = async (id: string) => {
    await fetch(`${API}/api/layouts/${layoutId}/blocks/${id}`, { method: 'DELETE' });
    await refresh();
  };

  const createPoint = async (name: string, dccAddress: number, blockId: string | null) => {
    await fetch(`${API}/api/layouts/${layoutId}/points`, {
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
    await fetch(`${API}/api/layouts/${layoutId}/points/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    await refresh();
  };

  const deletePoint = async (id: string) => {
    await fetch(`${API}/api/layouts/${layoutId}/points/${id}`, { method: 'DELETE' });
    await refresh();
  };

  const createSensor = async (
    name: string,
    type: 'block_detection' | 'ir_position',
    blockId: string | null,
    mqttTopic: string,
  ) => {
    await fetch(`${API}/api/layouts/${layoutId}/sensors`, {
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
    await fetch(`${API}/api/layouts/${layoutId}/sensors/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    await refresh();
  };

  const deleteSensor = async (id: string) => {
    await fetch(`${API}/api/layouts/${layoutId}/sensors/${id}`, { method: 'DELETE' });
    await refresh();
  };

  const createLoco = async (
    name: string,
    address: number,
    type: string,
    maxSpeed: number,
    brakingFactor: number,
  ) => {
    await fetch(`${API}/api/layouts/${layoutId}/locos`, {
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
    await fetch(`${API}/api/layouts/${layoutId}/locos/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    await refresh();
  };

  const deleteLoco = async (id: string) => {
    await fetch(`${API}/api/layouts/${layoutId}/locos/${id}`, { method: 'DELETE' });
    await refresh();
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
  };
}
