import { useState } from 'react';

interface Props {
  onLogin: (username: string, password: string) => Promise<boolean>;
  error: string | null;
}

export function LoginScreen({ onLogin, error }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password || submitting) return;
    setSubmitting(true);
    try {
      await onLogin(username, password);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={styles.root}>
      <form style={styles.card} onSubmit={handleSubmit}>
        <h1 style={styles.title}>Layout Orchestrator</h1>
        <p style={styles.subtitle}>Sign in to operate or configure the layout.</p>

        <label style={styles.label} htmlFor="username">
          Username
        </label>
        <input
          id="username"
          style={styles.input}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoFocus
        />

        <label style={styles.label} htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          style={styles.input}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />

        {error && <div style={styles.error}>{error}</div>}

        <button type="submit" style={styles.submit} disabled={submitting || !username || !password}>
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

const styles = {
  root: {
    height: '100vh',
    background: '#1e1e2e',
    color: '#cdd6f4',
    fontFamily: "'Segoe UI', system-ui, sans-serif",
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as React.CSSProperties,
  card: {
    background: '#181825',
    border: '1px solid #313244',
    borderRadius: 8,
    padding: '32px 28px',
    width: 320,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  } as React.CSSProperties,
  title: {
    margin: 0,
    fontSize: 18,
    fontWeight: 700,
  } as React.CSSProperties,
  subtitle: {
    margin: '4px 0 16px',
    fontSize: 13,
    color: '#6c7086',
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
  submit: {
    marginTop: 20,
    background: '#89b4fa',
    color: '#1e1e2e',
    border: 'none',
    borderRadius: 4,
    padding: '10px 12px',
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
  } as React.CSSProperties,
} as const;
