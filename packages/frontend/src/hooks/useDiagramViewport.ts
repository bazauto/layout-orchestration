/**
 * useDiagramViewport
 *
 * Pan, zoom, middle-drag panning, wheel zoom, `fitToContent`, `centerOn`, and
 * the per-layout localStorage persistence of the view. Extracted from
 * `GridEditor.tsx` by #75 — the viewport has nothing to do with authoring and
 * a future monitor view (#63/#82) wants the identical behaviour, not a second
 * implementation of "where am I looking".
 *
 * Needs the `<svg>` element itself (via `svgRef`, owned by the caller —
 * currently `GridEditor`, forwarded through to `TrackDiagram`) to turn a
 * client-space centring request into an `offset`, which is why this is a
 * hook rather than a pure function: `centerOn`/`fitToContent` read layout
 * geometry off the DOM.
 */

import { RefObject, useCallback, useEffect, useRef, useState } from 'react';

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

export interface DiagramViewport {
  offset: { x: number; y: number };
  zoom: number;
  setOffset: React.Dispatch<React.SetStateAction<{ x: number; y: number }>>;
  setZoom: React.Dispatch<React.SetStateAction<number>>;
  /** Starts a middle-drag pan at this client point. */
  beginPan: (clientX: number, clientY: number) => void;
  /** Updates `offset` if a pan is in progress. Returns whether it was — the caller's mouse-move falls through to its own handling when this is `false`. */
  continuePan: (clientX: number, clientY: number) => boolean;
  endPan: () => void;
  /** Wheel-scroll zoom, clamped to [0.3, 3]. Takes the raw `deltaY`. */
  onWheel: (deltaY: number) => void;
  /**
   * Pans, without changing zoom, so `cell` sits at the centre of the
   * viewport. Used by the diagnostics panel's "jump to" buttons (#94).
   */
  centerOn: (cell: { x: number; y: number }) => void;
  /**
   * Frames the given tiles in the viewport.
   *
   * `⌂` used to reset to zoom 1 at the origin, which on a layout drawn away
   * from the origin leaves the canvas apparently blank — the control that is
   * supposed to rescue you from being lost was itself a way to get lost.
   */
  fitToContent: (tiles: readonly { x: number; y: number }[]) => void;
}

export function useDiagramViewport(
  layoutId: string | null,
  svgRef: RefObject<SVGSVGElement>,
  tileSize: number,
  rulerSize: number,
): DiagramViewport {
  // Viewport pan/zoom. Restored from the last visit to this layout (#69) —
  // reopening the tab should put you back where you were, not at the origin
  // of a layout that may be drawn nowhere near it.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  const panStart = useRef<{ mx: number; my: number; ox: number; oy: number } | null>(null);
  /** Which layout's saved view has been restored, so persistence can't race it. */
  const hydratedFor = useRef<string | null>(null);
  /** The view just restored, held until it has rendered — see the persist effect. */
  const pendingRestore = useRef<SavedView | null>(null);

  const beginPan = useCallback(
    (clientX: number, clientY: number) => {
      panStart.current = { mx: clientX, my: clientY, ox: offset.x, oy: offset.y };
    },
    [offset],
  );

  const continuePan = useCallback((clientX: number, clientY: number) => {
    if (!panStart.current) return false;
    setOffset({
      x: panStart.current.ox + (clientX - panStart.current.mx),
      y: panStart.current.oy + (clientY - panStart.current.my),
    });
    return true;
  }, []);

  const endPan = useCallback(() => {
    panStart.current = null;
  }, []);

  const onWheel = useCallback((deltaY: number) => {
    setZoom((z) => Math.max(0.3, Math.min(3, z - deltaY * 0.001)));
  }, []);

  const centerOn = useCallback(
    (cell: { x: number; y: number }) => {
      const svg = svgRef.current;
      if (!svg) return;
      const view = svg.getBoundingClientRect();
      if (view.width === 0 || view.height === 0) return;
      const cx = (cell.x + 0.5) * tileSize;
      const cy = (cell.y + 0.5) * tileSize;
      setOffset({
        x: view.width / 2 - rulerSize - cx * zoom,
        y: view.height / 2 - rulerSize - cy * zoom,
      });
    },
    [zoom, svgRef, tileSize, rulerSize],
  );

  const fitToContent = useCallback(
    (tiles: readonly { x: number; y: number }[]) => {
      const svg = svgRef.current;
      if (!svg) return;
      const view = svg.getBoundingClientRect();
      if (view.width === 0 || view.height === 0) return;

      if (tiles.length === 0) {
        setZoom(1);
        setOffset({ x: 0, y: 0 });
        return;
      }

      // The ruler gutters (#94) reserve `rulerSize` off the top and left, so
      // content is centred in what is left of the viewport rather than the
      // whole of it — otherwise "fit to content" would frame a rectangle that
      // includes the strip the gutters cover.
      const availW = view.width - rulerSize;
      const availH = view.height - rulerSize;

      const minX = Math.min(...tiles.map((t) => t.x));
      const minY = Math.min(...tiles.map((t) => t.y));
      const maxX = Math.max(...tiles.map((t) => t.x));
      const maxY = Math.max(...tiles.map((t) => t.y));

      const contentW = (maxX - minX + 1) * tileSize;
      const contentH = (maxY - minY + 1) * tileSize;
      const pad = tileSize;

      const nextZoom = Math.max(
        0.3,
        Math.min(3, Math.min((availW - pad * 2) / contentW, (availH - pad * 2) / contentH)),
      );

      setZoom(nextZoom);
      setOffset({
        x: (availW - contentW * nextZoom) / 2 - minX * tileSize * nextZoom,
        y: (availH - contentH * nextZoom) / 2 - minY * tileSize * nextZoom,
      });
    },
    [svgRef, tileSize, rulerSize],
  );

  // Restore this layout's last view.
  useEffect(() => {
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

  return { offset, zoom, setOffset, setZoom, beginPan, continuePan, endPan, onWheel, centerOn, fitToContent };
}
