/**
 * useGridEditor
 *
 * Manages local grid state and syncs changes to the REST API.
 * The grid is a sparse map: key = "x,y" → GridTileRecord.
 */

import { useCallback, useEffect, useState } from 'react';
import { GridTileRecord, TileType } from '../types';

const API = 'http://localhost:3000';

export type GridMap = Map<string, GridTileRecord>;

function key(x: number, y: number) {
  return `${x},${y}`;
}

export function useGridEditor(layoutId: string | null) {
  const [grid, setGrid] = useState<GridMap>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!layoutId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API}/api/layouts/${layoutId}/grid`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tiles: GridTileRecord[] = await res.json();
      const map: GridMap = new Map();
      for (const t of tiles) map.set(key(t.x, t.y), t);
      setGrid(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [layoutId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const placeTile = useCallback(
    async (x: number, y: number, tileType: TileType, metadata: Record<string, unknown> = {}) => {
      if (!layoutId) return;
      // Optimistic update
      setGrid((prev) => {
        const next = new Map(prev);
        const existing = prev.get(key(x, y));
        next.set(key(x, y), {
          id: existing?.id ?? '',
          layoutId,
          x,
          y,
          tileType,
          metadata: JSON.stringify(metadata),
        });
        return next;
      });
      try {
        const res = await fetch(`${API}/api/layouts/${layoutId}/grid`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ x, y, tileType, metadata }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const saved: GridTileRecord = await res.json();
        setGrid((prev) => {
          const next = new Map(prev);
          next.set(key(x, y), saved);
          return next;
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        await refresh(); // revert on failure
      }
    },
    [layoutId, refresh],
  );

  const eraseTile = useCallback(
    async (x: number, y: number) => {
      if (!layoutId) return;
      setGrid((prev) => {
        const next = new Map(prev);
        next.delete(key(x, y));
        return next;
      });
      try {
        await fetch(`${API}/api/layouts/${layoutId}/grid/tile?x=${x}&y=${y}`, {
          method: 'DELETE',
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        await refresh();
      }
    },
    [layoutId, refresh],
  );

  const clearAll = useCallback(async () => {
    if (!layoutId) return;
    setGrid(new Map());
    try {
      await fetch(`${API}/api/layouts/${layoutId}/grid`, { method: 'DELETE' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    }
  }, [layoutId, refresh]);

  return { grid, loading, error, placeTile, eraseTile, clearAll, refresh };
}
