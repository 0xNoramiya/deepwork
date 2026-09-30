import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore, openRequests } from '../store.ts';
import { clock, cx, face } from '../util.ts';
import { CrewLayer } from './Crew.tsx';
import { FxLayer } from './Fx.tsx';
import { HullBack, HullFront } from './Hull.tsx';
import { WORLD } from './layout.ts';
import { RoomImages, RoomOverlays } from './Rooms.tsx';

function useFit(ref: React.RefObject<HTMLDivElement | null>) {
  const [fit, setFit] = useState({ s: 0.6, x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      const s = Math.min(width / WORLD.w, height / WORLD.h);
      setFit({ s, x: (width - WORLD.w * s) / 2, y: (height - WORLD.h * s) / 2 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return fit;
}

function DepthGauge() {
  const tasks = useStore((s) => s.tasks);
  const run = useStore((s) => s.run);
  const done = tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  const pct = run?.status === 'completed' ? 1 : tasks.length ? done / tasks.length : 0;
  return (
    <div className="depth" title={tasks.length ? `Progress: ${done} of ${tasks.length} tasks` : 'Progress appears once there is a plan'}>
      <span className="depth-label">depth</span>
      <span className="depth-tube">
        <span className="depth-fill" style={{ height: `${pct * 100}%` }} />
        {tasks.map((t, i) => (
          <span key={t.id} className={cx('depth-tick', (t.status === 'done' || t.status === 'skipped') && 'on')} style={{ top: `${((i + 1) / tasks.length) * 100}%` }} />
        ))}
      </span>
      <span className="depth-num">{tasks.length ? `${done}/${tasks.length}` : '—'}</span>
    </div>
  );
}

function Ticker() {
  const events = useStore((s) => s.events);
  const agents = useStore((s) => s.agents);
  const set = useStore((s) => s.set);
  const important = events.filter((e) => e.level === 'important' || e.level === 'warn' || e.level === 'error').slice(-4).reverse();
  if (!important.length) return null;
  return (
    <button type="button" className="ticker" onClick={() => set({ tab: 'log' })} aria-label="Open the full log">
      <span className="ticker-title">Captain's log</span>
      <ol>
        {important.map((e) => {
          const a = agents.find((x) => x.id === e.agentId);
          return (
            <li key={e.id} className={`lvl-${e.level}`}>
              <time>{clock(e.ts)}</time>
              {a ? <img src={face(a)} alt="" /> : <i className="dot" />}
              <span>{e.summary}</span>
            </li>
          );
        })}
      </ol>
    </button>
  );
}

export function World() {
  const frame = useRef<HTMLDivElement>(null);
  const fit = useFit(frame);
  const run = useStore((s) => s.run);
  const tasks = useStore((s) => s.tasks);
  const live = useStore((s) => s.live);
  const requests = useStore((s) => s.requests);
  const agents = useStore((s) => s.agents);

  const active = !!run && !['completed', 'failed', 'cancelled'].includes(run.status);
  const paused = run?.status === 'paused';
  const done = tasks.filter((t) => t.status === 'done' || t.status === 'skipped').length;
  const progress = run?.status === 'completed' ? 0 : tasks.length ? done / tasks.length : 0;
  const depth = !active ? 0 : 140 + progress * 220;
  const conc = run?.limits.concurrency ?? 0;
  const spinning = !active || paused ? 'stop' : conc <= 1 ? 'slow' : conc <= 3 ? 'half' : 'full';
  const periscopeUp = Object.values(live).some((l) => /^(fetching|GET|POST|PUT|PATCH|DELETE) /.test(l.detail ?? ''));
  const radioAlert = openRequests(requests).some((q) => q.kind === 'approval');
  const allDemo = agents.length > 0 && agents.filter((a) => a.enabled).every((a) => a.providerId === 'demo');

  const [bubbles] = useState(() => Array.from({ length: 14 }, (_, i) => ({ i, d: 3 + Math.random() * 4, x: Math.random() * 30, delay: Math.random() * 6, r: 3 + Math.random() * 6 })));
  return (
    <div className={cx('world-frame', paused && 'paused', !active && 'surfaced', fit.s < 0.45 && 'compact')} ref={frame}>
      <div className="ocean" style={{ transform: `translateY(${-depth * fit.s * 0.25}px) scale(1.08)` }} />
      <div className="abyss" style={{ opacity: active ? 0.15 + progress * 0.35 : 0 }} />
      <div
        className="world"
        style={{ width: WORLD.w, height: WORLD.h, transform: `translate(${fit.x}px, ${fit.y}px) scale(${fit.s})`, '--inv': 1 / fit.s } as CSSProperties}
      >
        <div className={cx('prop-bubbles', spinning !== 'stop' && 'on')} aria-hidden>
          {bubbles.map((b) => (
            <i key={b.i} style={{ left: b.x, width: b.r, height: b.r, animationDuration: `${b.d}s`, animationDelay: `${b.delay}s` }} />
          ))}
        </div>
        <div className="sub">
          <HullBack spinning={spinning} periscopeUp={periscopeUp} radioAlert={radioAlert} />
          <RoomImages />
          <HullFront />
          <RoomOverlays />
          <CrewLayer />
          <FxLayer />
        </div>
        <DepthGauge />
        {paused && <div className="stencil">All stop</div>}
      </div>
      {allDemo && (
        <div className="demo-ribbon" title="No model provider is connected. Planning, tasks, approvals and files are real; the words are templates.">
          Demo mode · simulated crew
        </div>
      )}
      <Ticker />
    </div>
  );
}
