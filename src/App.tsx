import { useCallback, useEffect, useState } from 'react';
import { errorMessage } from './api.ts';
import { connect, useStore } from './store.ts';
import { TopBar } from './panels/TopBar.tsx';
import { SidePanel } from './panels/SidePanel.tsx';
import { SettingsModal } from './panels/SettingsModal.tsx';
import { HaulModal } from './panels/HaulModal.tsx';
import { Toast } from './panels/Toast.tsx';
import { World } from './world/World.tsx';

export function App() {
  const ready = useStore((s) => s.ready);
  const load = useStore((s) => s.load);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const haulOpen = useStore((s) => s.haulOpen);

  const [bootError, setBootError] = useState<string | null>(null);
  const boot = useCallback(() => {
    setBootError(null);
    load().catch((e) => setBootError(errorMessage(e)));
  }, [load]);

  useEffect(() => {
    boot();
    return connect();
  }, [boot]);

  if (!ready) {
    return (
      <div className="boot">
        <img src="/art/crew/navigator-face.webp" alt="" />
        {bootError ? (
          <>
            <p>Can't reach the Deepwork server: {bootError}</p>
            <button type="button" className="btn" onClick={boot}>
              Try again
            </button>
          </>
        ) : (
          <p>Flooding the ballast tanks…</p>
        )}
      </div>
    );
  }
  return (
    <div className="app">
      <TopBar />
      <main className="main">
        <World />
        <SidePanel />
      </main>
      {settingsOpen && <SettingsModal />}
      {haulOpen && <HaulModal />}
      <Toast />
    </div>
  );
}
