import { useState } from 'react';
import { useUsers } from '../hooks/useUsers';
import { Role } from '../types';

type Ops = ReturnType<typeof useUsers>;

interface Props {
  ops: Ops;
  /**
   * The current session's username, used only to disable a row's own
   * destructive controls (role select, Delete) — the backend refuses
   * self-mutation anyway (409 `SelfMutationError`), but the UI should not
   * offer it. Compared by username, not id: `GET /api/auth/me` (`useAuth`'s
   * `AuthUser`) does not carry the session's user id, and usernames are
   * already guaranteed unique (`users_username_unq`), so this is equivalent
   * without widening that response.
   */
  currentUsername: string;
}

export function UsersTab({ ops, currentUsername }: Props) {
  const { users, loading, error } = ops;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [feedback, setFeedback] = useState<string | null>(null);

  const submit = async () => {
    if (!username.trim() || !password) return;
    const result = await ops.createUser(username.trim(), password, role);
    if (result.ok) {
      setUsername('');
      setPassword('');
      setRole('operator');
      setFeedback(null);
    } else {
      // Leave the operator's input in place — a failed create must not look like it saved.
      setFeedback(result.message ?? 'Create failed');
    }
  };

  // Shared by the inline role <select>/Delete/Reset below — a failed
  // mutation surfaces its message rather than being swallowed (the
  // last-admin/self-mutation 409s must be visible, not silent).
  const runUpdate = async (result: Promise<{ ok: boolean; message?: string }>) => {
    const r = await result;
    setFeedback(r.ok ? null : (r.message ?? 'Update failed'));
  };

  return (
    <div style={s.tabBody}>
      <div style={s.addRow}>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Username"
          style={s.input}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          type="password"
          style={s.input}
        />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={s.select}>
          <option value="operator">Operator</option>
          <option value="admin">Admin</option>
        </select>
        <button onClick={submit} style={s.addBtn}>Add</button>
      </div>
      {loading && users.length === 0 && <p style={s.empty}>Loading…</p>}
      {(error || feedback) && <p style={s.error}>{error ?? feedback}</p>}
      <table style={s.table}>
        <thead>
          <tr>
            {['Username', 'Role', 'Created', ''].map((h) => (
              <th key={h} style={s.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const isSelf = u.username === currentUsername;
            return (
              <tr key={u.id}>
                <td style={s.td}>{u.username}</td>
                <td style={s.td}>
                  <select
                    value={u.role}
                    disabled={isSelf}
                    onChange={(e) => runUpdate(ops.changeRole(u.id, e.target.value as Role))}
                    style={s.inlineSelect}
                    title={isSelf ? 'You cannot change your own role' : undefined}
                  >
                    <option value="operator">Operator</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td style={s.tdMono}>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td style={s.td}>
                  <ResetPasswordControl onReset={(pw) => runUpdate(ops.resetPassword(u.id, pw))} />
                  <button
                    onClick={() => runUpdate(ops.deleteUser(u.id))}
                    disabled={isSelf}
                    title={isSelf ? 'You cannot delete your own account' : undefined}
                    style={s.delBtn}
                  >
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

/** Inline "Reset password" control — a small text input + button, revealed on click, matching EditableCell's reveal pattern in ConfigPanel.tsx. */
function ResetPasswordControl({ onReset }: { onReset: (password: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  if (!editing) {
    return (
      <button onClick={() => setEditing(true)} style={s.resetBtn}>
        Reset password
      </button>
    );
  }

  const submit = () => {
    if (!draft) return;
    onReset(draft);
    setDraft('');
    setEditing(false);
  };

  return (
    <span style={{ display: 'inline-flex', gap: 4 }}>
      <input
        autoFocus
        type="password"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') { setEditing(false); setDraft(''); }
        }}
        placeholder="New password"
        style={s.inlineInput}
      />
      <button onClick={submit} style={s.saveBtn}>✓</button>
      <button onClick={() => { setEditing(false); setDraft(''); }} style={s.cancelBtn}>✕</button>
    </span>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────
//
// Matches ConfigPanel.tsx's `s` object exactly (same colour palette/sizes) —
// deliberately not shared as an import, since ConfigPanel's `s` is a
// module-private const, same posture as EdgesTab.tsx's own copy.

const s = {
  tabBody:      { padding: 16 } as React.CSSProperties,
  addRow:       { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' as const, alignItems: 'center' },
  input:        { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '4px 8px', fontSize: 13, flex: 1, minWidth: 120 } as React.CSSProperties,
  inlineInput:  { background: '#313244', color: '#cdd6f4', border: '1px solid #89b4fa', borderRadius: 4, padding: '2px 6px', fontSize: 13, width: 140 } as React.CSSProperties,
  select:       { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 4, padding: '4px 8px', fontSize: 13 } as React.CSSProperties,
  inlineSelect: { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 3, padding: '2px 6px', fontSize: 12 } as React.CSSProperties,
  addBtn:       { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 4, padding: '5px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 13 } as React.CSSProperties,
  saveBtn:      { background: '#a6e3a1', color: '#1e1e2e', border: 'none', borderRadius: 3, padding: '2px 7px', cursor: 'pointer', fontSize: 12, fontWeight: 700 } as React.CSSProperties,
  cancelBtn:    { background: '#313244', color: '#cdd6f4', border: '1px solid #45475a', borderRadius: 3, padding: '2px 7px', cursor: 'pointer', fontSize: 12 } as React.CSSProperties,
  resetBtn:     { background: 'none', border: '1px solid #45475a', borderRadius: 3, color: '#89b4fa', cursor: 'pointer', padding: '1px 8px', fontSize: 12, marginRight: 6 } as React.CSSProperties,
  table:        { width: '100%', borderCollapse: 'collapse', fontSize: 13 } as React.CSSProperties,
  th:           { textAlign: 'left' as const, padding: '4px 8px', color: '#6c7086', borderBottom: '1px solid #313244' },
  td:           { padding: '6px 8px', color: '#cdd6f4', borderBottom: '1px solid #1e1e2e' } as React.CSSProperties,
  tdMono:       { padding: '6px 8px', color: '#cdd6f4', borderBottom: '1px solid #1e1e2e', fontFamily: 'monospace', fontSize: 11 } as React.CSSProperties,
  delBtn:       { background: 'none', border: '1px solid #45475a', borderRadius: 3, color: '#f38ba8', cursor: 'pointer', padding: '1px 7px', fontSize: 13 } as React.CSSProperties,
  empty:        { color: '#6c7086', fontSize: 13, padding: 16 } as React.CSSProperties,
  error:        { color: '#f38ba8', fontSize: 12, marginBottom: 8 } as React.CSSProperties,
} as const;
