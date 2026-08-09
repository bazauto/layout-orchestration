import { useMemo, useState } from 'react';
import {
  BlockRecord,
  BlockState,
  LocoRecord,
  RouteFaultView,
  RouteReservation,
} from '../types';

interface Props {
  /** Live reservations from the WebSocket snapshot, keyed by route id. */
  routes: Record<string, RouteReservation>;
  routeFaults: RouteFaultView[];
  blocks: Record<string, BlockState>;
  blockRecords: BlockRecord[];
  locoRecords: LocoRecord[];
  disabled: boolean;
  onRequest: (req: {
    locoAddress: number;
    startBlockId: string;
    destinationBlockId: string;
  }) => Promise<{ ok: boolean; message?: string }>;
  onCancel: (routeId: string) => Promise<{ ok: boolean; message?: string }>;
  onResume: (routeId: string) => Promise<{ ok: boolean; message?: string }>;
  onAcknowledgeFault: (routeId: string) => Promise<{ ok: boolean; message?: string }>;
}

/**
 * Operator-facing surface for #4 (pathfinding and setting the road). Three
 * parts, in the order an operator needs them:
 *
 *  1. **Latched route faults** first, because the system is Safe-Stopped
 *     while any exists and nothing else on this panel will work until one is
 *     acknowledged. Unlike a sensor fault there is no arming counter — a
 *     route cannot prove itself, so Acknowledge is always enabled
 *     (docs/pathfinding.md P8).
 *  2. **Request a route** — loco, start block, destination. The path itself
 *     is the *backend's* to choose; this deliberately offers no way to hand
 *     one in. An explicit edge list is still accepted by the API for tooling
 *     and tests, but an operator picking edges by id would be a worse
 *     interface than the pathfinder, not a more powerful one.
 *  3. **Live routes** — active and suspended only, with Cancel and (for
 *     suspended) Resume. Released and cancelled routes are dropped rather
 *     than accumulating; the reservation row survives on the backend for the
 *     record, but a terminal route is not something to operate.
 *
 * Every rejected request keeps its message on screen and leaves the form
 * populated — a refused grant is information (`block b4 is occupied`), not a
 * reason to make the operator retype what they asked for. Same posture as
 * EdgesTab's violation banner.
 */
