import type { FeatureScores, FeatureSettleFlags } from '../types';

const LABELS: { key: keyof FeatureScores; label: string }[] = [
  { key: 'veinVisibility', label: 'Vein visibility' },
  { key: 'patternDetail', label: 'Pattern detail' },
  { key: 'colourSignature', label: 'Colour signature' },
  { key: 'frameStability', label: 'Frame stability' },
  { key: 'imageConfidence', label: 'Image confidence' },
];

interface Props {
  scores: FeatureScores;
  visible: boolean;
  settled?: FeatureSettleFlags | null;
}

export function FloatingMetrics({ scores, visible, settled }: Props) {
  if (!visible) return null;

  return (
    <div className="floating-metrics" aria-label="Live visual measurements">
      {LABELS.map(({ key, label }) => {
        const value = Math.round(scores[key]);
        const isSettled = settled?.[key] ?? false;
        return (
          <div
            className={`metric-row${isSettled ? ' metric-row--settled' : ''}`}
            key={key}
          >
            <div className="metric-label-row">
              <span className="metric-label">{label}</span>
              <span className="metric-value">{value}</span>
            </div>
            <div className="metric-track" aria-hidden>
              <div
                className="metric-fill"
                style={{
                  width: `${value}%`,
                  transitionDuration: isSettled ? '420ms' : '160ms',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
