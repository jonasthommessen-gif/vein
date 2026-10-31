import type { GuidanceHint, ScanStage } from '../types';
import { GUIDANCE_LABELS, STAGE_LABELS } from '../vision/session';

interface Props {
  progress: number;
  stage: ScanStage;
  guidance: GuidanceHint;
  analyzing: boolean;
  complete: boolean;
}

export function ScanProgress({ progress, stage, guidance, analyzing, complete }: Props) {
  if (!analyzing && !complete) return null;

  const stageLabel = complete ? 'Profile ready — pour carefully' : STAGE_LABELS[stage];
  const hint = guidance ? GUIDANCE_LABELS[guidance] : null;

  return (
    <div className="progress-block">
      <div className="progress-pct">{complete ? 100 : Math.min(99, progress)}%</div>
      <div className="progress-stage" key={stageLabel}>
        {complete ? 'Analysis complete' : stageLabel}
      </div>
      {hint && !complete ? <div className="progress-hint">{hint}</div> : null}
      {complete ? <div className="progress-hint">This vintage has been… celebrated</div> : null}
    </div>
  );
}
