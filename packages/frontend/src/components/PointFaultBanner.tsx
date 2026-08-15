import { useState } from 'react';
import { PointFaultView } from '../types';

interface Props {
  faults: PointFaultView[];
  /** Point id → display name, so a fault can be named rather than shown as a bare id. */
  pointNames: Record<string, string>;
  onAcknowledge: (pointId: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Operator-facing surface for #25 (point position feedback). Renders nothing
 * when there are no faults. Mirrors `SensorFaultBanner` exactly — same
 * arming rule (`docs/point-feedback.md` D4), same posture on a failed
 * acknowledge (shown inline, the fault stays listed).
 *
 * Every kind Safe-Stops the whole system (D4), including a fault on a point
 * no route currently holds — a point whose position is unknown makes every
 * edge gated on it untraversable, not merely the edges a route happens to be
 * using right now. The escape hatch for a point whose feedback is unreliable
 * or not wanted is flipping it back to `positionFeedback: 'none'` on the
 * Configure screen, not acknowledging around it here.
 */
export function PointFaultBanner({ faults, pointNames, onAcknowledge }: Props) {
  const [acking, setAcking] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  if (faults.length === 0) return null;

  const handleAcknowledge = async (pointId: string) => {
    setAcking((a) => ({ ...a, [pointId]: true }));
    const result = await onAcknowledge(pointId);
    setAcking((a) => ({ ...a, [pointId]: false }));
    setErrors((e) => ({ ...e, [pointId]: result.ok ? '' : (result.message ?? 'Acknowledge failed') }));
  };

  return (
    <div style={s.banner}>
      {faults.map((f) => {
        const outstanding = f.requiredConfirmations - f.consecutiveConfirmations;
        const isAcking = acking[f.pointId] ?? false;
        const error = errors[f.pointId];
        return (
          <div key={f.pointId} style={s.row}>
            <div style={s.text}>
              <p style={s.line}>
                <strong>{pointNames[f.pointId] ?? f.pointId}</strong> — {f.reason}
              </p>
              <p style={s.meta}>Faulted at {new Date(f.faultedAt).toLocaleString()}</p>
              {error && <p style={s.line}>{error}</p>}
            </div>
            <button
              onClick={() => handleAcknowledge(f.pointId)}
              disabled={!f.armed || isAcking}
              style={f.armed ? s.ackBtn : s.ackBtnDisabled}
              title={f.armed ? 'Acknowledge this fault' : `${outstanding} more confirming reading(s) needed`}
            >
              {f.armed ? 'Acknowledge' : `${outstanding} more confirmation${outstanding === 1 ? '' : 's'} needed`}
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Styles (matches SensorFaultBanner — Catppuccin Mocha) ────────────────────

const s = {
  banner:          { background: '#3a2130', border: '1px solid #f38ba8', borderRadius: 4, padding: '8px 12px', margin: '0 16px 12px' } as React.CSSProperties,
  row:             { display: 'flex', gap: 12, alignItems: 'center', padding: '4px 0' } as React.CSSProperties,
  text:            { flex: 1, minWidth: 0 } as React.CSSProperties,
  line:            { margin: '2px 0', fontSize: 12, color: '#f38ba8' } as React.CSSProperties,
  meta:            { margin: '2px 0', fontSize: 11, color: '#f38ba8', opacity: 0.8 } as React.CSSProperties,
  ackBtn:          { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '5px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } as React.CSSProperties,
  ackBtnDisabled:  { background: '#45475a', color: '#6c7086', border: 'none', borderRadius: 4, padding: '5px 12px', fontWeight: 700, cursor: 'not-allowed', fontSize: 12, whiteSpace: 'nowrap' } as React.CSSProperties,
} as const;
