/**
 * Opening marks — where a port actually sits on a tile boundary (#103 step
 * 6.1).
 *
 * ## Why a mark on the boundary, not a word at a nearby cell
 *
 * `docs/track-editor.md` D12 (superseded by #103) drew an end's label at the
 * tile the geometry chose to carry it, which is a *plausible* cell near the
 * opening rather than the boundary the opening actually is. #91's fused-siding
 * bug was invisible behind exactly that kind of plausible label: two yard
 * roads drawn side by side produced a perfectly reasonable-looking end name
 * while being wrongly fused into one. A mark drawn at the wrong boundary is
 * not plausible — it is visibly wrong, which is the entire argument for this
 * module. The label still says *which* opening; this says *where*.
 *
 * ## Frames, and the double-rotation bug
 *
 * `Port.edge` (`../types.ts`, mirroring the backend's `tileGeometry.ts`) is
 * already in the **rotated (screen)** frame — the compiler applies
 * `metadata.rotation` once, server-side, before it ever reaches here.
 * `portMarkGeometry` takes no rotation of its own and must not be drawn inside
 * the tile's rotated `<g>` (the one `TilePath` renders in) — doing either
 * would rotate an already-rotated edge a second time, which is the classic bug
 * the comment above `tileGeometry.ts`'s `Port` warns about.
 */

import { TileEdge } from '../types';
import { edgeAnchor } from './pointRoads';

/**
 * Which neighbouring cell each tile edge faces, in **screen** coordinates — y
 * increases downward, matching the SVG the editor draws.
 *
 * Mirrors the backend's `EDGE_OFFSET`
 * (`packages/backend/src/services/tileGeometry.ts`). A third small
 * backend→frontend duplicate alongside `findBlockRuns` and `TILE_LEGS`
 * (`CLAUDE.md` "Open limits"); #75 unifies all of them. Needed here only for
 * its direction, to turn a boundary point into a tick that crosses the
 * boundary rather than one that runs along it.
 */
const EDGE_OFFSET: Readonly<Record<TileEdge, { dx: number; dy: number }>> = {
  n: { dx: 0, dy: -1 },
  ne: { dx: 1, dy: -1 },
  e: { dx: 1, dy: 0 },
  se: { dx: 1, dy: 1 },
  s: { dx: 0, dy: 1 },
  sw: { dx: -1, dy: 1 },
  w: { dx: -1, dy: 0 },
  nw: { dx: -1, dy: -1 },
};

/** Full length of the tick mark, in local tile-pixel units, centred on the boundary it crosses. */
export const OPENING_TICK_LENGTH = 10;

/** The minimum a port needs for this module — never `x`/`y`, which the caller's own `<g translate>` already carries. */
export interface PortLike {
  edge: TileEdge;
}

/**
 * A short tick crossing the tile boundary a port names, centred on that
 * boundary's midpoint — or, for a diagonal `TileEdge`, its corner — and
 * running **perpendicular to the boundary**, which is the same direction the
 * opening faces (`EDGE_OFFSET`).
 *
 * Pure geometry: `size` is the caller's tile size in local SVG units (the
 * editor's `TILE_SIZE`), and the result is in that same local frame, ready to
 * draw inside the tile's `<g transform="translate(x*size, y*size)">` —
 * **not** inside the sibling `<g>` that applies `rotation`, since `port.edge`
 * already carries it.
 */
export function portMarkGeometry(
  port: PortLike,
  size: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const { dx, dy } = EDGE_OFFSET[port.edge];
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const anchor = edgeAnchor(port.edge, size);
  const half = OPENING_TICK_LENGTH / 2;
  return {
    x1: anchor.x - ux * half,
    y1: anchor.y - uy * half,
    x2: anchor.x + ux * half,
    y2: anchor.y + uy * half,
  };
}
