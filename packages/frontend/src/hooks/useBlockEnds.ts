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

  return { ends, loadError, refresh, generate, rename };
}
