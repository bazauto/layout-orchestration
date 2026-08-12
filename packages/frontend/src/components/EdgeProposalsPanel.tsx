/**
 * EdgeProposalsPanel — reviewing the candidate `block_edges` the drawing
 * implies (#78), and accepting the ones that are right.
 *
 * ## Why accepting is `ops.createEdge` and nothing else
 *
 * There is no accept endpoint, deliberately: a proposal becomes an edge only
 * by travelling the ordinary `POST .../edges`, through the same
 * `TopologyService` validation a hand-authored edge gets. That is what makes a
 * bypass structurally impossible on the server. This panel keeps the same
 * property on the client by having no write of its own — every acceptance
 * below is the identical call the form underneath it makes, with the fields
 * filled in from the walk instead of by hand.
 *
 * The drawing therefore still does not author the track graph. It only stops
 * the authoring being transcription, which is where the two representations
 * were drifting apart.
 *
 * ## Both directions are separate rows on purpose
 *
 * A connection is bidirectional track and `block_edges` is directional, so the
 * backend offers each pairing twice and either may be declined. The panel does
 * not collapse them: accepting one and refusing its reverse is a real thing to
 * want (a trailing connection an operator does not want routed through the
 * other way), and hiding the second row would make that unsayable.
 *
 * ## What is deliberately not offered
 *
 * A length. `lengthMm` is omitted from every body posted here rather than sent
 * as `null`, because the two mean the same thing to the schema and omitting it
 * is the honest statement: geometry never supplied one (`docs/braking.md` B4).
 * Measure the track and fill it in on the row below.
 */

import { useCallback, useMemo, useState } from 'react';
import { useEdgeProposals } from '../hooks/useEdgeProposals';
import { useLayoutConfig } from '../hooks/useLayoutConfig';
import {
  countByStatus,
  describeConditions,
  describeConnection,
  describeProposalNote,
  describeStatus,
  isAcceptable,
  proposalKey,
  sortForReview,
  statusBadge,
} from '../diagram/edgeProposals';
import { BlockRecord, EdgeProposal, PointRecord } from '../types';

type Ops = ReturnType<typeof useLayoutConfig>;

interface Props {
  layoutId: string;
  blocks: BlockRecord[];
  points: PointRecord[];
  ops: Ops;
}

/** The outcome of one accept, kept per row so a refusal names the row it belongs to. */
type AcceptOutcome = { ok: true } | { ok: false; message: string };

