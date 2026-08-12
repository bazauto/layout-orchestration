/**
 * useEdgeProposals — the Edges tab's read of the candidate `block_edges` the
 * drawing implies (#78).
 *
 * Read-only by construction, exactly like `useGridDiagnostics`: there is no
 * mutation here because there is no accept endpoint to call. Accepting a
 * proposal is an ordinary `POST .../edges` through `ops.createEdge`, which
 * `TopologyService` validates the same way it validates a hand-authored edge.
 * That is what makes a bypass structurally impossible, and keeping this hook
 * write-free is how the frontend keeps its half of it.
 *
 * ## Why this one is lazy
 *
 * Unlike every other config read, nothing here is fetched on mount. The
 * response is a port walk over the whole grid from every block opening,
 * bounded but not cheap, and it is only ever wanted while somebody is actually
 * authoring edges. `refresh()` is called when the panel is opened and after
 * each accepted proposal — an accept changes the status of at least the
 * proposal just taken and its reverse, and the server is the only thing that
 * can recompute that (`reconcileProposals`).
 *
 * `loadError` holds the last failure and is *not* cleared by a subsequent
 * failure-free render, only by a successful fetch — the #62 posture: a stale
 * error is less misleading than no error.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { EdgeProposalReport } from '../types';

const EMPTY: EdgeProposalReport = { proposals: [], notes: [] };

export function useEdgeProposals(layoutId: string | null) {
  const [report, setReport] = useState<EdgeProposalReport>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** False until the first completed fetch, so the panel can tell "none found" from "not asked yet". */
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!layoutId) {
      setReport(EMPTY);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/layouts/${layoutId}/grid/edge-proposals`);
      if (!res.ok) {
        // The one status worth naming: the walk refuses rather than rendering
        // a wall of candidates nobody can review (`MAX_EDGE_PROPOSALS`), and
        // the body says how many it found.
        throw new Error(await describeFailure(res));
      }
      setReport((await res.json()) as EdgeProposalReport);
      setLoadError(null);
      setLoaded(true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [layoutId]);

  // Switching layouts must not leave the previous layout's proposals on
  // screen — those block ids mean something else here. Deliberately does not
  // fetch: see the header.
  useEffect(() => {
    setReport(EMPTY);
    setLoaded(false);
    setLoadError(null);
  }, [layoutId]);

  return { report, loading, loaded, loadError, refresh };
}

async function describeFailure(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object' && 'error' in body) {
      const err = (body as { error: unknown }).error;
      if (typeof err === 'string') return err;
    }
  } catch {
    // Non-JSON error body — fall through to the status.
  }
  return `HTTP ${res.status}`;
}
