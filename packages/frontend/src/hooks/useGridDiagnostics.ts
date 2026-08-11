/**
 * useGridDiagnostics — the editor's read of what the drawing and the track
 * graph disagree about.
 *
 * Read-only by construction: there is no mutation here and there is no
 * corresponding write route. Diagnostics are advisory, never a gate — a buffer
 * contradicted by an edge is a drawing-versus-graph disagreement, not a
 * topology violation, and `TopologyService` does not start refusing edge
 * writes because of a tile (#84).
 *
 * `revision` is what the caller bumps after an edit, rather than this hook
 * polling. The findings are derived from the whole layout, so recomputing them
 * on every painted cell of a drag would be one request per tile for a result
 * nobody reads until the gesture ends.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { GridDiagnostic } from '../types';

export function useGridDiagnostics(layoutId: string | null, revision: number) {
  const [diagnostics, setDiagnostics] = useState<GridDiagnostic[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!layoutId) {
      setDiagnostics([]);
      return;
    }
    try {
      const res = await apiFetch(`/api/layouts/${layoutId}/grid/diagnostics`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setDiagnostics(await res.json());
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

  return { diagnostics, loadError, refresh };
}
