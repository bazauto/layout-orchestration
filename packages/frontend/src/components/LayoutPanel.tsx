import { BlockState, BlockRecord, ClientMessage, PointState, PointRecord } from '../types';

interface Props {
  blocks: Record<string, BlockState>;
  points: Record<string, PointState>;
  blockRecords: BlockRecord[];
  pointRecords: PointRecord[];
  disabled: boolean;
  send: (msg: ClientMessage) => void;
}

const OCCUPANCY_COLOUR: Record<string, string> = {
  occupied: '#f38ba8',
  clear: '#a6e3a1',
  unknown: '#f9e2af',
};

const POSITION_COLOUR: Record<string, string> = {
  normal: '#89b4fa',
  reverse: '#cba6f7',
  unknown: '#f9e2af',
};

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
                        background: OCCUPANCY_COLOUR[b.occupancy] ?? '#6c7086',
                        color: '#1e1e2e',
                      }}
                    >
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
                        background: POSITION_COLOUR[p.position] ?? '#6c7086',
                        color: '#1e1e2e',
                      }}
                    >
                      {p.position}
                    </span>
                  </td>
                  <td style={styles.td}>{p.locked ? '🔒' : '—'}</td>
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