export function EdgeProposalsPanel({ layoutId, blocks, points, ops }: Props) {
  const { report, loading, loaded, loadError, refresh } = useEdgeProposals(layoutId);
  const [open, setOpen] = useState(false);
  /** Keyed by `proposalKey` — the direction, not the pair. */
  const [outcomes, setOutcomes] = useState<Record<string, AcceptOutcome>>({});
  const [busy, setBusy] = useState(false);
  const [batchSummary, setBatchSummary] = useState<string | null>(null);

  const names = useMemo(
    () => ({
      blocks: new Map(blocks.map((b) => [b.id, b.name] as const)),
      points: new Map(points.map((p) => [p.id, p.name] as const)),
    }),
    [blocks, points],
  );

  const rows = useMemo(() => sortForReview(report.proposals), [report.proposals]);
  const counts = useMemo(() => countByStatus(report.proposals), [report.proposals]);
  const acceptable = useMemo(() => report.proposals.filter(isAcceptable), [report.proposals]);

  const toggle = useCallback(() => {
    // Fetch on first open only. The walk is over the whole grid from every
    // opening — worth a round trip when somebody is authoring, not on every
    // visit to the Edges tab.
    //
    // Read `open` here rather than inside a `setOpen` updater: an updater is
    // expected to be pure and StrictMode invokes it twice in development, so a
    // fetch in there fires twice on the first open.
    if (!open && !loaded) void refresh();
    setOpen(!open);
  }, [open, loaded, refresh]);

  /**
   * Accepts one proposal.
   *
   * `isAcceptable` has already narrowed both ends to `string`, so no null can
   * reach the body — the guard is what makes that a compile-time property
   * rather than a 400 discovered at runtime.
   */
  const accept = useCallback(
    async (p: EdgeProposal): Promise<AcceptOutcome> => {
      if (!isAcceptable(p)) {
        return { ok: false, message: describeStatus(p.status) };
      }
      const result = await ops.createEdge({
        fromBlockId: p.fromBlockId,
        fromEnd: p.fromEnd,
        toBlockId: p.toBlockId,
        toEnd: p.toEnd,
        pointConditions: p.pointConditions,
      });
      if (result.ok) return { ok: true };

      // A 422 carries `violations`; `mutate()` has already rendered the
      // backend's own message alongside them, and that message is the one
      // written for an operator.
      return { ok: false, message: result.message ?? `HTTP ${result.status}` };
    },
    [ops],
  );

  const acceptOne = useCallback(
    async (p: EdgeProposal) => {
      setBusy(true);
      setBatchSummary(null);
      const outcome = await accept(p);
      setOutcomes((o) => ({ ...o, [proposalKey(p)]: outcome }));
      // Re-walk even on failure: a refusal can be a duplicate the graph
      // already carries, in which case the status is the thing that changed.
      await refresh();
      setBusy(false);
    },
    [accept, refresh],
  );

  /**
   * Accepts every proposal that can be accepted, one at a time.
   *
   * Sequential rather than parallel, and it does **not** stop at the first
   * refusal. Each edge is validated independently by `TopologyService`, so one
   * being refused says nothing about the next; stopping would leave the
   * operator with a partly-applied batch and no idea which rows were even
   * attempted. Every row gets an outcome, and the summary counts both sides.
   */
  const acceptAll = useCallback(async () => {
    setBusy(true);
    setBatchSummary(null);

    const results: Record<string, AcceptOutcome> = {};
    let accepted = 0;
    let refused = 0;

    for (const p of acceptable) {
      const outcome = await accept(p);
      results[proposalKey(p)] = outcome;
      if (outcome.ok) accepted += 1;
      else refused += 1;
    }

    setOutcomes((o) => ({ ...o, ...results }));
    setBatchSummary(
      refused === 0
        ? `${accepted} edge(s) authored.`
        : `${accepted} authored, ${refused} refused — see the rows below.`,
    );
    await refresh();
    setBusy(false);
  }, [acceptable, accept, refresh]);

  return (
    <div style={s.panel}>
      <div style={s.header}>
        <button onClick={toggle} style={s.toggle} aria-expanded={open}>
          {open ? '▾' : '▸'} Propose edges from the drawing
        </button>
        {open && (
          <button onClick={() => void refresh()} style={s.secondaryBtn} disabled={busy || loading}>
            Re-walk
          </button>
        )}
        {open && acceptable.length > 0 && (
          <button onClick={() => void acceptAll()} style={s.acceptAllBtn} disabled={busy}>
            Accept all {acceptable.length} new
          </button>
        )}
        {(loading || busy) && <span style={s.status}>Working…</span>}
        {loadError && (
          <span style={s.error} role="alert">
            Could not read proposals: {loadError}
          </span>
        )}
      </div>

      {open && (
        <div style={s.body}>
          {!loaded && !loading && !loadError && (
            <p style={s.muted}>Walking the drawing…</p>
          )}

          {loaded && (
            <p style={s.muted}>
              {report.proposals.length} candidate{report.proposals.length === 1 ? '' : 's'} —{' '}
              {counts.new} new · {counts.conflicting} conflicting · {counts['needs-end-label']}{' '}
              missing an end name · {counts.existing} already authored. Both directions of each
              connection are listed separately.
            </p>
          )}

          {batchSummary && <p style={s.batch}>{batchSummary}</p>}

          {loaded && report.proposals.length > 0 && (
            <table style={s.table}>
              <thead>
                <tr>
                  {['', 'Connection', 'Point conditions', 'Path', ''].map((h, i) => (
                    <th key={i} style={s.th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => {
                  const key = proposalKey(p);
                  const outcome = outcomes[key];
                  return (
                    <tr key={key} data-testid={`proposal-${p.fromBlockId}-${p.toBlockId}`}>
                      <td style={s.td}>
                        {/* Text, never a colour alone — the same rule the
                            diagram encoding follows (#81). */}
                        <span style={s.badge} title={describeStatus(p.status)}>
                          {statusBadge(p.status)}
                        </span>
                      </td>
                      <td style={s.td}>
                        {describeConnection(p, names)}
                        {p.crossesDiamond && (
                          <span
                            style={s.diamond}
                            title="This path crosses a plain diamond. Route conflicts through it are NOT detected (#26)."
                          >
                            {' '}
                            ⚠ crosses a diamond
                          </span>
                        )}
                      </td>
                      <td style={s.td}>
                        {p.pointConditions.length === 0
                          ? '—'
                          : describeConditions(p.pointConditions, names).map((c) => (
                              <span key={c} style={s.chip}>
                                {c}
                              </span>
                            ))}
                      </td>
                      <td
                        style={s.td}
                        title={
                          p.via.length === 0
                            ? 'The two blocks meet directly'
                            : p.via.map((v) => `(${v.x}, ${v.y})`).join(' → ')
                        }
                      >
                        {p.via.length === 0 ? 'adjacent' : `${p.via.length} cell(s)`}
                      </td>
                      <td style={s.td}>
                        {isAcceptable(p) ? (
                          <button
                            onClick={() => void acceptOne(p)}
                            style={s.acceptBtn}
                            disabled={busy}
                          >
                            Accept
                          </button>
                        ) : (
                          <span style={s.muted} title={describeStatus(p.status)}>
                            —
                          </span>
                        )}
                        {outcome && !outcome.ok && (
                          <p style={s.rowError} role="alert">
                            {outcome.message}
                          </p>
                        )}
                        {outcome?.ok && <p style={s.rowOk}>authored</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {loaded && report.proposals.length === 0 && (
            <p style={s.muted}>
              The walk found no connections. If you expected some, the notes below say where it
              stopped.
            </p>
          )}

          {/*
            Notes are the whole difference between a to-do and a mystery: the
            walk under-proposes on purpose, and silence would be
            indistinguishable from "there is nothing here".
          */}
          {loaded && report.notes.length > 0 && (
            <ul style={s.notes}>
              {report.notes.map((n, i) => (
                <li key={i} style={s.note}>
                  <span style={s.noteBadge}>NOTE</span> {describeProposalNote(n, names)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Styles (Catppuccin Mocha, matching ConfigPanel/EdgesTab) ─────────────────

const s = {
  panel:        { border: '1px solid #313244', borderRadius: 4, marginBottom: 12, background: '#181825' } as React.CSSProperties,
  header:       { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', flexWrap: 'wrap' as const },
  toggle:       { background: 'none', border: 'none', color: '#89b4fa', cursor: 'pointer', font: 'inherit', fontSize: 13, padding: 0, textAlign: 'left' as const } as React.CSSProperties,
  secondaryBtn: { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  acceptAllBtn: { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '3px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  acceptBtn:    { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 3, padding: '2px 10px', fontWeight: 700, cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  body:         { padding: '0 10px 10px' } as React.CSSProperties,
  status:       { fontSize: 12, color: '#f9e2af' },
  error:        { fontSize: 12, color: '#f38ba8' },
  muted:        { color: '#6c7086', fontSize: 11, margin: '4px 0' } as React.CSSProperties,
  batch:        { color: '#a6e3a1', fontSize: 12, margin: '4px 0' } as React.CSSProperties,
  table:        { width: '100%', borderCollapse: 'collapse', fontSize: 12 } as React.CSSProperties,
  th:           { textAlign: 'left' as const, padding: '4px 8px', color: '#6c7086', borderBottom: '1px solid #313244', fontWeight: 400 },
  td:           { padding: '5px 8px', color: '#cdd6f4', borderBottom: '1px solid #1e1e2e', verticalAlign: 'top' as const } as React.CSSProperties,
  badge:        { fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.5px', color: '#9399b2', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  chip:         { display: 'inline-block', background: '#313244', borderRadius: 8, padding: '1px 8px', fontSize: 11, marginRight: 4, whiteSpace: 'nowrap' as const } as React.CSSProperties,
  diamond:      { color: '#f9e2af', fontSize: 11 } as React.CSSProperties,
  rowError:     { color: '#f38ba8', fontSize: 11, margin: '4px 0 0' } as React.CSSProperties,
  rowOk:        { color: '#a6e3a1', fontSize: 11, margin: '4px 0 0' } as React.CSSProperties,
  notes:        { listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column' as const, gap: 3 } as React.CSSProperties,
  note:         { color: '#9399b2', fontSize: 11, lineHeight: 1.5 } as React.CSSProperties,
  noteBadge:    { fontFamily: 'monospace', fontSize: 9, letterSpacing: '0.5px' } as React.CSSProperties,
} as const;
