/**
 * The `NameBook` builder and the `NameBookCache` that owns it (#54, see
 * `docs/naming.md` for the full decision record D1–D10).
 *
 * `buildNameBook` is pure — it takes plain record arrays, not a repository —
 * so it stays unit-testable without a database. `NameBookCache` is the thin
 * stateful wrapper `LayoutService`/`ReservationService`/`TopologyService`
 * inject as an `INameBook`: it owns the one repository round-trip and caches
 * the result until the next `refresh`.
 */

import { BlockEdge, LayoutId, NameBook } from '../domain/types';
import { EMPTY_NAME_BOOK, buildEdgeLabel, truncateLabel } from '../domain/naming';
import { ILayoutRepository, LayoutRecord, LocoRecord, PointRecord, SensorRecord, BlockRecord } from '../ports/ILayoutRepository';
import { INameBook } from '../ports/INameBook';
import { BlockEdgeRowInvalidError } from './validation';

export interface NameBookSources {
  layouts: readonly LayoutRecord[];
  blocks: readonly BlockRecord[];
  points: readonly PointRecord[];
  sensors: readonly SensorRecord[];
  locos: readonly LocoRecord[];
  edges: readonly BlockEdge[];
}

/**
 * Pure. Truncates every value to `MAX_LABEL_CHARS` (D6). Edge labels are
 * derived from the UNTRUNCATED block names via `buildEdgeLabel` (D1) — the
 * assembled label is what gets truncated, not each half of it.
 */
export function buildNameBook(sources: NameBookSources): NameBook {
  const blockNames = new Map(sources.blocks.map((b) => [b.id, b.name] as const));

  const layouts = new Map(sources.layouts.map((l) => [l.id, truncateLabel(l.name)] as const));
  const blocks = new Map(sources.blocks.map((b) => [b.id, truncateLabel(b.name)] as const));
  const points = new Map(sources.points.map((p) => [p.id, truncateLabel(p.name)] as const));
  const sensors = new Map(sources.sensors.map((s) => [s.id, truncateLabel(s.name)] as const));
  const locos = new Map(sources.locos.map((l) => [l.address, truncateLabel(l.name)] as const));
  const edges = new Map(
    sources.edges.map((e) => [e.id, buildEdgeLabel(e, (id) => blockNames.get(id))] as const),
  );

  return { layouts, blocks, points, sensors, locos, edges };
}

/**
 * Caches the `NameBook` for one layout, rebuilding it from `ILayoutRepository`
 * on `refresh` (D5's invalidation points). Bound to one `layoutId` at
 * construction; `refresh` on any other layout id is a documented no-op, so a
 * config write against a non-running layout can never clobber the running
 * layout's book.
 */
export class NameBookCache implements INameBook {
  private book: NameBook = EMPTY_NAME_BOOK;

  constructor(
    private readonly repo: ILayoutRepository,
    private readonly boundLayoutId: LayoutId,
  ) {}

  get(): NameBook {
    return this.book;
  }

  async refresh(layoutId: LayoutId): Promise<void> {
    if (layoutId !== this.boundLayoutId) return;

    const [layouts, blocks, points, sensors, locos, edges] = await Promise.all([
      this.repo.listLayouts(),
      this.repo.listBlocks(layoutId),
      this.repo.listPoints(layoutId),
      this.repo.listSensors(layoutId),
      this.repo.listLocos(layoutId),
      // D10: `listBlockEdges` runs `parseBlockEdgeRow` and can throw
      // `BlockEdgeRowInvalidError` on a corrupt row. `LayoutService.reloadTopology`
      // now calls this refresh BEFORE `loadTopology`, whose own catch for
      // this same error is deliberately narrow (#10 — Safe-Stop on invalid
      // topology, not a bare throw). An unguarded refresh here would let the
      // error escape that narrow catch and regress #10. The name book is
      // diagnostic; it must never be the thing that fails, so this — and
      // ONLY this error — falls back to an empty edges map instead of
      // propagating. Anything else (a generic repository error) is left to
      // propagate, matching `loadTopology`'s own posture.
      this.repo.listBlockEdges(layoutId).catch((err) => {
        if (err instanceof BlockEdgeRowInvalidError) return [];
        throw err;
      }),
    ]);

    this.book = buildNameBook({ layouts, blocks, points, sensors, locos, edges });
  }
}

/** Inert default for every optional `INameBook` constructor parameter — `get()` returns `EMPTY_NAME_BOOK`, `refresh()` resolves without touching a repository. Keeps the ~60 existing test construction sites for `LayoutService`/`ReservationService`/`TopologyService` compiling untouched. */
export const INERT_NAME_BOOK: INameBook = {
  get: () => EMPTY_NAME_BOOK,
  refresh: async () => {},
};
