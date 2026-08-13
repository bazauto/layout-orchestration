import { useState } from 'react';
import { useLayoutConfig } from '../hooks/useLayoutConfig';
import { useUsers } from '../hooks/useUsers';
import { BlockRecord, PointRecord, Role, SensorRecord } from '../types';
import { EdgesTab } from './EdgesTab';
import { UsersTab } from './UsersTab';

type Ops = ReturnType<typeof useLayoutConfig>;

interface Props {
  layoutId: string | null;
  /** Gates the Users tab (admin-only) and identifies the current session for self-mutation disabling — see UsersTab. */
  role: Role;
  currentUsername: string;
}

type Tab = 'blocks' | 'sensors' | 'points' | 'locos' | 'edges' | 'users';

const CONFIG_TABS: Exclude<Tab, 'users'>[] = ['blocks', 'sensors', 'points', 'locos', 'edges'];

export function ConfigPanel({ layoutId, role, currentUsername }: Props) {
  const [tab, setTab] = useState<Tab>('blocks');
  const ops = useLayoutConfig(layoutId);
  const { config, loading, error } = ops;
  // Users aren't part of LayoutConfig (no layoutId scoping — accounts are
  // global), so this hook is mounted here regardless of which tab is active,
  // same as `ops` above. It's cheap: one GET, only re-fetched on a mutation.
  const usersOps = useUsers();

  if (!layoutId) return <p style={s.empty}>No layout selected.</p>;
  if (loading && config.layoutId !== layoutId) return <p style={s.empty}>Loading…</p>;

  return (
    <section style={s.panel}>
      <div style={s.header}>
        <h2 style={s.heading}>Configuration</h2>
        {error && <span style={s.error}>{error}</span>}
        <div style={s.tabs}>
          {CONFIG_TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
              <span style={s.badge}>{config[t].length}</span>
            </button>
          ))}
          {/*
            Rendered separately, after the map, rather than folded into
            CONFIG_TABS: the badge above reads `config[t].length`, and users
            are not part of LayoutConfig — folding this in would force a
            refactor of that badge logic for no gain. Admin-only (Q4,
            docs/auth.md): an operator may not enumerate accounts.
          */}
          {role === 'admin' && (
            <button
              onClick={() => setTab('users')}
              style={{ ...s.tab, ...(tab === 'users' ? s.tabActive : {}) }}
            >
              Users
              <span style={s.badge}>{usersOps.users.length}</span>
            </button>
          )}
        </div>
      </div>

      {tab === 'blocks'  && <BlocksTab  blocks={config.blocks} ops={ops} />}
      {tab === 'sensors' && <SensorsTab sensors={config.sensors} blocks={config.blocks} ops={ops} layoutId={layoutId} />}
      {tab === 'points'  && <PointsTab  points={config.points} blocks={config.blocks} ops={ops} />}
      {tab === 'locos'   && <LocosTab   locos={config.locos} ops={ops} />}
      {tab === 'edges'   && <EdgesTab   layoutId={layoutId} edges={config.edges} topology={config.topology} blocks={config.blocks} points={config.points} ops={ops} />}
      {tab === 'users' && role === 'admin' && <UsersTab ops={usersOps} currentUsername={currentUsername} />}
    </section>
  );
}

// ─── Shared inline-edit cell ──────────────────────────────────────────────────

/** Narrowed shape any `updateX` call needs to satisfy for `EditableCell` to report success/failure. */
type SaveResult = { ok: boolean; message?: string };

