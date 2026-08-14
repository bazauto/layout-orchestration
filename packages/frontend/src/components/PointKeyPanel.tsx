/**
 * PointKeyPanel — what the abbreviations on the diagram mean, and what each
 * point is doing.
 *
 * The diagram draws `P1` where the point is called `P1 - Fiddle Yard`, and
 * puts the full name in a `<title>` (#93). That works for a mouse and is
 * useless on a wall display nobody is standing at, which is what this panel
 * fixes: every abbreviation resolved at once.
 *
 * ## It floats over the canvas, and the operator places it
 *
 * This was a column *beside* the canvas, and `docs/liveness.md` M6 argued for
 * that: an overlay covers track on the one view whose whole job is showing all
 * of it. What it missed is that a fixed column covers track too — it takes the
 * width off the canvas permanently, everywhere, whether or not there is
 * anything under it. On the real layout the result was a 260px column of
 * wrapped two-line names against a diagram that had lost a fifth of its width.
 *
 * So it floats, and it is **dragged where the operator wants it**. A layout
 * always has empty canvas somewhere; which corner is empty is a property of
 * the drawing, and the person looking at it is the one who knows. That is also
 * what pays for the width: free of the canvas's flex row it sizes to its own
 * content, so the names stop wrapping.
 *
 * Collapsible, and both the position and the collapsed state persist per
 * layout, because the two audiences want opposite things. An unattended mimic
 * wants the whole canvas; someone checking why a route will not set wants the
 * table. Neither should have to re-place it every time the tab changes.
 *
 * Monitor-only. The Track Editor shows no live state at all
 * (`docs/liveness.md` M2), so two of the four columns would be blank there and
 * the remaining two are already on the tiles.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PointKeyRow } from '../diagram/pointKey';
import { INK, LOCK, POINT_POSITION } from '../diagram/encoding';

const panelKey = (layoutId: string) => `layout-orchestrator:monitorPointKey:${layoutId}`;

/** Where the panel sits, in pixels from the canvas's top-left. */
interface Placement {
  open: boolean;
  /** `null` until it has been dragged: the default corner is computed from the canvas. */
  at: { x: number; y: number } | null;
}

const DEFAULT_PLACEMENT: Placement = { open: true, at: null };

/** Clear of the Safe-Stop banner, which spans the top of the canvas. */
const DEFAULT_INSET = { right: 12, top: 40 };

/** How far one arrow-key press moves the panel. */
const NUDGE = 12;

/**
 * Tolerant of anything it finds and silent on failure, the same posture
 * `useDiagramViewport` takes: a corrupt entry or a disabled localStorage must
 * never stop the monitor rendering, which is the one view that has to come up
 * unattended.
 *
 * It also still reads the bare `'open'`/`'closed'` this key held before the
 * panel could be placed. Not compatibility for its own sake — the alternative
 * is an operator whose panel silently re-opens once, which is a small thing to
 * pay a branch for.
 */
function loadPlacement(layoutId: string | null): Placement {
  if (!layoutId) return DEFAULT_PLACEMENT;
  try {
    const raw = window.localStorage.getItem(panelKey(layoutId));
    if (raw === null) return DEFAULT_PLACEMENT;
    if (raw === 'open' || raw === 'closed') return { open: raw === 'open', at: null };

    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PLACEMENT;
    const { open, at } = parsed as { open?: unknown; at?: unknown };
    const point =
      typeof at === 'object' &&
      at !== null &&
      Number.isFinite((at as { x?: unknown }).x) &&
      Number.isFinite((at as { y?: unknown }).y)
        ? { x: (at as { x: number }).x, y: (at as { y: number }).y }
        : null;
    return { open: open !== false, at: point };
  } catch {
    return DEFAULT_PLACEMENT;
  }
}

function savePlacement(layoutId: string | null, placement: Placement): void {
  if (!layoutId) return;
  try {
    window.localStorage.setItem(panelKey(layoutId), JSON.stringify(placement));
  } catch {
    /* a convenience, not worth surfacing */
  }
}

