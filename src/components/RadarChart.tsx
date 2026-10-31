import type { RadarValues } from '../types';

const AXES: { key: keyof RadarValues; lines: string[] }[] = [
  { key: 'clarity', lines: ['Clarity'] },
  { key: 'complexity', lines: ['Complexity'] },
  { key: 'tonalRichness', lines: ['Tonal', 'richness'] },
  { key: 'consistency', lines: ['Consistency'] },
  { key: 'rarity', lines: ['Rarity'] },
  { key: 'nocturnal', lines: ['Nocturnal'] },
];

interface Props {
  values: RadarValues;
  size?: number;
  className?: string;
}

/** Minimal monochrome six-axis radar — never Oxygen/Iron/medical labels. */
export function RadarChart({ values, size = 280, className }: Props) {
  // Extra viewBox padding so wrapped labels never clip on ~390px phones
  const pad = Math.round(size * 0.14);
  const vb = size + pad * 2;
  const cx = vb / 2;
  const cy = vb / 2;
  const radius = size * 0.30;
  const n = AXES.length;

  const pointAt = (i: number, value01: number) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const r = radius * Math.max(0, Math.min(1, value01));
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
    };
  };

  const labelAt = (i: number) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    // Pull labels inward so they stay inside the SVG on narrow screens
    const r = radius + size * 0.095;
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
      angle,
    };
  };

  const pts = AXES.map((a, i) => pointAt(i, (values[a.key] ?? 0) / 100));
  const polygon = pts.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <svg
      className={className ?? 'radar-chart'}
      width={size}
      height={size}
      viewBox={`0 0 ${vb} ${vb}`}
      role="img"
      aria-label="Profile radar: Clarity, Complexity, Tonal richness, Consistency, Rarity, Nocturnal suitability"
    >
      {AXES.map((_, i) => {
        const tip = pointAt(i, 1);
        return (
          <line
            key={`spoke-${i}`}
            x1={cx}
            y1={cy}
            x2={tip.x}
            y2={tip.y}
            stroke="#D8DCDB"
            strokeWidth={1}
          />
        );
      })}

      <polygon
        points={polygon}
        fill="rgba(23, 26, 28, 0.08)"
        stroke="#171A1C"
        strokeWidth={1.25}
        strokeLinejoin="round"
      />

      {pts.map((p, i) => (
        <circle key={`dot-${i}`} cx={p.x} cy={p.y} r={3.5} fill="#171A1C" />
      ))}

      {AXES.map((a, i) => {
        const lp = labelAt(i);
        const anchor =
          Math.abs(lp.x - cx) < 6 ? 'middle' : lp.x < cx ? 'end' : 'start';
        const lineH = 11;
        const blockH = a.lines.length * lineH;
        const baseY = lp.y - blockH / 2 + lineH * 0.75;
        return (
          <text
            key={a.key}
            x={lp.x}
            y={baseY}
            textAnchor={anchor}
            fill="#667077"
            fontSize={10}
            fontFamily="inherit"
            fontWeight={450}
          >
            {a.lines.map((line, li) => (
              <tspan key={line} x={lp.x} dy={li === 0 ? 0 : lineH}>
                {line}
              </tspan>
            ))}
          </text>
        );
      })}
    </svg>
  );
}

export { AXES as RADAR_AXES };
