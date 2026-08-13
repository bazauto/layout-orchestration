/**
 * Port: IGraphCompletenessView
 *
 * A read-only view of how complete the compiled track graph is (#103, D6),
 * implemented by `CompileService` and injected into `LayoutService` the same
 * way `INameBook` is — an optional trailing constructor parameter with an inert
 * default, so every existing construction compiles unchanged.
 *
 * ## Why a port rather than a `CompileService` reference
 *
 * `LayoutService` must not depend on the compiler. It has no business reading a
 * tile, and `CompileService` reads nothing but tiles; the whole guardrail
 * `docs/track-grid.md` records is that a domain decision never comes from the
 * drawing. What crosses this boundary is deliberately **one number** — how many
 * holes the graph has — which is a fact about `block_edges`, not about the
 * picture it was compiled from.
 *
 * ## Why it is read live rather than cached
 *
 * A mode change is a rare, human-initiated action, and the walk is 90 tiles on
 * Westgate Hollow. A cached gap count is a second source of truth about exactly
 * the thing #103 exists to stop having two of, and a stale one would gate `auto`
 * on a graph the operator has already fixed — or, worse, permit it on one they
 * have just broken.
 */

import { LayoutId } from '../domain/types';

export interface IGraphCompletenessView {
  /**
   * How many gaps the drawing currently compiles to.
   *
   * `0` means the compiler is confident about the whole railway. Anything above
   * that is a hole it declined to guess at, recorded outside the graph rather
   * than inside it wearing a badge (D6).
   */
  gapCount(layoutId: LayoutId): Promise<number>;
}

/**
 * The default: a graph with no gaps, gating nothing.
 *
 * Not a fail-closed default, and deliberately so. This is what an unwired
 * `LayoutService` gets — every existing test, and any process that never
 * constructed a compiler — and in that configuration nothing has *said*
 * anything about completeness, so refusing `auto` would be inventing a
 * limitation from an absent dependency rather than reporting one. The real
 * fail-safe here is elsewhere and stronger: a graph with holes cannot route a
 * train through them, because the edges simply are not there.
 */
export const INERT_GRAPH_COMPLETENESS: IGraphCompletenessView = {
  gapCount: async () => 0,
};
