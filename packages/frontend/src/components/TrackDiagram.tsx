/**
 * TrackDiagram
 *
 * The presentational `<svg>`: grid lines, block tints, tile paths,
 * point-road letters, annotations, point labels, block run labels, and the
 * ruler gutters.
 *
 * ## What it deliberately does not draw
 *
 * **Compiled openings.** Boundary ticks, the `⊣` stop glyph and the opening
 * label were all drawn here until the operator asked for them to go: on a
 * layout whose graph is compiled and applied, an opening's name is disposable
 * output that nothing on the canvas needs, and three marks per opening were
 * competing for cells that carry occupancy, locks and block names. They are
 * still in the keyboard readout (`diagram/cursorAnnouncement.ts`), which is
 * where a name is asked for rather than always present, and in the Edges tab
 * and the compile diff, where an end label is the join key and means
 * something. See `docs/track-editor.md` D15.
 *
 * Extracted from `GridEditor.tsx` by #75. This component draws the railway
 * and nothing else — no palette, no ghost-preview *policy*, no mouse
 * painting, no writes. Those stay in `GridEditor`, which composes this
 * component and supplies its own mouse/keyboard handlers as props. That
 * split is what lets a future monitor view (#63/#82) mount this same
 * component with a read-only set of handlers instead of writing a second
 * renderer of the same railway.
 *
 * ## The live overlay (#63, #82)
 *
 * `live` is the optional second layer: what the layout is doing now. The
 * editor passes nothing and draws the railway exactly as it always did; the
 * monitor passes a `LiveDiagramState` and gets occupancy, locks and commanded
 * point roads on the same geometry. That is the whole point of #75 — one
 * renderer, so the two surfaces cannot drift.
 *
 * Two rules the overlay obeys, both from `docs/diagram-encoding.md`:
 *
 * - **State wins the colour channel.** Where live state is drawn, the block
 *   identity tint is *not* — a tile cannot carry two independent colour
 *   systems and stay readable. Block identity falls back to its label, which
 *   is a large part of why one-label-per-run (#68) matters beyond tidiness.
 * - **Colour is never the sole carrier.** Occupancy is a fill *and* a hatch
 *   pattern; a lock is an outline; a set road is solid where an unset one is
 *   dimmed. Every distinction survives the colour being removed.
 */

import { forwardRef } from 'react';
import { BlockRun } from '../diagram/blockRuns';
import { BLOCK_TINTS, BLOCK_TINT_OPACITY, INK, LOCK, OCCUPANCY, POINT_POSITION, SURFACE } from '../diagram/encoding';
import { DiagramPatternDefs } from '../diagram/patterns';
import { LiveDiagramState, perimeterEdges, roadSelection } from '../diagram/liveState';
import { edgeAnchor, roadLabel } from '../diagram/pointRoads';
import { chordPath, legPath } from '../diagram/trackGeometry';
import { shortPointLabel } from '../diagram/pointLabels';
import { rulerTicks } from '../diagram/ruler';
import { TilePath, TILE_SIZE } from '../diagram/tilePaths';
import {
  BlockRecord,
  GridTileMetadata,
  GridTileRecord,
  PointRecord,
  TileType,
  classifyTile,
} from '../types';

/**
 * Width/height of the ruler gutters (#94), in screen pixels — fixed
 * regardless of zoom, since it is UI chrome rather than part of the
 * drawing. The pan/zoom `<g>` is translated by this much so the gutters get
 * a reserved strip rather than overlapping the top-left of the content.
 */
export const RULER_SIZE = 20;

const T = TILE_SIZE;
const H = T / 2; // half tile

/** The paint tool's hover preview. Editor-only; omitted entirely for any other caller. */
export interface GhostPreview {
  cell: { x: number; y: number };
  tileType: TileType;
  rotation: number;
  /** The block name to preview under the tile, if one is selected. */
  blockName?: string | null;
}

/** A diagnostics "jump to" pulse ring (#94). Editor-only. */
export interface JumpPulse {
  x: number;
  y: number;
  id: number;
}

