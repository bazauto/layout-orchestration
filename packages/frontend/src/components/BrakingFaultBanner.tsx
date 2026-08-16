import { useState } from 'react';
import { BrakingFaultView } from '../types';

interface Props {
  faults: BrakingFaultView[];
  /** Loco address → display name, so a fault can name the train rather than show a bare DCC address. */
  locoNames: Record<number, string>;
  /** Block id → display name, for the block an overrun was proved by. */
  blockNames: Record<string, string>;
  onAcknowledge: (locoAddress: number) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Each kind is shown as what it means to someone standing at the layout, not as
 * its wire name: `overrun` names the block that proved it (the train is further
 * along than it was told to stop), `speed-command-rejected` means a moving train
 * stopped taking commands, and #7's two (`docs/automation.md` A10) say whether
 * the train could not be stopped in time or simply never reached its beam.
 *
 * **A total mapping rather than a ternary**, which is what this was while there
 * were only two kinds. A ternary silently mislabels every kind added afterwards
 * as whichever one sits on its false branch — it would have reported #7's
 * `unable-to-stop`, the most serious of the four, as "speed command rejected".
 * A `Record` keyed on the union makes that a compile error instead.
 */
const KIND_LABELS: Record<BrakingFaultView['kind'], string> = {
  overrun: 'overran its stopping point',
  'speed-command-rejected': 'speed command rejected',
  'unable-to-stop': 'could not be stopped within its authority',
  'berth-not-confirmed': 'never reached its stopping beam',
};

/**
 * Operator-facing surface for #6's braking faults (docs/braking.md B10), and
 * #7's two (docs/automation.md A10). Renders nothing when there are none.
 * Mirrors `PointFaultBanner` and `SensorFaultBanner` — same shape, same
 * Safe-Stop posture, same acknowledge-in-place behaviour on failure.
 *
 * **No arming rule, unlike the other two**, and the button says so rather
 * than staying enabled with no explanation: a sensor proves itself by
 * publishing valid readings and a point by confirming its position, but the
 * loco this fault is about has already been Safe-Stopped, so nothing it does
 * next is evidence of anything (B10). The operator's acknowledgement *is* the
 * recovery.
 */

export function BrakingFaultBanner({ faults, locoNames, blockNames, onAcknowledge }: Props) {
  const [acking, setAcking] = useState<Record<number, boolean>>({});
  const [errors, setErrors] = useState<Record<number, string>>({});

  if (faults.length === 0) return null;

  const handleAcknowledge = async (locoAddress: number) => {
    setAcking((a) => ({ ...a, [locoAddress]: true }));
    const result = await onAcknowledge(locoAddress);
    setAcking((a) => ({ ...a, [locoAddress]: false }));
    setErrors((e) => ({
      ...e,
      [locoAddress]: result.ok ? '' : (result.message ?? 'Acknowledge failed'),
    }));
  };

  return (
    <div style={s.banner}>
      {faults.map((f) => {
        const isAcking = acking[f.locoAddress] ?? false;
        const error = errors[f.locoAddress];
        const locoName = locoNames[f.locoAddress] ?? `Loco ${f.locoAddress}`;
        const where = f.blockId ? (blockNames[f.blockId] ?? f.blockId) : null;
        return (
          <div key={f.locoAddress} style={s.row}>
            <div style={s.text}>
              <p style={s.line}>
                {/* The kind is spelled out beside the name: colour alone never
                    carries meaning here either (docs/diagram-encoding.md D1). */}
                <strong>{locoName}</strong> — {KIND_LABELS[f.kind]}: {f.reason}
              </p>
              <p style={s.meta}>
                Faulted at {new Date(f.faultedAt).toLocaleString()}
                {where ? ` · proved by ${where}` : ''}
                {f.routeId ? ` · route ${f.routeId}` : ''}
              </p>
              {error && <p style={s.line}>{error}</p>}
            </div>
            <button
              onClick={() => handleAcknowledge(f.locoAddress)}
              disabled={isAcking}
              style={s.ackBtn}
              title="Acknowledge this fault — a loco cannot prove itself, so there is nothing to wait for"
            >
              Acknowledge
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ─── Styles (matches PointFaultBanner — Catppuccin Mocha) ─────────────────────

const s = {
  banner:          { background: '#3a2130', border: '1px solid #f38ba8', borderRadius: 4, padding: '8px 12px', margin: '0 16px 12px' } as React.CSSProperties,
  row:             { display: 'flex', gap: 12, alignItems: 'center', padding: '4px 0' } as React.CSSProperties,
  text:            { flex: 1, minWidth: 0 } as React.CSSProperties,
  line:            { margin: '2px 0', fontSize: 12, color: '#f38ba8' } as React.CSSProperties,
  meta:            { margin: '2px 0', fontSize: 11, color: '#f38ba8', opacity: 0.8 } as React.CSSProperties,
  ackBtn:          { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '5px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } as React.CSSProperties,
} as const;
