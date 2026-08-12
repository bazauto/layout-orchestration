/**
 * GridEditor
 *
 * SVG tile-based track layout editor.
 *
 * Controls:
 *   Left-click / drag        — paint selected tile type
 *   Right-click              — erase tile
 *   Middle-drag               — pan
 *   Scroll wheel              — zoom
 *   Arrow keys                — move the cursor (#94)
 *   Enter / Space              — paint at the cursor
 *   Delete / Backspace         — erase at the cursor
 *   Escape                     — leave the grid, back to the toolbar
 *
 * The canvas takes keyboard focus (`tabIndex`, `role="application"`) so all
 * of the above works without a mouse — see `docs/track-editor.md` D11.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGridEditor } from '../hooks/useGridEditor';
import { useBlockEnds } from '../hooks/useBlockEnds';
import { useGridDiagnostics } from '../hooks/useGridDiagnostics';
import { assignRunTints, findBlockRuns } from '../diagram/blockRuns';
import { BLOCK_TINTS, BLOCK_TINT_OPACITY, INK, OCCUPANCY, SURFACE } from '../diagram/encoding';
import { describeDiagnostic, diagnosticCoordinate, partitionDiagnostics } from '../diagram/diagnostics';
import { defaultPointRoads, edgeAnchor, isPointTile, roadLabel } from '../diagram/pointRoads';
import { pointLabelAnchors, shortPointLabel } from '../diagram/pointLabels';
import { describeCursor } from '../diagram/cursorAnnouncement';
import { rulerTicks } from '../diagram/ruler';
import { GridDiagnostic, GridTileMetadata, TileType, classifyTile } from '../types';
import { BlockRecord, PointRecord, SensorRecord } from '../types';

interface Props {
  layoutId: string | null;
  blocks: BlockRecord[];
  points: PointRecord[];
  sensors: SensorRecord[];
}

const TILE_SIZE = 40;

/**
 * The canvas the editor draws when the grid is empty. **Not a limit** — the
 * drawn extent grows with the content (`useGridExtent`), which is what #69
 * asked for in preference to a bigger constant. Westgate Hollow already
 * reached column 29 of the old fixed 30, and raising the number would only
 * have moved the wall.
 */
const MIN_COLS = 30;
const MIN_ROWS = 20;

/** Blank columns/rows kept beyond the furthest tile, so there is always room to draw on. */
const GROWTH_MARGIN = 6;

/**
 * Hard upper bound on a coordinate.
 *
 * Admission control against a fat finger or a stray script creating a tile
 * nothing can ever scroll to — not a canvas size. It deliberately matches the
 * bound the backend validates against (`MAX_TILE_COORDINATE`, #70); if that
 * one changes, change this with it. A layout ~1000 tiles across is already far
 * beyond anything a physical railway needs.
 */
const MAX_COORDINATE = 999;

/** How many strokes of undo to keep. A stroke, not a tile — see `pushUndo`. */
const UNDO_LIMIT = 50;

/**
 * Width/height of the ruler gutters (#94), in screen pixels — fixed
 * regardless of zoom, since it is UI chrome rather than part of the
 * drawing. The pan/zoom `<g>` is translated by this much so the gutters get
 * a reserved strip rather than overlapping the top-left of the content.
 */
const RULER_SIZE = 20;

/** Grid-cell deltas for the four arrow keys — the keyboard cursor movement `onCanvasKeyDown` reads (#94). */
const ARROW_DELTAS: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 },
};

// ─── Tile palette ─────────────────────────────────────────────────────────────

const PALETTE: { type: TileType; label: string; icon: string; key: string }[] = [
  { type: 'straight-h',  label: 'Straight', icon: '─', key: '1' },
  { type: 'straight-45', label: 'Corner',   icon: '╱', key: '2' },
  { type: 'point-left',  label: 'Point L',  icon: '⊣', key: '3' },
  { type: 'point-right', label: 'Point R',  icon: '⊢', key: '4' },
  { type: 'crossing',    label: 'Crossing', icon: '╋', key: '5' },
  { type: 'buffer',      label: 'Buffer',   icon: '■', key: '6' },
  { type: 'platform',    label: 'Platform', icon: '▬', key: '7' },
];

const TRACK_COLOUR = '#89b4fa';
const SLEEPER_COLOUR = '#585b70';
const T = TILE_SIZE;
const H = T / 2; // half tile

// ─── SVG paths per tile type ─────────────────────────────────────────────────

function TilePath({ type }: { type: TileType }) {
  const stroke = { stroke: TRACK_COLOUR, strokeWidth: 4, fill: 'none', strokeLinecap: 'round' as const };
  const sleeper = { stroke: SLEEPER_COLOUR, strokeWidth: 2, fill: 'none' };

  // Sleeper marks across the track
  const sleeperMarks = (positions: number[], vertical = false) =>
    positions.map((p, i) =>
      vertical
        ? <line key={i} x1={H - 7} y1={p} x2={H + 7} y2={p} {...sleeper} />
        : <line key={i} x1={p} y1={H - 7} x2={p} y2={H + 7} {...sleeper} />,
    );

  switch (type) {
    case 'straight-h':
      return <>
        {sleeperMarks([8, 16, 24, 32])}
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
      </>;
    case 'straight-v':
      return <>
        {sleeperMarks([8, 16, 24, 32], true)}
        <line x1={H} y1={0} x2={H} y2={T} {...stroke} />
      </>;
    case 'straight-45':
      return (
        // Midpoint-to-midpoint diagonal so adjacent tiles connect cleanly
        <line x1={0} y1={H} x2={H} y2={0} {...stroke} />
      );
    case 'curve':
      // Quarter-circle connecting left-centre → bottom-centre.
      // Rotate 90° → bottom→right, 180° → right→top, 270° → top→left.
      return <path d={`M 0 ${H} A ${H} ${H} 0 0 0 ${H} ${T}`} {...stroke} />;
    case 'curve-ne':
      return <path d={`M ${H} ${T} A ${H} ${H} 0 0 1 ${T} ${H}`} {...stroke} />;
    case 'curve-nw':
      return <path d={`M ${H} ${T} A ${H} ${H} 0 0 0 ${0} ${H}`} {...stroke} />;
    case 'curve-se':
      return <path d={`M ${H} ${0} A ${H} ${H} 0 0 0 ${T} ${H}`} {...stroke} />;
    case 'curve-sw':
      return <path d={`M ${H} ${0} A ${H} ${H} 0 0 1 ${0} ${H}`} {...stroke} />;
    case 'point-left':
      // Through line left→right. Divergent forks at left-center up to top-center.
      // Place a Corner@180° directly above to redirect to a parallel track.
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <line x1={0} y1={H} x2={H} y2={0} {...{ ...stroke, strokeWidth: 3, stroke: '#cba6f7' }} />
      </>;
    case 'point-right':
      // Divergent forks at left-center down to bottom-center.
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <line x1={0} y1={H} x2={H} y2={T} {...{ ...stroke, strokeWidth: 3, stroke: '#cba6f7' }} />
      </>;
    case 'crossing':
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <line x1={H} y1={0} x2={H} y2={T} {...stroke} />
      </>;
    case 'buffer':
      return <>
        <line x1={0} y1={H} x2={H} y2={H} {...stroke} />
        <rect x={H - 2} y={H - 8} width={10} height={16} fill={TRACK_COLOUR} rx={2} />
      </>;
    case 'platform':
      return <>
        <line x1={0} y1={H} x2={T} y2={H} {...stroke} />
        <rect x={4} y={H - 12} width={T - 8} height={8} fill="#a6e3a1" rx={2} opacity={0.7} />
      </>;
    default:
      return null;
  }
}

