/**
 * useGridEditor
 *
 * Covers tile placement (including the optimistic update, reconciled once
 * the PUT resolves), replacing a tile at an occupied coordinate, erasing a
 * tile, clearing the grid, and reading a coordinate that was never
 * populated — the sparse-grid handling issue #8 calls out.
 *
 * Rotation is deliberately NOT covered here: it does not live in this hook.
 * `selectedRotation` and the +/-45° rotate handlers are local state in
 * `components/GridEditor.tsx`, which only ever passes the current rotation
 * through to `placeTile` as `metadata.rotation` — an opaque field this hook
 * does not interpret. Exercising rotation belongs to a GridEditor component
 * test, not this hook's.
 *
 * `apiFetch` (api.ts) is a thin wrapper over the global `fetch`, so `fetch`
 * itself is stubbed here rather than the `api` module — the request shape
 * `useGridEditor` builds (method, path, body) is part of what's under test.
 */

import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGridEditor, type GridMap } from './useGridEditor';
import { GridTileRecord } from '../types';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function tile(overrides: Partial<GridTileRecord> = {}): GridTileRecord {
  return {
    id: 'tile-1',
    layoutId: 'layout-1',
    x: 0,
    y: 0,
    tileType: 'straight-h',
    metadata: '{}',
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Mounts the hook against an empty backend grid and waits out the initial load. */
async function mountWithEmptyGrid(
  layoutId = 'layout-1',
): Promise<RenderHookResult<ReturnType<typeof useGridEditor>, string | null>> {
  fetchMock.mockResolvedValueOnce(jsonResponse([]));
  const view = renderHook(() => useGridEditor(layoutId));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  fetchMock.mockClear();
  return view;
}

describe('useGridEditor', () => {
  it('does not fetch when layoutId is null, and the grid stays empty', () => {
    const { result } = renderHook(() => useGridEditor(null));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.grid.size).toBe(0);
    expect(result.current.loading).toBe(false);
  });

  it('loads tiles on mount into a sparse map keyed by "x,y"', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([tile({ id: 't1', x: 2, y: 3 }), tile({ id: 't2', x: 5, y: 5 })]),
    );
    const { result } = renderHook(() => useGridEditor('layout-1'));

    // setLoading(true) runs synchronously before the fetch's first await, so
    // it is already visible once the mount's effects have flushed.
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.grid.size).toBe(2);
    expect(result.current.grid.get('2,3')).toEqual(tile({ id: 't1', x: 2, y: 3 }));
    expect(result.current.grid.get('5,5')).toEqual(tile({ id: 't2', x: 5, y: 5 }));
  });

  it('reading a coordinate that was never populated returns undefined', async () => {
    const { result } = await mountWithEmptyGrid();

    expect(result.current.grid.get('99,99')).toBeUndefined();
  });

  it('placeTile shows an optimistic tile before the PUT resolves, then reconciles with the server response', async () => {
    const { result } = await mountWithEmptyGrid();

    let resolveFetch: (value: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    fetchMock.mockReturnValueOnce(pending);

    let placeDone: Promise<void> = Promise.resolve();
    act(() => {
      placeDone = result.current.placeTile(9, 9, 'buffer');
    });

    // Optimistic update: visible immediately, with a placeholder id since
    // nothing was there before and the server hasn't responded yet.
    expect(result.current.grid.get('9,9')).toMatchObject({ id: '', x: 9, y: 9, tileType: 'buffer' });

    await act(async () => {
      resolveFetch(jsonResponse(tile({ id: 'server-id', x: 9, y: 9, tileType: 'buffer' })));
      await placeDone;
    });

    // Reconciled with whatever the server actually persisted.
    expect(result.current.grid.get('9,9')).toEqual(tile({ id: 'server-id', x: 9, y: 9, tileType: 'buffer' }));
  });

  it('placing a tile at an occupied coordinate replaces the entry rather than adding a second one', async () => {
    const { result } = await mountWithEmptyGrid();

    fetchMock.mockResolvedValueOnce(jsonResponse(tile({ id: 'a', x: 4, y: 4, tileType: 'straight-h' })));
    await act(async () => {
      await result.current.placeTile(4, 4, 'straight-h');
    });
    expect(result.current.grid.size).toBe(1);

    fetchMock.mockResolvedValueOnce(jsonResponse(tile({ id: 'a', x: 4, y: 4, tileType: 'crossing' })));
    await act(async () => {
      await result.current.placeTile(4, 4, 'crossing');
    });

    expect(result.current.grid.size).toBe(1);
    expect(result.current.grid.get('4,4')?.tileType).toBe('crossing');
  });

  it('a failed placeTile reverts the optimistic tile via refresh, rather than leaving stale data in place', async () => {
    const { result } = await mountWithEmptyGrid();

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500));
    // placeTile's catch block calls refresh() to revert — it re-fetches the
    // authoritative (still empty) grid. Note refresh() itself does
    // `setError(null)` before that re-fetch, so the failed-mutation error is
    // transient here rather than persisted — unlike useLayoutConfig's
    // `mutate()` path, which does NOT auto-refresh on failure and so keeps
    // the error visible to the operator.
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    await act(async () => {
      await result.current.placeTile(7, 7, 'straight-h');
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBeNull();
    expect(result.current.grid.has('7,7')).toBe(false);
  });

  it('eraseTile removes the map key entirely rather than storing an empty value', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([tile({ id: 't1', x: 2, y: 2 })]));
    const { result } = renderHook(() => useGridEditor('layout-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.grid.has('2,2')).toBe(true);

    fetchMock.mockResolvedValueOnce(jsonResponse(undefined, 204));
    await act(async () => {
      await result.current.eraseTile(2, 2);
    });

    expect(result.current.grid.has('2,2')).toBe(false);
    expect([...result.current.grid.keys()]).not.toContain('2,2');
  });

  it('clearAll empties the grid map and issues a DELETE for the whole grid', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([tile({ id: 't1', x: 1, y: 1 }), tile({ id: 't2', x: 2, y: 2 })]),
    );
    const { result } = renderHook(() => useGridEditor('layout-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.grid.size).toBe(2);

    fetchMock.mockResolvedValueOnce(jsonResponse(undefined, 204));
    await act(async () => {
      await result.current.clearAll();
    });

    const empty: GridMap = new Map();
    expect(result.current.grid).toEqual(empty);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:3000/api/layouts/layout-1/grid',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
