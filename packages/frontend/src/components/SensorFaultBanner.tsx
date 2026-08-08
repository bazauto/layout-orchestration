import { useState } from 'react';
import { SensorFaultView } from '../types';

interface Props {
  faults: SensorFaultView[];
  /** Sensor id → display name, so a fault can be named rather than shown as a bare id. */
  sensorNames: Record<string, string>;
  onAcknowledge: (sensorId: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Operator-facing surface for #34 (sensor-fault recovery). Renders nothing
 * when there are no faults. Per fault:
 *  - sensor name (falls back to the raw id), reason, and when it was faulted.
 *  - an **Acknowledge** button, enabled only once the fault is `armed`
 *    (`docs/sensor-fault-recovery.md` D1) — a device publishing valid
 *    readings again is necessary but not sufficient; a human still has to
 *    say the layout may move. Disabled, it names exactly how many more
 *    consecutive valid readings are outstanding, unambiguous to someone
 *    standing at the layout.
 *  - on a failed acknowledge (premature, already cleared, ...), the error is
 *    shown inline and the fault stays listed — same posture as `EdgesTab`'s
 *    violation banner: a rejected mutation must not look like it succeeded.
 *
 * Deliberately does not offer "mark out of service" here — that is a
 * persistent config change (D5) and stays on the Configure screen's Sensors
 * tab, authored alongside the sensor's other fields.
 */
export function SensorFaultBanner({ faults, sensorNames, onAcknowledge }: Props) {
  const [acking, setAcking] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (faults.length === 0) return null;

  const handleAcknowledge = async (sensorId: string) => {
    setAcking((a) => ({ ...a, [sensorId]: true }));
    const result = await onAcknowledge(sensorId);
    setAcking((a) => ({ ...a, [sensorId]: false }));
    setErrors((e) => ({ ...e, [sensorId]: result.ok ? '' : (result.message ?? 'Acknowledge failed') }));
  };

  return (
    <div style={s.banner}>
      {faults.map((f) => {
        const outstanding = f.requiredValidReadings - f.consecutiveValidReadings;
        const isAcking = acking[f.sensorId] ?? false;
        const error = errors[f.sensorId];
        return (
          <div key={f.sensorId} style={s.row}>
            <div style={s.text}>
              <p style={s.line}>
                <strong>{sensorNames[f.sensorId] ?? f.sensorId}</strong> — {f.reason}
              </p>
              <p style={s.meta}>Faulted at {new Date(f.faultedAt).toLocaleString()}</p>
              {error && <p style={s.line}>{error}</p>}
            </div>
            <button
              onClick={() => handleAcknowledge(f.sensorId)}
              disabled={!f.armed || isAcking}
              style={f.armed ? s.ackBtn : s.ackBtnDisabled}
              title={f.armed ? 'Acknowledge this fault' : `${outstanding} more valid reading(s) needed`}
            >
              {f.armed ? 'Acknowledge' : `${outstanding} more valid reading${outstanding === 1 ? '' : 's'} needed`}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Styles (matches EdgesTab's violation banner — Catppuccin Mocha) ──────────

const s = {
  banner:          { background: '#3a2130', border: '1px solid #f38ba8', borderRadius: 4, padding: '8px 12px', margin: '0 16px 12px' } as React.CSSProperties,
  row:             { display: 'flex', gap: 12, alignItems: 'center', padding: '4px 0' } as React.CSSProperties,
  text:            { flex: 1, minWidth: 0 } as React.CSSProperties,
  line:            { margin: '2px 0', fontSize: 12, color: '#f38ba8' } as React.CSSProperties,
  meta:            { margin: '2px 0', fontSize: 11, color: '#f38ba8', opacity: 0.8 } as React.CSSProperties,
  ackBtn:          { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '5px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } as React.CSSProperties,
  ackBtnDisabled:  { background: '#45475a', color: '#6c7086', border: 'none', borderRadius: 4, padding: '5px 12px', fontWeight: 700, cursor: 'not-allowed', fontSize: 12, whiteSpace: 'nowrap' } as React.CSSProperties,
} as const;
