/**
 * useLayoutConfig
 *
 * A 449-line CRUD hook against six REST resources (blocks, points, sensors,
 * locos, edges, topology) that mostly funnel through two shared helpers,
 * `json()` (the load path) and `mutate()` (every write). Per the issue #8
 * plan, full endpoint-by-endpoint coverage is disproportionate here, so this
 * file prioritises:
 *
 *  - the load lifecycle (`refresh`): success, the `loading` flag, and a
 *    failed request surfacing `error` without silently discarding whatever
 *    config was already loaded:
 *  - the block and loco CRUD paths (create/update/delete) as the
 *    representative exercise of `mutate()` and the direct-`apiFetch`
 *    `deleteBlock` path.
 *  - one edge-mutation test for `violations`, since that field only exists
 *    because of a 422 from `TopologyService` (see `mutate()`'s doc comment)
 *    and is otherwise untouched by the block/loco paths.
 *  - one route-mutation test for the documented "does NOT call refresh()"
 *    asymmetry (route state arrives over the WebSocket instead).
 *
 * Left uncovered, and left to the reader that this is a deliberate scope cut
 * rather than an oversight: points and sensors CRUD (identical shape to
 * blocks — same `mutate()` call, same refresh-on-success),
 * `acknowledgeSensorFault`, `cancelRoute`/`resumeRoute`/`acknowledgeRouteFault`
 * beyond the one asymmetry test above, and `updateEdge`.
 *
 * `apiFetch` (api.ts) is a thin wrapper over the global `fetch`, so `fetch`
 * itself is stubbed here rather than the `api` module — the request shape
 * (`method`, path, body) `useLayoutConfig` builds is part of what's under
 * test, matching the convention in useGridEditor.test.ts.
 */

import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mutate,
  useLayoutConfig,
  type DeleteBlockResult,
  type MutationResult,
} from './useLayoutConfig';
import { BlockRecord, LocoRecord, TopologyStatus } from '../types';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

const EMPTY_TOPOLOGY: TopologyStatus = { valid: true, violations: [], edgeCount: 0 };

function block(overrides: Partial<BlockRecord> = {}): BlockRecord {
  return { id: 'block-1', layoutId: 'layout-1', name: 'Up Platform', lengthMm: null, ...overrides };
}

