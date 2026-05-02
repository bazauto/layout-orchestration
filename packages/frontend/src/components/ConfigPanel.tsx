import { useState } from 'react';
import { useLayoutConfig } from '../hooks/useLayoutConfig';
import { BlockRecord, PointRecord, SensorRecord } from '../types';

type Ops = ReturnType<typeof useLayoutConfig>;

interface Props {
  layoutId: string | null;
}

type Tab = 'blocks' | 'sensors' | 'points' | 'locos';

export function ConfigPanel({ layoutId }: Props) {
  const [tab, setTab] = useState<Tab>('blocks');
  const ops = useLayoutConfig(layoutId);
  const { config, loading, error } = ops;

  if (!layoutId) return <p style={s.empty}>No layout selected.</p>;
  if (loading && config.layoutId !== layoutId) return <p style={s.empty}>Loading…</p>;

  return (
    <section style={s.panel}>
      <div style={s.header}>
        <h2 style={s.heading}>Configuration</h2>
        {error && <span style={s.error}>{error}</span>}
        <div style={s.tabs}>
          {(['blocks', 'sensors', 'points', 'locos'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
              <span style={s.badge}>{config[t].length}</span>
            </button>
          ))}
        </div>
      </div>

      {tab === 'blocks'  && <BlocksTab  blocks={config.blocks} ops={ops} />}
      {tab === 'sensors' && <SensorsTab sensors={config.sensors} blocks={config.blocks} ops={ops} layoutId={layoutId} />}
      {tab === 'points'  && <PointsTab  points={config.points} blocks={config.blocks} ops={ops} />}
      {tab === 'locos'   && <LocosTab   locos={config.locos} ops={ops} />}
    </section>
  );
}

// ─── Shared inline-edit cell ──────────────────────────────────────────────────

