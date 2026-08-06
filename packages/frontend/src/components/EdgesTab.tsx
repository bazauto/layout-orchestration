import { useMemo, useState } from 'react';
import { useLayoutConfig } from '../hooks/useLayoutConfig';
import { BlockEdgeRecord, BlockRecord, PointRecord, TopologyStatus, TopologyViolation } from '../types';

type Ops = ReturnType<typeof useLayoutConfig>;

interface Props {
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
  lengthMm: string;
  pointConditions: EdgeFormPointCondition[];
}

export interface EdgeDraft {
  fromBlockId: string;
  fromEnd: string;
  toBlockId: string;
  toEnd: string;
  pointConditions: EdgeFormPointCondition[];
  lengthMm: number | null;
}

const EMPTY_FORM: EdgeFormState = {
  fromBlockId: '',
  fromEnd: '',
  toBlockId: '',
  toEnd: '',
  lengthMm: '',
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
  const lengthTrimmed = form.lengthMm.trim();
  const length = lengthTrimmed === '' ? NaN : Number(lengthTrimmed);
  return {
    fromBlockId: form.fromBlockId,
    fromEnd: form.fromEnd.trim().toLowerCase(),
    toBlockId: form.toBlockId,
    toEnd: form.toEnd.trim().toLowerCase(),
    pointConditions: form.pointConditions.filter((c) => c.pointId.length > 0),
    lengthMm: Number.isNaN(length) ? null : length,
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
    lengthMm: draft.lengthMm,
  };
}

/** Ends already used at `blockId`, derived from existing edges — offered via <datalist>, not enforced. */
function endsForBlock(blockId: string, edges: BlockEdgeRecord[]): string[] {
  if (!blockId) return [];
  const ends = new Set<string>();
  for (const e of edges) {
    if (e.fromBlockId === blockId) ends.add(e.fromEnd);
    if (e.toBlockId === blockId) ends.add(e.toEnd);
  }
  return Array.from(ends).sort();
}

/** Mirrors `describeViolation` in `domain/topology.ts` exactly — same wording, one violation at a time. */
function describeViolation(v: TopologyViolation): string {
  switch (v.kind) {
    case 'layout-mismatch':
      return `edge ${v.edgeId} belongs to layout ${v.actualLayoutId}, not ${v.expectedLayoutId}`;
    case 'duplicate-edge-id':
      return `duplicate edge id ${v.edgeId}`;
    case 'self-loop':
      return `edge ${v.edgeId} is a self-loop on block ${v.blockId}`;
    case 'unknown-block':
      return `edge ${v.edgeId} references unknown block ${v.blockId}`;
    case 'unknown-point':
      return `edge ${v.edgeId} references unknown point ${v.pointId}`;
    case 'duplicate-connection':
      return `edge ${v.edgeId} duplicates the connection already defined by edge ${v.conflictingEdgeId}`;
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

export function EdgesTab({ edges, topology, blocks, points, ops }: Props) {
  const [form, setForm] = useState<EdgeFormState>(EMPTY_FORM);
  const [alsoReverse, setAlsoReverse] = useState(false);
  const [submitError, setSubmitError] = useState<{ message?: string; violations?: TopologyViolation[] } | null>(null);

  const flagged = useMemo(() => violatedEdgeIds(topology.violations), [topology.violations]);
  const fromEndOptions = useMemo(() => endsForBlock(form.fromBlockId, edges), [form.fromBlockId, edges]);
  const toEndOptions = useMemo(() => endsForBlock(form.toBlockId, edges), [form.toBlockId, edges]);

  const blockName = (id: string) => blocks.find((b) => b.id === id)?.name ?? id;
  const pointName = (id: string) => points.find((p) => p.id === id)?.name ?? id;

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
      {!topology.valid && (
        <div style={s.violationBanner}>
          {topology.violations.map((v, i) => (
            <p key={i} style={s.violationLine}>
              {describeViolation(v)}
            </p>
          ))}
        </div>
      )}

      {submitError && (
        <div style={s.violationBanner}>
          {submitError.violations && submitError.violations.length > 0 ? (
            submitError.violations.map((v, i) => (
              <p key={i} style={s.violationLine}>
                {describeViolation(v)}
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

        <input
          value={form.lengthMm}
          onChange={(e) => setForm((f) => ({ ...f, lengthMm: e.target.value }))}
          placeholder="Length (mm)"
          type="number"
          min={1}
          style={{ ...s.input, flex: '0 0 110px' }}
        />
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
            {['Connection', 'Point Conditions', 'Length (mm)', ''].map((h) => (
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
                <td style={s.td}>{e.lengthMm ?? '—'}</td>
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
} as const;
