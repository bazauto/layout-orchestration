/**
 * EdgesTab — the track graph, and the compile that writes it (#103 PR 5).
 *
 * There is no form here any more. `block_edges` is written by exactly one
 * thing — `POST .../topology/compile/apply`, driven by `CompilePanel` above —
 * and the routes the form used to post to no longer exist (OQ1). What is left
 * is a read: the violation banner, the compile notice, and the edge table.
 *
 * The reason is D3, not tidiness. A recompile is a **replace**, so a
 * hand-authored edge is deleted by the next apply without anyone deciding it
 * should be. Leaving the form in place would keep the two-representations
 * problem #103 exists to end, at a new seam, and the operator would meet it as
 * "the edge I authored yesterday has vanished".
 */

import { useCallback, useMemo } from 'react';
import { useLayoutConfig } from '../hooks/useLayoutConfig';
import { blockLabel, buildEdgeLabel, edgeLabel, NameBook, pointLabel } from '../naming';
import { CompilePanel } from './CompilePanel';
import {
  BlockEdgeRecord,
  BlockRecord,
  PointRecord,
  TopologyStatus,
  TopologyViolation,
} from '../types';

type Ops = ReturnType<typeof useLayoutConfig>;

interface Props {
  layoutId: string;
  edges: BlockEdgeRecord[];
  topology: TopologyStatus;
  blocks: BlockRecord[];
  points: PointRecord[];
  ops: Ops;
}

// ─── Pure helpers (unit-testable without React — see issue #8) ───────────────

/**
 * Mirrors `describeViolation` in `domain/topology.ts` exactly — same
 * wording, one violation at a time — now including its optional `NameBook`
 * (#54). No `layouts` map is built here (`EdgesTab` has no layout records
 * in scope), so `layout-mismatch` degrades to the raw layout id, same as
 * the backend with no book (D8).
 */
function describeViolation(v: TopologyViolation, book?: NameBook): string {
  switch (v.kind) {
    case 'layout-mismatch':
      return `edge ${edgeLabel(v.edgeId, book)} belongs to layout ${v.actualLayoutId}, not ${v.expectedLayoutId}`;
    case 'duplicate-edge-id':
      return `duplicate edge id ${edgeLabel(v.edgeId, book)}`;
    case 'self-loop':
      return `edge ${edgeLabel(v.edgeId, book)} is a self-loop on block ${blockLabel(v.blockId, book)}`;
    case 'unknown-block':
      return `edge ${edgeLabel(v.edgeId, book)} references unknown block ${blockLabel(v.blockId, book)}`;
    case 'unknown-point':
      return `edge ${edgeLabel(v.edgeId, book)} references unknown point ${pointLabel(v.pointId, book)}`;
    case 'duplicate-connection':
      return `edge ${edgeLabel(v.edgeId, book)} duplicates the connection already defined by edge ${edgeLabel(v.conflictingEdgeId, book)}`;
  }
}

