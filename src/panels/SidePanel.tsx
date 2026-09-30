import { openRequests, useStore, type Tab } from '../store.ts';
import { cx } from '../util.ts';
import { ArchivePanel } from './ArchivePanel.tsx';
import { CrewPanel } from './CrewPanel.tsx';
import { LogPanel } from './LogPanel.tsx';
import { MissionPanel } from './MissionPanel.tsx';

const TABS: { id: Tab; label: string }[] = [
  { id: 'mission', label: 'Mission' },
  { id: 'crew', label: 'Crew' },
  { id: 'archive', label: 'Archive' },
  { id: 'log', label: 'Log' },
];

export function SidePanel() {
  const tab = useStore((s) => s.tab);
  const set = useStore((s) => s.set);
  const open = openRequests(useStore((s) => s.requests)).length;
  const artifacts = useStore((s) => s.artifacts);
  const run = useStore((s) => s.run);
  const count: Partial<Record<Tab, number>> = { mission: open, archive: artifacts.filter((a) => a.runId === run?.id).length };
  return (
    <aside className="side">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={cx(tab === t.id && 'on', t.id === 'mission' && open > 0 && 'alert')} onClick={() => set({ tab: t.id })}>
            {t.label}
            {!!count[t.id] && <b>{count[t.id]}</b>}
          </button>
        ))}
      </nav>
      <div className="side-body">
        {tab === 'mission' && <MissionPanel />}
        {tab === 'crew' && <CrewPanel />}
        {tab === 'archive' && <ArchivePanel />}
        {tab === 'log' && <LogPanel />}
      </div>
    </aside>
  );
}
