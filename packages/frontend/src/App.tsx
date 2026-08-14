import { useEffect, useState } from 'react';
import { useAuth } from './hooks/useAuth';
import { useCapabilities } from './hooks/useCapabilities';
import { useLayoutSocket } from './hooks/useLayoutSocket';
import { useConnectionHealth } from './hooks/useConnectionHealth';
import { useLayoutConfig } from './hooks/useLayoutConfig';
import { StatusBar } from './components/StatusBar';
import { LoginScreen } from './components/LoginScreen';
import { ThrottlePanel } from './components/ThrottlePanel';
import { LayoutPanel } from './components/LayoutPanel';
import { RoutesPanel } from './components/RoutesPanel';
import { SensorSimulationPanel } from './components/SensorSimulationPanel';
import { ConfigPanel } from './components/ConfigPanel';
import { GridEditor } from './components/GridEditor';
import { MonitorView } from './components/MonitorView';
import { SensorFaultBanner } from './components/SensorFaultBanner';
import { ChangePasswordDialog } from './components/ChangePasswordDialog';
import { apiFetch, API_BASE } from './api';
import { ClientMessage, Role, SystemMode } from './types';

type AppTab = 'operate' | 'monitor' | 'configure' | 'grid';

/**
 * Which tabs a role is offered (#61, #63).
 *
 * | role       | tabs                                   |
 * |------------|----------------------------------------|
 * | `admin`    | Operate, Monitor, Track Editor, Configure |
 * | `operator` | Operate, Monitor                       |
 * | `monitor`  | Monitor                                |
 *
 * Two decisions are encoded here, both recorded in `docs/auth.md`:
 *
 * **The authoring screens are absent for a non-admin, not disabled** (#61). A
 * greyed-out control still poses a question whose honest answer is "you may
 * not", and a nav entry says that better by not existing.
 *
 * **An operator gets the Monitor view too**, which "an operator sees the
 * Operate screen and nothing else" does not literally allow — that sentence
 * predates this view. The same section rejects a read-only Configure and a
 * read-only track view on the grounds that what an operator actually wants is
 * "a purpose-built situational-awareness view … tracked separately as the
 * `monitor` role, issue #63". This is that view. Withholding it would honour
 * the letter of the sentence against its own argument.
 *
 * This is affordance, not authorisation. Hiding a tab does nothing to `curl`,
 * a stale browser tab or a second client — `requireAdmin` on the write routes
 * and the WebSocket's per-connection role gate are the enforcement, and stay
 * load-bearing.
 */
const TABS_BY_ROLE: Record<Role, AppTab[]> = {
  admin: ['operate', 'monitor', 'grid', 'configure'],
  operator: ['operate', 'monitor'],
  monitor: ['monitor'],
};

const TAB_LABELS: Record<AppTab, string> = {
  operate: 'Operate',
  monitor: 'Monitor',
  grid: 'Track Editor',
  configure: 'Configure',
};

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
  // Passed to ChangePasswordDialog as onChanged (issue #53): a successful
  // change has already revoked every session the user holds server-side
  // (Q3, docs/auth.md) — this is the client-side mirror, resetting local
  // auth state back to LoginScreen the same way a deliberate "Log out" does.
  const capabilities = useCapabilities();
  const { snapshot, connectionState, lastMessageAt, send } = useLayoutSocket();
  const { systemStatus, systemMode, safeStopReason, blocks, points, locos, routes, sensorFaults, routeFaults } =
    snapshot;

  // One derived list feeds both the nav and the render guards below, rather
  // than scattering role checks — a panel must not render even if `appTab`
  // somehow held a tab this role cannot see (a future state-restore or deep
  // link).
  const visibleTabs = TABS_BY_ROLE[role];
  // A `monitor` has no Operate screen to default to. Falls back to the first
  // tab the role actually has rather than to a constant.
  const [appTab, setAppTab] = useState<AppTab>(() => visibleTabs[0]);
  const [layoutId, setLayoutId] = useState<string | null>(null);

  /**
   * #82: whether what is on screen can still be trusted as current. Derived
   * once here and handed down, so the status bar and the mimic cannot
   * disagree about it — a display whose two liveness indicators differ is
   * worse than one that has none.
   */
  const freshness = useConnectionHealth(connectionState, lastMessageAt);

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
        {visibleTabs.map((t) => (
          <button
            key={t}
            onClick={() => setAppTab(t)}
            style={{ ...styles.navBtn, ...(appTab === t ? styles.navBtnActive : {}) }}
          >
            {TAB_LABELS[t]}
          </button>
        ))}
        <div style={styles.session}>
          <span style={styles.sessionLabel}>{username} ({role})</span>
          <ChangePasswordDialog onChanged={onLogout} />
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
            {(() => {
              const routesPanel = (
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
              );
              // Two-arm conditional, not an always-present wrapper, so that
              // Operate is byte-identical to before #65 when the flag is
              // off — a `<div style={styles.operateRow}>` around a single
              // panel would still change the DOM even with nothing inside it.
              return capabilities.sensorSimulation ? (
                <div style={styles.operateRow}>
                  {routesPanel}
                  <SensorSimulationPanel
                    sensors={layoutConfig.config.sensors}
                    onInject={async (sensorId, body) => {
                      const r = await layoutConfig.simulateSensorReading(sensorId, body);
                      return { ok: r.ok, message: r.message, data: r.data };
                    }}
                  />
                </div>
              ) : (
                routesPanel
              );
            })()}
          </>
        )}
        {appTab === 'monitor' && visibleTabs.includes('monitor') && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <MonitorView
              layoutId={layoutId}
              blocks={layoutConfig.config.blocks}
              points={layoutConfig.config.points}
              sensors={layoutConfig.config.sensors}
              locos={layoutConfig.config.locos}
              edges={layoutConfig.config.edges}
              snapshot={snapshot}
              freshness={freshness}
            />
          </div>
        )}
        {appTab === 'grid' && visibleTabs.includes('grid') && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <GridEditor
              layoutId={layoutId}
              blocks={layoutConfig.config.blocks}
              points={layoutConfig.config.points}
              sensors={layoutConfig.config.sensors}
            />
          </div>
        )}
        {appTab === 'configure' && visibleTabs.includes('configure') && (
          <ConfigPanel layoutId={layoutId} role={role} currentUsername={username} />
        )}
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
  // #65: RoutesPanel (flex: 1, minWidth: 0) and SensorSimulationPanel
  // (flex: 0 0 340px) share this row, wrapping on a narrow viewport.
  operateRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: 12,
    flex: 1,
    minHeight: 0,
  } as React.CSSProperties,
} as const;