function loco(overrides: Partial<LocoRecord> = {}): LocoRecord {
  return {
    id: 'loco-1',
    layoutId: 'layout-1',
    name: 'Class 37',
    address: 37,
    type: 'diesel',
    maxSpeed: 100,
    brakingFactor: 1,
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

/**
 * `refresh()` fires all six GETs in one `Promise.all`, in this fixed order
 * (blocks, points, sensors, locos, edges, topology) — each entry's
 * `apiFetch` call runs synchronously up to its own first `await`, so the
 * six `fetch` calls land on the mock in exactly this order every time.
 */
function queueRefreshResponses(overrides: {
  blocks?: unknown;
  points?: unknown;
  sensors?: unknown;
  locos?: unknown;
  edges?: unknown;
  topology?: unknown;
}) {
  fetchMock.mockResolvedValueOnce(jsonResponse(overrides.blocks ?? []));
  fetchMock.mockResolvedValueOnce(jsonResponse(overrides.points ?? []));
  fetchMock.mockResolvedValueOnce(jsonResponse(overrides.sensors ?? []));
  fetchMock.mockResolvedValueOnce(jsonResponse(overrides.locos ?? []));
  fetchMock.mockResolvedValueOnce(jsonResponse(overrides.edges ?? []));
  fetchMock.mockResolvedValueOnce(jsonResponse(overrides.topology ?? EMPTY_TOPOLOGY));
}

async function mountWithEmptyConfig(
  layoutId = 'layout-1',
): Promise<RenderHookResult<ReturnType<typeof useLayoutConfig>, string | null>> {
  queueRefreshResponses({});
  const view = renderHook(() => useLayoutConfig(layoutId));
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  fetchMock.mockClear();
  return view;
}

describe('useLayoutConfig', () => {
  describe('load lifecycle', () => {
    it('does not fetch when layoutId is null', () => {
      const { result } = renderHook(() => useLayoutConfig(null));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.config.blocks).toEqual([]);
      expect(result.current.loading).toBe(false);
    });

    it('a successful load populates every field of config', async () => {
      queueRefreshResponses({
        blocks: [block()],
        locos: [loco()],
        topology: { valid: false, violations: [{ kind: 'self-loop', edgeId: 'e1', blockId: 'block-1' }], edgeCount: 1 },
      });
      const { result } = renderHook(() => useLayoutConfig('layout-1'));

      // setLoading(true) runs synchronously before the six fetches' first
      // await, so it's already visible once the mount's effects flush.
      expect(result.current.loading).toBe(true);

      await waitFor(() => expect(result.current.loading).toBe(false));

      expect(result.current.config.layoutId).toBe('layout-1');
      expect(result.current.config.blocks).toEqual([block()]);
      expect(result.current.config.locos).toEqual([loco()]);
      expect(result.current.config.topology.valid).toBe(false);
      expect(result.current.config.topology.violations).toHaveLength(1);
      expect(result.current.error).toBeNull();
    });

    it('a failed load surfaces an error without discarding the previously loaded config', async () => {
      const { result } = await mountWithEmptyConfig();

      // First, a real successful load with a block in it.
      queueRefreshResponses({ blocks: [block()] });
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.config.blocks).toEqual([block()]);

      // Then a failing refresh. All six GETs still fire (Promise.all's array
      // is built eagerly, so every `apiFetch` call has already started before
      // Promise.all even receives it) — only the first (blocks) needs to
      // 500 to reject the whole `Promise.all` and skip `setConfig`; the rest
      // (points, sensors, locos, edges, topology) still need responses
      // queued or the mock has nothing to return them.
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'db down' }, 500));
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // points
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // sensors
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // locos
      fetchMock.mockResolvedValueOnce(jsonResponse([])); // edges
      fetchMock.mockResolvedValueOnce(jsonResponse(EMPTY_TOPOLOGY)); // topology
      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.error).toBe('HTTP 500');
      // Unlike useGridEditor (which reverts via a second refresh),
      // useLayoutConfig's refresh() has no revert step — a failed refresh
      // simply never calls setConfig, so the last-known-good config survives.
      expect(result.current.config.blocks).toEqual([block()]);
    });
  });

  describe('block CRUD', () => {
    it('createBlock POSTs the name, and only refreshes on success', async () => {
      const { result } = await mountWithEmptyConfig();

      fetchMock.mockResolvedValueOnce(jsonResponse(block({ id: 'new-block' })));
      queueRefreshResponses({ blocks: [block({ id: 'new-block' })] });

      let outcome: MutationResult<BlockRecord> | undefined;
      await act(async () => {
        outcome = await result.current.createBlock('Down Platform');
      });

      expect(outcome).toMatchObject({ ok: true, data: block({ id: 'new-block' }) });
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'http://localhost:3000/api/layouts/layout-1/blocks',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ name: 'Down Platform' }) }),
      );
      expect(result.current.config.blocks).toEqual([block({ id: 'new-block' })]);
    });

    it('createBlock does NOT refresh when the request is rejected, and surfaces the error message', async () => {
      const { result } = await mountWithEmptyConfig();

      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'name already in use' }, 409));

      let outcome: MutationResult<BlockRecord> | undefined;
      await act(async () => {
        outcome = await result.current.createBlock('Up Platform');
      });

      expect(outcome).toEqual({ ok: false, status: 409, message: 'name already in use', violations: undefined });
      // Only the one POST — no refresh() GETs followed it.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.config.blocks).toEqual([]);
    });

    it('updateBlock PUTs to the block id and refreshes on success', async () => {
      const { result } = await mountWithEmptyConfig();

      const renamed = block({ name: 'Renamed' });
      fetchMock.mockResolvedValueOnce(jsonResponse(renamed));
      queueRefreshResponses({ blocks: [renamed] });

      await act(async () => {
        await result.current.updateBlock('block-1', { name: 'Renamed' });
      });

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'http://localhost:3000/api/layouts/layout-1/blocks/block-1',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ name: 'Renamed' }) }),
      );
      expect(result.current.config.blocks).toEqual([renamed]);
    });

    it('deleteBlock surfaces removedEdges on success and refreshes', async () => {
      const { result } = await mountWithEmptyConfig();

      fetchMock.mockResolvedValueOnce(jsonResponse({ removedEdges: 2 }));
      queueRefreshResponses({});

      let outcome: DeleteBlockResult | undefined;
      await act(async () => {
        outcome = await result.current.deleteBlock('block-1');
      });

      expect(outcome).toEqual({ ok: true, removedEdges: 2 });
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'http://localhost:3000/api/layouts/layout-1/blocks/block-1',
        expect.objectContaining({ method: 'DELETE' }),
      );
    });

    it('deleteBlock surfaces the error message on failure without refreshing', async () => {
      const { result } = await mountWithEmptyConfig();

      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'block still referenced by an edge' }, 422));

      let outcome: DeleteBlockResult | undefined;
      await act(async () => {
        outcome = await result.current.deleteBlock('block-1');
      });

      expect(outcome).toEqual({ ok: false, message: 'block still referenced by an edge' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('loco CRUD', () => {
    it('createLoco POSTs the full payload and refreshes on success', async () => {
      const { result } = await mountWithEmptyConfig();

      const created = loco({ id: 'new-loco' });
      fetchMock.mockResolvedValueOnce(jsonResponse(created));
      queueRefreshResponses({ locos: [created] });

      await act(async () => {
        await result.current.createLoco('Class 37', 37, 'diesel', 100, 1);
      });

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'http://localhost:3000/api/layouts/layout-1/locos',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ name: 'Class 37', address: 37, type: 'diesel', maxSpeed: 100, brakingFactor: 1 }),
        }),
      );
      expect(result.current.config.locos).toEqual([created]);
    });

    it('updateLoco PUTs a partial payload to the loco id and refreshes on success', async () => {
      const { result } = await mountWithEmptyConfig();

      const updated = loco({ maxSpeed: 80 });
      fetchMock.mockResolvedValueOnce(jsonResponse(updated));
      queueRefreshResponses({ locos: [updated] });

      await act(async () => {
        await result.current.updateLoco('loco-1', { maxSpeed: 80 });
      });

      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'http://localhost:3000/api/layouts/layout-1/locos/loco-1',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ maxSpeed: 80 }) }),
      );
      expect(result.current.config.locos).toEqual([updated]);
    });

    it('deleteLoco refreshes on success and does not on failure', async () => {
      const { result } = await mountWithEmptyConfig();

      fetchMock.mockResolvedValueOnce(jsonResponse(undefined, 204));
      queueRefreshResponses({});

      let outcome: MutationResult<void> | undefined;
      await act(async () => {
        outcome = await result.current.deleteLoco('loco-1');
      });
      expect(outcome).toEqual({ ok: true, status: 204, data: undefined });

      fetchMock.mockClear();
      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'loco still assigned to an active route' }, 409));
      let failedOutcome: MutationResult<void> | undefined;
      await act(async () => {
        failedOutcome = await result.current.deleteLoco('loco-1');
      });
      expect(failedOutcome).toEqual({
        ok: false,
        status: 409,
        message: 'loco still assigned to an active route',
        violations: undefined,
      });
      expect(fetchMock).toHaveBeenCalledTimes(1); // no refresh
    });
  });

  describe('violations reach the caller (the reason mutate() exists)', () => {
    it('surfaces a 422 with its violations rather than swallowing the response', async () => {
      // This used to be asserted through `createEdge`, which is gone with the
      // manual edge write path (#103 PR 5). The behaviour it defended is not:
      // `mutate` is what every config write goes through, and a 422 carrying
      // `violations` still has to reach the caller intact — `CompilePanel`
      // renders exactly this shape when an apply is refused by the validator.
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'topology rejected',
            violations: [{ kind: 'self-loop', edgeId: 'e1', blockId: 'block-1' }],
          },
          422,
        ),
      );

      const outcome = await mutate('/api/layouts/layout-1/topology/compile/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ fingerprint: 'fp-1' }),
      });

      expect(outcome).toEqual({
        ok: false,
        status: 422,
        message: 'topology rejected',
        violations: [{ kind: 'self-loop', edgeId: 'e1', blockId: 'block-1' }],
      });
    });
  });

  describe('routes (no refresh — state arrives over the WebSocket)', () => {
    it('requestRoute never calls refresh, win or lose', async () => {
      const { result } = await mountWithEmptyConfig();

      fetchMock.mockResolvedValueOnce(jsonResponse({ id: 'route-1' }));
      await act(async () => {
        await result.current.requestRoute({ locoAddress: 37, startBlockId: 'block-1', destinationBlockId: 'block-2' });
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'no path found' }, 422));
      await act(async () => {
        await result.current.requestRoute({ locoAddress: 37, startBlockId: 'block-1', destinationBlockId: 'block-2' });
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * A Zod 400 carries the only actionable text in `details`, not `error`.
   * Reported from the live layout: adding an operator with a short password
   * showed "Invalid user payload" and nothing else.
   */
  describe('error message extraction', () => {
    it('surfaces a Zod field error rather than the generic error label', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'Invalid user payload',
            details: {
              formErrors: [],
              fieldErrors: { password: ['Password must be at least 8 characters'] },
            },
          },
          400,
        ),
      );

      const result = await mutate('/api/users', { method: 'POST' });

      expect(result.ok).toBe(false);
      expect(result.message).toBe('password: Password must be at least 8 characters');
    });

    it('joins multiple field errors and includes form-level errors', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'Invalid user payload',
            details: {
              formErrors: ['Unrecognized key: nickname'],
              fieldErrors: {
                username: ['Username is required'],
                password: ['Password must be at least 8 characters'],
              },
            },
          },
          400,
        ),
      );

      const result = await mutate('/api/users', { method: 'POST' });

      expect(result.message).toBe(
        'Unrecognized key: nickname; username: Username is required; password: Password must be at least 8 characters',
      );
    });

    it('falls back to the error field when there are no details', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Cannot demote the last admin account' }, 409),
      );

      const result = await mutate('/api/users/u1', { method: 'PATCH' });

      expect(result.message).toBe('Cannot demote the last admin account');
    });

    it('falls back to the error field when details carry no usable strings', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Invalid user payload', details: { formErrors: [], fieldErrors: {} } }, 400),
      );

      const result = await mutate('/api/users', { method: 'POST' });

      expect(result.message).toBe('Invalid user payload');
    });

    it('falls back to the status when the body is not JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 502,
        json: async () => {
          throw new Error('not JSON');
        },
      } as unknown as Response);

      const result = await mutate('/api/users', { method: 'POST' });

      expect(result.message).toBe('HTTP 502');
    });
  });
});
