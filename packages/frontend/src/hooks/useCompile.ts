/**
 * useCompile — the Edges tab's read of the graph the drawing implies, and the
 * one write that turns it into `block_edges` (#103 PR 5).
 *
 * ## Why this one is lazy
 *
 * Nothing here is fetched on mount, unlike every other config read. The
 * response is a branch search over the whole grid from every block opening —
 * bounded, but not cheap — and it is only wanted while somebody is actually
 * reviewing. `refresh()` runs when the panel is opened and after an apply.
 * `GET .../grid/openings` is the cheap read the Track Editor uses per stroke;
 * this is the expensive one, and they are two routes precisely so this cost is
 * paid on purpose (D-H).
 *
 * ## The apply carries a fingerprint and nothing else
 *
 * Not the rows. The server recompiles the drawing and refuses if it has moved
 * since the review, which is what makes "approve one graph, apply another"
 * impossible rather than merely unlikely. A body carrying edges is a 400 — a
 * second authoring path wearing the compiler's name is the bypass D1 and D3
 * exist to prevent, and it must not be reachable from here either.
 *
 * The fingerprint sent is the one from the report **currently on screen**, so
 * what the operator approved and what is applied are the same artefact by
 * construction.
 *
 * `loadError` holds the last failure and is *not* cleared by a subsequent
 * failure-free render, only by a successful fetch — the #62 posture: a stale
 * error is less misleading than no error.
 */

import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import { CompileView, TopologyViolation } from '../types';

const EMPTY: CompileView = {
  report: { fingerprint: '', edges: [], gaps: [], components: [] },
  status: {
    compiledAt: null,
    compiledFingerprint: null,
    drawingFingerprint: '',
    stale: true,
    gapCount: 0,
  },
  diff: { added: [], removed: [], unchanged: [], changed: [], relabelled: [] },
};

/**
 * The outcome of an apply.
 *
 * `status` is carried through rather than flattened to a boolean because the
 * three refusals need different words: a 409 means the drawing moved and the
 * answer is re-compile, a 422 means the railway the drawing describes is
 * invalid and the answer is redraw it, and a 403 means you are not an admin.
 */
export type ApplyOutcome =
  | { ok: true }
  | { ok: false; status: number; message: string; violations?: TopologyViolation[] };

export function useCompile(layoutId: string | null) {
  const [view, setView] = useState<CompileView>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** False until the first completed fetch, so the panel can tell "nothing found" from "not asked yet". */
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    if (!layoutId) {
      setView(EMPTY);
      return;
    }
    setLoading(true);
    try {
      const res = await apiFetch(`/api/layouts/${layoutId}/topology/compile`);
      if (!res.ok) throw new Error((await readError(res)).message);
      setView((await res.json()) as CompileView);
      setLoadError(null);
      setLoaded(true);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [layoutId]);

  /**
   * Applies the report currently held in `view`.
   *
   * Deliberately does **not** re-read before posting: sending a freshly fetched
   * fingerprint would defeat the guard entirely, since the whole point is that
   * the fingerprint attests to what a human looked at. If the drawing has moved
   * the server says so and the operator looks again.
   */
  const apply = useCallback(async (): Promise<ApplyOutcome> => {
    if (!layoutId) return { ok: false, status: 0, message: 'No layout selected' };

    const res = await apiFetch(`/api/layouts/${layoutId}/topology/compile/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fingerprint: view.report.fingerprint }),
    });

    if (!res.ok) {
      const { message, violations } = await readError(res);
      return { ok: false, status: res.status, message, violations };
    }

    // The response *is* the post-apply view — an empty diff and `stale: false`,
    // re-read from storage rather than assumed. Using it directly is both a
    // saved round trip and the honest thing to display: what is on screen is
    // what the server says is stored.
    setView((await res.json()) as CompileView);
    setLoaded(true);
    setLoadError(null);
    return { ok: true };
  }, [layoutId, view.report.fingerprint]);

  // Switching layouts must not leave the previous layout's report on screen —
  // those block ids mean something else here. Deliberately does not fetch: see
  // the header.
  useEffect(() => {
    setView(EMPTY);
    setLoaded(false);
    setLoadError(null);
  }, [layoutId]);

  return { view, loading, loaded, loadError, refresh, apply };
}

async function readError(
  res: Response,
): Promise<{ message: string; violations?: TopologyViolation[] }> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const violations =
        'violations' in body ? (body as { violations: TopologyViolation[] }).violations : undefined;
      if ('error' in body) {
        const err = (body as { error: unknown }).error;
        if (typeof err === 'string') return { message: err, violations };
      }
      return { message: `HTTP ${res.status}`, violations };
    }
  } catch {
    // Non-JSON error body — fall through to the status.
  }
  return { message: `HTTP ${res.status}` };
}
