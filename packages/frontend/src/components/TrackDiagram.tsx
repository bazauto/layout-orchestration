/**
 * TrackDiagram
 *
 * The presentational `<svg>`: grid lines, block tints, tile paths,
 * point-road letters, annotations, opening port ticks and stop glyphs,
 * opening labels, point labels, block run labels, and the ruler gutters.
 *
 * Extracted from `GridEditor.tsx` by #75. This component draws the railway
 * and nothing else — no palette, no ghost-preview *policy*, no mouse
 * painting, no writes. Those stay in `GridEditor`, which composes this
 * component and supplies its own mouse/keyboard handlers as props. That
 * split is what lets a future monitor view (#63/#82) mount this same
 * component with a read-only set of handlers instead of writing a second
 * renderer of the same railway.
 *
 * Live state (occupancy, point position/lock, routes) is deliberately NOT a
 * prop here. This PR is the geometry-only extraction; #63/#82 bind a live
 * overlay to this component in a later PR, adding whatever shape it actually
 * needs once there is real state to validate against — an unused prop today
 * would only be a guess at that shape.
 */

import { forwardRef } from 'react';
import { BlockRun } from '../diagram/blockRuns';
import { BLOCK_TINTS, BLOCK_TINT_OPACITY, INK, OCCUPANCY, OPENING, SURFACE } from '../diagram/encoding';
import { edgeAnchor, roadLabel } from '../diagram/pointRoads';
import { portMarkGeometry } from '../diagram/openings';
import { shortPointLabel } from '../diagram/pointLabels';
import { rulerTicks } from '../diagram/ruler';
import { TilePath, TILE_SIZE } from '../diagram/tilePaths';
import {
  BlockRecord,
  CompiledOpening,
  GridTileMetadata,
  GridTileRecord,
  Port,
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
  portsAtCell: ReadonlyMap<string, { edge: Port['edge']; label: string }[]>;
  openingsAtCell: ReadonlyMap<string, CompiledOpening[]>;
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
}

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
    portsAtCell,
    openingsAtCell,
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
      aria-label="Track diagram editor grid. Arrow keys move the cursor, Enter or Space paints the selected tile, Delete erases, Escape returns to the toolbar."
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
      <title>
        Track diagram editor grid — arrow keys move the cursor, Enter/Space paints, Delete
        erases, Escape leaves the grid.
      </title>
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
          // #103 (D-H) — ports whose boundary sits on THIS tile (an
          // opening can span several tiles, so a port's own cell is not
          // necessarily `opening.at`) and openings whose *label* sits
          // here.
          const portsHere = portsAtCell.get(`${tile.x},${tile.y}`) ?? [];
          const openingsHere = openingsAtCell.get(`${tile.x},${tile.y}`) ?? [];
          return (
            <g key={tile.id || `${tile.x},${tile.y}`}
              transform={`translate(${tile.x * TILE_SIZE},${tile.y * TILE_SIZE})`}>
              <rect width={T} height={T} fill={SURFACE.tile} />
              {/* Block tint: a wash under the track, never over it, so the
                  drawing stays exactly as legible as it was. */}
              {tint !== undefined && (
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
                  return (
                    <text
                      key={i}
                      x={anchor.x + (anchor.x === 0 ? 5 : anchor.x === T ? -5 : 0)}
                      y={anchor.y + (anchor.y === 0 ? 9 : anchor.y === T ? -3 : 3)}
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
                #103 (D-H) — a tick at each tile boundary a compiled
                opening's ports actually cross. This is the mark #91's
                fused-siding bug argues for: a word at a *nearby* cell
                (the model this replaces, `docs/track-editor.md` D12) read
                as a perfectly plausible label right up until someone
                checked it against the drawing, and a mark at the *wrong*
                boundary is not plausible — it is visibly wrong. The tick
                says *where*; the block label below says *which*.

                Drawn in THIS `<g>`, never inside the sibling one below
                that applies `rotation` to `TilePath` — `port.edge` is
                already in the rotated (screen) frame
                (`diagram/openings.ts`), and rotating it again is the
                double-rotation bug that module's header warns about.
              */}
              {labelsVisible(tile.x, tile.y) &&
                portsHere.map((p, i) => {
                  const mark = portMarkGeometry(p, T);
                  return (
                    <line
                      key={`${p.edge}-${i}`}
                      x1={mark.x1}
                      y1={mark.y1}
                      x2={mark.x2}
                      y2={mark.y2}
                      stroke={OPENING.colour}
                      strokeWidth={2}
                      strokeLinecap="round"
                    >
                      <title>{p.label}</title>
                    </line>
                  );
                })}

              {/*
                The stop glyph, on a terminated opening's closed side.
                Drawn inside the same rotation `TilePath` uses below —
                `buffer` is the only palette tile that terminates today,
                and its stop block is always drawn just right of centre in
                the *unrotated* frame, so sharing that transform puts the
                glyph on the correct physical side without re-deriving
                which edge is "closed" a second time.
              */}
              {labelsVisible(tile.x, tile.y) && openingsHere.some((o) => o.terminated) && (
                <g transform={`rotate(${rotation}, ${H}, ${H})`}>
                  <text
                    x={H + 12}
                    y={H + 3}
                    textAnchor="middle"
                    fontSize={9}
                    fill={OPENING.colour}
                    fontFamily="monospace"
                    stroke={SURFACE.tile}
                    strokeWidth={2.5}
                    paintOrder="stroke"
                  >
                    ⊣
                  </text>
                </g>
              )}

              {/*
                The label, once per opening, at `opening.at` — the tile
                the compiler chose to carry it. Not "pinned"/"generated":
                unlike a `block_ends` row, a compiled label is disposable
                output with nothing referencing it between compiles (D8).
              */}
              {labelsVisible(tile.x, tile.y) &&
                openingsHere.map((o) => (
                  <text
                    key={o.label}
                    x={H}
                    y={H + 3}
                    textAnchor="middle"
                    fontSize={7}
                    fill={INK.secondary}
                    fontFamily="monospace"
                    stroke={SURFACE.canvas}
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {o.label}
                  </text>
                ))}
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

        {/* One block label per contiguous run, at a tile of that run. */}
        {runs.map((run) => {
          // Falls back to the raw id rather than rendering nothing, the
          // same degradation the NameBook contract takes (docs/naming.md
          // D8). If the block records fail to load, the tint would
          // otherwise be the only thing distinguishing one block from the
          // next — which is exactly the colour-alone encoding #81 forbids.
          const name = blocks.find((b) => b.id === run.blockId)?.name ?? run.blockId;
          if (!labelsVisible(run.labelAt.x, run.labelAt.y)) return null;
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
              {name}
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
