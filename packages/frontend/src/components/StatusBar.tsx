import { SystemMode, SystemStatus } from '../types';
import { ConnectionState } from '../hooks/useLayoutSocket';

interface Props {
  status: SystemStatus;
  mode: SystemMode;
  reason: string | null;
  connectionState: ConnectionState;
  onEmergencyStop: () => void;
  onModeChange: (mode: SystemMode) => void;
}

const STATUS_COLOURS: Record<SystemStatus, string> = {
  online: '#22c55e',
  'safe-stop': '#f59e0b',
  offline: '#6b7280',
};

const CONN_LABELS: Record<ConnectionState, string> = {
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
};

export function StatusBar({ status, mode, reason, connectionState, onEmergencyStop, onModeChange }: Props) {
  const colour = STATUS_COLOURS[status];

  return (
    <header style={styles.bar}>
      <div style={styles.left}>
        <span style={{ ...styles.dot, background: colour }} />
        <strong style={{ color: colour }}>{status.toUpperCase()}</strong>
        {reason && <span style={styles.reason}> — {reason}</span>}
      </div>

      <div style={styles.centre}>
        <span style={styles.connLabel}>{CONN_LABELS[connectionState]}</span>
      </div>

      <div style={styles.right}>
        <label style={styles.modeLabel}>Mode:</label>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as SystemMode)}
          style={styles.select}
          disabled={status === 'offline'}
        >
          <option value="manual">Manual</option>
          <option value="hybrid">Hybrid</option>
          <option value="auto">Auto</option>
        </select>

        <button
          onClick={onEmergencyStop}
          disabled={status === 'offline'}
          style={styles.estop}
          title="Emergency Stop — halts all locos immediately"
        >
          ⏹ E-STOP
        </button>
      </div>
    </header>
  );
}

const styles = {
  bar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '8px 16px',
    background: '#1e1e2e',
    borderBottom: '1px solid #313244',
    minHeight: 48,
    gap: 12,
  } as React.CSSProperties,
  left: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  } as React.CSSProperties,
  dot: {
    width: 10,
    height: 10,
    borderRadius: '50%',
    display: 'inline-block',
  } as React.CSSProperties,
  reason: {
    color: '#cdd6f4',
    fontSize: 13,
  } as React.CSSProperties,
  centre: {
    flex: 1,
    textAlign: 'center',
    fontSize: 12,
    color: '#6c7086',
  } as React.CSSProperties,
  connLabel: {
    fontSize: 12,
    color: '#6c7086',
  } as React.CSSProperties,
  right: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flex: 1,
    justifyContent: 'flex-end',
  } as React.CSSProperties,
  modeLabel: {
    color: '#cdd6f4',
    fontSize: 13,
  } as React.CSSProperties,
  select: {
    background: '#313244',
    color: '#cdd6f4',
    border: '1px solid #45475a',
    borderRadius: 4,
    padding: '3px 6px',
    fontSize: 13,
    cursor: 'pointer',
  } as React.CSSProperties,
  estop: {
    background: '#f38ba8',
    color: '#1e1e2e',
    border: 'none',
    borderRadius: 4,
    padding: '5px 12px',
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
    letterSpacing: '0.5px',
  } as React.CSSProperties,
} as const;
