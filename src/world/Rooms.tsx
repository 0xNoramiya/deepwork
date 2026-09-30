import type { RoomId } from '../../shared/types.ts';
import { useStore, openRequests } from '../store.ts';
import { money, plural } from '../util.ts';
import { BRIDGE_PATH, INTERIOR_PATH } from './Hull.tsx';
import { ROOM, ROOMS, type RoomDef } from './layout.ts';

const STATION_ROOMS = new Set<RoomId>(['chart', 'sonar', 'cabin', 'lab', 'workshop']);

export function RoomImages() {
  const deck = ROOMS.filter((r) => r.id !== 'bridge');
  const bridge = ROOM.bridge;
  return (
    <>
      <div className="layer rooms" style={{ clipPath: `path('${INTERIOR_PATH}')` }}>
        {deck.map((r) => (
          <img key={r.id} src={`/art/rooms/${r.id}.webp`} alt="" draggable={false} style={{ left: r.x, top: r.y, width: r.w, height: r.h }} />
        ))}
      </div>
      <div className="layer rooms" style={{ clipPath: `path('${BRIDGE_PATH}')` }}>
        <img src="/art/rooms/bridge.webp" alt="" draggable={false} style={{ left: bridge.x, top: bridge.y, width: bridge.w, height: bridge.h }} />
      </div>
    </>
  );
}

function useRoomInfo() {
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.live);
  const requests = useStore((s) => s.requests);
  const run = useStore((s) => s.run);
  const artifacts = useStore((s) => s.artifacts);
  const memories = useStore((s) => s.memories);
  const open = openRequests(requests);
  return { agents, live, run, open, artifacts, memories };
}

export function RoomOverlays() {
  const { agents, live, run, open, artifacts, memories } = useRoomInfo();
  const set = useStore((s) => s.set);
  const selectAgent = useStore((s) => s.selectAgent);
  const approvals = open.filter((q) => q.kind === 'approval').length;
  const questions = open.filter((q) => q.kind !== 'approval').length;
  const paused = run?.status === 'paused';
  const active = run && !['completed', 'failed', 'cancelled'].includes(run.status);

  const owners = (room: RoomId) => agents.filter((a) => a.enabled && a.station === room);
  const busy = (room: RoomId) =>
    owners(room).some((a) => ['working', 'planning', 'blocked', 'failed'].includes(live[a.id]?.activity ?? '')) ||
    agents.some((a) => {
      const l = live[a.id];
      return l?.activity === 'consulting' && l.withAgentId && agents.find((t) => t.id === l.withAgentId)?.station === room;
    });

  const plaque = (r: RoomDef): { title: string; info?: string; tone?: 'alert' | 'warn' } => {
    switch (r.id) {
      case 'bridge':
        return { title: 'Bridge · you', info: questions ? `${questions} waiting on you` : undefined, tone: questions ? 'warn' : undefined };
      case 'radio':
        return { title: 'Radio room', info: approvals ? `${approvals} awaiting approval` : 'outside requests', tone: approvals ? 'alert' : undefined };
      case 'engine':
        return { title: 'Engine room', info: run ? `${money(run.spentUsd)} of ${money(run.limits.budgetUsd)}` : 'budget & pace' };
      case 'archive':
        return { title: 'Archive', info: `${artifacts.length} filed · ${plural(memories.length, 'note')}` };
      case 'galley':
        return { title: 'Galley' };
      default:
        return { title: r.label, info: owners(r.id).map((a) => a.name).join(', ') || 'empty berth' };
    }
  };

  const click = (r: RoomDef) => {
    if (STATION_ROOMS.has(r.id) && r.id !== 'chart') {
      const o = owners(r.id)[0];
      if (o) return selectAgent(o.id);
    }
    if (r.id === 'archive') return set({ tab: 'archive', openArtifact: null });
    if (r.id === 'galley') return set({ tab: 'crew', selectedAgent: null });
    if (r.id === 'engine') return set({ tab: 'mission', selectedTask: null });
    set({ tab: 'mission', selectedTask: null });
  };

  const budgetLeft = run ? Math.max(0, 1 - run.spentUsd / run.limits.budgetUsd) : 1;

  return (
    <div className={`layer overlays ${paused ? 'is-paused' : ''}`}>
      {ROOMS.map((r) => {
        const station = STATION_ROOMS.has(r.id);
        const lit = !active ? true : station ? busy(r.id) : true;
        const p = plaque(r);
        return (
          <button
            key={r.id}
            type="button"
            className={`room-hit room-${r.id} ${lit ? 'lit' : 'dim'} ${r.id === 'radio' && approvals ? 'alarm' : ''}`}
            style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            onClick={() => click(r)}
            aria-label={`${r.label}: ${r.purpose}`}
          >
            <span className="room-glow" />
            <span className={`plaque ${p.tone ?? ''}`}>
              <b>{p.title}</b>
              {p.info && <span>{p.info}</span>}
            </span>
            <span className="room-tip">{r.purpose}</span>
            {r.id === 'engine' && run && (
              <span className="fuel" title={`Budget left: ${Math.round(budgetLeft * 100)}%`}>
                <span style={{ height: `${budgetLeft * 100}%` }} className={budgetLeft < 0.2 ? 'low' : ''} />
              </span>
            )}
            {r.id === 'radio' && approvals > 0 && <span className="lamp" />}
          </button>
        );
      })}
    </div>
  );
}
