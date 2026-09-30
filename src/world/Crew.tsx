import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, AgentLive, RoomId, Run } from '../../shared/types.ts';
import { useStore, type Fx } from '../store.ts';
import { clip, cx, face, sprite } from '../util.ts';
import { CHARACTER_HEIGHT, FLOOR, placementFor, ROOM } from './layout.ts';
import { positions, route, step, type Walker } from './motion.ts';

interface Target {
  room: RoomId;
  x: number;
  /** Name tags of close neighbours alternate between two rows so they don't overlap. */
  row?: number;
}

/** Assign every agent a room and a free spot in it. Stable order keeps people from swapping places. */
function allocate(agents: Agent[], live: Record<string, AgentLive>, run: Run | null, prev: Map<string, Target>): Map<string, Target> {
  const placed = new Map<string, Target>();
  const used = new Map<RoomId, Set<number>>();
  const placeOf = (id: string) => placed.get(id)?.room ?? prev.get(id)?.room;
  const take = (room: RoomId, prefer: number): number => {
    const r = ROOM[room];
    const set = used.get(room) ?? new Set<number>();
    used.set(room, set);
    for (let i = 0; i < r.spots.length; i++) {
      const idx = (prefer + i) % r.spots.length;
      if (!set.has(idx)) {
        set.add(idx);
        return r.spots[idx];
      }
    }
    // Room is full: squeeze in with a small offset.
    const extra = r.spots[0] + ((set.size % 4) - 1.5) * 24;
    set.add(set.size);
    return extra;
  };
  // Non-visitors first so visitors can stand next to whoever they're visiting.
  const order = [...agents].sort((a, b) => Number(live[a.id]?.activity === 'consulting') - Number(live[b.id]?.activity === 'consulting') || a.sort - b.sort);
  for (const a of order) {
    const l = live[a.id];
    const kept = prev.get(a.id);
    if (l?.activity === 'paused' && kept) {
      placed.set(a.id, kept);
      continue;
    }
    const p = placementFor(a, l, run, placeOf);
    const host = p.near ? placed.get(p.near) : undefined;
    if (host) {
      const t = host;
      const r = ROOM[t.room];
      const side = t.x + 58 < r.x + r.w - 20 ? 58 : -58;
      placed.set(a.id, { room: t.room, x: t.x + side });
      continue;
    }
    placed.set(a.id, { room: p.room, x: take(p.room, p.prefer) });
  }
  const byRoom = new Map<RoomId, Target[]>();
  for (const t of placed.values()) byRoom.set(t.room, [...(byRoom.get(t.room) ?? []), t]);
  for (const list of byRoom.values()) {
    list.sort((a, b) => a.x - b.x);
    list.forEach((t, i) => (t.row = i > 0 && t.x - list[i - 1].x < 92 && list[i - 1].row === 0 ? 1 : 0));
  }
  return placed;
}

interface BubbleSpec {
  kind: 'say' | 'think' | 'alert' | 'stamp' | 'status';
  text: string;
  faces?: Agent[];
  tone?: 'red' | 'grey' | 'amber';
  onClick?: () => void;
}

function bubbleFor(a: Agent, l: AgentLive | undefined, fx: Fx[], agents: Agent[], now: number, open: () => void, reviewing: boolean): BubbleSpec | null {
  const mine = fx.filter((f) => f.agentId === a.id && now - f.at < 6500);
  const said = mine.findLast((f) => f.kind === 'answer' || f.kind === 'ask');
  if (said?.text) return { kind: 'say', text: clip(said.text, 110) };
  if (mine.some((f) => f.kind === 'done' && now - f.at < 3200)) return { kind: 'stamp', text: 'handed in ✓' };
  if (!l) return null;
  switch (l.activity) {
    case 'waiting_user':
      return { kind: 'alert', text: clip((l.detail ?? 'needs your call').replace(/^asks: /, ''), 64), tone: 'amber', onClick: open };
    case 'waiting_approval':
      return { kind: 'alert', text: clip(l.detail ?? 'needs approval', 60), tone: 'red', onClick: open };
    case 'failed':
      return { kind: 'alert', text: clip(l.detail ?? 'failed', 60), tone: 'red', onClick: open };
    case 'blocked':
      return { kind: 'alert', text: clip(`stuck: ${l.detail ?? ''}`, 60), tone: 'grey', onClick: open };
    case 'waiting_dep': {
      if (reviewing) return null;
      const faces = l.blockedBy.map((id) => agents.find((x) => x.id === id)).filter((x): x is Agent => !!x);
      return faces.length ? { kind: 'think', text: '', faces } : { kind: 'think', text: clip(l.detail ?? 'waiting', 30) };
    }
    case 'paused':
      return { kind: 'think', text: l.detail === 'held by the Captain' ? 'on hold' : 'paused' };
    case 'chatting':
      return { kind: 'say', text: '…' };
    case 'working':
    case 'planning':
    case 'consulting':
      return l.detail ? { kind: 'status', text: clip(l.detail, 46) } : null;
    default:
      return null;
  }
}

