import { BlockState, BlockRecord, ClientMessage, PointState, PointRecord } from '../types';
import { LOCK, OCCUPANCY, POINT_CONFIRMATION, type StateEncoding } from '../diagram/encoding';
import { effectivePosition } from '../diagram/pointConfirmation';

interface Props {
  blocks: Record<string, BlockState>;
  points: Record<string, PointState>;
  blockRecords: BlockRecord[];
  pointRecords: PointRecord[];
  disabled: boolean;
  send: (msg: ClientMessage) => void;
}

/**
 * This file used to hold two ad-hoc colour maps, `OCCUPANCY_COLOUR` and
 * `POSITION_COLOUR`, which were the pattern #81 was filed to stop spreading.
 * The encodings now come from `diagram/encoding.ts`, shared with the Track
 * Editor and with whatever the monitor view (#63) turns out to be.
 *
 * The badges here already carried their state as text, so colour was never
 * the sole carrier on this screen — the glyph is added because the state word
 * is the first thing to be dropped when a layout gets tight, and the glyph
 * survives that.
 *
 * The Points table's badge (#25, docs/point-feedback.md D3) shows
 * `confirmedPosition` — what was actually reported, `'unknown'` until a
 * reading lands — as the primary value, with `commandedPosition` alongside it
 * only when the two disagree: a mismatch, or a `'required'` point still
 * `pending`. The badge's colour and glyph come from `POINT_CONFIRMATION`, not
 * from the position itself, because the fact worth surfacing at a glance is
 * how far the position can be trusted — `mismatch`, `indeterminate` and
 * `timed-out` all read as fault-coloured but carry distinct glyphs and words,
 * never colour alone. `stale` (#167) reads untrusted-yellow rather than
 * fault-red on purpose: its controller went quiet, which degrades the position
 * without latching anything.
 */
const UNSET = '#6c7086';

function badgeOf(map: Record<string, StateEncoding>, state: string): StateEncoding | null {
  return map[state] ?? null;
}

