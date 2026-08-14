/**
 * PointKeyPanel — what the abbreviations on the diagram mean, and what each
 * point is doing.
 *
 * The diagram draws `P1` where the point is called `P1 - Fiddle Yard`, and
 * puts the full name in a `<title>` (#93). That works for a mouse and is
 * useless on a wall display nobody is standing at, which is what this panel
 * fixes: every abbreviation resolved at once, beside the drawing rather than
 * on it.
 *
 * Collapsible, and persisted per layout, because the two audiences want
 * opposite things. An unattended mimic wants the whole canvas; someone
 * checking why a route will not set wants the table. Neither should have to
 * re-open it every time the tab changes.
 *
 * Monitor-only. The Track Editor shows no live state at all
 * (`docs/liveness.md` M2), so two of the four columns would be blank there and
 * the remaining two are already on the tiles.
 */

import { useCallback, useEffect, useState } from 'react';
import { PointKeyRow } from '../diagram/pointKey';
import { INK, LOCK, POINT_POSITION } from '../diagram/encoding';

const panelKey = (layoutId: string) => `layout-orchestrator:monitorPointKey:${layoutId}`;

/**
 * Tolerant of anything it finds and silent on failure, the same posture
 * `useDiagramViewport` takes: a corrupt entry or a disabled localStorage must
 * never stop the monitor rendering, which is the one view that has to come up
 * unattended.
 */
function loadOpen(layoutId: string | null): boolean {
  if (!layoutId) return true;
  try {
    const raw = window.localStorage.getItem(panelKey(layoutId));
    return raw === null ? true : raw === 'open';
  } catch {
    return true;
  }
}

export function PointKeyPanel({
  layoutId,
  rows,
}: {
  layoutId: string | null;
  rows: readonly PointKeyRow[];
}) {
  const [open, setOpen] = useState(() => loadOpen(layoutId));

  // Re-read on a layout change rather than keeping one panel state across all
  // layouts — the preference is per layout, so switching must adopt the new
  // one instead of writing the old one over it.
  useEffect(() => {
    setOpen(loadOpen(layoutId));
  }, [layoutId]);

  const toggle = useCallback(() => {
    setOpen((was) => {
      const next = !was;
      if (layoutId) {
        try {
          window.localStorage.setItem(panelKey(layoutId), next ? 'open' : 'closed');
        } catch {
          /* a convenience, not worth surfacing */
        }
      }
      return next;
    });
  }, [layoutId]);

  return (
    <div style={open ? st.panel : st.panelCollapsed}>
      <button
        type="button"
        onClick={toggle}
        style={st.header}
        aria-expanded={open}
        aria-controls="point-key-body"
        title={open ? 'Hide the point key' : 'Show the point key'}
      >
        <span>{open ? '▾' : '▸'}</span>
        <span style={st.headerText}>Points</span>
        <span style={st.count}>{rows.length}</span>
      </button>

      {open && (
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

const st = {
  panel: {
    width: 260,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    minHeight: 0,
    background: '#181825',
    border: '1px solid #313244',
    borderRadius: 4,
    overflow: 'hidden',
  } as React.CSSProperties,
  panelCollapsed: {
    flexShrink: 0,
    alignSelf: 'flex-start',
    background: '#181825',
    border: '1px solid #313244',
    borderRadius: 4,
    overflow: 'hidden',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '6px 10px',
    background: 'transparent',
    border: 'none',
    borderBottom: '1px solid #313244',
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
  } as React.CSSProperties,
  td: { padding: '3px 8px', verticalAlign: 'top' } as React.CSSProperties,
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
