import { LADDERS, FLOOR, ROOMS } from './layout.ts';

export const HULL_PATH =
  'M 250 262 L 1330 262 C 1480 262 1548 380 1548 481 C 1548 582 1480 720 1330 720 L 250 720 C 160 720 98 604 72 522 L 72 440 C 98 358 160 262 250 262 Z';
export const INTERIOR_PATH =
  'M 250 284 L 1330 284 C 1462 284 1526 386 1526 481 C 1526 576 1462 700 1330 700 L 250 700 C 172 700 116 596 94 516 L 94 446 C 116 366 172 284 250 284 Z';
export const TOWER_PATH = 'M 588 272 L 596 98 Q 598 54 642 54 L 858 54 Q 902 54 904 98 L 912 272 Z';
export const BRIDGE_PATH = 'M 612 254 L 616 104 Q 618 76 648 76 L 852 76 Q 882 76 884 104 L 888 254 Z';

function Defs() {
  return (
    <defs>
      <filter id="felt" x="-5%" y="-5%" width="110%" height="110%">
        <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="warp" />
        <feDisplacementMap in="SourceGraphic" in2="warp" scale="4" xChannelSelector="R" yChannelSelector="G" result="rough" />
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="3" result="noise" />
        <feColorMatrix in="noise" type="saturate" values="0" result="mono" />
        <feComponentTransfer in="mono" result="grain">
          <feFuncA type="table" tableValues="0 0.22" />
        </feComponentTransfer>
        <feComposite in="grain" in2="rough" operator="in" result="grainIn" />
        <feBlend in="rough" in2="grainIn" mode="multiply" result="textured" />
        <feDropShadow in="textured" dx="0" dy="5" stdDeviation="5" floodColor="#050c18" floodOpacity="0.45" />
      </filter>
      <filter id="soft-shadow" x="-10%" y="-10%" width="120%" height="120%">
        <feDropShadow dx="0" dy="3" stdDeviation="3" floodColor="#050c18" floodOpacity="0.4" />
      </filter>
      <clipPath id="hull-clip">
        <path d={HULL_PATH} />
      </clipPath>
      <clipPath id="interior-clip">
        <path d={INTERIOR_PATH} />
      </clipPath>
      <radialGradient id="porthole-glass" cx="35%" cy="35%" r="70%">
        <stop offset="0%" stopColor="#bfe3de" />
        <stop offset="60%" stopColor="#4f8f96" />
        <stop offset="100%" stopColor="#23485a" />
      </radialGradient>
    </defs>
  );
}

function Rivets({ y, from, to, gap = 28 }: { y: number; from: number; to: number; gap?: number }) {
  const xs: number[] = [];
  for (let x = from; x <= to; x += gap) xs.push(x);
  return (
    <g fill="#e2c07a" opacity="0.55">
      {xs.map((x) => (
        <circle key={x} cx={x} cy={y} r="2.2" />
      ))}
    </g>
  );
}

