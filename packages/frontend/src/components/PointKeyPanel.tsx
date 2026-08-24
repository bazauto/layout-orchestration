/**
 * PointKeyPanel — what the abbreviations on the diagram mean, what each point
 * is doing, and (#165) where each point is set from.
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
 * content, so the names stop wrapping. The drag, the clamp, the arrow-key
 * nudge and the persistence all live in `useFloatingPlacement` since #165 put
 * throttle cards on the same canvas under the same rule.
 *
 * Collapsible, and both the position and the collapsed state persist per
 * layout, because the two audiences want opposite things. An unattended mimic
 * wants the whole canvas; someone checking why a route will not set wants the
 * table. Neither should have to re-place it every time the tab changes.
 *
 * ## Setting a point (#165)
 *
 * The row already carried everything needed to decide whether to move a point
 * — its trusted position, how far that can be trusted, and whether a route
 * holds it — and could not act on any of it. Two buttons per row close that,
 * and they are **explicit `Normal` and `Reverse`, never a toggle**: a toggle
 * asks the operator to work out what "the other one" means from a position
 * that may read `unknown`, which is exactly the state where guessing is worst.
 *
 * Re-commanding the position a point is already in is deliberately allowed —
 * that is how an operator re-asserts a point whose confirmation came back
 * `mismatch` or `timed-out` (`docs/point-feedback.md`).
 *
 * A point **held by a route offers no buttons at all**. Forcing one cancels
 * the route holding it (D6), and that is a consequential act belonging on the
 * Routes panel where the route it destroys is named and visible — not one
 * mis-tap from a key that is mostly read rather than pressed.
 *
 * Control-plane only. The Track Editor shows no live state at all
 * (`docs/liveness.md` M2), so two of the four columns would be blank there and
 * the remaining two are already on the tiles.
 */

import { PointKeyRow } from '../diagram/pointKey';
import { INK, LOCK, POINT_CONFIRMATION, POINT_POSITION } from '../diagram/encoding';
import { useFloatingPlacement } from '../hooks/useFloatingPlacement';

/**
 * Unchanged since before #165, deliberately. The panel is the same panel, and
 * a renamed key would silently reset the position and collapsed state of every
 * operator who had already placed it — a rename nobody asked for, paid for by
 * the people who had most made the feature theirs.
 */
const panelKey = (layoutId: string) => `layout-orchestrator:monitorPointKey:${layoutId}`;

/** Clear of the Safe-Stop banner, which spans the top of the canvas. */
const DEFAULT_POSITION: React.CSSProperties = { right: 12, top: 40 };

export interface PointKeyPanelProps {
  layoutId: string | null;
  rows: readonly PointKeyRow[];
  /**
   * Whether this session may command a point at all (#165). `false` for the
   * `monitor` role, which gets the key and none of the buttons. Affordance
   * only: `DRIVING_MESSAGE_TYPES` on the backend is what enforces it (#63 D2),
   * and a `curl` or a stale tab is refused there regardless of this flag.
   */
  canControl: boolean;
  /** Connection or system status makes every command pointless — the same rule as Operate. */
  disabled: boolean;
  onSetPoint: (pointId: string, position: 'normal' | 'reverse') => void;
}