function EditableCell({
  value,
  onSave,
  /**
   * What this cell edits, e.g. `"length"`. Required, not defaulted to "Edit":
   * most rows here carry several of these — a loco row has four — and a column
   * of identical `Edit` buttons is unusable with a screen reader and ambiguous
   * to a test locator. It renders as `Edit length` in both `title` and
   * `aria-label`.
   */
  label,
  /**
   * Shown in place of an empty value. Only meaningful with `allowEmpty` — a
   * blank cell reads as an oversight, and for a block length the difference
   * between "unmeasured" and "nobody filled this in" decides whether an
   * automated braked run is permitted (docs/braking.md B4).
   */
  placeholder,
  /**
   * Whether clearing the field is a save rather than a cancel. Off by default:
   * for a name, an empty string is a mistake and backing out is the kind
   * reading. For an optional measurement it is how you retract one.
   */
  allowEmpty = false,
}: {
  value: string;
  onSave: (v: string) => Promise<SaveResult>;
  label: string;
  placeholder?: string;
  allowEmpty?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = draft.trim();
    if ((!trimmed && !allowEmpty) || trimmed === value) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const result = await onSave(trimmed);
    setSaving(false);
    if (result.ok) {
      setError(null);
      setEditing(false);
    } else {
      // Stay in edit mode with the operator's draft intact — a failed save
      // must not look like it succeeded, and must not lose their input.
      setError(result.message ?? 'Save failed');
    }
  };

  if (editing) {
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ display: 'flex', gap: 4 }}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') { setEditing(false); setError(null); }
            }}
            style={s.inlineInput}
            disabled={saving}
          />
          <button onClick={() => save()} style={s.saveBtn} disabled={saving}>✓</button>
          <button onClick={() => { setEditing(false); setError(null); }} style={s.cancelBtn}>✕</button>
        </span>
        {error && <span style={s.error}>{error}</span>}
      </span>
    );
  }
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {value === '' && placeholder ? <em style={s.placeholderText}>{placeholder}</em> : value}
      <button
        onClick={() => { setDraft(value); setEditing(true); setError(null); }}
        style={s.editBtn}
        title={`Edit ${label}`}
        aria-label={`Edit ${label}`}
      >✎</button>
    </span>
  );
}

// ─── Blocks tab ───────────────────────────────────────────────────────────────