export function PointKeyPanel({
  layoutId,
  rows,
}: {
  layoutId: string | null;
  rows: readonly PointKeyRow[];
}) {
  const [placement, setPlacement] = useState<Placement>(() => loadPlacement(layoutId));
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  // Re-read on a layout change rather than keeping one panel state across all
  // layouts — the preference is per layout, so switching must adopt the new
  // one instead of writing the old one over it.
  useEffect(() => {
    setPlacement(loadPlacement(layoutId));
  }, [layoutId]);

  const update = useCallback(
    (next: Placement) => {
      setPlacement(next);
      savePlacement(layoutId, next);
    },
    [layoutId],
  );

  const toggle = useCallback(() => {
    setPlacement((was) => {
      const next = { ...was, open: !was.open };
      savePlacement(layoutId, next);
      return next;
    });
  }, [layoutId]);

  /**
   * Keeps the panel inside the canvas.
   *
   * A panel dragged off the edge of an unattended display cannot be dragged
   * back — there is nothing to grab — so the clamp is not a nicety. It is
   * applied on every move rather than only on release, so the panel stops at
   * the edge instead of appearing to leave and then jumping back.
   */
  const clamp = useCallback((x: number, y: number) => {
    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!panel || !parent) return { x, y };
    const maxX = Math.max(0, parent.clientWidth - panel.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - panel.offsetHeight);
    return { x: Math.min(Math.max(0, x), maxX), y: Math.min(Math.max(0, y), maxY) };
  }, []);

  const onGripDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    if (!panel || !parent) return;
    const box = panel.getBoundingClientRect();
    dragRef.current = { dx: e.clientX - box.left, dy: e.clientY - box.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onGripMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    const parent = panelRef.current?.offsetParent as HTMLElement | null;
    if (!drag || !parent) return;
    const box = parent.getBoundingClientRect();
    setPlacement((was) => ({
      ...was,
      at: clamp(e.clientX - box.left - drag.dx, e.clientY - box.top - drag.dy),
    }));
  };

  const onGripUp = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    savePlacement(layoutId, placement);
  };

  /**
   * Arrow keys move it too. Dragging is the gesture, but a panel that can
   * *only* be dragged is a panel a keyboard user cannot move at all — and the
   * position is the whole feature.
   */
  const onGripKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-NUDGE, 0],
      ArrowRight: [NUDGE, 0],
      ArrowUp: [0, -NUDGE],
      ArrowDown: [0, NUDGE],
    };
    const delta = deltas[e.key];
    if (!delta) return;
    e.preventDefault();

    const panel = panelRef.current;
    const parent = panel?.offsetParent as HTMLElement | null;
    // Before the first drag there is no stored position, so the nudge starts
    // from where the panel is actually drawn rather than from (0, 0).
    const from =
      placement.at ??
      (panel && parent
        ? { x: panel.offsetLeft, y: panel.offsetTop }
        : { x: DEFAULT_INSET.right, y: DEFAULT_INSET.top });
    update({ ...placement, at: clamp(from.x + delta[0], from.y + delta[1]) });
  };

  const position: React.CSSProperties = placement.at
    ? { left: placement.at.x, top: placement.at.y }
    : { right: DEFAULT_INSET.right, top: DEFAULT_INSET.top };

  return (
    <div
      ref={panelRef}
      style={{ ...(placement.open ? st.panel : st.panelCollapsed), ...position }}
      aria-label="Point key"
    >
      <div style={st.header}>
        {/*
          A separate grip rather than a draggable header. The header is a
          button, and a drag that also toggles — or a toggle suppressed by a
          movement threshold — is the kind of gesture that works for whoever
          tuned the threshold and for nobody else.
        */}
        <button
          type="button"
          style={st.grip}
          onPointerDown={onGripDown}
          onPointerMove={onGripMove}
          onPointerUp={onGripUp}
          onPointerCancel={onGripUp}
          onKeyDown={onGripKeyDown}
          title="Drag to move the point key, or use the arrow keys"
          aria-label="Move the point key. Use the arrow keys to move it with the keyboard."
        >
          ⠿
        </button>
        <button
          type="button"
          onClick={toggle}
          style={st.headerButton}
          aria-expanded={placement.open}
          aria-controls="point-key-body"
          title={placement.open ? 'Hide the point key' : 'Show the point key'}
        >
          <span>{placement.open ? '▾' : '▸'}</span>
          <span style={st.headerText}>Points</span>
          <span style={st.count}>{rows.length}</span>
        </button>
      </div>

      {placement.open && (
        <div id="point-key-body" style={st.body}>
          {rows.length === 0 ? (
            <p style={st.empty}>No points on this layout.</p>
          ) : (
            <table style={st.table}>
              <caption style={st.caption}>
                Point key. Positions are <strong>commanded</strong>, not confirmed.
              </caption>
              <thead>
                <tr>
                  <th scope="col" style={st.th}>
                    On&nbsp;diagram
                  </th>
                  <th scope="col" style={st.th}>
                    Name
                  </th>
                  <th scope="col" style={st.th}>
                    Set
                  </th>
                  <th scope="col" style={st.th}>
                    Held
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const enc = POINT_POSITION[row.position];
                  return (
                    <tr key={row.pointId}>
                      {/* Monospace and italic, matching how the tile draws it —
                          the column is only useful if the eye can match the two. */}
                      <td style={st.tdShort}>{row.short}</td>
                      <td style={st.td}>{row.name}</td>
                      {/* The word, not only the colour (#81). The glyph comes
                          from the encoding module so the table and the diagram
                          cannot disagree about it. */}
                      <td style={{ ...st.td, color: enc.colour }}>
                        <span style={st.glyph}>{enc.glyph}</span> {enc.label}
                      </td>
                      <td style={st.td}>
                        {row.lockedByRoute ? (
                          <span title={`Held by route ${row.lockedByRoute}`}>
                            <span style={{ ...st.glyph, color: LOCK.colour }}>{LOCK.glyph}</span>{' '}
                            {LOCK.label}
                          </span>
                        ) : (
                          <span style={st.free}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Sized by its content between a floor and a ceiling, not to a fixed column
 * width: the names are the reason the panel exists and wrapping them defeats
 * it, but a pathological name must not be allowed to cover the drawing.
 */
const surface: React.CSSProperties = {
  position: 'absolute',
  zIndex: 3,
  width: 'max-content',
  minWidth: 230,
  maxWidth: 420,
  background: '#181825',
  border: '1px solid #45475a',
  borderRadius: 4,
  boxShadow: '0 6px 18px rgba(0, 0, 0, 0.45)',
  overflow: 'hidden',
};

const st = {
  panel: {
    ...surface,
    display: 'flex',
    flexDirection: 'column',
    // Bounded, and scrolls inside itself: a layout with thirty points must not
    // produce a panel taller than the canvas it is floating over.
    maxHeight: 'calc(100% - 24px)',
  } as React.CSSProperties,
  panelCollapsed: surface,
  header: {
    display: 'flex',
    alignItems: 'stretch',
    borderBottom: '1px solid #313244',
  } as React.CSSProperties,
  grip: {
    padding: '6px 6px 6px 8px',
    background: 'transparent',
    border: 'none',
    color: INK.muted,
    font: 'inherit',
    fontSize: 12,
    cursor: 'move',
    touchAction: 'none',
  } as React.CSSProperties,
  headerButton: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    padding: '6px 10px 6px 4px',
    background: 'transparent',
    border: 'none',
    color: INK.primary,
    font: 'inherit',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    textAlign: 'left',
  } as React.CSSProperties,
  headerText: { flex: 1 } as React.CSSProperties,
  count: { color: INK.muted, fontWeight: 400 } as React.CSSProperties,
  body: { overflow: 'auto', minHeight: 0 } as React.CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 11,
    color: INK.primary,
  } as React.CSSProperties,
  caption: {
    captionSide: 'top',
    padding: '6px 10px',
    color: INK.secondary,
    fontSize: 11,
    textAlign: 'left',
  } as React.CSSProperties,
  th: {
    textAlign: 'left',
    padding: '4px 8px',
    color: INK.secondary,
    fontWeight: 600,
    borderBottom: '1px solid #313244',
    position: 'sticky',
    top: 0,
    background: '#181825',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  td: { padding: '3px 8px', verticalAlign: 'top', whiteSpace: 'nowrap' } as React.CSSProperties,
  tdShort: {
    padding: '3px 8px',
    verticalAlign: 'top',
    fontFamily: 'monospace',
    fontStyle: 'italic',
    color: INK.primary,
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  glyph: { fontFamily: 'monospace' } as React.CSSProperties,
  free: { color: INK.muted } as React.CSSProperties,
  empty: { padding: 10, color: INK.secondary, fontSize: 12 } as React.CSSProperties,
} as const;