export function PointKeyPanel({
  layoutId,
  rows,
  canControl,
  disabled,
  onSetPoint,
}: PointKeyPanelProps) {
  const panel = useFloatingPlacement(layoutId ? panelKey(layoutId) : null, DEFAULT_POSITION);
  const { open } = panel.placement;

  return (
    <div
      ref={panel.panelRef}
      style={{ ...(open ? st.panel : st.panelCollapsed), ...panel.position }}
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
          {...panel.gripHandlers}
          title="Drag to move the point key, or use the arrow keys"
          aria-label="Move the point key. Use the arrow keys to move it with the keyboard."
        >
          ⠿
        </button>
        <button
          type="button"
          onClick={panel.toggle}
          style={st.headerButton}
          aria-expanded={open}
          aria-controls="point-key-body"
          title={open ? 'Hide the point key' : 'Show the point key'}
        >
          <span>{open ? '▾' : '▸'}</span>
          <span style={st.headerText}>Points</span>
          <span style={st.count}>{rows.length}</span>
        </button>
      </div>

      {open && (
        <div id="point-key-body" style={st.body}>
          {rows.length === 0 ? (
            <p style={st.empty}>No points on this layout.</p>
          ) : (
            <table style={st.table}>
              <caption style={st.caption}>
                Point key. Positions are shown as trusted (#25) — a point configured with no
                feedback channel falls back to what was last commanded.
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
                    Position
                  </th>
                  <th scope="col" style={st.th}>
                    Held
                  </th>
                  {canControl && (
                    <th scope="col" style={st.th}>
                      Set
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const enc = POINT_POSITION[row.position];
                  const confEnc = POINT_CONFIRMATION[row.confirmation];
                  return (
                    <tr key={row.pointId}>
                      {/* Monospace and italic, matching how the tile draws it —
                          the column is only useful if the eye can match the two. */}
                      <td style={st.tdShort}>{row.short}</td>
                      <td style={st.td}>{row.name}</td>
                      {/* The word, not only the colour (#81). The glyph comes
                          from the encoding module so the table and the diagram
                          cannot disagree about it. `position` here is already
                          `effectivePosition` (D7) — trusted, not raw commanded. */}
                      <td style={{ ...st.td, color: enc.colour }}>
                        <span style={st.glyph}>{enc.glyph}</span> {enc.label}
                        {/*
                          A wall display cannot hover, so a position that is not
                          confirmed says so in the row itself rather than reading
                          as settled — always shown, not only on a fault, so
                          "confirmed" is as legible a statement as "mismatch".
                        */}
                        <span style={{ ...st.confirmation, color: confEnc.colour }}>
                          <span style={st.glyph}>{confEnc.glyph}</span> {confEnc.label}
                        </span>
                        {/*
                          A configuration fact, independent of the transient
                          confirmation above: this point was never asked to
                          prove its position at all (docs/point-feedback.md
                          open question 1 — an automated route may still hold
                          it, with a reduced guarantee stated here).
                        */}
                        {row.positionFeedback === 'none' && (
                          <span
                            style={st.noFeedback}
                            title="This point is not configured to confirm its position — its reported position is not independently verified."
                          >
                            no feedback
                          </span>
                        )}
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
                      {canControl && (
                        <td style={st.td}>
                          {row.lockedByRoute ? (
                            /*
                              A held point offers no buttons, and says why in
                              words rather than presenting two disabled ones —
                              a greyed control still poses a question whose
                              honest answer is "not from here" (#61's argument,
                              applied a row at a time).
                            */
                            <span
                              style={st.free}
                              title={`Route ${row.lockedByRoute} holds this point. Cancel or complete the route to move it.`}
                            >
                              route
                            </span>
                          ) : (
                            <span style={st.setButtons}>
                              {(['normal', 'reverse'] as const).map((position) => (
                                <button
                                  key={position}
                                  type="button"
                                  onClick={() => onSetPoint(row.pointId, position)}
                                  disabled={disabled}
                                  aria-pressed={row.position === position}
                                  aria-label={`Set ${row.name} to ${position}`}
                                  title={`Set ${row.name} to ${position}`}
                                  style={{
                                    ...st.setBtn,
                                    ...(row.position === position ? st.setBtnActive : {}),
                                  }}
                                >
                                  {position === 'normal' ? 'N' : 'R'}
                                </button>
                              ))}
                            </span>
                          )}
                        </td>
                      )}
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
  confirmation: { display: 'block', fontSize: 10 } as React.CSSProperties,
  noFeedback: {
    display: 'block',
    fontSize: 10,
    color: INK.muted,
    fontStyle: 'italic',
  } as React.CSSProperties,
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
  setButtons: { display: 'inline-flex', gap: 3 } as React.CSSProperties,
  setBtn: {
    background: '#313244',
    color: INK.primary,
    border: '1px solid #45475a',
    borderRadius: 3,
    padding: '1px 6px',
    font: 'inherit',
    fontSize: 11,
    cursor: 'pointer',
  } as React.CSSProperties,
  setBtnActive: {
    background: '#89b4fa',
    color: '#1e1e2e',
    fontWeight: 700,
  } as React.CSSProperties,
  empty: { padding: 10, color: INK.secondary, fontSize: 12 } as React.CSSProperties,
} as const;
