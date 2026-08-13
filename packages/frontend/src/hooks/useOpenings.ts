/**
 * useOpenings — the editor's read of where each block opens (#103, D-H).
 *
 * Read-only by construction, exactly like `useGridDiagnostics`: there is no
 * mutation here and no corresponding write route. `GET .../grid/openings` is
 * pure geometry — no walk, no point-condition search — which is what makes it
 * cheap enough to call on every stroke end rather than only when a review
 * panel opens (that heavier read is `GET .../topology/compile`, D-H).
 *
 * `revision` is what the caller bumps after an edit, rather than this hook
 * polling. Openings are derived from the whole layout, so recomputing them on
 * every painted cell of a drag would be one request per tile for a result
 * nobody looks at until the gesture ends.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { CompiledOpening } from '../types';

export function useOpenings(layoutId: string | null, revision: number) {
  const [openings, setOpenings] = useState<CompiledOpening[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!layoutId) {
      setOpenings([]);
      return;
    }
    try {
      const res = await apiFetch(`/api/layouts/${layoutId}/grid/openings`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setOpenings(await res.json());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, [layoutId]);

  useEffect(() => {
    void refresh();
    // `revision` is a deliberate dependency: the caller bumps it when a stroke
    // ends, which is when a recompute is worth a round trip.
  }, [refresh, revision]);

  return { openings, loadError, refresh };
}
