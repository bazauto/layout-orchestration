import { useState } from 'react';
import { apiFetch } from '../api';

interface Props {
  /**
   * Called after a successful change. The backend has already revoked every
   * session the user holds (including this one) and cleared the cookie
   * (Q3, docs/auth.md) — this is the client-side mirror: `App` passes
   * `auth.logout`, which resets local state to `LoginScreen` the same way a
   * deliberate "Log out" click does, regardless of what the now-cookie-less
   * `POST /api/auth/logout` call inside it returns.
   */
  onChanged: () => void;
}

/**
 * Reachable by ANY logged-in user (not admin-gated) from the session area in
 * `App`'s nav, beside "Log out" — self-service password change has no role
 * restriction on the backend either (Q4, docs/auth.md).
 */
export function ChangePasswordDialog({ onChanged }: Props) {
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const close = () => {
    setOpen(false);
    setCurrentPassword('');
    setNewPassword('');
    setError(null);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentPassword || !newPassword || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (res.status === 204) {
        close();
        onChanged();
        return;
      }
      const body = await res.json().catch(() => ({}) as { error?: string });
      // 403 (wrong current password) and 400 (policy/schema) both land here
      // — the caller doesn't need to distinguish them, only see the message.
      setError(body.error ?? `Password change failed (HTTP ${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={s.trigger}>
        Change password
      </button>
    );
  }

  return (
    <div style={s.overlay}>
      <form style={s.card} onSubmit={submit}>
        <h2 style={s.title}>Change password</h2>

        <label style={s.label} htmlFor="current-password">
          Current password
        </label>
        <input
          id="current-password"
          type="password"
          style={s.input}
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          autoComplete="current-password"
          autoFocus
        />

        <label style={s.label} htmlFor="new-password">
          New password
        </label>
        <input
          id="new-password"
          type="password"
          style={s.input}
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          autoComplete="new-password"
        />

        {error && <div style={s.error}>{error}</div>}

        <div style={s.actions}>
          <button type="button" onClick={close} style={s.cancelBtn} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" style={s.submit} disabled={submitting || !currentPassword || !newPassword}>
            {submitting ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </div>
  );
}

const s = {
  trigger: {
    background: 'none',
    border: '1px solid #45475a',
    borderRadius: 4,
    padding: '4px 10px',
    color: '#cdd6f4',
    cursor: 'pointer',
    fontSize: 12,
  } as React.CSSProperties,
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  } as React.CSSProperties,
  card: {
    background: '#181825',
    border: '1px solid #313244',
    borderRadius: 8,
    padding: '24px 24px',
    width: 300,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  } as React.CSSProperties,
  title: {
    margin: '0 0 8px',
    fontSize: 16,
    fontWeight: 700,
    color: '#cdd6f4',
  } as React.CSSProperties,
  label: {
    fontSize: 12,
    color: '#a6adc8',
    marginTop: 8,
    marginBottom: 4,
  } as React.CSSProperties,
  input: {
    background: '#313244',
    color: '#cdd6f4',
    border: '1px solid #45475a',
    borderRadius: 4,
    padding: '8px 10px',
    fontSize: 14,
  } as React.CSSProperties,
  error: {
    marginTop: 12,
    color: '#f38ba8',
    fontSize: 13,
  } as React.CSSProperties,
  actions: {
    marginTop: 20,
    display: 'flex',
    gap: 8,
    justifyContent: 'flex-end',
  } as React.CSSProperties,
  cancelBtn: {
    background: 'none',
    border: '1px solid #45475a',
    borderRadius: 4,
    padding: '8px 14px',
    color: '#cdd6f4',
    cursor: 'pointer',
    fontSize: 13,
  } as React.CSSProperties,
  submit: {
    background: '#89b4fa',
    color: '#1e1e2e',
    border: 'none',
    borderRadius: 4,
    padding: '8px 14px',
    fontWeight: 700,
    fontSize: 13,
    cursor: 'pointer',
  } as React.CSSProperties,
} as const;
