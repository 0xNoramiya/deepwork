import type { Activity, Agent, AgentLive, RoomId, Run } from '../../shared/types.ts';

// World coordinates. The whole scene is authored at 1600×900 and scaled to fit.
export const WORLD = { w: 1600, h: 900 };

export type Level = 'bridge' | 'upper' | 'lower';

/** y of the floor (where feet touch) on each level. */
export const FLOOR: Record<Level, number> = { bridge: 244, upper: 486, lower: 690 };

export interface RoomDef {
  id: RoomId;
  label: string;
  purpose: string;
  x: number;
  y: number;
  w: number;
  h: number;
  level: Level;
  /** Feet x positions for people in this room, in order of preference. */
  spots: number[];
}

export const ROOMS: RoomDef[] = [
  { id: 'bridge', label: 'Bridge', purpose: 'Your post. Crew come here when they need a decision from you.', x: 612, y: 76, w: 276, h: 176, level: 'bridge', spots: [760, 820, 700, 655] },
  { id: 'radio', label: 'Radio room', purpose: 'Every request to the outside world waits here for your approval.', x: 170, y: 290, w: 250, h: 205, level: 'upper', spots: [318, 268, 372] },
  { id: 'chart', label: 'Chart room', purpose: 'The mission plan lives on this board. The lead plans here.', x: 420, y: 290, w: 280, h: 205, level: 'upper', spots: [548, 610, 480, 655] },
  { id: 'sonar', label: 'Sonar room', purpose: 'Research station.', x: 700, y: 290, w: 260, h: 205, level: 'upper', spots: [838, 780, 900] },
  { id: 'cabin', label: "Writer's cabin", purpose: 'Writing station.', x: 960, y: 290, w: 240, h: 205, level: 'upper', spots: [1072, 1020, 1140] },
  { id: 'lab', label: 'Inspection lab', purpose: 'Review station.', x: 1200, y: 290, w: 230, h: 205, level: 'upper', spots: [1300, 1250, 1360] },
  { id: 'engine', label: 'Engine room', purpose: 'The budget. The fuel gauge drains as the mission spends.', x: 170, y: 495, w: 270, h: 205, level: 'lower', spots: [330, 280, 390] },
  { id: 'archive', label: 'Archive', purpose: 'Shared memory and every artifact the crew has filed.', x: 440, y: 495, w: 320, h: 205, level: 'lower', spots: [640, 520, 700, 480] },
  { id: 'galley', label: 'Galley', purpose: 'Where idle crew wait, and where they wait on each other.', x: 760, y: 495, w: 320, h: 205, level: 'lower', spots: [918, 986, 850, 1050, 800, 1020] },
  { id: 'workshop', label: 'Workshop', purpose: 'Engineering station.', x: 1080, y: 495, w: 350, h: 205, level: 'lower', spots: [1250, 1190, 1320, 1380] },
];

export const ROOM = Object.fromEntries(ROOMS.map((r) => [r.id, r])) as Record<RoomId, RoomDef>;

export interface Ladder {
  x: number;
  top: Level;
  bottom: Level;
}

export const LADDERS: Ladder[] = [
  { x: 655, top: 'bridge', bottom: 'upper' },
  { x: 585, top: 'upper', bottom: 'lower' },
  { x: 1112, top: 'upper', bottom: 'lower' },
];

export const CHARACTER_HEIGHT = 118;

export interface Placement {
  room: RoomId;
  /** Preferred spot index; the allocator moves people along if it's taken. */
  prefer: number;
  near?: string;
}

/** Where an agent belongs right now, derived only from real engine state. */
export function placementFor(agent: Agent, live: AgentLive | undefined, run: Run | null, placeOf: (agentId: string) => RoomId | undefined): Placement {
  const act: Activity = live?.activity ?? 'idle';
  if (!agent.enabled || act === 'off_duty') return { room: 'galley', prefer: 5 };
  if (run?.status === 'review' && live?.taskId) return { room: 'chart', prefer: 0 };
  switch (act) {
    case 'planning':
    case 'working':
    case 'filing':
    case 'blocked':
    case 'failed':
      return { room: agent.station, prefer: 0 };
    case 'waiting_user':
    case 'chatting':
      return { room: 'bridge', prefer: 0 };
    case 'waiting_approval':
      return { room: 'radio', prefer: 0 };
    case 'consulting': {
      const target = live?.withAgentId;
      const room = (target && placeOf(target)) || 'galley';
      return { room, prefer: 1, near: target ?? undefined };
    }
    case 'waiting_dep':
    case 'idle':
    case 'consulted':
    case 'paused':
    default:
      return { room: 'galley', prefer: 0 };
  }
}
