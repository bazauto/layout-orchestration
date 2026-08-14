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
 *
 * ## The #75 split
 *
 * The tile geometry, the pan/zoom viewport, and the model derived from the
 * drawing (parsed metadata, block runs, opening geometry) used to live in
 * this file. #75 pulled them out into `diagram/tilePaths.tsx`,
 * `hooks/useDiagramViewport.ts`, `diagram/diagramModel.ts` and the
 * presentational `TrackDiagram` component, because a monitor view (#63/#82)
 * needs exactly the same geometry and would otherwise become a second,
 * divergent renderer of the same railway. What is left here is authoring
 * only: the palette, the ghost-preview *policy* (which tile, which
 * rotation), mouse painting, undo, the write path, diagnostics, and the
 * cursor readout.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGridEditor } from '../hooks/useGridEditor';
import { useGridDiagnostics } from '../hooks/useGridDiagnostics';
import { useOpenings } from '../hooks/useOpenings';
import { useDiagramViewport } from '../hooks/useDiagramViewport';
import { MAX_COORDINATE, useDiagramModel } from '../diagram/diagramModel';
import { TILE_SIZE } from '../diagram/tilePaths';
import { OCCUPANCY } from '../diagram/encoding';
import { describeDiagnostic, diagnosticCoordinate, partitionDiagnostics } from '../diagram/diagnostics';
import { defaultPointRoads, isPointTile } from '../diagram/pointRoads';
import { describeCursor } from '../diagram/cursorAnnouncement';
import { GridDiagnostic, GridTileMetadata, TileType } from '../types';
import { BlockRecord, PointRecord, SensorRecord } from '../types';
import { RULER_SIZE, TrackDiagram } from './TrackDiagram';

interface Props {
  layoutId: string | null;
  blocks: BlockRecord[];
  points: PointRecord[];
  sensors: SensorRecord[];
}

