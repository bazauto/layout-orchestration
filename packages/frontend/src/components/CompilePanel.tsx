/**
 * CompilePanel — reviewing the graph the drawing compiles to, and applying it
 * (#103 PR 5, D1).
 *
 * ## One button, and why there is no per-row accept
 *
 * The compiler owns the **whole** edge set (D3): a recompile is a replace, not
 * a merge. So there is nothing coherent for "accept this row" to mean — take
 * one and leave the rest and you have authored a graph the drawing does not
 * describe, which is the two-representations problem this issue exists to end,
 * wearing a friendly face. #78's panel had per-row accept because it was
 * proposing rows into a hand-authored graph. This is not that.
 *
 * What the operator approves is *the drawing*, and the fingerprint is how they
 * say so. `Apply` posts that and nothing else.
 *
 * ## Gaps come before the diff
 *
 * D7's argument, in the layout of the panel: "Fiddle Yard 2 has no connections"
 * outranks any number of rows, because a diff that looks tidy while a block is
 * unreachable is a diff that will be approved. Graph-level assertions sort
 * above their own per-cell evidence (`diagram/compile.ts#gapRank`).
 *
 * ## A mismatch is not retried
 *
 * A 409 means the drawing moved between the review and the apply. Re-fetching
 * and re-posting automatically would defeat the guard exactly — it exists so a
 * human cannot approve one graph and apply another, and an automatic retry is a
 * machine doing precisely that. The operator gets a sentence and a button.
 */

import { useCallback, useMemo, useState } from 'react';
import { useCompile } from '../hooks/useCompile';
import {
  CompileRow,
  countByKind,
  describeComponents,
  describeConditions,
  describeConnection,
  describeGap,
  describeRowKind,
  diffRows,
  hasSubstantiveChange,
  rowBadge,
  sortGapsForReview,
} from '../diagram/compile';
import { BlockRecord, PointRecord, TopologyViolation } from '../types';

interface Props {
  layoutId: string;
  blocks: BlockRecord[];
  points: PointRecord[];
  /** Rendered by `EdgesTab`, which owns the `NameBook` these violations are named against. */
  describeViolation: (v: TopologyViolation) => string;
  /** The Edges tab's own refresh — an apply rewrites the edge table underneath it. */
  onApplied: () => void | Promise<void>;
}

type ApplyState =
  | { kind: 'idle' }
  | { kind: 'applied'; edgeCount: number }
  | { kind: 'stale' }
  | { kind: 'invalid'; violations: TopologyViolation[]; message: string }
  | { kind: 'refused'; message: string };

