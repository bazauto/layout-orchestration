/**
 * BlockEndsPanel — naming a block's openings by hand (#72), from inside the
 * Track Editor.
 *
 * ## Why here and not on the Configure screen
 *
 * An end is a *named opening*, and the opening is on the drawing. Every
 * question this panel answers — which end is this, is it where I think it is,
 * is anything referencing it — is a question about a cell, and the answer is
 * three columns away from a picture of that cell. The Configure screen has no
 * drawing to point at.
 *
 * ## Why it is a list and not a click on the label
 *
 * The canvas is `role="application"`: a click paints. Making an end label
 * clickable would mean a mis-click on a label silently paints a tile, which is
 * the failure #69's per-stroke undo exists to soften and this would reintroduce
 * in a place with no gesture to undo. A list of ordinary controls is also the
 * only version that is keyboard-reachable, which the canvas deliberately is
 * not (D11).
 *
 * ## The one thing this cannot fix
 *
 * An end the generator **refused to name** — two openings of one block facing
 * the same way, reported as `end-label-collision` — can be given a label here,
 * and that label will author edges perfectly well. What it will not get is
 * geometry: `generateBlockEnds` drops both colliding clusters from `openings`,
 * so nothing matches the new row back to a cell, and it reports as
 * `pinned-end-not-on-diagram` (or `end-not-on-diagram` once an edge uses it).
 * See `docs/topology.md` — resolving that needs an end to be able to name a
 * *specific* opening, which `block_ends` cannot express today.
 */

import { useCallback, useMemo, useState } from 'react';
import { useBlockEnds } from '../hooks/useBlockEnds';
import { BlockEndView, BlockRecord } from '../types';

interface Props {
  ends: BlockEndView[];
  blocks: BlockRecord[];
  ops: Pick<ReturnType<typeof useBlockEnds>, 'create' | 'rename' | 'remove'>;
  /** Moves the editor's cursor to a cell and centres the view — the same action a diagnostic's jump takes. */
  onJumpTo: (at: { x: number; y: number }) => void;
  /** Bumped by the caller after any write, so the diagnostics recompute. */
  onChanged: () => void;
}