/** Everything behind the rooms: tail, fins, hull body, tower, periscope. */
export function HullBack({ spinning, periscopeUp, radioAlert }: { spinning: 'stop' | 'slow' | 'half' | 'full'; periscopeUp: boolean; radioAlert: boolean }) {
  return (
    <svg className="layer" viewBox="0 0 1600 900" aria-hidden>
      <Defs />
      {/* periscope and mast sit behind the tower so they rise out of it */}
      <g className={`periscope ${periscopeUp ? 'up' : ''}`}>
        <rect x="700" y="10" width="16" height="70" rx="3" fill="#b8893a" />
        <rect x="690" y="4" width="40" height="18" rx="5" fill="#caa050" />
        <rect x="722" y="8" width="10" height="10" rx="2" fill="#23485a" />
      </g>
      <g>
        <rect x="846" y="12" width="5" height="50" fill="#8f6a2b" />
        <line x1="836" y1="22" x2="861" y2="22" stroke="#8f6a2b" strokeWidth="3" />
        <circle cx="848.5" cy="10" r="5" className={`mast-light ${radioAlert ? 'alert' : ''}`} />
      </g>

      {/* tail: fins and propeller */}
      <g filter="url(#felt)">
        <path d="M 150 300 L 96 222 Q 92 212 104 214 L 214 270 Z" fill="#c9563f" />
        <path d="M 150 662 L 96 740 Q 92 750 104 748 L 214 692 Z" fill="#c9563f" />
        <rect x="26" y="470" width="60" height="22" rx="6" fill="#8f6a2b" />
      </g>
      <g className={`propeller spin-${spinning}`} style={{ transformOrigin: '34px 481px' }}>
        <ellipse cx="34" cy="438" rx="11" ry="40" fill="#caa050" />
        <ellipse cx="34" cy="524" rx="11" ry="40" fill="#b8893a" />
        <circle cx="34" cy="481" r="13" fill="#8f6a2b" />
      </g>

      <g filter="url(#felt)">
        <path d={HULL_PATH} fill="#243d5e" />
        <path d={TOWER_PATH} fill="#243d5e" />
      </g>
      {/* paint: coral keel band and a mustard sheer line */}
      <g clipPath="url(#hull-clip)">
        <rect x="0" y="668" width="1600" height="60" fill="#c9563f" opacity="0.95" />
        <rect x="0" y="664" width="1600" height="5" fill="#e2a93b" opacity="0.9" />
      </g>
      <rect x="588" y="236" width="324" height="7" fill="#e2a93b" opacity="0.85" />
      {/* nose portholes */}
      <g filter="url(#soft-shadow)">
        {[
          [1470, 420],
          [1470, 540],
        ].map(([cx, cy]) => (
          <g key={cy}>
            <circle cx={cx} cy={cy} r="26" fill="#b8893a" />
            <circle cx={cx} cy={cy} r="18" fill="url(#porthole-glass)" />
          </g>
        ))}
      </g>
      <Rivets y={273} from={262} to={1330} />
      <Rivets y={710} from={262} to={1330} />
      <Rivets y={66} from={650} to={850} gap={26} />
    </svg>
  );
}

/** Structure drawn over the rooms: deck, bulkheads, ladders, the rim. People walk in front of this. */
export function HullFront() {
  const upper = ROOMS.filter((r) => r.level === 'upper');
  const lower = ROOMS.filter((r) => r.level === 'lower');
  const rung = (x: number, y1: number, y2: number) => {
    const ys: number[] = [];
    for (let y = y1 + 10; y < y2; y += 17) ys.push(y);
    return (
      <g key={`${x}-${y1}`} className="ladder">
        <rect x={x - 13} y={y1} width="4" height={y2 - y1} rx="2" />
        <rect x={x + 9} y={y1} width="4" height={y2 - y1} rx="2" />
        {ys.map((y) => (
          <rect key={y} x={x - 11} y={y} width="22" height="3" rx="1" />
        ))}
      </g>
    );
  };
  return (
    <svg className="layer" viewBox="0 0 1600 900" aria-hidden>
      <g clipPath="url(#interior-clip-front)">
        <defs>
          <clipPath id="interior-clip-front">
            <path d={INTERIOR_PATH} />
          </clipPath>
        </defs>
        {/* deck between upper and lower */}
        <rect x="60" y="492" width="1500" height="9" fill="#5b3a22" />
        <rect x="60" y="492" width="1500" height="2" fill="#8f6a2b" />
        {LADDERS.filter((l) => l.top === 'upper').map((l) => (
          <rect key={l.x} x={l.x - 18} y="491" width="36" height="11" fill="#1b140e" />
        ))}
        {/* bulkheads with hatch doors */}
        {[...upper.slice(1).map((r) => ({ x: r.x, y1: 284, y2: 492 })), ...lower.slice(1).map((r) => ({ x: r.x, y1: 501, y2: 700 }))].map((b) => (
          <g key={`${b.x}-${b.y1}`}>
            <rect x={b.x - 5} y={b.y1} width="10" height={b.y2 - b.y1} fill="#3a2a1c" />
            <rect x={b.x - 5} y={b.y1} width="3" height={b.y2 - b.y1} fill="#6b4a2c" />
            <rect x={b.x - 9} y={b.y2 - 118} width="18" height="118" rx="9" fill="none" stroke="#b8893a" strokeWidth="2.5" opacity="0.7" />
          </g>
        ))}
        {LADDERS.map((l) => rung(l.x, l.top === 'bridge' ? 250 : 494, FLOOR[l.bottom] + 4))}
      </g>
      {/* the tower ladder rises through the hull into the bridge */}
      {rung(655, FLOOR.bridge - 4, 290)}
      <path d={INTERIOR_PATH} fill="none" stroke="#162840" strokeWidth="7" />
      <path d={BRIDGE_PATH} fill="none" stroke="#162840" strokeWidth="6" />
    </svg>
  );
}
