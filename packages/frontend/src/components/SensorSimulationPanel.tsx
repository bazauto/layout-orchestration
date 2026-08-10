import { useState } from 'react';
import { MalformedVariant, SensorRecord, SimulateReadingRequest, SimulateReadingResponse } from '../types';

interface Props {
  sensors: SensorRecord[];
  onInject: (
    sensorId: string,
    body: SimulateReadingRequest,
  ) => Promise<{ ok: boolean; message?: string; data?: SimulateReadingResponse }>;
}

const MALFORMED_VARIANTS: MalformedVariant[] = ['bad-enum', 'missing-field', 'not-an-object'];

/** One entry in the client-side "last injected" history (D8) — a record of your own keystrokes, never a claim about the layout. Capped at 20, newest first. */
interface HistoryEntry {
  at: string;
  sensorId: string;
  ok: boolean;
  message?: string;
  data?: SimulateReadingResponse;
}

const MAX_HISTORY = 20;

/**
 * Operator-facing surface for #65 (sensor simulation panel). Bench-testing
 * tool: publishes a fabricated reading to a sensor's own MQTT topic and lets
 * it round-trip through the ordinary ingestion path, exactly as hardware
 * would (D1). Rendered only when `capabilities.sensorSimulation` is true
 * (App.tsx) — this component itself does no gating.
 *
 * Deliberately ignores App's `isDisabled` (WebSocket disconnected / system
 * offline) — D10 allows injection during Safe-Stop, and injection is a REST
 * publish that does not depend on the socket at all. The panel therefore
 * stays enabled whenever it renders; there is no `disabled` prop to wire up.
 *
 * `sensors` here is `layoutConfig.config.sensors` — the same in-service
 * flag the Configure screen's Sensors tab edits — so a sensor marked out of
 * service disables here immediately without a separate fetch (D9;
 * presentation only, the 409 is the enforcement).
 */
export function SensorSimulationPanel({ sensors, onInject }: Props) {
  const [sensorId, setSensorId] = useState('');
  const [retain, setRetain] = useState(true);
  const [variant, setVariant] = useState<MalformedVariant>('bad-enum');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const canInject = sensorId !== '' && !busy;

  const runInject = async (body: SimulateReadingRequest) => {
    if (!canInject) return;
    setBusy(true);
    const result = await onInject(sensorId, body);
    setBusy(false);
    setHistory((h) =>
      [{ at: new Date().toISOString(), sensorId, ok: result.ok, message: result.message, data: result.data }, ...h].slice(
        0,
        MAX_HISTORY,
      ),
    );
  };

  return (
    <section style={s.panel}>
      <h3 style={s.heading}>⚠ Sensor Simulation</h3>

      <div style={s.form}>
        <select
          value={sensorId}
          onChange={(e) => setSensorId(e.target.value)}
          style={s.select}
          aria-label="Simulation sensor"
        >
          <option value="">Sensor…</option>
          {sensors.map((sensor) => (
            <option key={sensor.id} value={sensor.id} disabled={!sensor.inService}>
              {sensor.name}
              {sensor.inService ? '' : ' (out of service)'}
            </option>
          ))}
        </select>

        <label style={s.checkboxLabel}>
          <input type="checkbox" checked={retain} onChange={(e) => setRetain(e.target.checked)} />
          retain
        </label>

        <div style={s.buttonRow}>
          <button
            onClick={() => runInject({ action: 'reading', state: 'occupied', retain })}
            disabled={!canInject}
            style={canInject ? s.actionBtn : s.actionBtnDisabled}
          >
            Occupied
          </button>
          <button
            onClick={() => runInject({ action: 'reading', state: 'clear', retain })}
            disabled={!canInject}
            style={canInject ? s.actionBtn : s.actionBtnDisabled}
          >
            Clear
          </button>
          <button
            onClick={() => runInject({ action: 'clear-retained' })}
            disabled={!canInject}
            style={canInject ? s.actionBtn : s.actionBtnDisabled}
          >
            Clear retained
          </button>
        </div>

        <div style={s.buttonRow}>
          <select
            value={variant}
            onChange={(e) => setVariant(e.target.value as MalformedVariant)}
            style={s.select}
            aria-label="Malformed variant"
          >
            {MALFORMED_VARIANTS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <button
            onClick={() => runInject({ action: 'malformed', variant, retain })}
            disabled={!canInject}
            style={canInject ? s.malformedBtn : s.actionBtnDisabled}
          >
            Inject malformed
          </button>
        </div>
      </div>

      <p style={s.subheading}>Last injected</p>
      {history.length === 0 ? (
        <p style={s.empty}>Nothing injected yet.</p>
      ) : (
        <ul style={s.list}>
          {history.map((entry, i) => (
            <li key={i} style={s.historyRow}>
              {entry.ok ? (
                <>
                  <p style={s.historyLine}>
                    {new Date(entry.at).toLocaleTimeString()} — {entry.data?.sensorName ?? entry.sensorId}
                  </p>
                  <p style={s.historyMeta}>
                    {JSON.stringify(entry.data?.payload)} · retain: {String(entry.data?.retain)}
                  </p>
                </>
              ) : (
                <p style={s.errorLine}>
                  {new Date(entry.at).toLocaleTimeString()} — {entry.sensorId}: {entry.message ?? 'Injection failed'}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ─── Styles (Catppuccin Mocha, warning colours matching SensorFaultBanner) ────

const s = {
  panel:           { background: '#181825', border: '1px solid #f38ba8', borderRadius: 6, padding: 16, flex: '0 0 340px' } as React.CSSProperties,
  heading:         { margin: '0 0 12px', fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: '#f38ba8' } as React.CSSProperties,

  form:            { display: 'flex', flexDirection: 'column', gap: 8 } as React.CSSProperties,
  select:          { background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '6px 8px', fontSize: 12, minWidth: 120 } as React.CSSProperties,
  checkboxLabel:   { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#a6adc8' } as React.CSSProperties,
  buttonRow:       { display: 'flex', gap: 8, flexWrap: 'wrap' } as React.CSSProperties,
  actionBtn:       { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '6px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  actionBtnDisabled: { background: '#45475a', color: '#6c7086', border: 'none', borderRadius: 4, padding: '6px 12px', fontWeight: 700, cursor: 'not-allowed', fontSize: 12 } as React.CSSProperties,
  malformedBtn:    { background: '#f38ba8', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '6px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12 } as React.CSSProperties,

  subheading:      { margin: '14px 0 4px', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, color: '#a6adc8' } as React.CSSProperties,
  empty:           { margin: 0, fontSize: 12, color: '#6c7086' } as React.CSSProperties,
  list:            { listStyle: 'none', margin: 0, padding: 0, maxHeight: 220, overflowY: 'auto' } as React.CSSProperties,
  historyRow:      { padding: '4px 0', borderTop: '1px solid #313244' } as React.CSSProperties,
  historyLine:     { margin: '2px 0', fontSize: 12, color: '#cdd6f4' } as React.CSSProperties,
  historyMeta:     { margin: '2px 0', fontSize: 11, color: '#a6adc8', wordBreak: 'break-word' } as React.CSSProperties,
  errorLine:       { margin: '2px 0', fontSize: 12, color: '#f38ba8' } as React.CSSProperties,
} as const;
