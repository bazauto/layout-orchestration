import { BlockState, BlockRecord, ClientMessage, PointState, PointRecord } from '../types';
import { LOCK, OCCUPANCY, POINT_POSITION, type StateEncoding } from '../diagram/encoding';

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

  const throwPoint = (pointId: string, current: string) => {
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
              {pointList.map((p) => (
                <tr key={p.pointId}>
                  <td style={styles.td}>{pointName(p.pointId)}</td>
                  <td style={styles.td}>
                    <span
                      style={{
                        ...styles.badge,
                        background: badgeOf(POINT_POSITION, p.position)?.colour ?? UNSET,
                        color: '#1e1e2e',
                      }}
                    >
                      <span aria-hidden="true">{badgeOf(POINT_POSITION, p.position)?.glyph}</span>{' '}
                      {p.position}
                    </span>
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
                      onClick={() => throwPoint(p.pointId, p.position)}
                      disabled={disabled || p.locked}
                      title={p.locked ? `Locked by route ${p.lockedByRoute}` : 'Throw point'}
                      style={styles.throwBtn}
                    >
                      Throw
                    </button>
                  </td>
                </tr>
              ))}
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
