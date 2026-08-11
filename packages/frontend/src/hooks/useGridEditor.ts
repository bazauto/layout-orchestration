/**
 * useGridEditor
 *
 * Manages local grid state and syncs changes to the REST API.
 * The grid is a sparse map: key = "x,y" → GridTileRecord.
 *
 * ## Why the mutations return a result instead of setting an error string
 *
 * This hook used to hold one shared `error` string that both the loader and
 * the mutations wrote to — and that its own reload path reset. The result
 * (#62) was a Track Editor that reported refused writes as successes, in two
 * different ways:
 *
 * - `eraseTile` and `clearAll` never checked `res.ok` at all, so a 403, 404,
 *   409 or 500 fell straight through the `try` as if the delete had landed.
 *   The tile stayed gone on screen while the backend still had it, and the
 *   divergence only surfaced on a refresh the operator might not do for an
 *   hour.
 * - `placeTile` *did* check, set `error`, then called `refresh()` to revert —
 *   and `refresh()` opens with `setError(null)`. Both updates landed in the
 *   same React 18 batch, so the message was never committed to a single
 *   render. The tile flickered on and vanished with no explanation.
 *
 * Every mutation now returns a per-call `MutationResult` the caller owns,
 * which is the shape the rest of the config surface settled on (#22) and
 * which `useLayoutConfig#mutate` already implements — including
 * `readErrorBody`, so the operator sees the backend's own message ("Admin
 * role required") rather than a bare `HTTP 403`. `loadError` below carries
 * *only* the initial/refresh load failure, so nothing can stamp on a
 * mutation's message ever again.
 */

import { useCallback, useEffect, useState } from 'react';
import { mutate, MutationResult } from './useLayoutConfig';
import { apiFetch } from '../api';
import { GridTileRecord, TileType } from '../types';

export type GridMap = Map<string, GridTileRecord>;

function key(x: number, y: number) {
  return `${x},${y}`;
}

/** No layout selected — every mutation is a no-op with an honest result. */
function noLayout<T>(): MutationResult<T> {
  return { ok: false, status: 0, message: 'No layout selected' };
}

export function useGridEditor(layoutId: string | null) {
  const [grid, setGrid] = useState<GridMap>(new Map());
  const [loading, setLoading] = useState(false);
  /**
   * Load failures only. Deliberately NOT written by any mutation — see the
   * module comment: this is the state `refresh()` clears, and a mutation
   * error that lives here cannot survive its own revert.
   */
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!layoutId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const res = await apiFetch(`/api/layouts/${layoutId}/grid`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tiles: GridTileRecord[] = await res.json();
      const map: GridMap = new Map();
      for (const t of tiles) map.set(key(t.x, t.y), t);
      setGrid(map);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [layoutId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Reverts an optimistic local mutation by re-reading the authoritative grid.
   *
   * Note this is the opposite of `useLayoutConfig`'s convention, where a
   * failed mutation deliberately does NOT refresh so the operator's form is
   * left untouched. The difference is that those mutations are not optimistic:
   * nothing changed on screen, so there is nothing to undo. Here the tile is
   * already painted (or already erased) before the request resolves, so a
   * failure that did not re-read would leave the screen asserting something
   * the backend never accepted — the exact divergence #62 is about.
   */
  const revert = refresh;

  const placeTile = useCallback(
    async (
      x: number,
      y: number,
      tileType: TileType,
      metadata: Record<string, unknown> = {},
    ): Promise<MutationResult<GridTileRecord>> => {
      if (!layoutId) return noLayout<GridTileRecord>();

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

      const result = await mutate<GridTileRecord>(`/api/layouts/${layoutId}/grid`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x, y, tileType, metadata }),
      });

      if (!result.ok) {
        await revert();
        return result;
      }

      // Reconcile with whatever the server actually persisted.
      if (result.data) {
        const saved = result.data;
        setGrid((prev) => {
          const next = new Map(prev);
          next.set(key(x, y), saved);
          return next;
        });
      }
      return result;
    },
    [layoutId, revert],
  );

  const eraseTile = useCallback(
    async (x: number, y: number): Promise<MutationResult<void>> => {
      if (!layoutId) return noLayout<void>();

      setGrid((prev) => {
        const next = new Map(prev);
        next.delete(key(x, y));
        return next;
      });

      const result = await mutate<void>(
        `/api/layouts/${layoutId}/grid/tile?x=${x}&y=${y}`,
        { method: 'DELETE' },
      );

      if (!result.ok) await revert();
      return result;
    },
    [layoutId, revert],
  );

  /**
   * Not wired to any control today (`GridEditor` destructures only what it
   * uses). Fixed alongside its siblings anyway: it had `eraseTile`'s defect
   * exactly, so wiring up a "Clear grid" button would otherwise have shipped a
   * control that reports success on a refused wipe of the entire drawing.
   */
  const clearAll = useCallback(async (): Promise<MutationResult<void>> => {
    if (!layoutId) return noLayout<void>();

    setGrid(new Map());

    const result = await mutate<void>(`/api/layouts/${layoutId}/grid`, { method: 'DELETE' });

    if (!result.ok) await revert();
    return result;
  }, [layoutId, revert]);

  return { grid, loading, loadError, placeTile, eraseTile, clearAll, refresh };
}