export function LayoutPanel({ blocks, points, blockRecords, pointRecords, disabled, send }: Props) {
  const blockList = Object.values(blocks);
  const pointList = Object.values(points);

  const blockName = (id: string) => blockRecords.find((b) => b.id === id)?.name ?? id;
  const pointName = (id: string) => pointRecords.find((p) => p.id === id)?.name ?? id;

  // Targets the opposite of the *displayed* (effective, D7) position, never
  // the raw commanded field — a `'none'` point that was thrown and never
  // reported would otherwise show `confirmedPosition: 'unknown'` forever and
  // toggle to the same value on every click. Falls back to `'normal'` on an
  // unknown/never-commanded point, same as before #25.
  const throwPoint = (pointId: string, point: PointState) => {
    const current = effectivePosition(point);
    const next = current === 'normal' ? 'reverse' : 'normal';
    send({ type: 'POINT_COMMAND', payload: { pointId, position: next as 'normal' | 'reverse' } });
  };

  return (
    <div style={styles.wrapper}>
      {/* ── Blocks ── */}
      <section style={styles.panel}>
        <h2 style={styles.heading}>Blocks</h2>
        {blockList.length === 0 && <p style={styles.empty}>No blocks configured.</p>}
        {blockList.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                {['Block', 'Occupancy', 'Loco', 'Route'].map((h) => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {blockList.map((b) => (
                <tr key={b.blockId}>
                  <td style={styles.td}>{blockName(b.blockId)}</td>
                  <td style={styles.td}>
                    <span
                      style={{
                        ...styles.badge,
                        background: badgeOf(OCCUPANCY, b.occupancy)?.colour ?? UNSET,
                        color: '#1e1e2e',
                      }}
                    >
                      <span aria-hidden="true">{badgeOf(OCCUPANCY, b.occupancy)?.glyph}</span>{' '}
                      {b.occupancy}
                    </span>
                  </td>
                  <td style={styles.td}>{b.locoAddress ?? '—'}</td>
                  <td style={styles.td}>{b.lockedByRoute ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Points ── */}
      <section style={styles.panel}>
        <h2 style={styles.heading}>Points</h2>
        {pointList.length === 0 && <p style={styles.empty}>No points configured.</p>}
        {pointList.length > 0 && (
          <table style={styles.table}>
            <thead>
              <tr>
                {['Point', 'Position', 'Locked', ''].map((h) => (
                  <th key={h} style={styles.th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pointList.map((p) => {
                const confEnc = badgeOf(POINT_CONFIRMATION, p.confirmation);
                const pending = p.confirmation === 'pending';
                // Secondary text only when there is something to disagree
                // with: a `commandedPosition` that differs from what was
                // actually reported (a mismatch, or a `'required'` point
                // still pending and reset to `'unknown'`).
                const showCommanded = p.commandedPosition !== null && p.commandedPosition !== p.confirmedPosition;
                return (
                  <tr key={p.pointId}>
                    <td style={styles.td}>{pointName(p.pointId)}</td>
                    <td style={styles.td}>
                      <span
                        style={{
                          ...styles.badge,
                          background: confEnc?.colour ?? UNSET,
                          color: '#1e1e2e',
                        }}
                        title={confEnc?.label ?? p.confirmation}
                      >
                        <span aria-hidden="true">{confEnc?.glyph}</span> {p.confirmedPosition}
                      </span>
                      {/* The word, never colour alone (#81) — mismatch, timed-out
                          and indeterminate all read fault-coloured and must stay
                          distinct without it. */}
                      <span style={styles.confirmationLabel}>{confEnc?.label ?? p.confirmation}</span>
                      {showCommanded && (
                        <span style={styles.secondary}>commanded {p.commandedPosition}</span>
                      )}
                      {/* D2 open question 1: an automated route may still hold
                          this point, with a reduced guarantee — stated here,
                          per point, rather than in a footnote. */}
                      {p.positionFeedback === 'none' && (
                        <span
                          style={styles.noFeedback}
                          title="This point is not configured to confirm its position — its reported position is not independently verified."
                        >
                          no feedback
                        </span>
                      )}
                    </td>
                    <td style={styles.td}>
                      {p.locked ? (
                        <span title={`${LOCK.label} by route ${p.lockedByRoute}`}>
                          {LOCK.glyph} {LOCK.label}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td style={styles.td}>
                      <button
                        onClick={() => throwPoint(p.pointId, p)}
                        disabled={disabled || p.locked || pending}
                        title={
                          p.locked
                            ? `Locked by route ${p.lockedByRoute}`
                            : pending
                              ? 'Waiting for this point to confirm its last command'
                              : 'Throw point'
                        }
                        style={styles.throwBtn}
                      >
                        Throw
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

const styles = {
  wrapper: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 12,
  } as React.CSSProperties,
  panel: {
    background: '#181825',
    border: '1px solid #313244',
    borderRadius: 6,
    padding: 16,
  } as React.CSSProperties,
  heading: {
    margin: '0 0 12px',
    fontSize: 15,
    color: '#89dceb',
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
  } as React.CSSProperties,
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  } as React.CSSProperties,
  th: {
    textAlign: 'left' as const,
    padding: '4px 8px',
    color: '#6c7086',
    borderBottom: '1px solid #313244',
  },
  td: {
    padding: '6px 8px',
    color: '#cdd6f4',
    borderBottom: '1px solid #1e1e2e',
  } as React.CSSProperties,
  badge: {
    display: 'inline-block',
    padding: '1px 7px',
    borderRadius: 10,
    fontSize: 11,
    fontWeight: 700,
  } as React.CSSProperties,
  confirmationLabel: {
    display: 'block',
    fontSize: 10,
    color: '#a6adc8',
    marginTop: 2,
  } as React.CSSProperties,
  secondary: {
    display: 'block',
    fontSize: 10,
    color: '#a6adc8',
  } as React.CSSProperties,
  noFeedback: {
    display: 'block',
    fontSize: 10,
    color: '#6c7086',
    fontStyle: 'italic',
  } as React.CSSProperties,
  throwBtn: {
    background: '#313244',
    color: '#cdd6f4',
    border: '1px solid #45475a',
    borderRadius: 3,
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 11,
  } as React.CSSProperties,
  empty: {
    color: '#6c7086',
    fontSize: 13,
    margin: 0,
  } as React.CSSProperties,
} as const;
