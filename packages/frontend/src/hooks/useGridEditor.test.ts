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

    let placeDone: Promise<unknown> = Promise.resolve();
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

  it('a failed placeTile reverts the optimistic tile via refresh, and returns the failure to its caller', async () => {
    const { result } = await mountWithEmptyGrid();

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500));
    // The revert re-fetches the authoritative (still empty) grid. Since #62
    // the failure is carried by the returned `MutationResult`, not by a
    // shared error string the revert would immediately clear.
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    let outcome: Awaited<ReturnType<typeof result.current.placeTile>> | undefined;
    await act(async () => {
      outcome = await result.current.placeTile(7, 7, 'straight-h');
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ ok: false, status: 500, message: 'nope' });
    expect(result.current.loadError).toBeNull();
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

  it('a successful eraseTile reports success to its caller', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([tile({ id: 't1', x: 2, y: 2 })]));
    const { result } = renderHook(() => useGridEditor('layout-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockResolvedValueOnce(jsonResponse(undefined, 204));
    let outcome: Awaited<ReturnType<typeof result.current.eraseTile>> | undefined;
    await act(async () => {
      outcome = await result.current.eraseTile(2, 2);
    });

    expect(outcome).toMatchObject({ ok: true, status: 204 });
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

/**
 * Regression coverage for #62 — a refused grid write reported as a success.
 *
 * 403 is used to trigger it because that is what an operator session gets on
 * every `/grid` write, but the mechanism has nothing to do with roles: the
 * same swallow applied to a 404 on a stale `layoutId`, or a 500, or anything
 * else the backend can answer with. A 500 case is included to pin that.
 *
 * These assert on the value observed across EVERY render, not only the
 * terminal one. That distinction is the point: `placeTile` used to set an
 * error and then call `refresh()`, which opens with `setError(null)`, so a
 * terminal-value assertion would pass for the wrong reason — the message was
 * never committed to any render at all.
 */
describe('a refused write is reported, not swallowed (#62)', () => {
  const REFUSAL = { error: 'Admin role required' };

  it('painting a tile: the failure reaches the caller and the tile reverts', async () => {
    const observed: (string | null)[] = [];
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const { result } = renderHook(() => {
      const hook = useGridEditor('layout-1');
      observed.push(hook.loadError);
      return hook;
    });
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(REFUSAL, 403)) // the PUT
      .mockResolvedValueOnce(jsonResponse([])); // the revert refresh
    observed.length = 0;

    let outcome: Awaited<ReturnType<typeof result.current.placeTile>> | undefined;
    await act(async () => {
      outcome = await result.current.placeTile(1, 1, 'straight-h');
    });

    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(result.current.grid.has('1,1')).toBe(false);
    // The mutation failure must not be routed through the state `refresh()`
    // clears — that is the mechanism that erased it.
    expect(observed.every((e) => e === null)).toBe(true);
  });

  it('erasing a tile: the refusal reverts the tile back onto the screen', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([tile({ id: 't1', x: 3, y: 4 })]));
    const { result } = renderHook(() => useGridEditor('layout-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.grid.has('3,4')).toBe(true);

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(REFUSAL, 403)) // the DELETE
      .mockResolvedValueOnce(jsonResponse([tile({ id: 't1', x: 3, y: 4 })])); // revert

    let outcome: Awaited<ReturnType<typeof result.current.eraseTile>> | undefined;
    await act(async () => {
      outcome = await result.current.eraseTile(3, 4);
    });

    expect(outcome).toMatchObject({ ok: false, status: 403 });
    // Previously: no `res.ok` check at all, so the tile stayed gone on screen
    // while the backend still had it, and only a page reload revealed it.
    expect(result.current.grid.has('3,4')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // Acceptance criterion 3: the operator sees the backend's own message, not
  // a bare `HTTP 403`. `readErrorBody` in useLayoutConfig already extracts it.
  it.each([
    ['placeTile', (h: ReturnType<typeof useGridEditor>) => h.placeTile(0, 0, 'straight-h')],
    ['eraseTile', (h: ReturnType<typeof useGridEditor>) => h.eraseTile(0, 0)],
    ['clearAll', (h: ReturnType<typeof useGridEditor>) => h.clearAll()],
  ])("%s surfaces the backend's message rather than a bare status code", async (_name, call) => {
    const { result } = await mountWithEmptyGrid();

    fetchMock
      .mockResolvedValueOnce(jsonResponse(REFUSAL, 403))
      .mockResolvedValueOnce(jsonResponse([]));

    let outcome: { ok: boolean; message?: string } | undefined;
    await act(async () => {
      outcome = await call(result.current);
    });

    expect(outcome).toMatchObject({ ok: false, message: 'Admin role required' });
  });

  // The defect was never about roles — it was about not looking at the
  // response at all.
  it('a 500 on erase is surfaced and reverted just like a 403', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([tile({ id: 't1', x: 5, y: 5 })]));
    const { result } = renderHook(() => useGridEditor('layout-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'database is locked' }, 500))
      .mockResolvedValueOnce(jsonResponse([tile({ id: 't1', x: 5, y: 5 })]));

    let outcome: Awaited<ReturnType<typeof result.current.eraseTile>> | undefined;
    await act(async () => {
      outcome = await result.current.eraseTile(5, 5);
    });

    expect(outcome).toMatchObject({ ok: false, status: 500, message: 'database is locked' });
    expect(result.current.grid.has('5,5')).toBe(true);
  });

  // `clearAll` has no caller in GridEditor today, so this is the only thing
  // standing between a future "Clear grid" button and a control that silently
  // reports success on a refused wipe of the whole drawing.
  it('clearAll restores the grid when the wipe is refused', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([tile({ id: 't1', x: 1, y: 1 }), tile({ id: 't2', x: 2, y: 2 })]),
    );
    const { result } = renderHook(() => useGridEditor('layout-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));

    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(REFUSAL, 403))
      .mockResolvedValueOnce(
        jsonResponse([tile({ id: 't1', x: 1, y: 1 }), tile({ id: 't2', x: 2, y: 2 })]),
      );

    let outcome: Awaited<ReturnType<typeof result.current.clearAll>> | undefined;
    await act(async () => {
      outcome = await result.current.clearAll();
    });

    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(result.current.grid.size).toBe(2);
  });
});
