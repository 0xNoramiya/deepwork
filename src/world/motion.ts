import { FLOOR, LADDERS, type Level } from './layout.ts';

export interface Waypoint {
  x: number;
  y: number;
  level: Level;
  climb?: boolean;
}

export interface Walker {
  x: number;
  y: number;
  level: Level;
  path: Waypoint[];
  facing: 1 | -1;
  /** Where the walker is headed; used to avoid re-routing to the same place. */
  goal: { x: number; level: Level } | null;
}

const ORDER: Level[] = ['bridge', 'upper', 'lower'];
const WALK = 185;
const CLIMB = 130;

/** Shared, mutable positions so effects (parcels, capsules) can start from where people are. */
export const positions = new Map<string, { x: number; y: number }>();

export function route(from: { x: number; level: Level }, to: { x: number; level: Level }): Waypoint[] {
  const pts: Waypoint[] = [];
  let cur = { ...from };
  while (cur.level !== to.level) {
    const dir = ORDER.indexOf(to.level) > ORDER.indexOf(cur.level) ? 1 : -1;
    const next = ORDER[ORDER.indexOf(cur.level) + dir];
    const options = LADDERS.filter((l) => (l.top === cur.level && l.bottom === next) || (l.bottom === cur.level && l.top === next));
    const ladder = options.reduce((best, l) => (Math.abs(cur.x - l.x) + Math.abs(l.x - to.x) < Math.abs(cur.x - best.x) + Math.abs(best.x - to.x) ? l : best));
    pts.push({ x: ladder.x, y: FLOOR[cur.level], level: cur.level });
    pts.push({ x: ladder.x, y: FLOOR[next], level: next, climb: true });
    cur = { x: ladder.x, level: next };
  }
  pts.push({ x: to.x, y: FLOOR[to.level], level: to.level });
  return pts;
}

export type Motion = 'still' | 'walk' | 'climb';

export function step(w: Walker, dt: number): Motion {
  let budget = dt;
  let motion: Motion = 'still';
  while (w.path.length && budget > 0) {
    const wp = w.path[0];
    const speed = wp.climb ? CLIMB : WALK;
    const dx = wp.x - w.x;
    const dy = wp.y - w.y;
    const dist = Math.hypot(dx, dy);
    if (Math.abs(dx) > 0.5 && !wp.climb) w.facing = dx > 0 ? 1 : -1;
    motion = wp.climb ? 'climb' : 'walk';
    const can = speed * budget;
    if (dist <= can) {
      w.x = wp.x;
      w.y = wp.y;
      w.level = wp.level;
      w.path.shift();
      budget -= dist / speed;
    } else {
      w.x += (dx / dist) * can;
      w.y += (dy / dist) * can;
      budget = 0;
    }
  }
  return w.path.length ? motion : 'still';
}
