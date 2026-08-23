/**
 * useOpenings
 *
 * Read-only, so there is nothing here to test beyond the shape
 * `useGridDiagnostics` already established: no fetch with no layout, load on
 * mount, refetch when `revision` bumps, and an error surfaced rather than
 * swallowed.
 */

import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOpenings } from './useOpenings';
import { CompiledOpening } from '../types';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function opening(overrides: Partial<CompiledOpening> = {}): CompiledOpening {
  return {
    blockId: 'block-1',
    label: 'east',
    at: { x: 1, y: 1 },
    terminated: false,
    ports: [{ x: 1, y: 1, edge: 'e' }],
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

describe('useOpenings', () => {
  it('does not fetch when layoutId is null, and openings stay empty', () => {
    const { result } = renderHook(() => useOpenings(null, 0));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.openings).toEqual([]);
  });

  it('loads openings on mount', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([opening()]));
    const { result } = renderHook(() => useOpenings('layout-1', 0));

    await waitFor(() => expect(result.current.openings).toHaveLength(1));
    expect(result.current.openings[0]).toEqual(opening());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/layouts/layout-1/grid/openings',
      expect.anything(),
    );
  });

  it('refetches when revision bumps, matching useGridDiagnostics', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const { result, rerender } = renderHook(({ revision }) => useOpenings('layout-1', revision), {
      initialProps: { revision: 0 },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fetchMock.mockResolvedValueOnce(jsonResponse([opening()]));
    rerender({ revision: 1 });

    await waitFor(() => expect(result.current.openings).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a failed load surfaces its error rather than swallowing it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'nope' }, 500));
    const { result } = renderHook(() => useOpenings('layout-1', 0));

    await waitFor(() => expect(result.current.loadError).not.toBeNull());
    expect(result.current.openings).toEqual([]);
  });
});