export function CompilePanel({ layoutId, blocks, points, describeViolation, onApplied }: Props) {
  const { view, loading, loaded, loadError, refresh, apply } = useCompile(layoutId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyState, setApplyState] = useState<ApplyState>({ kind: 'idle' });

  const names = useMemo(
    () => ({
      blocks: new Map(blocks.map((b) => [b.id, b.name] as const)),
      points: new Map(points.map((p) => [p.id, p.name] as const)),
    }),
    [blocks, points],
  );

  const gaps = useMemo(() => sortGapsForReview(view.report.gaps), [view.report.gaps]);
  const rows = useMemo(() => diffRows(view.diff), [view.diff]);
  const counts = useMemo(() => countByKind(view.diff), [view.diff]);
  const applicable = hasSubstantiveChange(view.diff);

  const toggle = useCallback(() => {
    // Fetch on first open only, for the reason in `useCompile`'s header: this
    // is the expensive read, and visiting the Edges tab is not reviewing.
    //
    // `open` is read here rather than inside a `setOpen` updater: an updater is
    // expected to be pure and StrictMode invokes it twice in development, so a
    // fetch in there fires twice on the first open.
    if (!open && !loaded) void refresh();
    setOpen(!open);
  }, [open, loaded, refresh]);

  const recompile = useCallback(async () => {
    setBusy(true);
    setApplyState({ kind: 'idle' });
    await refresh();
    setBusy(false);
  }, [refresh]);

  const onApply = useCallback(async () => {
    setBusy(true);
    const edgeCount = view.report.edges.length;
    const outcome = await apply();

    if (outcome.ok) {
      setApplyState({ kind: 'applied', edgeCount });
      await onApplied();
    } else if (outcome.status === 409) {
      setApplyState({ kind: 'stale' });
    } else if (outcome.violations && outcome.violations.length > 0) {
      setApplyState({ kind: 'invalid', violations: outcome.violations, message: outcome.message });
    } else {
      setApplyState({ kind: 'refused', message: outcome.message });
    }

    setBusy(false);
  }, [apply, onApplied, view.report.edges.length]);

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <button onClick={toggle} style={s.toggle} aria-expanded={open}>
          {open ? '▾' : '▸'} Compile the graph from the drawing
        </button>
        {open && (
          <button onClick={() => void recompile()} style={s.secondaryBtn} disabled={busy || loading}>
            Re-compile
          </button>
        )}
        {open && loaded && (
          <button
            onClick={() => void onApply()}
            style={applicable ? s.applyBtn : s.applyBtnDisabled}
            disabled={busy || !applicable}
            title={
              applicable
                ? 'Replaces the whole track graph with the one this drawing implies.'
                : 'The stored graph already matches the drawing — nothing to apply.'
            }
          >
            Apply
          </button>
        )}
        {(loading || busy) && <span style={s.status}>Working…</span>}
        {loadError && (
          <span style={s.error} role="alert">
            Could not compile: {loadError}
          </span>
        )}
      </div>

      {open && (
        <div style={s.body}>
          {!loaded && !loading && !loadError && <p style={s.muted}>Compiling the drawing…</p>}

          {loaded && (
            <p style={s.muted}>
              {view.report.edges.length} connection
              {view.report.edges.length === 1 ? '' : 's'} in the compiled graph —{' '}
              {counts.changed} changed · {counts.added} to add · {counts.removed} to remove ·{' '}
              {counts.relabelled} renamed · {counts.unchanged} unchanged.{' '}
              {view.status.stale
                ? view.status.compiledAt === null
                  ? 'This graph has never been compiled.'
                  : 'The drawing has changed since the graph was last compiled.'
                : 'The stored graph was compiled from this drawing.'}
            </p>
          )}

          {/* ── The apply's own outcome ── */}

          {applyState.kind === 'applied' && (
            <p style={s.applied} role="status">
              Applied. The track graph is now the {applyState.edgeCount} connection
              {applyState.edgeCount === 1 ? '' : 's'} above.
            </p>
          )}

          {applyState.kind === 'stale' && (
            <div style={s.violationBanner} role="alert">
              <p style={s.violationLine}>
                The drawing changed while you were reviewing. Re-compile and look again — nothing
                was written.
              </p>
            </div>
          )}

          {applyState.kind === 'invalid' && (
            <div style={s.violationBanner} role="alert">
              <p style={s.violationLine}>
                The drawing compiles to a graph the validator refuses. Nothing was written.
              </p>
              {applyState.violations.map((v, i) => (
                <p key={i} style={s.violationLine}>
                  {describeViolation(v)}
                </p>
              ))}
            </div>
          )}

          {applyState.kind === 'refused' && (
            <div style={s.violationBanner} role="alert">
              <p style={s.violationLine}>{applyState.message}</p>
            </div>
          )}

          {/* ── Gaps, first (D7) ── */}

          {loaded && gaps.length > 0 && (
            <>
              <h4 style={s.sectionHeading}>
                {gaps.length} gap{gaps.length === 1 ? '' : 's'} — automatic mode is refused until
                these are resolved
              </h4>
              <ul style={s.gaps}>
                {gaps.map((g, i) => (
                  <li key={i} style={s.gap}>
                    <span style={s.gapBadge}>GAP</span> {describeGap(g, names)}
                  </li>
                ))}
              </ul>
            </>
          )}

          {loaded && gaps.length === 0 && (
            <p style={s.clean}>
              No gaps: every drawn block is connected, detected, and has no unresolved openings.
            </p>
          )}

          {/* ── The diff ── */}

          {loaded && rows.length > 0 && (
            <table style={s.table}>
              <thead>
                <tr>
                  {['', 'Connection', 'Point conditions', 'Path'].map((h, i) => (
                    <th key={i} style={s.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <DiffRow key={row.key} row={row} names={names} />
                ))}
              </tbody>
            </table>
          )}

          {loaded && rows.length === 0 && (
            <p style={s.muted}>
              The drawing implies no connections at all. If you expected some, the gaps above say
              where the walk stopped.
            </p>
          )}

          {/* ── Components, reported and never gated (D-B) ── */}

          {loaded && view.report.components.length > 1 && (
            <p style={s.components}>{describeComponents(view.report.components, names)}</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * One diff row.
 *
 * `removed` has no candidate side, so it renders the live edge's own ends —
 * which is the whole content of "applying deletes this".
 */
function DiffRow({
  row,
  names,
}: {
  row: CompileRow;
  names: { blocks: ReadonlyMap<string, string>; points: ReadonlyMap<string, string> };
}) {
  const edge = row.proposed ?? row.live!;
  const conditions = row.proposed?.pointConditions ?? row.live!.pointConditions;

  return (
    <tr data-testid={`compile-${row.kind}-${edge.fromBlockId}-${edge.toBlockId}`}>
      <td style={s.td}>
        {/* Text, never a colour alone — the rule the diagram encoding follows (#81). */}
        <span style={s.badge} title={describeRowKind(row.kind)}>
          {rowBadge(row.kind)}
        </span>
      </td>
      <td style={s.td}>
        {describeConnection(edge, names)}
        {row.proposed?.crossesDiamond && (
          <span
            style={s.diamond}
            title="This path crosses a plain diamond. Route conflicts through it are NOT detected (#26)."
          >
            {' '}
            ⚠ crosses a diamond
          </span>
        )}
        {row.kind === 'relabelled' && row.live && (
          <span style={s.wasLine}> (was {row.live.fromEnd} → {row.live.toEnd})</span>
        )}
      </td>
      <td style={s.td}>
        {conditions.length === 0
          ? '—'
          : describeConditions(conditions, names).map((c) => (
              <span key={c} style={s.chip}>
                {c}
              </span>
            ))}
        {/* The safety-relevant case, stated rather than left to be spotted by
            comparing two cells: this connection used to need different blades. */}
        {row.kind === 'changed' && row.live && (
          <span style={s.wasLine}>
            {' '}
            was{' '}
            {row.live.pointConditions.length === 0
              ? 'unconditional'
              : describeConditions(row.live.pointConditions, names).join(', ')}
          </span>
        )}
      </td>
      <td
        style={s.td}
        title={
          !row.proposed
            ? 'Not in the compiled graph'
            : row.proposed.via.length === 0
              ? 'The two blocks meet directly'
              : row.proposed.via.map((v) => `(${v.x}, ${v.y})`).join(' → ')
        }
      >
        {!row.proposed
          ? '—'
          : row.proposed.via.length === 0
            ? 'adjacent'
            : `${row.proposed.via.length} cell(s)`}
      </td>
    </tr>
  );
}

// ─── Styles (Catppuccin Mocha, matching ConfigPanel/EdgesTab) ─────────────────

const s = {
  panel:        { border: '1px solid #313244', borderRadius: 4, marginBottom: 12, background: '#181825' } as React.CSSProperties,
  header:       { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexWrap: 'wrap' as const },
  toggle:       { background: 'none', border: 'none', color: '#89b4fa', cursor: 'pointer', font: 'inherit', fontSize: 13, padding: 0, textAlign: 'left' as const } as React.CSSProperties,
  secondaryBtn: { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  applyBtn:     { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '3px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  applyBtnDisabled: { background: '#313244', color: '#6c7086', border: '1px solid #45475a', borderRadius: 4, padding: '3px 14px', fontWeight: 700, cursor: 'not-allowed', fontSize: 12 } as React.CSSProperties,
  body:         { padding: '0 10px 10px' } as React.CSSProperties,
  status:       { fontSize: 12, color: '#f9e2af' },
  error:        { fontSize: 12, color: '#f38ba8' },
  muted:        { color: '#6c7086', fontSize: 11, margin: '4px 0' } as React.CSSProperties,
  clean:        { color: '#a6e3a1', fontSize: 11, margin: '4px 0' } as React.CSSProperties,
  applied:      { color: '#a6e3a1', fontSize: 12, margin: '4px 0' } as React.CSSProperties,
  sectionHeading: { color: '#f9e2af', fontSize: 12, fontWeight: 700, margin: '8px 0 4px' } as React.CSSProperties,
  gaps:         { listStyle: 'none', margin: '0 0 8px', padding: 0, display: 'flex', flexDirection: 'column' as const, gap: 3 } as React.CSSProperties,
  gap:          { color: '#cdd6f4', fontSize: 11, lineHeight: 1.5 } as React.CSSProperties,
  gapBadge:     { fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.5px', color: '#f9e2af' } as React.CSSProperties,
  table:        { width: '100%', borderCollapse: 'collapse', fontSize: 12 } as React.CSSProperties,
  th:           { textAlign: 'left' as const, padding: '4px 8px', color: '#6c7086', borderBottom: '1px solid #313244', fontWeight: 400 },
  td:           { padding: '5px 8px', color: '#cdd6f4', borderBottom: '1px solid #1e1e2e', verticalAlign: 'top' as const } as React.CSSProperties,
  badge:        { fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.5px', color: '#9399b2', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  chip:         { display: 'inline-block', background: '#313244', borderRadius: 8, padding: '1px 8px', fontSize: 11, marginRight: 4, whiteSpace: 'nowrap' as const } as React.CSSProperties,
  wasLine:      { color: '#9399b2', fontSize: 11 } as React.CSSProperties,
  diamond:      { color: '#f9e2af', fontSize: 11 } as React.CSSProperties,
  components:   { color: '#9399b2', fontSize: 11, margin: '8px 0 0' } as React.CSSProperties,
  violationBanner: { background: '#3a2130', border: '1px solid #f38ba8', borderRadius: 4, padding: '8px 12px', margin: '8px 0' } as React.CSSProperties,
  violationLine: { margin: '2px 0', fontSize: 12, color: '#f38ba8' } as React.CSSProperties,
} as const;
