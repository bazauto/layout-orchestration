import { useEffect, useState } from 'react';
import { useAuth } from './hooks/useAuth';
import { useLayoutSocket } from './hooks/useLayoutSocket';
import { useLayoutConfig } from './hooks/useLayoutConfig';
import { StatusBar } from './components/StatusBar';
import { LoginScreen } from './components/LoginScreen';
import { ThrottlePanel } from './components/ThrottlePanel';
import { LayoutPanel } from './components/LayoutPanel';
import { RoutesPanel } from './components/RoutesPanel';
import { ConfigPanel } from './components/ConfigPanel';
import { GridEditor } from './components/GridEditor';
import { SensorFaultBanner } from './components/SensorFaultBanner';
import { apiFetch, API_BASE } from './api';
import { ClientMessage, Role, SystemMode } from './types';

type AppTab = 'operate' | 'configure' | 'grid';

export default function App() {
  const auth = useAuth();

  if (auth.status === 'loading') {
    return <div style={styles.root} />;
  }

  if (auth.status === 'unauthenticated') {
    return <LoginScreen onLogin={auth.login} error={auth.error} />;
  }

  return <AuthenticatedApp username={auth.user!.username} role={auth.user!.role} onLogout={auth.logout} />;
}

function AuthenticatedApp({
  username,
  role,
  onLogout,
}: {
  username: string;
  role: Role;
  onLogout: () => void;
}) {
  const { snapshot, connectionState, send } = useLayoutSocket();
  const { systemStatus, systemMode, safeStopReason, blocks, points, locos, routes, sensorFaults, routeFaults } =
    snapshot;
  const [appTab, setAppTab] = useState<AppTab>('operate');
  const [layoutId, setLayoutId] = useState<string | null>(null);

  useEffect(() => {
    if (connectionState !== 'connected' || layoutId) return;
    apiFetch('/api/layouts')
      .then((r) => r.json())
      .then((list: Array<{ id: string }>) => { if (list[0]) setLayoutId(list[0].id); })
      .catch(() => undefined);
  }, [connectionState, layoutId]);

  const layoutConfig = useLayoutConfig(layoutId);

  const isDisabled = connectionState !== 'connected' || systemStatus === 'offline';

  // Deliberately NOT the WebSocket EMERGENCY_STOP message: the WS upgrade
  // now requires a live authenticated session, but Emergency Stop must work
  // even if that session has expired or the socket has dropped — it can
  // only move the system in the fail-safe direction. POST /api/emergency-stop
  // is unauthenticated on the backend for exactly this reason (see
  // docs/auth.md).
  const handleEmergencyStop = () => {
    fetch(`${API_BASE}/api/emergency-stop`, { method: 'POST' }).catch(() => undefined);
  };
  const handleModeChange = (mode: SystemMode) => send({ type: 'SET_MODE', payload: { mode } });

  // Sensor id → name, so the fault banner can name the sensor rather than a
  // bare id (#34). Falls back to the id inside SensorFaultBanner itself if a
  // sensor's config hasn't loaded yet (or was deleted after the fault fired).
  const sensorNames = Object.fromEntries(layoutConfig.config.sensors.map((s) => [s.id, s.name]));

  return (
    <div style={styles.root}>
      <StatusBar
        status={systemStatus}
        mode={systemMode}
        reason={safeStopReason}
        connectionState={connectionState}
        onEmergencyStop={handleEmergencyStop}
        onModeChange={handleModeChange}
      />

      <SensorFaultBanner
        faults={sensorFaults}
        sensorNames={sensorNames}
        onAcknowledge={async (sensorId) => {
          const result = await layoutConfig.acknowledgeSensorFault(sensorId);
          return { ok: result.ok, message: result.message };
        }}
      />

      <nav style={styles.nav}>
        {(['operate', 'grid', 'configure'] as AppTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setAppTab(t)}
            style={{ ...styles.navBtn, ...(appTab === t ? styles.navBtnActive : {}) }}
          >
            {t === 'operate' ? 'Operate' : t === 'grid' ? 'Track Editor' : 'Configure'}
          </button>
        ))}
        <div style={styles.session}>
          <span style={styles.sessionLabel}>{username} ({role})</span>
          <button onClick={onLogout} style={styles.logoutBtn}>
            Log out
          </button>
        </div>
      </nav>

      <main style={styles.main}>
        {appTab === 'operate' && (
          <>
            <ThrottlePanel
              locos={locos}
              locoRecords={layoutConfig.config.locos}
              disabled={isDisabled}
              send={send as (msg: ClientMessage) => void}
            />
            <LayoutPanel
              blocks={blocks}
              points={points}
              blockRecords={layoutConfig.config.blocks}
              pointRecords={layoutConfig.config.points}
              disabled={isDisabled}
              send={send as (msg: ClientMessage) => void}
            />
            <RoutesPanel
              routes={routes}
              routeFaults={routeFaults}
              blocks={blocks}
              blockRecords={layoutConfig.config.blocks}
              locoRecords={layoutConfig.config.locos}
              disabled={isDisabled}
              onRequest={async (req) => {
                const r = await layoutConfig.requestRoute(req);
                return { ok: r.ok, message: r.message };
              }}
              onCancel={async (routeId) => {
                const r = await layoutConfig.cancelRoute(routeId);
                return { ok: r.ok, message: r.message };
              }}
              onResume={async (routeId) => {
                const r = await layoutConfig.resumeRoute(routeId);
                return { ok: r.ok, message: r.message };
              }}
              onAcknowledgeFault={async (routeId) => {
                const r = await layoutConfig.acknowledgeRouteFault(routeId);
                return { ok: r.ok, message: r.message };
              }}
            />
          </>
        )}
        {appTab === 'grid' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <GridEditor
              layoutId={layoutId}
              blocks={layoutConfig.config.blocks}
              points={layoutConfig.config.points}
            />
          </div>
        )}
        {appTab === 'configure' && <ConfigPanel layoutId={layoutId} />}
      </main>
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
    flexDirection: 'column',
    overflow: 'hidden',
  } as React.CSSProperties,
  nav: {
    display: 'flex',
    gap: 0,
    background: '#181825',
    borderBottom: '1px solid #313244',
    padding: '0 16px',
  } as React.CSSProperties,
  navBtn: {
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    padding: '8px 18px',
    color: '#6c7086',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 500,
  } as React.CSSProperties,
  navBtnActive: {
    color: '#cdd6f4',
    borderBottomColor: '#89b4fa',
  } as React.CSSProperties,
  session: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  } as React.CSSProperties,
  sessionLabel: {
    fontSize: 12,
    color: '#a6adc8',
  } as React.CSSProperties,
  logoutBtn: {
    background: 'none',
    border: '1px solid #45475a',
    borderRadius: 4,
    padding: '4px 10px',
    color: '#cdd6f4',
    cursor: 'pointer',
    fontSize: 12,
  } as React.CSSProperties,
  main: {
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    flex: 1,
    minHeight: 0,
  } as React.CSSProperties,
} as const;