export function CrewLayer() {
  const agents = useStore((s) => s.agents);
  const live = useStore((s) => s.live);
  const run = useStore((s) => s.run);
  const fx = useStore((s) => s.fx);
  const selected = useStore((s) => s.selectedAgent);
  const selectAgent = useStore((s) => s.selectAgent);
  const set = useStore((s) => s.set);
  const streams = useStore((s) => s.streams);

  const walkers = useRef(new Map<string, Walker>());
  const targets = useRef(new Map<string, Target>());
  const els = useRef(new Map<string, HTMLDivElement>());
  const [now, setNow] = useState(Date.now());

  // Re-evaluate time-based bubbles a few times a second.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 700);
    return () => clearInterval(t);
  }, []);

  const placed = useMemo(() => allocate(agents, live, run, targets.current), [agents, live, run]);

  useEffect(() => {
    for (const [id, t] of placed) {
      const level = ROOM[t.room].level;
      let w = walkers.current.get(id);
      if (!w) {
        w = { x: t.x, y: FLOOR[level], level, path: [], facing: 1, goal: { x: t.x, level } };
        walkers.current.set(id, w);
      } else if (!w.goal || w.goal.x !== t.x || w.goal.level !== level) {
        // Mid-climb: finish the ladder segment first, then route from where it ends.
        const lead = w.path.length && w.path[0].climb ? [w.path[0]] : [];
        const start = lead.length ? { x: lead[0].x, level: lead[0].level } : { x: w.x, level: w.level };
        w.path = [...lead, ...route(start, { x: t.x, level })];
        w.goal = { x: t.x, level };
      }
    }
    for (const id of [...walkers.current.keys()]) if (!agents.some((a) => a.id === id)) walkers.current.delete(id);
    targets.current = placed;
  }, [placed, agents]);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      for (const [id, w] of walkers.current) {
        const paused = useStore.getState().live[id]?.activity === 'paused';
        const motion = paused ? 'still' : step(w, dt);
        positions.set(id, { x: w.x, y: w.y });
        const el = els.current.get(id);
        if (!el) continue;
        el.style.transform = `translate(${w.x}px, ${w.y}px)`;
        el.style.zIndex = String(Math.round(w.y));
        if (el.dataset.motion !== motion) el.dataset.motion = motion;
        const facing = w.facing === 1 ? 'right' : 'left';
        if (el.dataset.facing !== facing) el.dataset.facing = facing;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const openDecisions = () => set({ tab: 'mission', selectedTask: null });
  const enabled = agents.filter((a) => a.enabled);
  const mixed = enabled.some((a) => a.providerId === 'demo') && enabled.some((a) => a.providerId !== 'demo');

  return (
    <div className="layer crew-layer">
      {agents.map((a) => {
        const l = live[a.id];
        const b = bubbleFor(a, l, fx, agents, now, openDecisions, run?.status === 'review');
        const typing = streams[a.id] && now - streams[a.id].at < 1500 && (l?.activity === 'working' || l?.activity === 'planning');
        const demo = a.providerId === 'demo' && mixed;
        const row = placed.get(a.id)?.row ?? 0;
        return (
          <div
            key={a.id}
            ref={(el) => {
              if (el) els.current.set(a.id, el);
              else els.current.delete(a.id);
            }}
            className={cx('crew', `act-${l?.activity ?? 'idle'}`, selected === a.id && 'selected', !a.enabled && 'off')}
            data-motion="still"
            data-facing="right"
          >
            <button type="button" className="crew-hit" onClick={() => selectAgent(a.id)} aria-label={`${a.name}, ${a.title}`} style={{ height: CHARACTER_HEIGHT }}>
              <span className="crew-shadow" />
              <span className="crew-ring" style={{ borderColor: a.color }} />
              <span className="puppet">
                <img src={sprite(a)} alt="" draggable={false} style={{ height: CHARACTER_HEIGHT }} />
              </span>
            </button>
            <span className={cx('nametag', row === 1 && 'row2')}>
              <i style={{ background: a.color }} />
              {a.name}
              {demo && <em title="This crew member runs on the demo provider: simulated output, no model">sim</em>}
            </span>
            {b && (
              <span
                className={cx('bubble', `b-${b.kind}`, b.tone && `t-${b.tone}`, b.onClick && 'clickable')}
                onClick={b.onClick}
                role={b.onClick ? 'button' : undefined}
              >
                {b.faces && (
                  <svg className="hourglass" viewBox="0 0 24 24" aria-label="waiting on">
                    <path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9" />
                  </svg>
                )}
                {b.faces?.map((f) => <img key={f.id} src={face(f)} alt={f.name} title={`waiting on ${f.name}`} />)}
                {b.text && <span>{b.text}</span>}
                {typing && b.kind === 'status' && <span className="typing" aria-hidden><i /><i /><i /></span>}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
