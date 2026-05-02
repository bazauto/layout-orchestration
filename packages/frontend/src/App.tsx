import { useEffect, useState } from 'react';
import { useLayoutSocket } from './hooks/useLayoutSocket';
import { useLayoutConfig } from './hooks/useLayoutConfig';
import { StatusBar } from './components/StatusBar';
import { ThrottlePanel } from './components/ThrottlePanel';
import { LayoutPanel } from './components/LayoutPanel';
import { ConfigPanel } from './components/ConfigPanel';
import { GridEditor } from './components/GridEditor';
import { ClientMessage, SystemMode } from './types';

type AppTab = 'operate' | 'configure' | 'grid';

export default function App() {
  const { snapshot, connectionState, send } = useLayoutSocket();
  const { systemStatus, systemMode, safeStopReason, blocks, points, locos } = snapshot;
  const [appTab, setAppTab] = useState<AppTab>('operate');
  const [layoutId, setLayoutId] = useState<string | null>(null);

  useEffect(() => {
    if (connectionState !== 'connected' || layoutId) return;
    fetch('http://localhost:3000/api/layouts')
      .then((r) => r.json())
      .then((list: Array<{ id: string }>) => { if (list[0]) setLayoutId(list[0].id); })
      .catch(() => undefined);
  }, [connectionState, layoutId]);

  const layoutConfig = useLayoutConfig(layoutId);

  const isDisabled = connectionState !== 'connected' || systemStatus === 'offline';

  const handleEmergencyStop = () => send({ type: 'EMERGENCY_STOP' });
  const handleModeChange = (mode: SystemMode) => send({ type: 'SET_MODE', payload: { mode } });

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
  main: {
    padding: 16,
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    flex: 1,
    minHeight: 0,
  } as React.CSSProperties,
} as const;