function EditableCell({
  value,
  onSave,
}: {
  value: string;
  onSave: (v: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  const save = () => {
    if (draft.trim() && draft.trim() !== value) onSave(draft.trim());
    setEditing(false);
  };

  if (editing) {
    return (
      <span style={{ display: 'flex', gap: 4 }}>
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          style={s.inlineInput}
        />
        <button onClick={save} style={s.saveBtn}>✓</button>
        <button onClick={() => setEditing(false)} style={s.cancelBtn}>✕</button>
      </span>
    );
  }
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {value}
      <button onClick={() => { setDraft(value); setEditing(true); }} style={s.editBtn} title="Edit">✎</button>
    </span>
  );
}

// ─── Blocks tab ───────────────────────────────────────────────────────────────

function BlocksTab({ blocks, ops }: { blocks: BlockRecord[]; ops: Ops }) {
  const [name, setName] = useState('');
  const submit = async () => {
    if (!name.trim()) return;
    await ops.createBlock(name.trim());
    setName('');
  };
  return (
    <div style={s.tabBody}>
      <div style={s.addRow}>
        <input value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Block name" style={s.input} />
        <button onClick={submit} style={s.addBtn}>Add</button>
      </div>
      <table style={s.table}>
        <thead><tr>
          <th style={s.th}>Name</th><th style={s.th}>ID</th><th style={s.th} />
        </tr></thead>
        <tbody>
          {blocks.map((b) => (
            <tr key={b.id}>
              <td style={s.td}>
                <EditableCell value={b.name} onSave={(v) => ops.updateBlock(b.id, v)} />
              </td>
              <td style={s.tdMono}>{b.id.slice(0, 8)}…</td>
              <td style={s.td}><button onClick={() => ops.deleteBlock(b.id)} style={s.delBtn}>×</button></td>
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

  const slug = (str: string) => str.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const derivedTopic = name.trim() ? `layout/${layoutId}/sensor/${slug(name.trim())}/reading` : '';

  const submit = async () => {
    if (!name.trim()) return;
    await ops.createSensor(name.trim(), type, blockId || null, derivedTopic);
    setName(''); setBlockId('');
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
      <table style={s.table}>
        <thead><tr>
          {['Name', 'Type', 'Block', 'MQTT Topic', ''].map((h) => <th key={h} style={s.th}>{h}</th>)}
        </tr></thead>
        <tbody>
          {sensors.map((ss) => (
            <tr key={ss.id}>
              <td style={s.td}>
                <EditableCell value={ss.name} onSave={(v) => ops.updateSensor(ss.id, { name: v })} />
              </td>
              <td style={s.td}>
                <select
                  value={ss.type}
                  onChange={(e) => ops.updateSensor(ss.id, { type: e.target.value as typeof ss.type })}
                  style={s.inlineSelect}
                >
                  <option value="block_detection">Block detection</option>
                  <option value="ir_position">IR position</option>
                </select>
              </td>
              <td style={s.td}>
                <select
                  value={ss.blockId ?? ''}
                  onChange={(e) => ops.updateSensor(ss.id, { blockId: e.target.value || null })}
                  style={s.inlineSelect}
                >
                  <option value="">— none —</option>
                  {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </td>
              <td style={s.tdMono}>
                <EditableCell value={ss.mqttTopic} onSave={(v) => ops.updateSensor(ss.id, { mqttTopic: v })} />
              </td>
              <td style={s.td}><button onClick={() => ops.deleteSensor(ss.id)} style={s.delBtn}>×</button></td>
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

  const submit = async () => {
    const dcc = parseInt(addr, 10);
    if (!name.trim() || isNaN(dcc)) return;
    await ops.createPoint(name.trim(), dcc, blockId || null);
    setName(''); setAddr(''); setBlockId('');
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
      <table style={s.table}>
        <thead><tr>
          {['Name', 'DCC Addr', 'Block', ''].map((h) => <th key={h} style={s.th}>{h}</th>)}
        </tr></thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.id}>
              <td style={s.td}>
                <EditableCell value={p.name} onSave={(v) => ops.updatePoint(p.id, { name: v })} />
              </td>
              <td style={s.td}>
                <EditableCell
                  value={String(p.dccAddress)}
                  onSave={(v) => { const n = parseInt(v, 10); if (!isNaN(n)) ops.updatePoint(p.id, { dccAddress: n }); }}
                />
              </td>
              <td style={s.td}>
                <select
                  value={p.blockId ?? ''}
                  onChange={(e) => ops.updatePoint(p.id, { blockId: e.target.value || null })}
                  style={s.inlineSelect}
                >
                  <option value="">— none —</option>
                  {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </td>
              <td style={s.td}><button onClick={() => ops.deletePoint(p.id)} style={s.delBtn}>×</button></td>
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

  const submit = async () => {
    const dcc = parseInt(addr, 10);
    if (!name.trim() || isNaN(dcc)) return;
    await ops.createLoco(name.trim(), dcc, type, parseInt(maxSpeed, 10), parseFloat(braking));
    setName(''); setAddr('');
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
      <table style={s.table}>
        <thead><tr>
          {['Name', 'Addr', 'Type', 'Max Speed', 'Braking', ''].map((h) => <th key={h} style={s.th}>{h}</th>)}
        </tr></thead>
        <tbody>
          {locos.map((l) => (
            <tr key={l.id}>
              <td style={s.td}>
                <EditableCell value={l.name} onSave={(v) => ops.updateLoco(l.id, { name: v })} />
              </td>
              <td style={s.td}>
                <EditableCell
                  value={String(l.address)}
                  onSave={(v) => { const n = parseInt(v, 10); if (!isNaN(n)) ops.updateLoco(l.id, { address: n }); }}
                />
              </td>
              <td style={s.td}>
                <select value={l.type} onChange={(e) => ops.updateLoco(l.id, { type: e.target.value })} style={s.inlineSelect}>
                  {['steam', 'diesel', 'electric', 'unknown'].map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </td>
              <td style={s.td}>
                <EditableCell
                  value={String(l.maxSpeed)}
                  onSave={(v) => { const n = parseInt(v, 10); if (!isNaN(n)) ops.updateLoco(l.id, { maxSpeed: n }); }}
                />
              </td>
              <td style={s.td}>
                <EditableCell
                  value={String(l.brakingFactor)}
                  onSave={(v) => { const n = parseFloat(v); if (!isNaN(n)) ops.updateLoco(l.id, { brakingFactor: n }); }}
                />
              </td>
              <td style={s.td}><button onClick={() => ops.deleteLoco(l.id)} style={s.delBtn}>×</button></td>
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
} as const;

