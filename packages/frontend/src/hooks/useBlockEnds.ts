/**
 * useBlockEnds — the Track Editor's view of `block_ends` (#72).
 *
 * Mutations return a per-call `MutationResult` rather than writing a shared
 * error string, the convention #62 settled on across the config surface: a
 * refused write must not be reported as a success, and a reload must not be
 * able to stamp on the only explanation the operator gets.
 *
 * That matters more here than elsewhere. Renaming an end that edges already
 * reference is refused with a 409, and the backend's own message names the
 * edges — a generic `HTTP 409` would leave the operator with no idea which
 * ones to fix.
 */

import { useCallback, useEffect, useState } from 'react';
import { mutate, MutationResult } from './useLayoutConfig';
import { apiFetch } from '../api';
import { BlockEndView, GenerateEndsSummary } from '../types';

function noLayout<T>(): MutationResult<T> {
  return { ok: false, status: 0, message: 'No layout selected' };
}

export function useBlockEnds(layoutId: string | null) {
  const [ends, setEnds] = useState<BlockEndView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!layoutId) {
      setEnds([]);
      return;
    }
    try {
      const res = await apiFetch(`/api/layouts/${layoutId}/block-ends`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEnds(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [layoutId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Regenerates the unpinned ends from the current drawing.
   *
   * Explicitly operator-triggered, never automatic (#72). Redrawing a corner
   * of the layout must not silently change names underneath authored edges,
   * and the summary this returns is the point: you see what was adopted,
   * created and removed before deciding whether the drawing was right.
   */
  const generate = useCallback(async (): Promise<MutationResult<GenerateEndsSummary>> => {
    if (!layoutId) return noLayout<GenerateEndsSummary>();
    const result = await mutate<GenerateEndsSummary>(
      `/api/layouts/${layoutId}/block-ends/generate`,
      { method: 'POST' },
    );
    if (result.ok) await refresh();
    return result;
  }, [layoutId, refresh]);

  /**
   * Creates an end by hand. Pinned by definition — you only do this to name
   * something the generator got wrong or cannot see.
   *
   * The case it exists for is `end-label-collision`: two openings of one block
   * facing the same way, which the generator refuses to name rather than
   * suffixing (#72). A silently suffixed label is exactly the kind that gets
   * typed wrong later in an edge.
   */
  const create = useCallback(
    async (blockId: string, label: string): Promise<MutationResult<BlockEndView>> => {
      if (!layoutId) return noLayout<BlockEndView>();
      const result = await mutate<BlockEndView>(`/api/layouts/${layoutId}/block-ends`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ blockId, label }),
      });
      if (result.ok) await refresh();
      return result;
    },
    [layoutId, refresh],
  );

  /** Renames an end and pins it. Renaming to its current label is how you pin a generated name you agree with. */
  const rename = useCallback(
    async (endId: string, label: string): Promise<MutationResult<BlockEndView>> => {
      if (!layoutId) return noLayout<BlockEndView>();
      const result = await mutate<BlockEndView>(`/api/layouts/${layoutId}/block-ends/${endId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label }),
      });
      if (result.ok) await refresh();
      return result;
    },
    [layoutId, refresh],
  );

  /**
   * Deletes an end.
   *
   * Refused with a 409 while any edge references it, for the same reason a
   * rename is: an end label is the only link between an edge and a block end,
   * so removing one silently orphans every edge using it. The backend's
   * message names the edges, and `mutate` carries it through — which is the
   * whole reason these return a `MutationResult` rather than writing a shared
   * error string (#62).
   */
  const remove = useCallback(
    async (endId: string): Promise<MutationResult<void>> => {
      if (!layoutId) return noLayout<void>();
      const result = await mutate<void>(`/api/layouts/${layoutId}/block-ends/${endId}`, {
        method: 'DELETE',
      });
      if (result.ok) await refresh();
      return result;
    },
    [layoutId, refresh],
  );

  return { ends, loadError, refresh, generate, create, rename, remove };
}
