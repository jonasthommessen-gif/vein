import type { RadarValues } from '../types';

const AXES: { key: keyof RadarValues; label: string }[] = [
  { key: 'clarity', label: 'Clarity' },
  { key: 'complexity', label: 'Complexity' },
  { key: 'tonalRichness', label: 'Tonal richness' },
  { key: 'consistency', label: 'Consistency' },
  { key: 'rarity', label: 'Rarity' },
  { key: 'nocturnal', label: 'Nocturnal suitability' },
];

interface Props {
  values: RadarValues;
  size?: number;
  className?: string;
}

/** Minimal monochrome six-axis radar — never Oxygen/Iron/medical labels. */
export function RadarChart({ values, size = 280, className }: Props) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.32;
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
    const r = radius + size * 0.12;
    return {
      x: cx + Math.cos(angle) * r,
      y: cy + Math.sin(angle) * r,
    };
  };

  const pts = AXES.map((a, i) => pointAt(i, (values[a.key] ?? 0) / 100));
  const polygon = pts.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <svg
      className={className ?? 'radar-chart'}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="Profile radar: Clarity, Complexity, Tonal richness, Consistency, Rarity, Nocturnal suitability"
    >
      {/* Axis spokes */}
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

      {/* Filled polygon */}
      <polygon
        points={polygon}
        fill="rgba(23, 26, 28, 0.08)"
        stroke="#171A1C"
        strokeWidth={1.25}
        strokeLinejoin="round"
      />

      {/* Value dots */}
      {pts.map((p, i) => (
        <circle key={`dot-${i}`} cx={p.x} cy={p.y} r={3.5} fill="#171A1C" />
      ))}

      {/* Labels */}
      {AXES.map((a, i) => {
        const lp = labelAt(i);
        const anchor =
          Math.abs(lp.x - cx) < 4 ? 'middle' : lp.x < cx ? 'end' : 'start';
        return (
          <text
            key={a.key}
            x={lp.x}
            y={lp.y}
            textAnchor={anchor}
            dominantBaseline="middle"
            fill="#667077"
            fontSize={11}
            fontFamily="inherit"
            fontWeight={450}
          >
            {a.label}
          </text>
        );
      })}
    </svg>
  );
}

export { AXES as RADAR_AXES };