// ─── Undo ─────────────────────────────────────────────────────────────────────

/**
 * What was at a coordinate before a stroke touched it. `null` means the cell
 * was empty, so the inverse of whatever happened there is an erase.
 */
interface UndoEntry {
  x: number;
  y: number;
  before: { tileType: TileType; metadata: Record<string, unknown> } | null;
}

// ─── Viewport persistence ─────────────────────────────────────────────────────

interface SavedView {
  offset: { x: number; y: number };
  zoom: number;
}

const DEFAULT_VIEW: SavedView = { offset: { x: 0, y: 0 }, zoom: 1 };

const viewKey = (layoutId: string) => `layout-orchestrator:gridView:${layoutId}`;

/**
 * Per-layout, and tolerant of anything it finds: this is a convenience, and a
 * corrupt or hand-edited entry must never stop the editor opening.
 */
function loadView(layoutId: string | null): SavedView | null {
  if (!layoutId) return null;
  try {
    const raw = window.localStorage.getItem(viewKey(layoutId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SavedView>;
    if (
      typeof parsed?.zoom !== 'number' ||
      !Number.isFinite(parsed.zoom) ||
      typeof parsed.offset?.x !== 'number' ||
      typeof parsed.offset?.y !== 'number' ||
      !Number.isFinite(parsed.offset.x) ||
      !Number.isFinite(parsed.offset.y)
    ) {
      return null;
    }
    return { offset: { x: parsed.offset.x, y: parsed.offset.y }, zoom: parsed.zoom };
  } catch {
    return null;
  }
}

// ─── Main component ───────────────────────────────────────────────────────────

export function GridEditor({ layoutId, blocks, points, sensors }: Props) {
  const { grid, loading, loadError, placeTile, eraseTile } = useGridEditor(layoutId);

  /**
   * Bumped when a gesture ends, not when a cell is painted.
   *
   * Diagnostics are derived from the whole layout, so recomputing them per
   * painted cell of a drag would be one round trip per tile for a result
   * nobody reads until the drag stops.
   */
  const [gridRevision, setGridRevision] = useState(0);

  const { ends, generate: generateEnds } = useBlockEnds(layoutId);
  const { diagnostics } = useGridDiagnostics(layoutId, gridRevision);

  /**
   * The last refused write, held here rather than in the hook (#62).
   *
   * A mutation's failure must outlive the `refresh()` that reverts it, and
   * `refresh()` clears the hook's own `loadError`. Keeping the two apart is
   * what stops a revert from erasing the only explanation the operator gets —
   * the tile used to flicker on and vanish with no message at all.
   *
   * Cleared on the next write that succeeds, not on a timer: a stale error is
   * less misleading than no error, which is the whole complaint in #62.
   */
  const [writeError, setWriteError] = useState<string | null>(null);

  const [selectedType, setSelectedType] = useState<TileType>('straight-h');
  const [selectedRotation, setSelectedRotation] = useState(0);
  const [selectedBlockId, setSelectedBlockId] = useState<string>('');
  const [selectedPointId, setSelectedPointId] = useState<string>('');

  /**
   * Painting track versus placing an entity on track that is already drawn.
   *
   * Two modes rather than a modifier key, because an annotation is a different
   * kind of edit: it changes an existing tile's metadata and never creates or
   * destroys a tile. Clicking an empty cell in annotate mode does nothing —
   * there is nothing to annotate — and says so, rather than silently painting
   * a tile the operator did not ask for.
   */
  const [paintMode, setPaintMode] = useState<'track' | 'annotate'>('track');

  /**
   * #71 — paint this stroke as *deliberately* not part of any block.
   *
   * The whole point of the classification: "I meant this" and "I have not got
   * to this yet" used to be the same absent key, so the editor could not
   * warn about either without warning about both.
   */
  const [paintDecorative, setPaintDecorative] = useState(false);

  const [selectedSensorId, setSelectedSensorId] = useState<string>('');

  /**
   * #73 — which drawn leg the point's `normal` position selects.
   *
   * Defaults to the conventional wiring (through road is normal) and is
   * captured *while the point is being placed*, which is the only time it is
   * cheap. A retrofit means revisiting every point tile on the layout by hand.
   */
  const [divergentIsNormal, setDivergentIsNormal] = useState(false);

  const [showDiagnostics, setShowDiagnostics] = useState(false);
  /** Summary of the last `Ends ⟳`, so a regeneration reports what it changed rather than happening invisibly. */
  const [endsSummary, setEndsSummary] = useState<string | null>(null);

  /**
   * Label density (#68 item 4). The useful density genuinely differs between
   * authoring — where you are checking every tile carries the block you meant
   * — and reading, where the labels are clutter over track you already know.
   * Defaults to `always`, which is the authoring case and the screen this is.
   */
  const [labelDensity, setLabelDensity] = useState<'always' | 'hover' | 'off'>('always');

  // Viewport pan/zoom. Restored from the last visit to this layout (#69) —
  // reopening the tab should put you back where you were, not at the origin
  // of a layout that may be drawn nowhere near it.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isPainting, setIsPainting] = useState(false);
  const [hoverCell, setHoverCell] = useState<{ x: number; y: number } | null>(null);

  /**
   * The keyboard cursor (#94) — distinct from `hoverCell` above, which the
   * mouse clears the moment it leaves the canvas. `cursor` is where a
   * keyboard user (or a screen reader announcement) currently *is*, and that
   * has to survive the mouse never having touched the canvas at all, which
   * is why it starts at the origin rather than `null`.
   *
   * Mouse hover also updates it (see `onMouseMove`), so the two input paths
   * converge on this one piece of state rather than the readout having to
   * pick between two possibly-disagreeing cells.
   */
  const [cursor, setCursor] = useState({ x: 0, y: 0 });

  /**
   * The cell a diagnostics-panel "jump to" click most recently landed on
   * (#94), briefly drawn with a fading ring so the jump is visible as well
   * as just moving the cursor. `id` forces React to remount the `<g>` on a
   * repeat click at the same cell, which is what makes the SVG `<animate>`
   * replay rather than sitting at its already-finished end state.
   */
  const [pulseCell, setPulseCell] = useState<{ x: number; y: number; id: number } | null>(null);
  const pulseTimer = useRef<number | null>(null);
  const pulseId = useRef(0);

  const svgRef = useRef<SVGSVGElement>(null);
  /**
   * Focused on Escape (#94). `role="application"` hands the canvas the
   * arrow keys and takes them away from the screen reader's own navigation,
   * so there has to be an obvious, keyboard-only way back out. `tabIndex={-1}`
   * keeps the toolbar itself out of the normal tab order — it was never a
   * stop before, and Escape reaching it is a targeted exit, not a new place
   * Tab lands on.
   */
  const toolbarRef = useRef<HTMLDivElement>(null);
  const panStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);

  /**
   * Undo stack, one entry per **stroke** rather than per tile.
   *
   * A drag paints or erases a run of tiles as one gesture, and undoing it one
   * tile at a time would be useless for the case that motivated this: a stray
   * right-drag across the diagram deletes a run, one DELETE per tile, on a
   * config surface representing an afternoon of authoring.
   *
   * Each entry records what was at a coordinate *before* the stroke touched
   * it, so undo is a replay of inverses — safe precisely because each tile is
   * an independent upsert/delete. It is client-side and deliberately not
   * persisted: it describes this session's edits, and an undo stack that
   * outlived a reload would be offering to revert changes made from another
   * browser.
   */
  const [undoStack, setUndoStack] = useState<UndoEntry[][]>([]);
  const strokeRef = useRef<UndoEntry[]>([]);
  /** Coordinates already recorded in the current stroke — only the first state matters. */
  const strokeSeen = useRef<Set<string>>(new Set());
  /** Which layout's saved view has been restored, so persistence can't race it. */
  const hydratedFor = useRef<string | null>(null);
  /** The view just restored, held until it has rendered — see the persist effect. */
  const pendingRestore = useRef<SavedView | null>(null);

  const svgToGrid = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current!.getBoundingClientRect();
      // The pan/zoom `<g>` is translated by `RULER_SIZE` on top of `offset`
      // so the ruler gutters get a reserved strip (#94) — subtract it here
      // to undo that shift, the same way `offset` itself is undone.
      const sx = (clientX - rect.left - offset.x - RULER_SIZE) / zoom;
      const sy = (clientY - rect.top - offset.y - RULER_SIZE) / zoom;
      return { x: Math.floor(sx / TILE_SIZE), y: Math.floor(sy / TILE_SIZE) };
    },
    [offset, zoom],
  );

  /**
   * Every tile's metadata, parsed once per grid change rather than per tile
   * per render — the render loop used to `JSON.parse` on every frame, and the
   * run detection, the write path and the diagnostics overlay all want the
   * same parse.
   *
   * Tolerant, like the backend's own read path: a blob that will not parse
   * reads as `{}` so the tile still draws. Refusing to open the editor over a
   * legacy cell would take away the only tool that can fix it. The backend
   * reports those cells as `tile-metadata-unreadable` so they are visible
   * rather than merely survived.
   */
  const parsedMeta = useMemo(() => {
    const out = new Map<string, GridTileMetadata>();
    for (const tile of grid.values()) {
      try {
        out.set(`${tile.x},${tile.y}`, JSON.parse(tile.metadata) as GridTileMetadata);
      } catch {
        out.set(`${tile.x},${tile.y}`, {});
      }
    }
    return out;
  }, [grid]);

  /** Records what was at `(x, y)` before this stroke first touched it. */
  const recordForUndo = useCallback(
    (x: number, y: number) => {
      const k = `${x},${y}`;
      if (strokeSeen.current.has(k)) return; // only the pre-stroke state matters
      strokeSeen.current.add(k);

      const existing = grid.get(k);
      strokeRef.current.push({
        x,
        y,
        before: existing
          ? {
              tileType: existing.tileType as TileType,
              metadata: (() => {
                try {
                  return JSON.parse(existing.metadata) as Record<string, unknown>;
                } catch {
                  return {};
                }
              })(),
            }
          : null,
      });
    },
    [grid],
  );

  /**
   * The metadata a paint stroke writes at `(x, y)`.
   *
   * Annotations on the cell are **carried over deliberately**. Repainting a
   * curve as a straight is a change to the drawing; it is not a statement that
   * the sensor sitting there has moved, and silently dropping the annotation
   * would lose authored placement to a cosmetic edit (#74).
   *
   * `blockId` and `trackRole` are mutually exclusive — the write path refuses
   * a tile carrying both (#71), so the decorative toggle wins and the block
   * select is disabled while it is on.
   */
  const metadataForPaint = useCallback(
    (existing: GridTileMetadata): GridTileMetadata => {
      const meta: GridTileMetadata = { rotation: selectedRotation as GridTileMetadata['rotation'] };

      if (paintDecorative) meta.trackRole = 'decorative';
      else if (selectedBlockId) meta.blockId = selectedBlockId;

      if (selectedPointId) {
        meta.pointId = selectedPointId;
        const roads = defaultPointRoads(selectedType, selectedPointId, divergentIsNormal);
        if (roads) meta.pointRoads = roads;
      }

      if (existing.annotations?.length) meta.annotations = existing.annotations;

      return meta;
    },
    [selectedRotation, paintDecorative, selectedBlockId, selectedPointId, selectedType, divergentIsNormal],
  );

  /**
   * Adds or removes the selected entity's annotation at `(x, y)`.
   *
   * A toggle rather than an add: clicking the same sensor on the same tile
   * twice removes it, which is the only way to correct a misplacement without
   * repainting the tile and losing everything else on it.
   *
   * Refuses on an empty cell. An annotation says "this entity sits *here*", and
   * "here" has to be somewhere the track is drawn.
   */
  const toggleAnnotation = useCallback(
    (x: number, y: number, existing: GridTileMetadata, tileType: TileType) => {
      if (!selectedSensorId) {
        setWriteError('Pick a sensor to place first');
        return null;
      }

      const current = existing.annotations ?? [];
      const without = current.filter(
        (a) => !(a.entityType === 'sensor' && a.entityId === selectedSensorId),
      );
      const annotations =
        without.length === current.length
          ? [
              ...current,
              {
                entityType: 'sensor' as const,
                entityId: selectedSensorId,
                orientation: selectedRotation as GridTileMetadata['rotation'],
              },
            ]
          : without;

      const meta: GridTileMetadata = { ...existing };
      if (annotations.length > 0) meta.annotations = annotations;
      else delete meta.annotations;

      return placeTile(x, y, tileType, meta as Record<string, unknown>);
    },
    [selectedSensorId, selectedRotation, placeTile],
  );

  /**
   * Paints or erases at a grid coordinate. Split out from `handleTileAction`
   * (#94) so the mouse path (which has to turn a client point into a grid
   * cell first) and the keyboard path (which already has one — the cursor)
   * converge on the same logic below `svgToGrid` rather than the keyboard
   * needing a second copy of it.
   */
  const paintAt = useCallback(
    (x: number, y: number, erase: boolean) => {
      // No upper bound from a fixed canvas any more — the canvas grows with
      // the content. `MAX_COORDINATE` is admission control, not an edge, and
      // matches what the backend will accept.
      if (x < 0 || y < 0 || x > MAX_COORDINATE || y > MAX_COORDINATE) return;

      const existingTile = grid.get(`${x},${y}`);
      const existingMeta = parsedMeta.get(`${x},${y}`) ?? {};

      // Annotating never creates or destroys a tile, so it neither records an
      // undo entry for a tile that is not changing shape nor acts on an empty
      // cell.
      if (paintMode === 'annotate' && !erase) {
        if (!existingTile) {
          setWriteError('Nothing to annotate at that cell — draw the track first');
          return;
        }
        const run = toggleAnnotation(x, y, existingMeta, existingTile.tileType as TileType);
        if (run) {
          void run.then((result) => {
            setWriteError(result.ok ? null : (result.message ?? `HTTP ${result.status}`));
          });
        }
        return;
      }

      recordForUndo(x, y);

      // Both mutations report their own outcome. A refused write must not look
      // like it saved (#62) — the same posture every ConfigPanel tab carries.
      const run = erase
        ? eraseTile(x, y)
        : placeTile(
            x,
            y,
            selectedType,
            metadataForPaint(existingMeta) as Record<string, unknown>,
          );

      void run.then((result) => {
        setWriteError(result.ok ? null : (result.message ?? `HTTP ${result.status}`));
      });
    },
    [
      grid,
      parsedMeta,
      paintMode,
      toggleAnnotation,
      recordForUndo,
      eraseTile,
      placeTile,
      selectedType,
      metadataForPaint,
    ],
  );

  const handleTileAction = useCallback(
    (clientX: number, clientY: number, erase: boolean) => {
      const { x, y } = svgToGrid(clientX, clientY);
      paintAt(x, y, erase);
    },
    [svgToGrid, paintAt],
  );

  /**
   * Replays the inverse of the last stroke.
   *
   * Sequential rather than parallel, so a partial failure leaves a coherent
   * result rather than a race, and so the first refusal is the one reported.
   * Safe to build on the write path only because #62 made it report honestly:
   * an undo stack over a path that lies about failure drifts out of sync with
   * the server, which is exactly why #69 asked for #62 to land first.
   */
  const undo = useCallback(async () => {
    const stroke = undoStack[undoStack.length - 1];
    if (!stroke) return;
    setUndoStack((s) => s.slice(0, -1));

    for (const entry of stroke) {
      const result = entry.before
        ? await placeTile(entry.x, entry.y, entry.before.tileType, entry.before.metadata)
        : await eraseTile(entry.x, entry.y);
      if (!result.ok) {
        setWriteError(`Undo failed: ${result.message ?? `HTTP ${result.status}`}`);
        return;
      }
    }
    setWriteError(null);
  }, [undoStack, placeTile, eraseTile]);

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) {
      // middle — pan
      panStart.current = { mx: e.clientX, my: e.clientY, ox: offset.x, oy: offset.y };
      e.preventDefault();
      return;
    }
    setIsPainting(true);
    handleTileAction(e.clientX, e.clientY, e.button === 2);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (panStart.current) {
      setOffset({
        x: panStart.current.ox + (e.clientX - panStart.current.mx),
        y: panStart.current.oy + (e.clientY - panStart.current.my),
      });
      return;
    }

    const { x, y } = svgToGrid(e.clientX, e.clientY);
    if (x >= 0 && y >= 0 && x < extent.cols && y < extent.rows) {
      setHoverCell({ x, y });
      // The mouse path and the keyboard path converge on one cursor (#94)
      // rather than the readout having to choose between two states that
      // could disagree.
      setCursor({ x, y });
    } else {
      setHoverCell(null);
    }

    if (!isPainting) return;
    handleTileAction(e.clientX, e.clientY, e.buttons === 2);
  };

  /**
   * Ends the gesture and commits it as one undo step. A drag is one stroke,
   * so undoing a stray right-drag restores the whole run it deleted rather
   * than one tile per press.
   *
   * Also the keyboard path's commit point (#94): `paintAt` records the
   * pre-stroke state synchronously (`recordForUndo`) before its write ever
   * resolves, so calling this right after a single keyboard paint/erase
   * closes that one keypress as its own one-entry stroke, exactly as a
   * click-and-immediately-release already does on the mouse path.
   */
  const commitStroke = useCallback(() => {
    if (strokeRef.current.length > 0) {
      const stroke = strokeRef.current;
      strokeRef.current = [];
      strokeSeen.current = new Set();
      setUndoStack((s) => [...s, stroke].slice(-UNDO_LIMIT));
    }

    // Recompute the diagnostics now the gesture is over, rather than once per
    // painted cell during it.
    setGridRevision((r) => r + 1);
  }, []);

  const onMouseUp = () => {
    setIsPainting(false);
    panStart.current = null;
    commitStroke();
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.3, Math.min(3, z - e.deltaY * 0.001)));
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const rotateForward = useCallback(() => {
    setSelectedRotation((r) => (r + 45) % 360);
  }, []);

  const rotateBackward = useCallback(() => {
    setSelectedRotation((r) => (r - 45 + 360) % 360);
  }, []);

  /**
   * The canvas's own keyboard handler (#94) — previously a `window` listener
   * guarded only against a form field having focus, which meant arrow keys
   * moved the cursor (once one existed) while focus was anywhere else on the
   * page, including the diagnostics list. Moving it here, an `onKeyDown` on
   * the `<svg>` itself, means every one of these bindings only fires while
   * the canvas actually has focus — no guard needed, because an `<input>` or
   * the diagnostics panel is a different part of the DOM tree and this event
   * never reaches it.
   *
   * A plain function rather than `useCallback`, matching `onMouseMove` and
   * `onMouseUp` above: it closes over state declared later in this component
   * (`cursor`, `extent`), which is safe for a closure invoked from an event
   * — by the time a keypress actually happens, the render that declared them
   * has long since completed — but would be a stale-or-TDZ risk if this were
   * memoised with a dependency array evaluated at its own declaration point.
   */
  const onCanvasKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    // Escape hands focus back to the toolbar — the obvious way out that
    // `role="application"` requires, since it otherwise takes the arrow keys
    // away from the screen reader's own navigation entirely.
    if (e.key === 'Escape') {
      toolbarRef.current?.focus();
      e.preventDefault();
      return;
    }

    const arrow = ARROW_DELTAS[e.key];
    if (arrow) {
      setCursor((c) => ({
        x: Math.max(0, Math.min(extent.cols - 1, c.x + arrow.dx)),
        y: Math.max(0, Math.min(extent.rows - 1, c.y + arrow.dy)),
      }));
      e.preventDefault();
      return;
    }

    // Enter/Space paints at the cursor — the keyboard equivalent of a
    // left-click — and Delete/Backspace erases it, of a right-click. Each is
    // its own one-keypress stroke (`commitStroke`), same as a mouse click.
    if (e.key === 'Enter' || e.key === ' ') {
      paintAt(cursor.x, cursor.y, false);
      commitStroke();
      e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      paintAt(cursor.x, cursor.y, true);
      commitStroke();
      e.preventDefault();
      return;
    }

    // 1..9 => palette selection by index
    if (/^[1-9]$/.test(e.key)) {
      const idx = parseInt(e.key, 10) - 1;
      if (idx >= 0 && idx < PALETTE.length) {
        setSelectedType(PALETTE[idx].type);
        e.preventDefault();
        return;
      }
    }

    // Ctrl/Cmd+Z => undo the last stroke.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      void undo();
      e.preventDefault();
      return;
    }

    // R => rotate +45, Shift+R => rotate -45
    if (e.key.toLowerCase() === 'r') {
      if (e.shiftKey) {
        rotateBackward();
      } else {
        rotateForward();
      }
      e.preventDefault();
    }
  };

  /**
   * Pans, without changing zoom, so `cell` sits at the centre of the
   * viewport. Used by the diagnostics panel's "jump to" buttons (#94).
   *
   * This only ever calls `setOffset` — exactly what dragging the canvas by
   * hand already does — so it cannot conflict with the saved-view restore
   * (D5): the persist effect saves whatever `offset` settles on without
   * caring whether a drag or a diagnostic click put it there.
   */
  const centerOn = useCallback(
    (cell: { x: number; y: number }) => {
      const svg = svgRef.current;
      if (!svg) return;
      const view = svg.getBoundingClientRect();
      if (view.width === 0 || view.height === 0) return;
      const cx = (cell.x + 0.5) * TILE_SIZE;
      const cy = (cell.y + 0.5) * TILE_SIZE;
      setOffset({
        x: view.width / 2 - RULER_SIZE - cx * zoom,
        y: view.height / 2 - RULER_SIZE - cy * zoom,
      });
    },
    [zoom],
  );

  /**
   * A diagnostics-panel line's "jump to" action (#94): move the cursor,
   * centre the view, and briefly pulse the cell so the jump is visible as
   * more than just the readout changing underneath you.
   */
  const jumpToDiagnostic = useCallback(
    (d: GridDiagnostic) => {
      const coord = diagnosticCoordinate(d);
      if (!coord) return;

      setCursor(coord);
      centerOn(coord);

      pulseId.current += 1;
      setPulseCell({ x: coord.x, y: coord.y, id: pulseId.current });
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
      pulseTimer.current = window.setTimeout(() => setPulseCell(null), 900);
    },
    [centerOn],
  );

  // The pulse timer must not outlive the component.
  useEffect(() => {
    return () => {
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
    };
  }, []);

  // Restore this layout's last view, and forget any undo history belonging to
  // the layout we just left — those coordinates mean something else here.
  useEffect(() => {
    strokeRef.current = [];
    strokeSeen.current = new Set();
    setUndoStack([]);

    const saved = loadView(layoutId) ?? DEFAULT_VIEW;
    setZoom(saved.zoom);
    setOffset(saved.offset);
    pendingRestore.current = saved;
    hydratedFor.current = layoutId;
  }, [layoutId]);

  /**
   * Persist the view — but only once the restored one has actually rendered.
   *
   * This effect fires in the same commit as the restore above, when
   * `offset`/`zoom` still hold their pre-restore values. Writing them there
   * clobbers the entry the restore just read. It is not merely a transient
   * wrong value either: under StrictMode's deliberate double-invocation the
   * restore then runs a second time and reads back the value this effect just
   * stamped over it, so the saved view is lost outright — which is exactly how
   * the e2e spec caught it.
   *
   * So `pendingRestore` holds what was restored, and nothing is written until
   * the state matches it. `hydratedFor` alone is not enough: the restore sets
   * it before this effect runs in the same commit.
   *
   * Failures are swallowed: a full or disabled localStorage must not break the
   * editor over a convenience.
   */
  useEffect(() => {
    if (!layoutId || hydratedFor.current !== layoutId) return;

    const pending = pendingRestore.current;
    if (pending) {
      const settled =
        pending.zoom === zoom && pending.offset.x === offset.x && pending.offset.y === offset.y;
      if (!settled) return; // the restore has not rendered yet
      pendingRestore.current = null;
      return; // nothing has changed since, so there is nothing new to write
    }

    try {
      window.localStorage.setItem(viewKey(layoutId), JSON.stringify({ offset, zoom }));
    } catch {
      /* not worth surfacing */
    }
  }, [layoutId, offset, zoom]);

  const runs = useMemo(
    () =>
      findBlockRuns(
        Array.from(grid.values()).map((t) => ({
          x: t.x,
          y: t.y,
          blockId: parsedMeta.get(`${t.x},${t.y}`)?.blockId,
        })),
      ),
    [grid, parsedMeta],
  );

  const tintOf = useMemo(() => assignRunTints(runs, BLOCK_TINTS.length), [runs]);

  /**
   * The one tile per point that carries its name (#93).
   *
   * A point is drawn as two tiles — the point tile and the `straight-45`
   * companion carrying the divergent road to the next row — and both are tagged
   * with the same `pointId`, so labelling per tile drew every name twice.
   */
  const pointLabelAt = useMemo(
    () =>
      pointLabelAnchors(
        Array.from(grid.values()).flatMap((t) => {
          const pointId = parsedMeta.get(`${t.x},${t.y}`)?.pointId;
          return pointId
            ? [{ x: t.x, y: t.y, tileType: t.tileType as TileType, pointId }]
            : [];
        }),
      ),
    [grid, parsedMeta],
  );

  const sensorNames = useMemo(() => new Map(sensors.map((s) => [s.id, s.name])), [sensors]);
  const blockNames = useMemo(() => new Map(blocks.map((b) => [b.id, b.name])), [blocks]);
  const pointNames = useMemo(() => new Map(points.map((p) => [p.id, p.name])), [points]);

  const { warnings, info } = useMemo(() => partitionDiagnostics(diagnostics), [diagnostics]);

  /**
   * Block end labels keyed by the cell they sit at, so the render loop can look
   * them up without scanning.
   *
   * Only ends the drawing can currently place — an end with no geometry is a
   * mismatch the diagnostics report in words, and inventing a cell for it
   * would put a wrong name on the diagram, which is the failure this whole
   * feature exists to prevent.
   */
  const endsAtCell = useMemo(() => {
    const out = new Map<string, { label: string; pinned: boolean; terminated: boolean }[]>();
    for (const end of ends) {
      if (!end.geometry) continue;
      const k = `${end.geometry.x},${end.geometry.y}`;
      const entry = { label: end.label, pinned: end.pinned, terminated: end.geometry.terminated };
      const list = out.get(k);
      if (list) list.push(entry);
      else out.set(k, [entry]);
    }
    return out;
  }, [ends]);

  /** What's at the cursor's cell, resolved the same way the render loop resolves any other tile. */
  const cursorTile = useMemo(() => {
    const k = `${cursor.x},${cursor.y}`;
    const tile = grid.get(k);
    if (!tile) return null;
    return {
      tileType: tile.tileType as TileType,
      metadata: parsedMeta.get(k) ?? {},
      ends: endsAtCell.get(k) ?? [],
    };
  }, [cursor, grid, parsedMeta, endsAtCell]);

  /**
   * The cursor readout (#94): one string, built by `describeCursor`, that is
   * both the visible line under the canvas for sighted users and the
   * `aria-live` announcement a screen reader gets — see that module for why
   * it has to be one implementation rather than two.
   */
  const cursorAnnouncement = useMemo(
    () =>
      describeCursor(cursor, cursorTile, {
        blocks: blockNames,
        points: pointNames,
        sensors: sensorNames,
      }),
    [cursor, cursorTile, blockNames, pointNames, sensorNames],
  );

  /**
   * Regenerates block end labels from the drawing.
   *
   * Deliberately a button. Regeneration on every grid write would silently
   * rename ends underneath the edges referencing them while you redrew a
   * corner of the layout — and an end label is the only link between an edge
   * and a block end, so that rename is a change to the track graph.
   */
  const regenerateEnds = useCallback(async () => {
    const result = await generateEnds();
    if (!result.ok) {
      setWriteError(result.message ?? `HTTP ${result.status}`);
      return;
    }
    const s = result.data;
    if (!s) return;
    const parts = [
      `${s.adopted.length} pinned from edges`,
      `${s.created.length} added`,
      `${s.removed.length} removed`,
    ];
    if (s.collisions.length > 0) parts.push(`${s.collisions.length} could not be named`);
    setEndsSummary(parts.join(' · '));
    setWriteError(null);
    setGridRevision((r) => r + 1);
  }, [generateEnds]);

  /**
   * Whether a label at this tile should be drawn, per the density control.
   *
   * `hover` shows the labels of the run under the cursor and its immediate
   * surroundings, which is what you want when checking one area without
   * repainting the whole diagram with text.
   */
  const labelsVisible = useCallback(
    (x: number, y: number) => {
      if (labelDensity === 'always') return true;
      if (labelDensity === 'off') return false;
      if (!hoverCell) return false;
      return Math.abs(hoverCell.x - x) <= 2 && Math.abs(hoverCell.y - y) <= 2;
    },
    [labelDensity, hoverCell],
  );

  /**
   * The drawn canvas: big enough for the content plus room to keep drawing.
   *
   * Derived rather than fixed (#69). The old constants silently dropped any
   * paint beyond column 30 / row 20, with no indication that painting further
   * right simply did nothing — and Westgate Hollow was already at column 29.
   * Growing with the content removes the ceiling rather than moving it.
   */
  const extent = useMemo(() => {
    let cols = MIN_COLS;
    let rows = MIN_ROWS;
    for (const t of grid.values()) {
      cols = Math.max(cols, t.x + 1 + GROWTH_MARGIN);
      rows = Math.max(rows, t.y + 1 + GROWTH_MARGIN);
    }
    return {
      cols: Math.min(cols, MAX_COORDINATE + 1),
      rows: Math.min(rows, MAX_COORDINATE + 1),
    };
  }, [grid]);

  const gridW = extent.cols * TILE_SIZE;
  const gridH = extent.rows * TILE_SIZE;

  /**
   * Frames the drawn tiles in the viewport.
   *
   * `⌂` used to reset to zoom 1 at the origin, which on a layout drawn away
   * from the origin leaves the canvas apparently blank — the control that is
   * supposed to rescue you from being lost was itself a way to get lost.
   */
  const fitToContent = useCallback(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const tiles = [...grid.values()];
    const view = svg.getBoundingClientRect();
    if (view.width === 0 || view.height === 0) return;

    if (tiles.length === 0) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      return;
    }

    // The ruler gutters (#94) reserve `RULER_SIZE` off the top and left, so
    // content is centred in what is left of the viewport rather than the
    // whole of it — otherwise "fit to content" would frame a rectangle that
    // includes the strip the gutters cover.
    const availW = view.width - RULER_SIZE;
    const availH = view.height - RULER_SIZE;

    const minX = Math.min(...tiles.map((t) => t.x));
    const minY = Math.min(...tiles.map((t) => t.y));
    const maxX = Math.max(...tiles.map((t) => t.x));
    const maxY = Math.max(...tiles.map((t) => t.y));

    const contentW = (maxX - minX + 1) * TILE_SIZE;
    const contentH = (maxY - minY + 1) * TILE_SIZE;
    const pad = TILE_SIZE;

    const nextZoom = Math.max(
      0.3,
      Math.min(3, Math.min((availW - pad * 2) / contentW, (availH - pad * 2) / contentH)),
    );

    setZoom(nextZoom);
    setOffset({
      x: (availW - contentW * nextZoom) / 2 - minX * TILE_SIZE * nextZoom,
      y: (availH - contentH * nextZoom) / 2 - minY * TILE_SIZE * nextZoom,
    });
  }, [grid]);

  if (!layoutId) return <p style={st.empty}>No layout selected.</p>;

  return (
    <div style={st.wrapper}>
      {/* ── Toolbar ── */}
      {/*
        `tabIndex={-1}` keeps this out of the normal Tab order — it was never
        a stop before #94 — while still letting Escape focus it
        programmatically as the canvas's declared way out of
        `role="application"`.
      */}
      <div style={st.toolbar} ref={toolbarRef} tabIndex={-1}>
        <div style={st.paletteGroup}>
          {PALETTE.map((p) => (
            <button
              key={p.type}
              title={`${p.label} [${p.key}]`}
              tabIndex={-1}
              onClick={() => setSelectedType(p.type)}
              style={{
                ...st.paletteBtn,
                ...(selectedType === p.type ? st.paletteBtnActive : {}),
              }}
            >
              <span style={st.paletteIcon}>{p.icon}</span>
              <span style={st.paletteLabel}>{p.label}</span>
            </button>
          ))}
        </div>

        <div style={st.toolSep} />

        <label style={st.toolLabel}>
          Mode
          <select
            value={paintMode}
            onChange={(e) => setPaintMode(e.target.value as typeof paintMode)}
            style={st.toolSelect}
            title="Track paints tiles; Annotate places an entity on a tile that is already drawn"
          >
            <option value="track">Track</option>
            <option value="annotate">Annotate</option>
          </select>
        </label>

        {paintMode === 'annotate' ? (
          <label style={st.toolLabel}>
            Sensor
            <select
              value={selectedSensorId}
              onChange={(e) => setSelectedSensorId(e.target.value)}
              style={st.toolSelect}
              title="Click a drawn tile to place this sensor; click again to remove it"
            >
              <option value="">— pick a sensor —</option>
              {sensors.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.inService ? '' : ' (out of service)'}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <>
            <label style={st.toolLabel}>
              Block
              <select
                value={selectedBlockId}
                onChange={(e) => setSelectedBlockId(e.target.value)}
                style={st.toolSelect}
                disabled={paintDecorative}
                title={
                  paintDecorative
                    ? 'Decorative track is deliberately not part of any block'
                    : undefined
                }
              >
                <option value="">— none —</option>
                {blocks.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </label>

            {/*
              #71. Not a cosmetic switch: it is the difference between "this
              track is deliberately not monitored" and "I have not tagged this
              yet", which used to be the same absent key — so the editor could
              not warn about the second without warning about the whole entry
              feeder as well.
            */}
            <label style={st.toolLabel} title="Mark this track as deliberately not part of any block">
              <input
                type="checkbox"
                checked={paintDecorative}
                onChange={(e) => setPaintDecorative(e.target.checked)}
              />
              Decorative
            </label>

            <label style={st.toolLabel}>
              Point
              <select
                value={selectedPointId}
                onChange={(e) => setSelectedPointId(e.target.value)}
                style={st.toolSelect}
              >
                <option value="">— none —</option>
                {points.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>

            {/*
              #73. Only meaningful while a point tile is selected, and shown
              only then — the mapping is cheap to capture while the points are
              being placed and expensive to retrofit, so it belongs next to the
              act of placing one.
            */}
            {selectedPointId !== '' && isPointTile(selectedType) && (
              <label
                style={st.toolLabel}
                title="Which drawn leg the point's normal position selects. Unverifiable authored data — nothing can check it for you."
              >
                <input
                  type="checkbox"
                  checked={divergentIsNormal}
                  onChange={(e) => setDivergentIsNormal(e.target.checked)}
                />
                Divergent = normal
              </label>
            )}
          </>
        )}

        <label style={st.toolLabel}>
          Rotation
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              onClick={rotateBackward}
              style={st.iconBtn}
              title="Rotate -45°"
            >↺</button>
            <span style={st.rotationBadge}>{selectedRotation}°</span>
            <button
              onClick={rotateForward}
              style={st.iconBtn}
              title="Rotate +45°"
            >↻</button>
          </div>
        </label>

        <label style={st.toolLabel}>
          Labels
          <select
            value={labelDensity}
            onChange={(e) => setLabelDensity(e.target.value as typeof labelDensity)}
            style={st.toolSelect}
            title="Label density — authoring wants every label, reading wants few"
          >
            <option value="always">Always</option>
            <option value="hover">On hover</option>
            <option value="off">Off</option>
          </select>
        </label>

        <div style={st.toolSep} />

        <button
          onClick={() => setZoom((z) => Math.min(z + 0.2, 3))}
          style={st.iconBtn}
          tabIndex={-1}
          title="Zoom in"
        >＋</button>
        <button
          onClick={() => setZoom((z) => Math.max(z - 0.2, 0.3))}
          style={st.iconBtn}
          tabIndex={-1}
          title="Zoom out"
        >－</button>
        <button
          onClick={fitToContent}
          style={st.iconBtn}
          tabIndex={-1}
          title="Fit to content"
        >⌂</button>

        <div style={st.toolSep} />

        {/* #72. A button, not a hook on the grid write path: regeneration
            renames things edges depend on, and that must never happen as a
            side effect of redrawing a corner of the layout. */}
        <button
          onClick={() => void regenerateEnds()}
          style={st.iconBtn}
          tabIndex={-1}
          title="Regenerate block end labels from the drawing. Pinned ends are never touched."
        >Ends ⟳</button>

        <button
          onClick={() => setShowDiagnostics((v) => !v)}
          style={{
            ...st.iconBtn,
            ...(warnings.length > 0 ? { borderColor: OCCUPANCY.occupied.colour } : {}),
          }}
          tabIndex={-1}
          title="Show what the drawing and the track graph disagree about"
        >
          {/* Counts, not a colour alone (#81): a bare red dot says something is
              wrong without saying how much or of what kind. */}
          ⚠ {warnings.length}/{info.length}
        </button>

        <button
          onClick={() => void undo()}
          style={{ ...st.iconBtn, opacity: undoStack.length === 0 ? 0.4 : 1 }}
          tabIndex={-1}
          disabled={undoStack.length === 0}
          title={
            undoStack.length === 0
              ? 'Nothing to undo'
              : `Undo last change (Ctrl+Z) — ${undoStack.length} step${undoStack.length === 1 ? '' : 's'}`
          }
        >↶</button>

        {loading && <span style={st.status}>Saving…</span>}
        {/*
          Two independent slots, because they mean different things: the grid
          could not be read at all, versus this particular edit was refused.
          Collapsing them into one string is how #62 happened.
        */}
        {loadError && <span style={st.statusErr}>Could not load grid: {loadError}</span>}
        {writeError && (
          <span style={st.statusErr} role="alert">
            Edit not saved: {writeError}
          </span>
        )}
      </div>

      {/* ── Canvas ── */}
      <div style={st.canvasWrap}>
        <svg
          ref={svgRef}
          style={{ cursor: 'crosshair', display: 'block', width: '100%', height: '100%' }}
          // #94: the canvas takes keyboard focus and hands the arrow keys to
          // itself rather than the screen reader's own navigation —
          // `docs/track-editor.md` D11 covers why `application` over `grid`.
          // `aria-label` is the accessible name read once on focus; the
          // `<title>` below is a native hover tooltip for a sighted mouse
          // user who never tabs in at all; the `aria-live` region further
          // down is what actually fires on every cursor move — three
          // different audiences, not one mechanism duplicated three times.
          tabIndex={0}
          role="application"
          aria-label="Track diagram editor grid. Arrow keys move the cursor, Enter or Space paints the selected tile, Delete erases, Escape returns to the toolbar."
          onKeyDown={onCanvasKeyDown}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => {
            onMouseUp();
            setHoverCell(null);
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
            <rect x={0} y={cursor.y * TILE_SIZE} width={gridW} height={TILE_SIZE} fill={INK.primary} opacity={0.05} />
            <rect x={cursor.x * TILE_SIZE} y={0} width={TILE_SIZE} height={gridH} fill={INK.primary} opacity={0.05} />

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
              const cellEnds = endsAtCell.get(`${tile.x},${tile.y}`) ?? [];
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
                    #72 — the end labels, at the openings the geometry found.
                    A pinned label is drawn in brackets so you can see which
                    names are load-bearing: a generated one will move when the
                    drawing does, a pinned one never will, and the edges depend
                    on the pinned ones.
                  */}
                  {cellEnds.map((end) => (
                    <text
                      key={end.label}
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
                      {end.pinned ? `[${end.label}]` : end.label}
                      {end.terminated ? ' ⊣' : ''}
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
            {hoverCell && (() => {
              const previewMetaBlock = selectedBlockId
                ? blocks.find((b) => b.id === selectedBlockId)?.name
                : null;
              const occupied = grid.has(`${hoverCell.x},${hoverCell.y}`);
              return (
                <g transform={`translate(${hoverCell.x * TILE_SIZE},${hoverCell.y * TILE_SIZE})`}>
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
                  <g opacity={0.45} transform={`rotate(${selectedRotation}, ${H}, ${H})`}>
                    <TilePath type={selectedType} />
                  </g>
                  {previewMetaBlock && (
                    <text x={T / 2} y={T - 5} textAnchor="middle"
                      fontSize={9} fill={INK.secondary} fontFamily="monospace"
                      stroke={SURFACE.canvas} strokeWidth={3} paintOrder="stroke"
                      opacity={0.8}>
                      {previewMetaBlock}
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
            {pulseCell && (
              <g
                key={pulseCell.id}
                transform={`translate(${pulseCell.x * TILE_SIZE},${pulseCell.y * TILE_SIZE})`}
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
      </div>

      {/*
        The cursor readout (#94) — the same string as the `aria-live`
        announcement below, and deliberately visible rather than
        screen-reader-only: it is what lets a sighted keyboard user confirm
        the announcement is telling the truth, and it is the only "where am
        I" a mouse-only user had before this issue at all.
      */}
      <div style={st.cursorReadout} aria-live="polite">
        {cursorAnnouncement}
      </div>

      {/* ── Diagnostics ── */}
      {showDiagnostics && (
        <div style={st.diagnostics} role="region" aria-label="Grid diagnostics">
          {diagnostics.length === 0 ? (
            <p style={st.diagnosticEmpty}>
              Nothing to report: the drawing and the track graph agree, and every tile is
              classified.
            </p>
          ) : (
            <ul style={st.diagnosticList}>
              {/*
                Warnings first, then the to-do list. The two are styled
                differently on purpose — an unfinished layout is a normal state
                (#72), and rendering "this end has no edge yet" as an error
                trains the operator to ignore the ones that are.
              */}
              {[...warnings, ...info].map((d, i) => {
                const text = describeDiagnostic(d, {
                  blocks: blockNames,
                  points: pointNames,
                  sensors: sensorNames,
                });
                // #94: a finding only becomes a button when it structurally
                // carries a coordinate — `diagnosticCoordinate` is the pure
                // sibling to `describeDiagnostic` that says so without
                // parsing the prose above back apart. The three kinds that
                // name a block end or a block rather than a cell stay plain
                // text; there is nowhere on the drawing to jump to.
                const coord = diagnosticCoordinate(d);
                return (
                  <li
                    key={`${d.kind}-${i}`}
                    style={d.severity === 'warning' ? st.diagnosticWarn : st.diagnosticInfo}
                  >
                    <span style={st.diagnosticBadge}>
                      {d.severity === 'warning' ? 'WARN' : 'TODO'}
                    </span>{' '}
                    {coord ? (
                      <button
                        type="button"
                        onClick={() => jumpToDiagnostic(d)}
                        style={st.diagnosticJump}
                        title={`Move the cursor to (${coord.x}, ${coord.y}) and centre the view there`}
                      >
                        {text}
                      </button>
                    ) : (
                      text
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* ── Legend ── */}
      <div style={st.legend}>
        <span style={{ color: '#6c7086', fontSize: 11 }}>
          Left-drag: {paintMode === 'annotate' ? 'place/remove entity' : 'paint'} · Right-click:
          erase · Middle-drag: pan · Scroll: zoom · Rotation: 45° steps (R / Shift+R) · Tile
          select: 1–7 · Ctrl+Z: undo · Arrows: move cursor · Enter/Space: paint at cursor ·
          Delete: erase at cursor · Esc: leave grid for toolbar · Canvas: {extent.cols}×
          {extent.rows} (grows as you draw) · {grid.size} tile{grid.size !== 1 ? 's' : ''}
          {endsSummary && <> · Ends: {endsSummary}</>}
        </span>
      </div>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const st = {
  wrapper:         { display: 'flex', flexDirection: 'column' as const, height: '100%', background: '#181825', border: '1px solid #313244', borderRadius: 6, overflow: 'hidden' },
  toolbar:         { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#1e1e2e', borderBottom: '1px solid #313244', flexWrap: 'wrap' as const },
  paletteGroup:    { display: 'flex', gap: 4, flexWrap: 'wrap' as const },
  paletteBtn:      { background: '#313244', border: '1px solid #45475a', borderRadius: 4, padding: '3px 7px', cursor: 'pointer', display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 1, minWidth: 44, outline: 'none', boxShadow: 'none', height: 46 },
  paletteBtnActive:{ background: '#2a2a3d', border: '1px solid #89b4fa' },
  paletteIcon:     { fontSize: 16, color: '#89b4fa', lineHeight: 1 },
  paletteLabel:    { fontSize: 9, color: '#6c7086', textTransform: 'uppercase' as const, letterSpacing: '0.3px' },
  toolSep:         { width: 1, height: 28, background: '#313244', margin: '0 4px', flexShrink: 0 },
  toolLabel:       { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#6c7086' },
  toolSelect:      { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '3px 6px', fontSize: 12 },
  rotationBadge:   { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '3px 7px', fontSize: 11, minWidth: 48, textAlign: 'center' as const },
  iconBtn:         { background: '#313244', border: '1px solid #45475a', borderRadius: 4, color: '#cdd6f4', cursor: 'pointer', padding: '0 9px', fontSize: 14, minWidth: 34, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' } as React.CSSProperties,
  status:          { fontSize: 12, color: '#f9e2af', marginLeft: 8 },
  statusErr:       { fontSize: 12, color: '#f38ba8', marginLeft: 8 },
  canvasWrap:      { flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative' as const },
  // The cursor readout (#94) — visible text, not sr-only, since it is the
  // same string the aria-live region announces and a sighted keyboard user
  // is the one who can confirm it is telling the truth.
  cursorReadout:   { padding: '4px 10px', background: '#11111b', borderTop: '1px solid #313244', color: '#a6adc8', fontSize: 11, fontFamily: 'monospace' },
  diagnostics:     { maxHeight: 180, overflowY: 'auto' as const, background: '#11111b', borderTop: '1px solid #313244', padding: '6px 10px' },
  diagnosticList:  { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' as const, gap: 3 },
  diagnosticEmpty: { color: '#6c7086', fontSize: 11, margin: 0 },
  diagnosticWarn:  { color: '#f38ba8', fontSize: 11, lineHeight: 1.5 },
  diagnosticInfo:  { color: '#9399b2', fontSize: 11, lineHeight: 1.5 },
  diagnosticBadge: { fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.5px' },
  // A diagnostic line with a coordinate renders as this rather than plain
  // text (#94) — styled to read as inline prose, not as a standalone button,
  // since it sits mid-sentence next to the WARN/TODO badge.
  diagnosticJump:  { background: 'none', border: 'none', padding: 0, margin: 0, color: 'inherit', font: 'inherit', textAlign: 'left' as const, cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' as const },
  legend:          { padding: '4px 10px', background: '#11111b', borderTop: '1px solid #313244' },
  empty:           { color: '#6c7086', fontSize: 13, padding: 16 },
} as const;
