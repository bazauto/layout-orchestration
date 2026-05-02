import { useState } from 'react';
import { ClientMessage, Direction, LocoRecord, LocoState } from '../types';

interface Props {
  locos: Record<number, LocoState>;
  locoRecords: LocoRecord[];
  disabled: boolean;
  send: (msg: ClientMessage) => void;
}

const CUSTOM = '__custom__';

export function ThrottlePanel({ locos, locoRecords, disabled, send }: Props) {
  const [selected, setSelected] = useState<string>(CUSTOM);
  const [customAddress, setCustomAddress] = useState(3);
  const [speed, setSpeed] = useState(0);
  const [direction, setDirection] = useState<Direction>('fwd');

  const activeLocoRecord = locoRecords.find((l) => l.id === selected);
  const address = activeLocoRecord ? activeLocoRecord.address : customAddress;
  const maxSpeed = activeLocoRecord ? activeLocoRecord.maxSpeed : 126;

  const activeLocos = Object.values(locos);

  const handleSelect = (id: string) => {
    setSelected(id);
    setSpeed(0); // reset speed on loco change
  };

  const dispatch = () => {
    send({ type: 'THROTTLE_COMMAND', payload: { locoAddress: address, speed, direction } });
  };

  const stop = (addr: number) => {
    send({ type: 'THROTTLE_COMMAND', payload: { locoAddress: addr, speed: 0, direction: 'stop' } });
  };

  const toggleLight = (addr: number, currentState: boolean) => {
    send({ type: 'FUNCTION_COMMAND', payload: { locoAddress: addr, fn: 0, state: !currentState } });
  };

  const locoLabel = (l: LocoRecord) => `${l.name} (addr ${l.address})`;

  return (
    <section style={styles.panel}>
      <h2 style={styles.heading}>Throttle</h2>

      {/* ── Command form ── */}
      <div style={styles.form}>
        <label style={styles.label}>
          Loco
          <select
            value={selected}
            onChange={(e) => handleSelect(e.target.value)}
            style={{ ...styles.select, flex: 1 }}
            disabled={disabled}
          >
            {locoRecords.map((l) => (
              <option key={l.id} value={l.id}>{locoLabel(l)}</option>
            ))}
            <option value={CUSTOM}>— Custom address —</option>
          </select>
        </label>

        {selected === CUSTOM && (
          <label style={styles.label}>
            Address
            <input
              type="number"
              min={1}
              max={9999}
              value={customAddress}
              onChange={(e) => setCustomAddress(Number(e.target.value))}
              style={styles.input}
              disabled={disabled}
            />
          </label>
        )}

        <label style={styles.label}>
          Speed (0–{maxSpeed})
          <input
            type="range"
            min={0}
            max={maxSpeed}
            value={Math.min(speed, maxSpeed)}
            onChange={(e) => setSpeed(Number(e.target.value))}
            style={{ flex: 1 }}
            disabled={disabled}
          />
          <span style={styles.speedVal}>{Math.min(speed, maxSpeed)}</span>
        </label>

        <label style={styles.label}>
          Direction
          <select
            value={direction}
            onChange={(e) => setDirection(e.target.value as Direction)}
            style={styles.select}
            disabled={disabled}
          >
            <option value="fwd">Forward</option>
            <option value="rev">Reverse</option>
            <option value="stop">Stop</option>
          </select>
        </label>

        <button onClick={dispatch} disabled={disabled} style={styles.btn}>
          Set
        </button>
      </div>

      {/* ── Active locos table ── */}
      {activeLocos.length > 0 && (
        <table style={styles.table}>
          <thead>
            <tr>
              {['Loco', 'Speed', 'Dir', 'F0', ''].map((h) => (
                <th key={h} style={styles.th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {activeLocos.map((loco) => {
              const rec = locoRecords.find((r) => r.address === loco.address);
              return (
                <tr key={loco.address}>
                  <td style={styles.td}>{rec ? rec.name : `addr ${loco.address}`}</td>
                  <td style={styles.td}>{loco.speed}</td>
                  <td style={styles.td}>{loco.direction}</td>
                  <td style={styles.td}>
                    <button
                      onClick={() => toggleLight(loco.address, !!loco.functions[0])}
                      disabled={disabled}
                      style={{
                        ...styles.fnBtn,
                        background: loco.functions[0] ? '#a6e3a1' : '#313244',
                        color: loco.functions[0] ? '#1e1e2e' : '#cdd6f4',
                      }}
                    >
                      {loco.functions[0] ? 'ON' : 'OFF'}
                    </button>
                  </td>
                  <td style={styles.td}>
                    <button onClick={() => stop(loco.address)} disabled={disabled} style={styles.stopBtn}>
                      Stop
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {activeLocos.length === 0 && (
        <p style={styles.empty}>No active locos. Select one above and set a speed.</p>
      )}
    </section>
  );
}

const styles = {
  panel: {
    background: '#181825',
    border: '1px solid #313244',
    borderRadius: 6,
    padding: 16,
  } as React.CSSProperties,
  heading: {
    margin: '0 0 12px',
    fontSize: 15,
    color: '#cba6f7',
    letterSpacing: '0.5px',
    textTransform: 'uppercase',
  } as React.CSSProperties,
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginBottom: 16,
  } as React.CSSProperties,
  label: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: '#cdd6f4',
    fontSize: 13,
  } as React.CSSProperties,
  input: {
    width: 70,
    background: '#313244',
    color: '#cdd6f4',
    border: '1px solid #45475a',
    borderRadius: 4,
    padding: '3px 6px',
    fontSize: 13,
  } as React.CSSProperties,
  speedVal: {
    width: 28,
    textAlign: 'right' as const,
    color: '#cdd6f4',
    fontSize: 13,
  },
  select: {
    background: '#313244',
    color: '#cdd6f4',
    border: '1px solid #45475a',
    borderRadius: 4,
    padding: '3px 6px',
    fontSize: 13,
  } as React.CSSProperties,
  btn: {
    alignSelf: 'flex-start',
    background: '#89b4fa',
    color: '#1e1e2e',
    border: 'none',
    borderRadius: 4,
    padding: '5px 16px',
    fontWeight: 700,
    cursor: 'pointer',
    fontSize: 13,
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
  fnBtn: {
    border: 'none',
    borderRadius: 3,
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
  } as React.CSSProperties,
  stopBtn: {
    background: '#f38ba8',
    color: '#1e1e2e',
    border: 'none',
    borderRadius: 3,
    padding: '2px 8px',
    cursor: 'pointer',
    fontSize: 11,
    fontWeight: 700,
  } as React.CSSProperties,
  empty: {
    color: '#6c7086',
    fontSize: 13,
    margin: 0,
  } as React.CSSProperties,
} as const;