export function RoutesPanel({
  routes,
  routeFaults,
  blocks,
  blockRecords,
  locoRecords,
  disabled,
  onRequest,
  onCancel,
  onResume,
  onAcknowledgeFault,
}: Props) {
  const [locoAddress, setLocoAddress] = useState<number | ''>('');
  const [startBlockId, setStartBlockId] = useState('');
  const [destinationBlockId, setDestinationBlockId] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [rowBusy, setRowBusy] = useState<Record<string, boolean>>({});

  const blockName = useMemo(
    () => Object.fromEntries(blockRecords.map((b) => [b.id, b.name])),
    [blockRecords],
  );

  // #54: names the loco holding a route/fault instead of just its DCC
  // address — RoutesPanel already had blockName in scope for the path
  // display, but rendered `Loco ${address}` bare.
  const locoName = useMemo(
    () => Object.fromEntries(locoRecords.map((l) => [l.address, l.name])),
    [locoRecords],
  );

  const liveRoutes = useMemo(
    () =>
      Object.values(routes)
        .filter((r) => r.status === 'active' || r.status === 'suspended')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [routes],
  );

  const canSubmit =
    !disabled && !busy && locoAddress !== '' && startBlockId !== '' && destinationBlockId !== '';

  const runRowAction = async (
    routeId: string,
    action: () => Promise<{ ok: boolean; message?: string }>,
  ) => {
    setRowBusy((b) => ({ ...b, [routeId]: true }));
    const result = await action();
    setRowBusy((b) => ({ ...b, [routeId]: false }));
    if (!result.ok) setMessage({ ok: false, text: result.message ?? 'Action failed' });
    else setMessage(null);
  };

  const handleSubmit = async () => {
    // `canSubmit` already establishes locoAddress is a number, and TypeScript
    // narrows through the aliased condition — no redundant re-check here.
    if (!canSubmit) return;
    setBusy(true);
    const result = await onRequest({ locoAddress, startBlockId, destinationBlockId });
    setBusy(false);
    setMessage(
      result.ok
        ? { ok: true, text: 'Route granted — points set.' }
        : { ok: false, text: result.message ?? 'Route refused' },
    );
  };

  return (
    <section style={s.panel}>
      <h2 style={s.heading}>Routes</h2>

      {routeFaults.length > 0 && (
        <div style={s.faultBanner}>
          {routeFaults.map((f) => (
            <div key={f.routeId} style={s.faultRow}>
              <div style={s.faultText}>
                <p style={s.faultLine}>
                  <strong>{locoName[f.locoAddress] ?? `Loco ${f.locoAddress}`}</strong> — {f.reason}
                </p>
                <p style={s.faultMeta}>
                  {f.kind}
                  {f.blockId ? ` · ${blockName[f.blockId] ?? f.blockId}` : ''} ·{' '}
                  {new Date(f.faultedAt).toLocaleString()}
                </p>
              </div>
              <button
                onClick={() => runRowAction(f.routeId, () => onAcknowledgeFault(f.routeId))}
                disabled={rowBusy[f.routeId] ?? false}
                style={s.ackBtn}
              >
                Acknowledge
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={s.form}>
        <select
          value={locoAddress}
          onChange={(e) => setLocoAddress(e.target.value === '' ? '' : Number(e.target.value))}
          disabled={disabled}
          style={s.select}
          // "Route loco", not "Loco" — ThrottlePanel already has a loco
          // select on the same screen, and two controls sharing an
          // accessible name is ambiguous to a screen reader as well as to a
          // test.
          aria-label="Route loco"
        >
          <option value="">Loco…</option>
          {locoRecords.map((l) => (
            <option key={l.id} value={l.address}>
              {l.name} ({l.address})
            </option>
          ))}
        </select>

        <select
          value={startBlockId}
          onChange={(e) => setStartBlockId(e.target.value)}
          disabled={disabled}
          style={s.select}
          aria-label="Route start block"
        >
          <option value="">From…</option>
          {blockRecords.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
              {blocks[b.id] === undefined ? '' : ` · ${blocks[b.id].occupancy}`}
            </option>
          ))}
        </select>

        <select
          value={destinationBlockId}
          onChange={(e) => setDestinationBlockId(e.target.value)}
          disabled={disabled}
          style={s.select}
          aria-label="Route destination block"
        >
          <option value="">To…</option>
          {blockRecords.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>

        <button onClick={handleSubmit} disabled={!canSubmit} style={canSubmit ? s.goBtn : s.goBtnDisabled}>
          {busy ? 'Requesting…' : 'Request route'}
        </button>
      </div>

      {message && (
        <p style={message.ok ? s.okMessage : s.errMessage}>{message.text}</p>
      )}

      {liveRoutes.length === 0 ? (
        <p style={s.empty}>No live routes.</p>
      ) : (
        <ul style={s.list}>
          {liveRoutes.map((r) => {
            const path = r.path.map((step) => blockName[step.blockId] ?? step.blockId);
            const isBusy = rowBusy[r.id] ?? false;
            return (
              <li key={r.id} style={s.routeRow}>
                <div style={s.routeText}>
                  <p style={s.routeLine}>
                    <strong>{locoName[r.locoAddress] ?? `Loco ${r.locoAddress}`}</strong>{' '}
                    <span style={r.status === 'active' ? s.statusActive : s.statusSuspended}>
                      {r.status}
                    </span>
                  </p>
                  <p style={s.routeMeta}>
                    {path.map((name, i) => (
                      <span key={i} style={i <= r.confirmedIndex ? s.stepDone : s.stepAhead}>
                        {i > 0 ? ' → ' : ''}
                        {name}
                      </span>
                    ))}
                  </p>
                  {r.reason && <p style={s.routeReason}>{r.reason}</p>}
                </div>
                <div style={s.routeActions}>
                  {r.status === 'suspended' && (
                    <button
                      onClick={() => runRowAction(r.id, () => onResume(r.id))}
                      disabled={isBusy || disabled}
                      style={s.resumeBtn}
                    >
                      Resume
                    </button>
                  )}
                  <button
                    onClick={() => runRowAction(r.id, () => onCancel(r.id))}
                    disabled={isBusy}
                    style={s.cancelBtn}
                  >
                    Cancel
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ─── Styles (Catppuccin Mocha, matching the other operate panels) ─────────────

const s = {
  panel:            { background: '#181825', border: '1px solid #313244', borderRadius: 6, padding: 16, minWidth: 0, flex: 1 } as React.CSSProperties,
  heading:          { margin: '0 0 12px', fontSize: 14, textTransform: 'uppercase', letterSpacing: 1, color: '#a6adc8' } as React.CSSProperties,

  faultBanner:      { background: '#3a2130', border: '1px solid #f38ba8', borderRadius: 4, padding: '8px 12px', marginBottom: 12 } as React.CSSProperties,
  faultRow:         { display: 'flex', gap: 12, alignItems: 'center', padding: '4px 0' } as React.CSSProperties,
  faultText:        { flex: 1, minWidth: 0 } as React.CSSProperties,
  faultLine:        { margin: '2px 0', fontSize: 12, color: '#f38ba8' } as React.CSSProperties,
  faultMeta:        { margin: '2px 0', fontSize: 11, color: '#f38ba8', opacity: 0.8 } as React.CSSProperties,
  ackBtn:           { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '5px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12, whiteSpace: 'nowrap' } as React.CSSProperties,

  form:             { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } as React.CSSProperties,
  select:           { background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '6px 8px', fontSize: 12, minWidth: 120 } as React.CSSProperties,
  goBtn:            { background: '#89b4fa', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '6px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  goBtnDisabled:    { background: '#45475a', color: '#6c7086', border: 'none', borderRadius: 4, padding: '6px 14px', fontWeight: 700, cursor: 'not-allowed', fontSize: 12 } as React.CSSProperties,

  okMessage:        { margin: '10px 0 0', fontSize: 12, color: '#a6e3a1' } as React.CSSProperties,
  errMessage:       { margin: '10px 0 0', fontSize: 12, color: '#f38ba8' } as React.CSSProperties,
  empty:            { margin: '12px 0 0', fontSize: 12, color: '#6c7086' } as React.CSSProperties,

  list:             { listStyle: 'none', margin: '12px 0 0', padding: 0 } as React.CSSProperties,
  routeRow:         { display: 'flex', gap: 12, alignItems: 'center', padding: '8px 0', borderTop: '1px solid #313244' } as React.CSSProperties,
  routeText:        { flex: 1, minWidth: 0 } as React.CSSProperties,
  routeLine:        { margin: '2px 0', fontSize: 13, color: '#cdd6f4' } as React.CSSProperties,
  routeMeta:        { margin: '2px 0', fontSize: 12 } as React.CSSProperties,
  routeReason:      { margin: '2px 0', fontSize: 11, color: '#f9e2af' } as React.CSSProperties,
  stepDone:         { color: '#a6e3a1' } as React.CSSProperties,
  stepAhead:        { color: '#6c7086' } as React.CSSProperties,
  statusActive:     { color: '#a6e3a1', fontSize: 11, textTransform: 'uppercase' } as React.CSSProperties,
  statusSuspended:  { color: '#f9e2af', fontSize: 11, textTransform: 'uppercase' } as React.CSSProperties,
  routeActions:     { display: 'flex', gap: 6 } as React.CSSProperties,
  resumeBtn:        { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '5px 10px', fontWeight: 700, cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  cancelBtn:        { background: '#f38ba8', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '5px 10px', fontWeight: 700, cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
} as const;