export function BlockEndsPanel({ ends, blocks, ops, onJumpTo, onChanged }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [newBlockId, setNewBlockId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  /**
   * The last refused write, held here and cleared only by the next successful
   * one — the #62 posture. A 409 naming the edges that block a rename is the
   * single most useful message this panel produces, and a `refresh()` must not
   * be able to stamp on it.
   */
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const blockNames = useMemo(() => new Map(blocks.map((b) => [b.id, b.name])), [blocks]);

  // Grouped by block and sorted by name, because "which ends does Siding 2
  // have" is the question being asked — the flat API order is arbitrary here.
  const rows = useMemo(
    () =>
      [...ends].sort(
        (a, b) =>
          (blockNames.get(a.blockId) ?? a.blockId).localeCompare(
            blockNames.get(b.blockId) ?? b.blockId,
          ) || a.label.localeCompare(b.label),
      ),
    [ends, blockNames],
  );

  const run = useCallback(
    async (action: () => Promise<{ ok: boolean; message?: string; status: number }>) => {
      setBusy(true);
      const result = await action();
      setBusy(false);
      if (!result.ok) {
        setError(result.message ?? `HTTP ${result.status}`);
        return false;
      }
      setError(null);
      onChanged();
      return true;
    },
    [onChanged],
  );

  const submitRename = useCallback(
    async (endId: string) => {
      const label = draftLabel.trim().toLowerCase();
      if (label.length === 0) return;
      if (await run(() => ops.rename(endId, label))) setEditingId(null);
    },
    [draftLabel, ops, run],
  );

  const submitCreate = useCallback(async () => {
    const label = newLabel.trim().toLowerCase();
    if (!newBlockId || label.length === 0) return;
    if (await run(() => ops.create(newBlockId, label))) {
      setNewLabel('');
    }
  }, [newBlockId, newLabel, ops, run]);

  return (
    <div style={s.panel} role="region" aria-label="Block ends">
      {error && (
        <p style={s.error} role="alert">
          {error}
        </p>
      )}

      <div style={s.addRow}>
        <select
          aria-label="Block for new end"
          value={newBlockId}
          onChange={(e) => setNewBlockId(e.target.value)}
          style={s.select}
        >
          <option value="">— block —</option>
          {blocks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <input
          aria-label="Label for new end"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitCreate();
          }}
          placeholder="end label (e.g. yard-3)"
          style={s.input}
        />
        <button onClick={() => void submitCreate()} style={s.addBtn} disabled={busy}>
          Add end
        </button>
        <span style={s.hint}>
          Lower-case letters, digits, <code>-</code> and <code>_</code>. A hand-added end is pinned,
          so <code>Ends ⟳</code> never renames it.
        </span>
      </div>

      {rows.length === 0 ? (
        <p style={s.muted}>
          No block ends yet. <code>Ends ⟳</code> generates them from the drawing.
        </p>
      ) : (
        <table style={s.table}>
          <thead>
            <tr>
              {['Block', 'End', 'Source', 'On the drawing', ''].map((h) => (
                <th key={h} style={s.th}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((end) => (
              <tr key={end.id} data-testid={`block-end-${end.id}`}>
                <td style={s.td}>{blockNames.get(end.blockId) ?? end.blockId}</td>
                <td style={s.td}>
                  {editingId === end.id ? (
                    <input
                      aria-label={`New label for ${end.label}`}
                      value={draftLabel}
                      autoFocus
                      onChange={(e) => setDraftLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitRename(end.id);
                        if (e.key === 'Escape') setEditingId(null);
                      }}
                      style={s.input}
                    />
                  ) : (
                    <code>{end.label}</code>
                  )}
                </td>
                <td style={s.td}>
                  {/*
                    Text, not a colour or an icon alone. "pinned" is a real
                    distinction with consequences — regeneration skips it —
                    and it has to survive being read aloud.
                  */}
                  <span style={s.badge}>{end.pinned ? 'pinned' : 'generated'}</span>
                </td>
                <td style={s.td}>
                  {end.geometry ? (
                    <button
                      onClick={() => onJumpTo(end.geometry!)}
                      style={s.jump}
                      title={`Move the cursor to (${end.geometry.x}, ${end.geometry.y}) and centre the view there`}
                    >
                      ({end.geometry.x}, {end.geometry.y})
                      {end.geometry.terminated ? ' · buffered' : ''}
                    </button>
                  ) : (
                    // Not an error on its own: an end authored ahead of the
                    // track it names is a legitimate work order. The
                    // diagnostics decide whether it has become a problem.
                    <span style={s.muted} title="No opening on the drawing carries this name">
                      not placed
                    </span>
                  )}
                </td>
                <td style={s.td}>
                  {editingId === end.id ? (
                    <>
                      <button
                        onClick={() => void submitRename(end.id)}
                        style={s.smallBtn}
                        disabled={busy}
                      >
                        Save
                      </button>{' '}
                      <button onClick={() => setEditingId(null)} style={s.smallBtn}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        onClick={() => {
                          setEditingId(end.id);
                          setDraftLabel(end.label);
                        }}
                        style={s.smallBtn}
                        // Saving the same label is how you pin a generated
                        // name you agree with, so this is offered on every row.
                        title="Rename and pin. Saving the label unchanged just pins it."
                      >
                        Rename
                      </button>{' '}
                      <button
                        onClick={() => void run(() => ops.remove(end.id))}
                        style={s.delBtn}
                        disabled={busy}
                        title="Delete. Refused while any edge references this label."
                        aria-label={`Delete end ${end.label}`}
                      >
                        ×
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ─── Styles (Catppuccin Mocha, matching the rest of the editor) ───────────────

const s = {
  panel:     { maxHeight: 220, overflowY: 'auto' as const, background: '#11111b', borderTop: '1px solid #313244', padding: '6px 10px' } as React.CSSProperties,
  addRow:    { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' as const, marginBottom: 6 } as React.CSSProperties,
  select:    { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '2px 6px', fontSize: 12 } as React.CSSProperties,
  input:     { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '2px 6px', fontSize: 12, minWidth: 140 } as React.CSSProperties,
  addBtn:    { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '3px 12px', fontWeight: 700, cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  smallBtn:  { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 3, padding: '1px 8px', cursor: 'pointer', fontSize: 11 } as React.CSSProperties,
  delBtn:    { background: 'none', border: '1px solid #45475a', borderRadius: 3, color: '#f38ba8', cursor: 'pointer', padding: '1px 7px', fontSize: 12 } as React.CSSProperties,
  table:     { width: '100%', borderCollapse: 'collapse', fontSize: 11 } as React.CSSProperties,
  th:        { textAlign: 'left' as const, padding: '3px 8px', color: '#6c7086', borderBottom: '1px solid #313244', fontWeight: 400 },
  td:        { padding: '4px 8px', color: '#cdd6f4', borderBottom: '1px solid #1e1e2e' } as React.CSSProperties,
  badge:     { fontSize: 10, color: '#9399b2', fontFamily: 'monospace' } as React.CSSProperties,
  jump:      { background: 'none', border: 'none', padding: 0, margin: 0, color: '#89b4fa', font: 'inherit', cursor: 'pointer', textDecoration: 'underline', textDecorationStyle: 'dotted' as const } as React.CSSProperties,
  muted:     { color: '#6c7086', fontSize: 11, margin: 0 } as React.CSSProperties,
  hint:      { color: '#6c7086', fontSize: 10 } as React.CSSProperties,
  error:     { color: '#f38ba8', fontSize: 11, margin: '0 0 6px' } as React.CSSProperties,
} as const;
