import { useEffect, useRef } from 'react';
import { useStore, type Fx } from '../store.ts';
import { ROOM, type Level } from './layout.ts';
import { positions } from './motion.ts';

const CEILING: Record<Level, number> = { bridge: 96, upper: 304, lower: 514 };
const levelOf = (y: number): Level => (y < 270 ? 'bridge' : y < 495 ? 'upper' : 'lower');

type Pt = [number, number];

/** A route that rides the ceiling pipes: up from the sender, along, down to the receiver. */
function pipeRoute(from: Pt, to: Pt): Pt[] {
  const lf = levelOf(from[1]);
  const lt = levelOf(to[1]);
  const pts: Pt[] = [from, [from[0], CEILING[lf]]];
  if (lf !== lt) {
    const shaftX = from[0] < 800 ? 585 : 1112;
    pts.push([shaftX, CEILING[lf]], [shaftX, CEILING[lt]]);
  }
  pts.push([to[0], CEILING[lt]], to);
  return pts;
}

function keyframes(pts: Pt[]): Keyframe[] {
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  let acc = 0;
  return pts.map((p, i) => {
    if (i > 0) acc += lens[i - 1];
    return { transform: `translate(${p[0]}px, ${p[1]}px)`, offset: acc / total };
  });
}

const head = (id: string | undefined): Pt | null => {
  const p = id ? positions.get(id) : undefined;
  return p ? [p.x, p.y - 88] : null;
};

const ARCHIVE: Pt = [600, 600];

function FxItem({ f }: { f: Fx }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (f.kind === 'stamp') {
      const r = ROOM.radio;
      el.style.transform = `translate(${r.x + r.w / 2}px, ${r.y + r.h / 2}px)`;
      el.animate(
        [
          { opacity: 0, scale: '1.8', rotate: '-4deg' },
          { opacity: 1, scale: '1', rotate: '-11deg', offset: 0.12 },
          { opacity: 1, scale: '1', rotate: '-11deg', offset: 0.75 },
          { opacity: 0, scale: '1', rotate: '-11deg' },
        ],
        { duration: 2400, fill: 'forwards', easing: 'ease-out' },
      );
      return;
    }
    const from = head(f.agentId);
    const to = f.kind === 'capsule' ? head(f.toId) : ARCHIVE;
    if (!from || !to) {
      el.style.display = 'none';
      return;
    }
    const pts = pipeRoute(from, to);
    const dur = f.kind === 'capsule' ? 2200 : 1700;
    el.animate(keyframes(pts), { duration: dur, easing: 'cubic-bezier(.45,.05,.35,1)', fill: 'forwards' });
    el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.08 }, { opacity: 1, offset: 0.9 }, { opacity: 0 }], { duration: dur, fill: 'forwards' });
  }, [f]);

  if (f.kind === 'stamp')
    return (
      <div ref={ref} className={`fx-stamp ${f.text === 'DENIED' ? 'denied' : ''}`}>
        <span>{f.text}</span>
      </div>
    );
  if (f.kind === 'capsule') return <div ref={ref} className="fx-capsule" title="Handoff" />;
  if (f.kind === 'parcel') return <div ref={ref} className="fx-parcel" />;
  if (f.kind === 'note') return <div ref={ref} className="fx-note" />;
  return null;
}

export function FxLayer() {
  const fx = useStore((s) => s.fx);
  const shown = fx.filter((f) => ['capsule', 'parcel', 'note', 'stamp'].includes(f.kind) && Date.now() - f.at < 8000);
  return (
    <div className="layer fx-layer" aria-hidden>
      {shown.map((f) => (
        <FxItem key={f.id} f={f} />
      ))}
    </div>
  );
}
