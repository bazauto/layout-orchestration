import { useMemo, useState } from 'react';
import { useBlockEnds } from '../hooks/useBlockEnds';
import { useLayoutConfig } from '../hooks/useLayoutConfig';
import { blockLabel, buildEdgeLabel, edgeLabel, NameBook, pointLabel } from '../naming';
import { EdgeProposalsPanel } from './EdgeProposalsPanel';
import {
  BlockEdgeRecord,
  BlockEndView,
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

export interface EdgeFormPointCondition {
  pointId: string;
  requiredPosition: 'normal' | 'reverse';
}

export interface EdgeFormState {
  fromBlockId: string;
  fromEnd: string;
  toBlockId: string;
  toEnd: string;
  pointConditions: EdgeFormPointCondition[];
}

export interface EdgeDraft {
  fromBlockId: string;
  fromEnd: string;
  toBlockId: string;
  toEnd: string;
  pointConditions: EdgeFormPointCondition[];
}

const EMPTY_FORM: EdgeFormState = {
  fromBlockId: '',
  fromEnd: '',
  toBlockId: '',
  toEnd: '',
  pointConditions: [],
};

/**
 * Builds the POST/PUT body from form state. Pure: no React, no fetch — the
 * end labels are trimmed and lower-cased client-side to match the
 * normalisation `edgeCreateSchema` applies server-side (see
 * `services/validation.ts`), so the operator sees the same value that will
 * be persisted rather than a silent server-side rewrite. Point conditions
 * with no point selected yet are dropped rather than sent as `pointId: ''`.
 */
export function buildEdgeDraft(form: EdgeFormState): EdgeDraft {
  return {
    fromBlockId: form.fromBlockId,
    fromEnd: form.fromEnd.trim().toLowerCase(),
    toBlockId: form.toBlockId,
    toEnd: form.toEnd.trim().toLowerCase(),
    pointConditions: form.pointConditions.filter((c) => c.pointId.length > 0),
  };
}

/** The reverse of a draft: from/to blocks and end labels swapped, everything else unchanged. */
function reverseOf(draft: EdgeDraft): EdgeDraft {
  return {
    fromBlockId: draft.toBlockId,
    fromEnd: draft.toEnd,
    toBlockId: draft.fromBlockId,
    toEnd: draft.fromEnd,
    pointConditions: draft.pointConditions,
  };
}

/**
 * End labels to offer at `blockId` — every `block_ends` row for the block,
 * plus anything existing edges already reference.
 *
 * The `block_ends` half is the important one and was missing: this list was
 * derived from `edges` alone, so on a layout with no edges yet the datalist
 * was empty and the operator typed the label of the opening they meant from
 * memory. `block_ends` is precisely the set of names the drawing generated
 * (#72), so it is the set that will match.
 *
 * Still a `<datalist>` and still not enforced. An end label is free text on
 * purpose: authoring an edge against a name before the track that carries it
 * is drawn is a legitimate work order, and the diagnostics report the mismatch
 * (`end-not-on-diagram`) rather than the write path refusing it.
 */
function endsForBlock(
  blockId: string,
  edges: BlockEdgeRecord[],
  blockEnds: BlockEndView[],
): string[] {
  if (!blockId) return [];
  const ends = new Set<string>();
  for (const end of blockEnds) {
    if (end.blockId === blockId) ends.add(end.label);
  }
  for (const e of edges) {
    if (e.fromBlockId === blockId) ends.add(e.fromEnd);
    if (e.toBlockId === blockId) ends.add(e.toEnd);
  }
  return Array.from(ends).sort();
}

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
  const [form, setForm] = useState<EdgeFormState>(EMPTY_FORM);
  const [alsoReverse, setAlsoReverse] = useState(false);
  const [submitError, setSubmitError] = useState<{ message?: string; violations?: TopologyViolation[] } | null>(null);

  // Read-only here: this tab never writes an end. Ends are authored in the
  // Track Editor, where the drawing that generates them is.
  const { ends: blockEnds } = useBlockEnds(layoutId);

  const flagged = useMemo(() => violatedEdgeIds(topology.violations), [topology.violations]);
  const fromEndOptions = useMemo(
    () => endsForBlock(form.fromBlockId, edges, blockEnds),
    [form.fromBlockId, edges, blockEnds],
  );
  const toEndOptions = useMemo(
    () => endsForBlock(form.toBlockId, edges, blockEnds),
    [form.toBlockId, edges, blockEnds],
  );

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

  const addPointCondition = () => {
    setForm((f) => ({
      ...f,
      pointConditions: [...f.pointConditions, { pointId: '', requiredPosition: 'normal' }],
    }));
  };

  const updatePointCondition = (idx: number, patch: Partial<EdgeFormPointCondition>) => {
    setForm((f) => ({
      ...f,
      pointConditions: f.pointConditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    }));
  };

  const removePointCondition = (idx: number) => {
    setForm((f) => ({ ...f, pointConditions: f.pointConditions.filter((_, i) => i !== idx) }));
  };

  const submit = async () => {
    if (!form.fromBlockId || !form.fromEnd.trim() || !form.toBlockId || !form.toEnd.trim()) return;

    const draft = buildEdgeDraft(form);
    const result = await ops.createEdge(draft);
    if (!result.ok) {
      setSubmitError({ message: result.message, violations: result.violations });
      return; // Leave the form populated — the operator must not lose their input.
    }

    if (alsoReverse) {
      const reverseResult = await ops.createEdge(reverseOf(draft));
      if (!reverseResult.ok) {
        setSubmitError({ message: reverseResult.message, violations: reverseResult.violations });
        return;
      }
    }

    setSubmitError(null);
    setForm(EMPTY_FORM);
    setAlsoReverse(false);
  };

  return (
    <div style={s.tabBody}>
      {/*
        #78's review surface, above the manual form rather than beside it: on a
        drawn layout it is the primary way edges get authored, and the form
        below is what you fall back to for a connection the drawing cannot
        imply. Nothing about length any more — that lives on the block
        (D4, docs/track-graph-compilation.md), edited in Configure → Blocks.
      */}
      <EdgeProposalsPanel layoutId={layoutId} blocks={blocks} points={points} ops={ops} />

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

      {submitError && (
        <div style={s.violationBanner}>
          {submitError.violations && submitError.violations.length > 0 ? (
            submitError.violations.map((v, i) => (
              <p key={i} style={s.violationLine}>
                {describeViolation(v, nameBook)}
              </p>
            ))
          ) : (
            <p style={s.violationLine}>{submitError.message ?? 'Edge rejected'}</p>
          )}
        </div>
      )}

      <div style={s.addRow}>
        <select
          aria-label="From block"
          value={form.fromBlockId}
          onChange={(e) => setForm((f) => ({ ...f, fromBlockId: e.target.value }))}
          style={s.select}
        >
          <option value="">— from block —</option>
          {blocks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          value={form.fromEnd}
          onChange={(e) => setForm((f) => ({ ...f, fromEnd: e.target.value }))}
          placeholder="From end"
          list="edges-from-end-options"
          style={s.input}
        />
        <datalist id="edges-from-end-options">
          {fromEndOptions.map((end) => (
            <option key={end} value={end} />
          ))}
        </datalist>

        <select
          aria-label="To block"
          value={form.toBlockId}
          onChange={(e) => setForm((f) => ({ ...f, toBlockId: e.target.value }))}
          style={s.select}
        >
          <option value="">— to block —</option>
          {blocks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          value={form.toEnd}
          onChange={(e) => setForm((f) => ({ ...f, toEnd: e.target.value }))}
          placeholder="To end"
          list="edges-to-end-options"
          style={s.input}
        />
        <datalist id="edges-to-end-options">
          {toEndOptions.map((end) => (
            <option key={end} value={end} />
          ))}
        </datalist>

      </div>

      <div style={s.pointConditionsBlock}>
        {form.pointConditions.map((pc, idx) => (
          <div key={idx} style={s.pointConditionRow}>
            <select
              aria-label="Point"
              value={pc.pointId}
              onChange={(e) => updatePointCondition(idx, { pointId: e.target.value })}
              style={s.inlineSelect}
            >
              <option value="">— point —</option>
              {points.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              aria-label="Required position"
              value={pc.requiredPosition}
              onChange={(e) =>
                updatePointCondition(idx, { requiredPosition: e.target.value as 'normal' | 'reverse' })
              }
              style={s.inlineSelect}
            >
              <option value="normal">normal</option>
              <option value="reverse">reverse</option>
            </select>
            <button onClick={() => removePointCondition(idx)} style={s.delBtn}>
              ×
            </button>
          </div>
        ))}
        <button onClick={addPointCondition} style={s.addSmallBtn}>
          + point condition
        </button>
      </div>

      <div style={s.submitRow}>
        <label style={s.checkboxLabel}>
          <input
            type="checkbox"
            checked={alsoReverse}
            onChange={(e) => setAlsoReverse(e.target.checked)}
          />
          also create reverse edge
        </label>
        <button onClick={submit} style={s.addBtn}>
          Add
        </button>
      </div>

      <table style={s.table}>
        <thead>
          <tr>
            {['Connection', 'Point Conditions', ''].map((h) => (
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
                <td style={s.td}>
                  <button onClick={() => ops.deleteEdge(e.id)} style={s.delBtn}>
                    ×
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Styles (matches the Catppuccin Mocha palette used across ConfigPanel) ────

const s = {
  tabBody:            { padding: 16 } as React.CSSProperties,
  addRow:             { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' as const, alignItems: 'center' },
  input:              { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '4px 8px', fontSize: 13, flex: 1, minWidth: 100 } as React.CSSProperties,
  select:             { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '4px 8px', fontSize: 13 } as React.CSSProperties,
  inlineSelect:       { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 3, padding: '2px 6px', fontSize: 12 } as React.CSSProperties,
  addBtn:             { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '5px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 13 } as React.CSSProperties,
  addSmallBtn:        { background: 'none', border: '1px dashed #45475a', color: '#89b4fa', borderRadius: 4, padding: '3px 10px', cursor: 'pointer', fontSize: 12, alignSelf: 'flex-start' } as React.CSSProperties,
  delBtn:             { background: 'none', border: '1px solid #45475a', borderRadius: 3, color: '#f38ba8', cursor: 'pointer', padding: '1px 7px', fontSize: 13 } as React.CSSProperties,
  pointConditionsBlock: { display: 'flex', flexDirection: 'column' as const, gap: 6, marginBottom: 8 },
  pointConditionRow:  { display: 'flex', gap: 6, alignItems: 'center' } as React.CSSProperties,
  submitRow:          { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 } as React.CSSProperties,
  checkboxLabel:      { display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: '#a6adc8' } as React.CSSProperties,
  table:              { width: '100%', borderCollapse: 'collapse', fontSize: 13 } as React.CSSProperties,
  th:                 { textAlign: 'left' as const, padding: '4px 8px', color: '#6c7086', borderBottom: '1px solid #313244' },
  td:                 { padding: '6px 8px', color: '#cdd6f4', borderBottom: '1px solid #1e1e2e' } as React.CSSProperties,
  flaggedCell:        { borderLeft: '3px solid #f38ba8' } as React.CSSProperties,
  chip:               { display: 'inline-block', background: '#313244', borderRadius: 8, padding: '1px 8px', fontSize: 11, marginRight: 4 } as React.CSSProperties,
  violationBanner:    { background: '#3a2130', border: '1px solid #f38ba8', borderRadius: 4, padding: '8px 12px', marginBottom: 12 } as React.CSSProperties,
  violationLine:      { margin: '2px 0', fontSize: 12, color: '#f38ba8' } as React.CSSProperties,
  // Amber, not the violation banner's red: a stale graph is a to-do, and a
  // to-do styled as an error trains the operator to ignore both.
  compileNotice:      { background: '#3a3324', border: '1px solid #f9e2af', borderRadius: 4, padding: '8px 12px', marginBottom: 12 } as React.CSSProperties,
  compileLine:        { margin: '2px 0', fontSize: 12, color: '#f9e2af' } as React.CSSProperties,
} as const;