/** How many strokes of undo to keep. A stroke, not a tile — see `pushUndo`. */
const UNDO_LIMIT = 50;

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

  const { diagnostics } = useGridDiagnostics(layoutId, gridRevision);
  /**
   * #103 (D-H) — pure geometry, no walk, so it is cheap enough to read on
   * every stroke end alongside the diagnostics above.
   *
   * The only source of opening names the editor has, as of step 6.2:
   * `useBlockEnds` and its two toolbar controls are gone. They named the same
   * openings out of a stored table that could disagree with the drawing; these
   * come from the drawing itself, on every read.
   */
  const { openings } = useOpenings(layoutId, gridRevision);

  const svgRef = useRef<SVGSVGElement>(null);
  const viewport = useDiagramViewport(layoutId, svgRef, TILE_SIZE, RULER_SIZE);

  /**
   * The derived-from-the-drawing model (#75) — parsed metadata, block runs
   * and their tints, where each point's name is drawn, and the per-cell view
   * of the compiled openings. Shared with whatever a monitor view (#63/#82)
   * ends up reading; see `diagram/diagramModel.ts`.
   */
  const model = useDiagramModel(grid, openings);

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

  /**
   * Label density (#68 item 4). The useful density genuinely differs between
   * authoring — where you are checking every tile carries the block you meant
   * — and reading, where the labels are clutter over track you already know.
   * Defaults to `always`, which is the authoring case and the screen this is.
   */
  const [labelDensity, setLabelDensity] = useState<'always' | 'hover' | 'off'>('always');

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

  /**
   * Focused on Escape (#94). `role="application"` hands the canvas the
   * arrow keys and takes them away from the screen reader's own navigation,
   * so there has to be an obvious, keyboard-only way back out. `tabIndex={-1}`
   * keeps the toolbar itself out of the normal tab order — it was never a
   * stop before, and Escape reaching it is a targeted exit, not a new place
   * Tab lands on.
   */
  const toolbarRef = useRef<HTMLDivElement>(null);

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

  const svgToGrid = useCallback(
    (clientX: number, clientY: number) => {
      const rect = svgRef.current!.getBoundingClientRect();
      // The pan/zoom `<g>` is translated by `RULER_SIZE` on top of `offset`
      // so the ruler gutters get a reserved strip (#94) — subtract it here
      // to undo that shift, the same way `offset` itself is undone.
      const sx = (clientX - rect.left - viewport.offset.x - RULER_SIZE) / viewport.zoom;
      const sy = (clientY - rect.top - viewport.offset.y - RULER_SIZE) / viewport.zoom;
      return { x: Math.floor(sx / TILE_SIZE), y: Math.floor(sy / TILE_SIZE) };
    },
    [viewport.offset, viewport.zoom],
  );

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
      const existingMeta = model.parsedMeta.get(`${x},${y}`) ?? {};

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
      model.parsedMeta,
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
      viewport.beginPan(e.clientX, e.clientY);
      e.preventDefault();
      return;
    }
    setIsPainting(true);
    handleTileAction(e.clientX, e.clientY, e.button === 2);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (viewport.continuePan(e.clientX, e.clientY)) return;

    const { x, y } = svgToGrid(e.clientX, e.clientY);
    if (x >= 0 && y >= 0 && x < model.extent.cols && y < model.extent.rows) {
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
    viewport.endPan();
    commitStroke();
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    viewport.onWheel(e.deltaY);
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
   * the `<svg>` itself (rendered by `TrackDiagram`), means every one of these
   * bindings only fires while the canvas actually has focus — no guard
   * needed, because an `<input>` or the diagnostics panel is a different part
   * of the DOM tree and this event never reaches it.
   *
   * A plain function rather than `useCallback`, matching `onMouseMove` and
   * `onMouseUp` above: it closes over state declared later in this component
   * (`cursor`, `model.extent`), which is safe for a closure invoked from an
   * event — by the time a keypress actually happens, the render that declared
   * them has long since completed — but would be a stale-or-TDZ risk if this
   * were memoised with a dependency array evaluated at its own declaration
   * point.
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
        x: Math.max(0, Math.min(model.extent.cols - 1, c.x + arrow.dx)),
        y: Math.max(0, Math.min(model.extent.rows - 1, c.y + arrow.dy)),
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
   * "Take me to this cell" (#94): move the cursor, centre the view, and
   * briefly pulse the cell so the jump is visible as more than just the
   * readout changing underneath you.
   *
   * Extracted from `jumpToDiagnostic` so any surface naming a cell can reuse
   * it verbatim — the block-ends panel did until #103 PR 6.2, and the next one
   * will. Two implementations of "jump" that drifted apart would be a genuinely
   * confusing bug.
   */
  const jumpToCell = useCallback(
    (coord: { x: number; y: number }) => {
      setCursor(coord);
      viewport.centerOn(coord);

      pulseId.current += 1;
      setPulseCell({ x: coord.x, y: coord.y, id: pulseId.current });
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
      pulseTimer.current = window.setTimeout(() => setPulseCell(null), 900);
    },
    [viewport.centerOn],
  );

  const jumpToDiagnostic = useCallback(
    (d: GridDiagnostic) => {
      const coord = diagnosticCoordinate(d);
      if (!coord) return;
      jumpToCell(coord);
    },
    [jumpToCell],
  );

  // The pulse timer must not outlive the component.
  useEffect(() => {
    return () => {
      if (pulseTimer.current !== null) window.clearTimeout(pulseTimer.current);
    };
  }, []);

  // Forget any undo history belonging to the layout we just left — those
  // coordinates mean something else here. Runs alongside, not inside, the
  // view-restore effect `useDiagramViewport` owns internally (#75): the two
  // are independent state, both triggered by this same `layoutId` change.
  useEffect(() => {
    strokeRef.current = [];
    strokeSeen.current = new Set();
    setUndoStack([]);
  }, [layoutId]);

  const sensorNames = useMemo(() => new Map(sensors.map((s) => [s.id, s.name])), [sensors]);
  const blockNames = useMemo(() => new Map(blocks.map((b) => [b.id, b.name])), [blocks]);
  const pointNames = useMemo(() => new Map(points.map((p) => [p.id, p.name])), [points]);

  const { warnings, info } = useMemo(() => partitionDiagnostics(diagnostics), [diagnostics]);

  /** What's at the cursor's cell, resolved the same way the render loop resolves any other tile. */
  const cursorTile = useMemo(() => {
    const k = `${cursor.x},${cursor.y}`;
    const tile = grid.get(k);
    if (!tile) return null;
    return {
      tileType: tile.tileType as TileType,
      metadata: model.parsedMeta.get(k) ?? {},
      openings: model.openingsAtCursor.get(k) ?? [],
    };
  }, [cursor, grid, model.parsedMeta, model.openingsAtCursor]);

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
   * The paint tool's hover preview, computed here (policy — which tile, which
   * rotation, which block) and handed to `TrackDiagram` as inert data. `null`
   * whenever there is nothing to preview, i.e. the mouse is off the canvas.
   */
  const ghostPreview = hoverCell
    ? {
        cell: hoverCell,
        tileType: selectedType,
        rotation: selectedRotation,
        blockName: selectedBlockId ? blocks.find((b) => b.id === selectedBlockId)?.name : null,
      }
    : undefined;

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
          onClick={() => viewport.setZoom((z) => Math.min(z + 0.2, 3))}
          style={st.iconBtn}
          tabIndex={-1}
          title="Zoom in"
        >＋</button>
        <button
          onClick={() => viewport.setZoom((z) => Math.max(z - 0.2, 0.3))}
          style={st.iconBtn}
          tabIndex={-1}
          title="Zoom out"
        >－</button>
        <button
          onClick={() => viewport.fitToContent(Array.from(grid.values()))}
          style={st.iconBtn}
          tabIndex={-1}
          title="Fit to content"
        >⌂</button>

        <div style={st.toolSep} />

        {/*
          `Ends ⟳` and `Ends ✎` were here (#103 PR 6.2). Both existed to keep a
          stored table of names level with the drawing: one regenerated it, the
          other patched what regeneration got wrong or refused. Neither has
          anything to do now — opening names are compiled from the drawing on
          every read, so there is no second copy to reconcile and no name for a
          hand to correct. The openings are drawn on the canvas and applied to
          the graph in Configure → Edges.
        */}

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
        <TrackDiagram
          ref={svgRef}
          grid={grid}
          parsedMeta={model.parsedMeta}
          extent={model.extent}
          offset={viewport.offset}
          zoom={viewport.zoom}
          runs={model.runs}
          tintOf={model.tintOf}
          pointLabelAt={model.pointLabelAt}
          points={points}
          blocks={blocks}
          sensorNames={sensorNames}
          labelsVisible={labelsVisible}
          onKeyDown={onCanvasKeyDown}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={() => setHoverCell(null)}
          onWheel={onWheel}
          onContextMenu={onContextMenu}
          cursor={cursor}
          ghostPreview={ghostPreview}
          jumpPulse={pulseCell ?? undefined}
        />
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
          Delete: erase at cursor · Esc: leave grid for toolbar · Canvas: {model.extent.cols}×
          {model.extent.rows} (grows as you draw) · {grid.size} tile{grid.size !== 1 ? 's' : ''}
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
  // A toggle that is currently *on*. Border and background together, not
  // colour alone — the same rule the diagram encoding follows (#81), and the
  // `aria-expanded` on the button carries it for anything not looking.
  iconBtnActive:   { background: '#2a2a3d', border: '1px solid #89b4fa' } as React.CSSProperties,
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