/** Edge ids implicated by at least one violation — used to flag table rows. */
function violatedEdgeIds(violations: readonly TopologyViolation[]): Set<string> {
  const ids = new Set<string>();
  for (const v of violations) {
    ids.add(v.edgeId);
    if (v.kind === 'duplicate-connection') ids.add(v.conflictingEdgeId);
  }
  return ids;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function EdgesTab({ layoutId, edges, topology, blocks, points, ops }: Props) {
  const flagged = useMemo(() => violatedEdgeIds(topology.violations), [topology.violations]);

  // #54: the props this component already receives (blocks, points, edges)
  // are enough to build a NameBook locally — the same book that used to be
  // a second, duplicated implementation of the backend's naming logic (the
  // old blockName/pointName helpers this folds into).
  const nameBook: NameBook = useMemo(() => {
    const blockEntries = new Map(blocks.map((b) => [b.id, b.name] as const));
    return {
      layouts: new Map(),
      blocks: blockEntries,
      points: new Map(points.map((p) => [p.id, p.name] as const)),
      sensors: new Map(),
      locos: new Map(),
      edges: new Map(
        edges.map((e) => [e.id, buildEdgeLabel(e, (id) => blockEntries.get(id))] as const),
      ),
    };
  }, [blocks, points, edges]);

  const blockName = (id: string) => nameBook.blocks.get(id) ?? id;
  const pointName = (id: string) => nameBook.points.get(id) ?? id;

  // Passed down rather than duplicated: `CompilePanel` renders the 422's
  // violations and this is the one implementation of that wording.
  const renderViolation = useCallback(
    (v: TopologyViolation) => describeViolation(v, nameBook),
    [nameBook],
  );

  return (
    <div style={s.tabBody}>
      {/*
        The only way `block_edges` is written. An apply replaces the whole set,
        so `ops.refresh` re-reads the table below rather than patching it.
      */}
      <CompilePanel
        layoutId={layoutId}
        blocks={blocks}
        points={points}
        describeViolation={renderViolation}
        onApplied={ops.refresh}
      />

      {/*
        Where the live graph stands against the drawing (#103, D10). Advisory,
        never a gate — an operator moving a platform tile makes the graph stale
        and must not be stopped from doing it. Two separate facts, deliberately
        worded apart: `stale` says the graph is behind the picture, `gapCount`
        says the picture has holes the compiler would not guess at, and only the
        second one refuses `auto`.
      */}
      {topology.compiled && (topology.compiled.stale || topology.compiled.gapCount > 0) && (
        <div style={s.compileNotice}>
          {topology.compiled.stale && (
            <p style={s.compileLine}>
              {topology.compiled.compiledAt === null
                ? 'This graph has never been compiled from the drawing.'
                : 'The drawing has changed since this graph was compiled.'}
            </p>
          )}
          {topology.compiled.gapCount > 0 && (
            <p style={s.compileLine}>
              The drawing compiles with {topology.compiled.gapCount} gap
              {topology.compiled.gapCount === 1 ? '' : 's'} — automatic mode is refused
              until they are resolved.
            </p>
          )}
        </div>
      )}

      {!topology.valid && (
        <div style={s.violationBanner}>
          {topology.violations.map((v, i) => (
            <p key={i} style={s.violationLine}>
              {describeViolation(v, nameBook)}
            </p>
          ))}
        </div>
      )}

      <table style={s.table}>
        <thead>
          <tr>
            {['Connection', 'Point Conditions'].map((h) => (
              <th key={h} style={s.th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {edges.map((e) => {
            const isFlagged = flagged.has(e.id);
            return (
              <tr key={e.id} data-testid={`edge-row-${e.id}`}>
                <td style={{ ...s.td, ...(isFlagged ? s.flaggedCell : {}) }}>
                  {blockName(e.fromBlockId)}:{e.fromEnd} → {blockName(e.toBlockId)}:{e.toEnd}
                </td>
                <td style={s.td}>
                  {e.pointConditions.length === 0
                    ? '—'
                    : e.pointConditions.map((c) => (
                        <span key={c.pointId} style={s.chip}>
                          {pointName(c.pointId)}={c.requiredPosition}
                        </span>
                      ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {edges.length === 0 && (
        <p style={s.empty}>
          The track graph is empty. Draw the railway in the Track Editor, then compile it above.
        </p>
      )}
    </div>
  );
}

// ─── Styles (matches the Catppuccin Mocha palette used across ConfigPanel) ────

const s = {
  tabBody:            { padding: 16 } as React.CSSProperties,
  table:              { width: '100%', borderCollapse: 'collapse', fontSize: 13 } as React.CSSProperties,
  th:                 { textAlign: 'left' as const, padding: '4px 8px', color: '#6c7086', borderBottom: '1px solid #313244' },
  td:                 { padding: '6px 8px', color: '#cdd6f4', borderBottom: '1px solid #1e1e2e' } as React.CSSProperties,
  flaggedCell:        { borderLeft: '3px solid #f38ba8' } as React.CSSProperties,
  chip:               { display: 'inline-block', background: '#313244', borderRadius: 8, padding: '1px 8px', fontSize: 11, marginRight: 4 } as React.CSSProperties,
  empty:              { color: '#6c7086', fontSize: 12, margin: '12px 0 0' } as React.CSSProperties,
  violationBanner:    { background: '#3a2130', border: '1px solid #f38ba8', borderRadius: 4, padding: '8px 12px', marginBottom: 12 } as React.CSSProperties,
  violationLine:      { margin: '2px 0', fontSize: 12, color: '#f38ba8' } as React.CSSProperties,
  // Amber, not the violation banner's red: a stale graph is a to-do, and a
  // to-do styled as an error trains the operator to ignore both.
  compileNotice:      { background: '#3a3324', border: '1px solid #f9e2af', borderRadius: 4, padding: '8px 12px', marginBottom: 12 } as React.CSSProperties,
  compileLine:        { margin: '2px 0', fontSize: 12, color: '#f9e2af' } as React.CSSProperties,
} as const;