function BlocksTab({ blocks, ops }: { blocks: BlockRecord[]; ops: Ops }) {
  const [name, setName] = useState('');
  const [length, setLength] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  const submit = async () => {
    if (!name.trim()) return;
    // Blank stays blank: an unmeasured block refuses a braked run, and
    // inventing a number here would be the one guess the braking model must
    // never make (docs/braking.md B4).
    const trimmed = length.trim();
    const parsed = trimmed === '' ? undefined : Number(trimmed);
    const result = await ops.createBlock(
      name.trim(),
      parsed === undefined || Number.isNaN(parsed) ? undefined : parsed,
    );
    if (result.ok) {
      setName('');
      setLength('');
      setFeedback(null);
    } else {
      // Leave the operator's input in place — a failed create must not look like it saved.
      setFeedback({ text: result.message ?? 'Create failed', ok: false });
    }
  };
  // A block delete now cascades to its edges — the response carries the
  // count, and can also 404. Both are surfaced rather than silently dropped.
  const handleDelete = async (id: string) => {
    const result = await ops.deleteBlock(id);
    setFeedback(
      result.ok
        ? { text: `Removed block and ${result.removedEdges} edge(s)`, ok: true }
        : { text: result.message ?? 'Delete failed', ok: false },
    );
  };
  return (
    <div style={s.tabBody}>
      <div style={s.addRow}>
        <input value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Block name" style={s.input} />
        <input value={length} onChange={(e) => setLength(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Length (mm)" type="number" min={1}
          aria-label="Block length in millimetres"
          style={{ ...s.input, flex: '0 0 130px' }} />
        <button onClick={submit} style={s.addBtn}>Add</button>
      </div>
      {feedback && (
        <p style={feedback.ok ? s.topicPreview : s.error}>{feedback.text}</p>
      )}
      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>Name</th><th style={s.th}>Length (mm)</th><th style={s.th}>ID</th><th style={s.th} />
        </tr></thead>
        <tbody>
          {blocks.map((b) => (
            <tr key={b.id}>
              <td style={s.td}>
                <EditableCell label="name" value={b.name} onSave={(v) => ops.updateBlock(b.id, { name: v })} />
              </td>
              <td style={s.td}>
                {/*
                  Rendered as the word "unmeasured", never a blank cell: blank
                  reads as an oversight, and the distinction decides whether an
                  automated braked run is allowed at all (docs/braking.md B4).
                  An empty edit clears it back to unmeasured.
                */}
                <EditableCell
                  label="length"
                  value={b.lengthMm === null ? '' : String(b.lengthMm)}
                  placeholder="unmeasured"
                  allowEmpty
                  onSave={(v) => {
                    const trimmed = v.trim();
                    const parsed = trimmed === '' ? null : Number(trimmed);
                    return ops.updateBlock(b.id, {
                      lengthMm: parsed !== null && Number.isNaN(parsed) ? null : parsed,
                    });
                  }}
                />
              </td>
              <td style={s.tdMono}>{b.id.slice(0, 8)}…</td>
              <td style={s.td}><button onClick={() => handleDelete(b.id)} style={s.delBtn}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Sensors tab ──────────────────────────────────────────────────────────────

function SensorsTab({ sensors, blocks, ops, layoutId }: {
  sensors: SensorRecord[];
  blocks: BlockRecord[];
  ops: Ops;
  layoutId: string;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'block_detection' | 'ir_position'>('block_detection');
  const [blockId, setBlockId] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const slug = (str: string) => str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const derivedTopic = name.trim() ? `layout/${layoutId}/sensor/${slug(name.trim())}/reading` : '';

  const submit = async () => {
    if (!name.trim()) return;
    const result = await ops.createSensor(name.trim(), type, blockId || null, derivedTopic);
    if (result.ok) {
      setName(''); setBlockId('');
      setFeedback(null);
    } else {
      // Leave the operator's input in place — a failed create must not look like it saved.
      setFeedback(result.message ?? 'Create failed');
    }
  };

  // Shared by every inline `<select>`/delete below: a failed update reverts
  // the control to `ss.*` on the next render (the select is controlled by
  // the still-unchanged record, since a failure never triggers `refresh()`)
  // — this just makes sure the operator sees *why* it reverted.
  const runUpdate = async (result: Promise<{ ok: boolean; message?: string }>) => {
    const r = await result;
    setFeedback(r.ok ? null : (r.message ?? 'Update failed'));
  };

  return (
    <div style={s.tabBody}>
      <div style={s.addRow}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Sensor name" style={s.input} />
        <select value={type} onChange={(e) => setType(e.target.value as typeof type)} style={s.select}>
          <option value="block_detection">Block detection</option>
          <option value="ir_position">IR position</option>
        </select>
        <select value={blockId} onChange={(e) => setBlockId(e.target.value)} style={s.select}>
          <option value="">— no block —</option>
          {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button onClick={submit} style={s.addBtn}>Add</button>
      </div>
      {name.trim() && <p style={s.topicPreview}>Topic: <code>{derivedTopic}</code></p>}
      {feedback && <p style={s.error}>{feedback}</p>}
      <table style={s.table}>
        <thead><tr>
          {['Name', 'Type', 'Block', 'In service', 'MQTT Topic', ''].map((h) => <th key={h} style={s.th}>{h}</th>)}
        </tr></thead>
        <tbody>
          {sensors.map((ss) => (
            <tr key={ss.id}>
              <td style={s.td}>
                <EditableCell label="name" value={ss.name} onSave={(v) => ops.updateSensor(ss.id, { name: v })} />
              </td>
              <td style={s.td}>
                <select
                  value={ss.type}
                  onChange={(e) => runUpdate(ops.updateSensor(ss.id, { type: e.target.value as typeof ss.type }))}
                  style={s.inlineSelect}
                >
                  <option value="block_detection">Block detection</option>
                  <option value="ir_position">IR position</option>
                </select>
              </td>
              <td style={s.td}>
                <select
                  value={ss.blockId ?? ''}
                  onChange={(e) => runUpdate(ops.updateSensor(ss.id, { blockId: e.target.value || null }))}
                  style={s.inlineSelect}
                >
                  <option value="">— none —</option>
                  {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </td>
              <td style={s.td}>
                {/*
                  Admin-only (requireAdmin already gates PUT .../sensors/:id
                  on the backend): out-of-service is a persistent config
                  change, not a driving action — #34 D5. Unchecking this
                  clears any latched fault for the sensor and unsubscribes it;
                  checking it starts clean, with no fault and no reading
                  (docs/sensor-fault-recovery.md D5's "not a regression").
                */}
                <input
                  type="checkbox"
                  checked={ss.inService}
                  onChange={(e) => runUpdate(ops.updateSensor(ss.id, { inService: e.target.checked }))}
                />
              </td>
              <td style={s.tdMono}>
                <EditableCell label="MQTT topic" value={ss.mqttTopic} onSave={(v) => ops.updateSensor(ss.id, { mqttTopic: v })} />
              </td>
              <td style={s.td}><button onClick={() => runUpdate(ops.deleteSensor(ss.id))} style={s.delBtn}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Points tab ───────────────────────────────────────────────────────────────

function PointsTab({ points, blocks, ops }: { points: PointRecord[]; blocks: BlockRecord[]; ops: Ops }) {
  const [name, setName] = useState('');
  const [addr, setAddr] = useState('');
  const [blockId, setBlockId] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  const submit = async () => {
    const dcc = parseInt(addr, 10);
    if (!name.trim() || isNaN(dcc)) return;
    const result = await ops.createPoint(name.trim(), dcc, blockId || null);
    if (result.ok) {
      setName(''); setAddr(''); setBlockId('');
      setFeedback(null);
    } else {
      // Leave the operator's input in place — a failed create must not look like it saved.
      setFeedback(result.message ?? 'Create failed');
    }
  };

  // A point delete can now be refused (422) while an edge's pointConditions
  // still reference it, and can 404 — both are surfaced instead of swallowed.
  // Shared with the inline update/select controls below.
  const runUpdate = async (result: Promise<{ ok: boolean; message?: string }>) => {
    const r = await result;
    setFeedback(r.ok ? null : (r.message ?? 'Update failed'));
  };

  return (
    <div style={s.tabBody}>
      <div style={s.addRow}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Point name" style={s.input} />
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="DCC addr"
          style={{ ...s.input, flex: '0 0 80px' }} type="number" min={1} />
        <select value={blockId} onChange={(e) => setBlockId(e.target.value)} style={s.select}>
          <option value="">— no block —</option>
          {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <button onClick={submit} style={s.addBtn}>Add</button>
      </div>
      {feedback && <p style={s.error}>{feedback}</p>}
      <table style={s.table}>
        <thead><tr>
          {['Name', 'DCC Addr', 'Block', ''].map((h) => <th key={h} style={s.th}>{h}</th>)}
        </tr></thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.id}>
              <td style={s.td}>
                <EditableCell label="name" value={p.name} onSave={(v) => ops.updatePoint(p.id, { name: v })} />
              </td>
              <td style={s.td}>
                <EditableCell
                  label="DCC address"
                  value={String(p.dccAddress)}
                  onSave={(v) => {
                    const n = parseInt(v, 10);
                    if (isNaN(n)) return Promise.resolve({ ok: false, message: 'Not a number' });
                    return ops.updatePoint(p.id, { dccAddress: n });
                  }}
                />
              </td>
              <td style={s.td}>
                <select
                  value={p.blockId ?? ''}
                  onChange={(e) => runUpdate(ops.updatePoint(p.id, { blockId: e.target.value || null }))}
                  style={s.inlineSelect}
                >
                  <option value="">— none —</option>
                  {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </td>
              <td style={s.td}><button onClick={() => runUpdate(ops.deletePoint(p.id))} style={s.delBtn}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Locos tab ────────────────────────────────────────────────────────────────

function LocosTab({ locos, ops }: { locos: Ops['config']['locos']; ops: Ops }) {
  const [name, setName] = useState('');
  const [addr, setAddr] = useState('');
  const [type, setType] = useState('diesel');
  const [maxSpeed, setMaxSpeed] = useState('126');
  const [braking, setBraking] = useState('0.5');
  const [feedback, setFeedback] = useState<string | null>(null);

  const submit = async () => {
    const dcc = parseInt(addr, 10);
    if (!name.trim() || isNaN(dcc)) return;
    const result = await ops.createLoco(name.trim(), dcc, type, parseInt(maxSpeed, 10), parseFloat(braking));
    if (result.ok) {
      setName(''); setAddr('');
      setFeedback(null);
    } else {
      // Leave the operator's input in place — a failed create must not look like it saved.
      setFeedback(result.message ?? 'Create failed');
    }
  };

  // Shared by every inline `<select>`/delete below — see PointsTab/SensorsTab.
  const runUpdate = async (result: Promise<{ ok: boolean; message?: string }>) => {
    const r = await result;
    setFeedback(r.ok ? null : (r.message ?? 'Update failed'));
  };

  return (
    <div style={s.tabBody}>
      <div style={s.addRow}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={s.input} />
        <input value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="Addr"
          style={{ ...s.input, flex: '0 0 70px' }} type="number" min={1} />
        <select value={type} onChange={(e) => setType(e.target.value)} style={s.select}>
          {['steam', 'diesel', 'electric', 'unknown'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={maxSpeed} onChange={(e) => setMaxSpeed(e.target.value)} placeholder="Max spd"
          style={{ ...s.input, flex: '0 0 70px' }} type="number" min={1} max={126} />
        <input value={braking} onChange={(e) => setBraking(e.target.value)} placeholder="Brake"
          style={{ ...s.input, flex: '0 0 60px' }} type="number" min={0} max={1} step={0.1} />
        <button onClick={submit} style={s.addBtn}>Add</button>
      </div>
      {feedback && <p style={s.error}>{feedback}</p>}
      <table style={s.table}>
        <thead><tr>
          {['Name', 'Addr', 'Type', 'Max Speed', 'Braking', ''].map((h) => <th key={h} style={s.th}>{h}</th>)}
        </tr></thead>
        <tbody>
          {locos.map((l) => (
            <tr key={l.id}>
              <td style={s.td}>
                <EditableCell label="name" value={l.name} onSave={(v) => ops.updateLoco(l.id, { name: v })} />
              </td>
              <td style={s.td}>
                <EditableCell
                  label="DCC address"
                  value={String(l.address)}
                  onSave={(v) => {
                    const n = parseInt(v, 10);
                    if (isNaN(n)) return Promise.resolve({ ok: false, message: 'Not a number' });
                    return ops.updateLoco(l.id, { address: n });
                  }}
                />
              </td>
              <td style={s.td}>
                <select
                  value={l.type}
                  onChange={(e) => runUpdate(ops.updateLoco(l.id, { type: e.target.value }))}
                  style={s.inlineSelect}
                >
                  {['steam', 'diesel', 'electric', 'unknown'].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td style={s.td}>
                <EditableCell
                  label="max speed"
                  value={String(l.maxSpeed)}
                  onSave={(v) => {
                    const n = parseInt(v, 10);
                    if (isNaN(n)) return Promise.resolve({ ok: false, message: 'Not a number' });
                    return ops.updateLoco(l.id, { maxSpeed: n });
                  }}
                />
              </td>
              <td style={s.td}>
                <EditableCell
                  label="braking factor"
                  value={String(l.brakingFactor)}
                  onSave={(v) => {
                    const n = parseFloat(v);
                    if (isNaN(n)) return Promise.resolve({ ok: false, message: 'Not a number' });
                    return ops.updateLoco(l.id, { brakingFactor: n });
                  }}
                />
              </td>
              <td style={s.td}><button onClick={() => runUpdate(ops.deleteLoco(l.id))} style={s.delBtn}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = {
  panel:        { background: '#181825', border: '1px solid #313244', borderRadius: 6, overflow: 'hidden' } as React.CSSProperties,
  header:       { padding: '12px 16px 0', background: '#1e1e2e', borderBottom: '1px solid #313244' } as React.CSSProperties,
  heading:      { margin: '0 0 10px', fontSize: 15, color: '#fab387', letterSpacing: '0.5px', textTransform: 'uppercase' } as React.CSSProperties,
  tabs:         { display: 'flex', gap: 2 } as React.CSSProperties,
  tab:          { background: 'none', border: 'none', borderBottom: '2px solid transparent', padding: '6px 14px', color: '#6c7086', cursor: 'pointer', fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' } as React.CSSProperties,
  tabActive:    { color: '#cdd6f4', borderBottomColor: '#fab387' } as React.CSSProperties,
  badge:        { background: '#313244', borderRadius: 8, padding: '1px 6px', fontSize: 11 } as React.CSSProperties,
  tabBody:      { padding: 16 } as React.CSSProperties,
  addRow:       { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' as const, alignItems: 'center' },
  input:        { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '4px 8px', fontSize: 13, flex: 1, minWidth: 120 } as React.CSSProperties,
  inlineInput:  { background: '#313244', color: '#cdd6f4', border: '1px solid #89b4fa', borderRadius: 4, padding: '2px 6px', fontSize: 13, width: 160 } as React.CSSProperties,
  select:       { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '4px 8px', fontSize: 13 } as React.CSSProperties,
  inlineSelect: { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 3, padding: '2px 6px', fontSize: 12 } as React.CSSProperties,
  addBtn:       { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '5px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 13 } as React.CSSProperties,
  saveBtn:      { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 3, padding: '2px 7px', cursor: 'pointer', fontSize: 12, fontWeight: 700 } as React.CSSProperties,
  cancelBtn:    { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 3, padding: '2px 7px', cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  editBtn:      { background: 'none', border: 'none', color: '#6c7086', cursor: 'pointer', fontSize: 12, padding: '0 2px', lineHeight: 1 } as React.CSSProperties,
  topicPreview: { fontSize: 11, color: '#6c7086', marginBottom: 8 } as React.CSSProperties,
  table:        { width: '100%', borderCollapse: 'collapse', fontSize: 13 } as React.CSSProperties,
  th:           { textAlign: 'left' as const, padding: '4px 8px', color: '#6c7086', borderBottom: '1px solid #313244' },
  td:           { padding: '6px 8px', color: '#cdd6f4', borderBottom: '1px solid #1e1e2e' } as React.CSSProperties,
  tdMono:       { padding: '6px 8px', color: '#cdd6f4', borderBottom: '1px solid #1e1e2e', fontFamily: 'monospace', fontSize: 11 } as React.CSSProperties,
  delBtn:       { background: 'none', border: '1px solid #45475a', borderRadius: 3, color: '#f38ba8', cursor: 'pointer', padding: '1px 7px', fontSize: 13 } as React.CSSProperties,
  empty:        { color: '#6c7086', fontSize: 13, padding: 16 } as React.CSSProperties,
  error:        { color: '#f38ba8', fontSize: 12, marginLeft: 12 } as React.CSSProperties,
  // Italic and dimmed, but still a **word** — the state is "unmeasured", and a
  // greyed blank would read as a rendering gap rather than a fact (#81's rule
  // that no state is carried by styling alone).
  placeholderText: { color: '#7f849c', fontStyle: 'italic' } as React.CSSProperties,
} as const;