export interface TrackDiagramProps {
  grid: ReadonlyMap<string, GridTileRecord>;
  parsedMeta: ReadonlyMap<string, GridTileMetadata>;
  extent: { cols: number; rows: number };
  offset: { x: number; y: number };
  zoom: number;
  runs: readonly BlockRun[];
  tintOf: ReadonlyMap<string, number>;
  pointLabelAt: ReadonlyMap<string, string>;
  points: readonly PointRecord[];
  blocks: readonly BlockRecord[];
  sensorNames: ReadonlyMap<string, string>;
  /** Whether a label at this tile should currently be drawn — density is an authoring concern the caller owns. */
  labelsVisible: (x: number, y: number) => boolean;

  onKeyDown: (e: React.KeyboardEvent<SVGSVGElement>) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseUp: () => void;
  onMouseLeave: () => void;
  onWheel: (e: React.WheelEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;

  /**
   * The keyboard cursor's crosshair band (#94). Optional: a caller with no
   * notion of a cursor simply omits it and the crosshair does not draw.
   */
  cursor?: { x: number; y: number };
  /** The paint tool's hover preview. Editor-only. */
  ghostPreview?: GhostPreview;
  /** A diagnostics "jump to" pulse ring (#94). Editor-only. */
  jumpPulse?: JumpPulse;

  /**
   * The live overlay (#63/#82). Omitted or `null` for the Track Editor, which
   * is a config surface and deliberately shows no live state at all — see
   * `docs/liveness.md` M2.
   */
  live?: LiveDiagramState | null;

  /**
   * Accessible name and hover title for the canvas.
   *
   * Defaulted to the editor's wording rather than made required, so the
   * extraction stayed behaviour-preserving — but a monitor announcing itself
   * as an editor to a screen reader would be describing controls it does not
   * have, which is worse than a generic name.
   */
  accessibleName?: string;
  accessibleTitle?: string;
}

const EDITOR_A11Y_NAME =
  'Track diagram editor grid. Arrow keys move the cursor, Enter or Space paints the selected tile, Delete erases, Escape returns to the toolbar.';
const EDITOR_A11Y_TITLE =
  'Track diagram editor grid — arrow keys move the cursor, Enter/Space paints, Delete erases, Escape leaves the grid.';

export const TrackDiagram = forwardRef<SVGSVGElement, TrackDiagramProps>(function TrackDiagram(
  {
    grid,
    parsedMeta,
    extent,
    offset,
    zoom,
    runs,
    tintOf,
    pointLabelAt,
    points,
    blocks,
    sensorNames,
    labelsVisible,
    onKeyDown,
    onMouseDown,
    onMouseMove,
    onMouseUp,
    onMouseLeave,
    onWheel,
    onContextMenu,
    cursor,
    ghostPreview,
    jumpPulse,
    live,
    accessibleName = EDITOR_A11Y_NAME,
    accessibleTitle = EDITOR_A11Y_TITLE,
  },
  svgRef,
) {
  const gridW = extent.cols * TILE_SIZE;
  const gridH = extent.rows * TILE_SIZE;

  return (
    <svg
      ref={svgRef}
      style={{ cursor: 'crosshair', display: 'block', width: '100%', height: '100%' }}
      // #94: the canvas takes keyboard focus and hands the arrow keys to
      // itself rather than the screen reader's own navigation —
      // `docs/track-editor.md` D11 covers why `application` over `grid`.
      // `aria-label` is the accessible name read once on focus; the
      // `<title>` below is a native hover tooltip for a sighted mouse
      // user who never tabs in at all; the `aria-live` region GridEditor
      // renders below the canvas is what actually fires on every cursor
      // move — three different audiences, not one mechanism duplicated
      // three times.
      tabIndex={0}
      role="application"
      aria-label={accessibleName}
      onKeyDown={onKeyDown}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => {
        onMouseUp();
        onMouseLeave();
      }}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
    >
      <title>{accessibleTitle}</title>
      {/* Only mounted when there is live state to draw — the editor has no
          use for these and an unused <defs> in every editor render is noise
          in the DOM the e2e specs read back. */}
      {live && <DiagramPatternDefs />}
      <g transform={`translate(${offset.x + RULER_SIZE},${offset.y + RULER_SIZE}) scale(${zoom})`}>
        {/* Grid lines. Every 5th is emphasised (#94), for counting cells
            at a zoom too low for the ruler numbers to fit — the same
            `rulerTicks` maths the gutters below use, so the two can never
            disagree about which lines count as major. */}
        <rect width={gridW} height={gridH} fill="#11111b" rx={2} />
        {rulerTicks(extent.cols + 1, TILE_SIZE * zoom).map((tick) => (
          <line
            key={`v${tick.index}`}
            x1={tick.index * TILE_SIZE} y1={0}
            x2={tick.index * TILE_SIZE} y2={gridH}
            stroke={tick.major ? '#45475a' : SURFACE.gridLine}
            strokeWidth={tick.major ? 1 : 0.5}
          />
        ))}
        {rulerTicks(extent.rows + 1, TILE_SIZE * zoom).map((tick) => (
          <line
            key={`h${tick.index}`}
            x1={0} y1={tick.index * TILE_SIZE}
            x2={gridW} y2={tick.index * TILE_SIZE}
            stroke={tick.major ? '#45475a' : SURFACE.gridLine}
            strokeWidth={tick.major ? 1 : 0.5}
          />
        ))}

        {/*
          The cursor's crosshair band (#94) — a faint wash across its
          full row and full column, so "where am I" survives without the
          ruler or the readout being read at all. A *position*, not a
          colour: #81 forbids colour as the sole carrier of a
          distinction, and this carries none — it marks a place, the
          same way the crosshair on any drawing tool does.
        */}
        {cursor && (
          <>
            <rect x={0} y={cursor.y * TILE_SIZE} width={gridW} height={TILE_SIZE} fill={INK.primary} opacity={0.05} />
            <rect x={cursor.x * TILE_SIZE} y={0} width={TILE_SIZE} height={gridH} fill={INK.primary} opacity={0.05} />
          </>
        )}

        {/* Placed tiles. The block name is NOT drawn here — one label per
            contiguous run is drawn below instead (#68). */}
        {Array.from(grid.values()).map((tile) => {
          const meta = parsedMeta.get(`${tile.x},${tile.y}`) ?? {};
          const rotation = typeof meta.rotation === 'number' ? meta.rotation : 0;
          const tint =
            meta.blockId !== undefined ? tintOf.get(meta.blockId) : undefined;
          // Same raw-id fallback as the block labels below: a point tile
          // that draws no name at all is the specific complaint in #68.
          const pName = meta.pointId
            ? (points.find((p) => p.id === meta.pointId)?.name ?? meta.pointId)
            : null;
          const classification = classifyTile(meta);
          return (
            <g key={tile.id || `${tile.x},${tile.y}`}
              transform={`translate(${tile.x * TILE_SIZE},${tile.y * TILE_SIZE})`}>
              <rect width={T} height={T} fill={SURFACE.tile} />
              {/*
                One colour system per surface (`docs/diagram-encoding.md`).

                Without `live`, the wash is block **identity** — which block
                is this — assigned by graph colouring over adjacency so
                neighbours differ (#68/#81).

                With `live`, the wash is block **state** — occupied, clear,
                unknown — and identity gives up the colour channel entirely,
                falling back to the run label. That is the standing rule the
                encoding module records, and it is why one-label-per-run
                matters beyond tidiness: on the monitor the label is the
                *only* thing naming a block.

                Either way it is a wash under the track, never over it, so
                the drawing stays exactly as legible as it was.
              */}
              {live
                ? (() => {
                    const state = meta.blockId ? live.blocks.get(meta.blockId) : undefined;
                    if (!state) return null;
                    const enc = OCCUPANCY[state.occupancy];
                    return (
                      <>
                        <rect width={T} height={T} fill={enc.colour} opacity={BLOCK_TINT_OPACITY} />
                        {/* The pattern is what survives colour being removed
                            (#81). `clear` has none, and that flatness is
                            itself the distinction. */}
                        {enc.pattern && (
                          <rect
                            width={T}
                            height={T}
                            fill={`url(#${enc.pattern})`}
                            opacity={0.55}
                          />
                        )}
                      </>
                    );
                  })()
                : tint !== undefined && (
                    <rect
                      width={T}
                      height={T}
                      fill={BLOCK_TINTS[tint]}
                      opacity={BLOCK_TINT_OPACITY}
                    />
                  )}
              {/*
                #71, and #81's rule applied. Decorative track reads as
                obviously-not-monitored and unclassified track reads as
                unfinished, both **without relying on colour**: decorative
                is drawn faint, unclassified carries a corner glyph. An
                operator needs to know at a glance which parts of the
                diagram the system can actually see.
              */}
              <g
                transform={`rotate(${rotation}, ${H}, ${H})`}
                opacity={classification === 'decorative' ? 0.4 : 1}
                strokeDasharray={classification === 'decorative' ? '3 3' : undefined}
              >
                <TilePath type={tile.tileType as TileType} />
              </g>
              {classification === 'unclassified' && labelsVisible(tile.x, tile.y) && (
                <text
                  x={3}
                  y={T - 3}
                  fontSize={8}
                  fill={INK.secondary}
                  fontFamily="monospace"
                  stroke={SURFACE.tile}
                  strokeWidth={2.5}
                  paintOrder="stroke"
                >
                  ?
                </text>
              )}

              {/*
                #73 — which leg each position selects, drawn as a letter at
                the leg's outer edge. Static: the editor draws the mapping,
                not a live position. Until #25 there is no confirmed
                position to draw at all, and a mimic that implied one would
                be asserting a physical fact the system does not have.
              */}
              <g transform={`rotate(${rotation}, ${H}, ${H})`}>
                {(meta.pointRoads ?? []).map((road, i) => {
                  const anchor = edgeAnchor(road.legs[1], T);
                  const x = anchor.x + (anchor.x === 0 ? 5 : anchor.x === T ? -5 : 0);
                  const y = anchor.y + (anchor.y === 0 ? 9 : anchor.y === T ? -3 : 3);
                  return (
                    <text
                      key={i}
                      x={x}
                      y={y}
                      // Counter-rotated about its own anchor, so the letter is
                      // *placed* by the tile's rotation but never turned by it.
                      // A point rotated 180° drew an upside-down `N`, and `N`
                      // and `R` are symbols with no direction to carry — unlike
                      // the `⊣` stop glyph below, which points at the closed
                      // side and must keep turning with the tile.
                      transform={rotation ? `rotate(${-rotation}, ${x}, ${y})` : undefined}
                      textAnchor="middle"
                      fontSize={7}
                      fontWeight="bold"
                      fill={INK.primary}
                      fontFamily="monospace"
                      stroke={SURFACE.tile}
                      strokeWidth={2.5}
                      paintOrder="stroke"
                    >
                      {roadLabel(road)}
                    </text>
                  );
                })}
              </g>

              {/*
                The set road (#63), drawn only when there is live state.

                `docs/diagram-encoding.md` is explicit that a set road drawn
                solid against a dimmed unset one is *already* a non-colour
                encoding and should stay that way — so this is opacity and
                stroke weight, not a second hue. The third state,
                `indeterminate`, is the fail-safe one and gets the `unknown`
                colour and a dash: a point whose position the system cannot
                determine must not be drawn like one it can.

                Inside the rotation group, because `road.legs` are named in
                the tile's **unrotated** frame (`diagram/pointRoads.ts`) —
                the same reason the letters above are.

                Every position drawn here is **commanded**, never confirmed.
                There is no feedback channel until #25, and the view says so
                once rather than qualifying each point.
              */}
              {live && (meta.pointRoads?.length ?? 0) > 0 && (
                <g transform={`rotate(${rotation}, ${H}, ${H})`}>
                  {meta.pointRoads!.map((road, i) => {
                    const selection = roadSelection(road, live.points);
                    const enc =
                      selection === 'indeterminate' ? POINT_POSITION.unknown : POINT_POSITION.normal;
                    return (
                      <path
                        key={`live-${i}`}
                        d={
                          legPath(tile.tileType as TileType, road.legs, T) ??
                          chordPath(road.legs, T)
                        }
                        fill="none"
                        stroke={enc.colour}
                        strokeWidth={selection === 'selected' ? 5 : 3}
                        strokeLinecap="round"
                        strokeDasharray={selection === 'indeterminate' ? '3 3' : undefined}
                        opacity={selection === 'unselected' ? 0.12 : 0.85}
                      >
                        <title>
                          {`road ${roadLabel(road)}: ${
                            selection === 'selected'
                              ? 'set (commanded)'
                              : selection === 'unselected'
                                ? 'not set'
                                : 'position unknown'
                          }`}
                        </title>
                      </path>
                    );
                  })}
                </g>
              )}

              {/*
                #74 — placed entities. Generic by construction: the glyph
                is chosen from `entityType`, so signals (#79) and RFID
                readers (#39) each get a case rather than a new mechanism.
              */}
              {(meta.annotations ?? []).map((a, i) => (
                <g key={`${a.entityType}:${a.entityId}`} transform={`translate(${4 + i * 9}, 4)`}>
                  <circle cx={3.5} cy={3.5} r={3.5} fill="none" stroke={INK.primary} strokeWidth={1.2} />
                  <line x1={3.5} y1={0} x2={3.5} y2={7} stroke={INK.primary} strokeWidth={1} />
                </g>
              ))}
              {meta.annotations?.length && labelsVisible(tile.x, tile.y) ? (
                <text
                  x={H}
                  y={T - 12}
                  textAnchor="middle"
                  fontSize={6}
                  fill={INK.secondary}
                  fontFamily="monospace"
                  stroke={SURFACE.tile}
                  strokeWidth={2.5}
                  paintOrder="stroke"
                >
                  {meta.annotations
                    .map((a) => sensorNames.get(a.entityId) ?? a.entityId)
                    .join(' ')}
                </text>
              ) : null}

              {/*
                #93 — the point's name, drawn **once per point** at the tile
                `pointLabelAnchors` chose, and abbreviated to what a 40px
                cell can hold. The full name is the `<title>`, which serves
                the hover tooltip and assistive technology from one place.

                The `<title>` sits on a wrapping `<g>` rather than inside
                the `<text>`. As a child of `<text>` it is not drawn, but it
                *is* part of that element's `textContent` — so anything
                reading the diagram's text back, the e2e spec included, sees
                `Yard ThroatYard Th…` and the abbreviation stops being one.

                Still deliberately unlike a block label — italic, at the top
                of the cell, where a block label is upright at the bottom.
                Points and blocks are different namespaces and must not look
                alike (#68). The leading `⌥` that used to carry that
                distinction is gone: it is U+2325, the Mac option key, and
                it resolved to a replacement box in the monospace fallback.
              */}
              {pName &&
                pointLabelAt.get(`${tile.x},${tile.y}`) === meta.pointId &&
                labelsVisible(tile.x, tile.y) && (
                  <g>
                    <title>{pName}</title>
                    <text
                      x={H}
                      y={9}
                      textAnchor="middle"
                      fontSize={8}
                      fill={INK.primary}
                      fontFamily="monospace"
                      fontStyle="italic"
                      stroke={SURFACE.tile}
                      strokeWidth={2.5}
                      paintOrder="stroke"
                    >
                      {shortPointLabel(pName)}
                    </text>
                  </g>
                )}
            </g>
          );
        })}

        {/*
          A route lock, drawn as an outline **around the run** (#63).

          `docs/diagram-encoding.md` gives occupancy the fill and a lock the
          outline precisely so the two compose: a block can be locked and
          clear (the road set ahead of a train) or occupied and unlocked, and
          both must be readable at once.

          Around the run, not around each tile: per-tile boxes on a nine-tile
          block read as a hatched region rather than as one locked block,
          which is the exact distinction the outline exists to make.

          There is deliberately **no separate route layer**. Every block on a
          granted route carries `lockedByRoute`, so a route highlight would be
          a second mark for one fact, competing for tiles that already carry
          occupancy and this outline — see `diagram/liveState.ts` rule 2.
        */}
        {live &&
          runs.map((run) => {
            const state = live.blocks.get(run.blockId);
            if (!state?.lockedByRoute) return null;
            return (
              <g key={`lock-${run.blockId}`}>
                {perimeterEdges(run.tiles).map((e, i) => {
                  const x = e.x * TILE_SIZE;
                  const y = e.y * TILE_SIZE;
                  const [x1, y1, x2, y2] =
                    e.side === 'n'
                      ? [x, y, x + T, y]
                      : e.side === 's'
                        ? [x, y + T, x + T, y + T]
                        : e.side === 'w'
                          ? [x, y, x, y + T]
                          : [x + T, y, x + T, y + T];
                  return (
                    <line
                      key={`${e.x},${e.y},${e.side},${i}`}
                      x1={x1}
                      y1={y1}
                      x2={x2}
                      y2={y2}
                      stroke={LOCK.colour}
                      strokeWidth={LOCK.strokeWidth}
                      strokeDasharray={LOCK.strokeDasharray}
                    />
                  );
                })}
              </g>
            );
          })}

        {/* One block label per contiguous run, at a tile of that run. */}
        {runs.map((run) => {
          // Falls back to the raw id rather than rendering nothing, the
          // same degradation the NameBook contract takes (docs/naming.md
          // D8). If the block records fail to load, the tint would
          // otherwise be the only thing distinguishing one block from the
          // next — which is exactly the colour-alone encoding #81 forbids.
          const name = blocks.find((b) => b.id === run.blockId)?.name ?? run.blockId;
          if (!labelsVisible(run.labelAt.x, run.labelAt.y)) return null;

          /**
           * On the monitor the label carries the state in words as well —
           * `Up Platform ■ 🔒 Jinty` — because the fill and the outline are
           * both area treatments, and #81's rule is that no distinction may
           * rest on colour alone. The glyphs come from the encoding module so
           * the legend and the diagram cannot disagree about them.
           */
          const state = live?.blocks.get(run.blockId);
          const marks = state
            ? [
                OCCUPANCY[state.occupancy].glyph,
                state.lockedByRoute ? LOCK.glyph : null,
                // An occupied block with no identified occupant is a real,
                // common state — a rake of coaches. Say nothing rather than
                // implying the block is empty of vehicles.
                ...state.occupants.map((o) => o.name ?? `#${o.address}`),
              ]
                .filter(Boolean)
                .join(' ')
            : '';

          return (
            <text
              key={`${run.blockId}@${run.labelAt.x},${run.labelAt.y}`}
              x={run.labelAt.x * TILE_SIZE + H}
              y={run.labelAt.y * TILE_SIZE + T - 5}
              textAnchor="middle"
              fontSize={9}
              fill={INK.primary}
              fontFamily="monospace"
              // Halo, so a label crossing the track stays readable without
              // needing a background box that would hide the drawing.
              stroke={SURFACE.canvas}
              strokeWidth={3}
              paintOrder="stroke"
            >
              {marks ? `${name} ${marks}` : name}
            </text>
          );
        })}

        {/* Ghost preview tile under cursor.
            "This cell is already taken" is carried by the corner wedge as
            well as the colour, so the warning survives colour being
            removed (#81) — it was previously a red tint and nothing else. */}
        {ghostPreview && (() => {
          const occupied = grid.has(`${ghostPreview.cell.x},${ghostPreview.cell.y}`);
          return (
            <g transform={`translate(${ghostPreview.cell.x * TILE_SIZE},${ghostPreview.cell.y * TILE_SIZE})`}>
              <rect
                width={T}
                height={T}
                fill={occupied ? '#f38ba822' : '#89b4fa22'}
                stroke={occupied ? OCCUPANCY.occupied.colour : '#89b4fa'}
                strokeWidth={1}
                strokeDasharray="3 2"
              />
              {occupied && (
                <path
                  d={`M ${T - 11} 0 L ${T} 0 L ${T} 11 Z`}
                  fill={OCCUPANCY.occupied.colour}
                />
              )}
              <g opacity={0.45} transform={`rotate(${ghostPreview.rotation}, ${H}, ${H})`}>
                <TilePath type={ghostPreview.tileType} />
              </g>
              {ghostPreview.blockName && (
                <text x={T / 2} y={T - 5} textAnchor="middle"
                  fontSize={9} fill={INK.secondary} fontFamily="monospace"
                  stroke={SURFACE.canvas} strokeWidth={3} paintOrder="stroke"
                  opacity={0.8}>
                  {ghostPreview.blockName}
                </text>
              )}
            </g>
          );
        })()}

        {/*
          A diagnostic's "jump to" pulse (#94) — a fading ring, not a
          colour by itself: it marks the same cell the cursor and the
          crosshair just moved to, so the click's effect is visible as
          more than the readout text changing underneath you. `key`
          forces a remount on a repeat click at the same cell so the
          `<animate>` replays instead of sitting at its finished state.
        */}
        {jumpPulse && (
          <g
            key={jumpPulse.id}
            transform={`translate(${jumpPulse.x * TILE_SIZE},${jumpPulse.y * TILE_SIZE})`}
          >
            <rect width={T} height={T} fill="none" stroke={INK.primary} strokeWidth={3}>
              <animate attributeName="opacity" values="1;0.15;1;0.15;1;0" dur="0.9s" fill="freeze" />
            </rect>
          </g>
        )}
      </g>

      {/*
        Ruler gutters (#94) — deliberately drawn in this sibling `<g>`,
        outside the pan/zoom group above, and positioned by hand from
        `offset`/`zoom` rather than inheriting the `scale()` transform.
        Text inside a scaled group shrinks with it; at zoom 0.3 a
        scaled "11" is no longer legible, which is the exact failure a
        ruler exists to prevent. `rulerTicks` decides which columns/rows
        get a printed number at the current zoom, thinning them out
        rather than shrinking them further.
      */}
      <g aria-hidden="true">
        <rect x={0} y={0} width="100%" height={RULER_SIZE} fill={SURFACE.canvas} />
        <rect x={0} y={0} width={RULER_SIZE} height="100%" fill={SURFACE.canvas} />
        {rulerTicks(extent.cols, TILE_SIZE * zoom).map((tick) => {
          const x = offset.x + RULER_SIZE + (tick.index + 0.5) * TILE_SIZE * zoom;
          return (
            <g key={`rc${tick.index}`}>
              <line
                x1={x} y1={RULER_SIZE - (tick.major ? 8 : 4)}
                x2={x} y2={RULER_SIZE}
                stroke={INK.muted} strokeWidth={1}
              />
              {tick.label && (
                <text x={x} y={RULER_SIZE - 10} textAnchor="middle" fontSize={9}
                  fontFamily="monospace" fill={INK.secondary}>
                  {tick.index}
                </text>
              )}
            </g>
          );
        })}
        {rulerTicks(extent.rows, TILE_SIZE * zoom).map((tick) => {
          const y = offset.y + RULER_SIZE + (tick.index + 0.5) * TILE_SIZE * zoom;
          return (
            <g key={`rr${tick.index}`}>
              <line
                x1={RULER_SIZE - (tick.major ? 8 : 4)} y1={y}
                x2={RULER_SIZE} y2={y}
                stroke={INK.muted} strokeWidth={1}
              />
              {tick.label && (
                <text x={4} y={y + 3} fontSize={9} fontFamily="monospace" fill={INK.secondary}>
                  {tick.index}
                </text>
              )}
            </g>
          );
        })}
        {/* The corner where both gutters meet, so no gridline peeks through underneath it. */}
        <rect x={0} y={0} width={RULER_SIZE} height={RULER_SIZE} fill={SURFACE.canvas} />
      </g>
    </svg>
  );
});
