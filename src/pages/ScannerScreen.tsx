import { useCallback, useEffect, useRef, useState } from 'react';
import { Info, MoreHorizontal } from 'lucide-react';
import { CameraView, type CameraViewHandle } from '../components/CameraView';
import { FloatingMetrics } from '../components/FloatingMetrics';
import { ScanProgress } from '../components/ScanProgress';
import { buildProfile } from '../domain/profile';
import { nextSubjectLabel } from '../persistence/profiles';
import type { AppPhase, FeatureScores, GuidanceHint, ScanStage, VeinProfile } from '../types';
import { FrameSampler } from '../vision/frameSampler';
import { AnalysisSession } from '../vision/session';

interface Props {
  onOpenLibrary: () => void;
  onProfileReady: (profile: VeinProfile) => void;
}

const EMPTY_SCORES: FeatureScores = {
  veinVisibility: 0,
  patternDetail: 0,
  colourSignature: 0,
  frameStability: 0,
  imageConfidence: 0,
};

export function ScannerScreen({ onOpenLibrary, onProfileReady }: Props) {
  const [phase, setPhase] = useState<AppPhase>('INTRO');
  const [error, setError] = useState<string | null>(null);
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const [scores, setScores] = useState<FeatureScores>(EMPTY_SCORES);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<ScanStage>('balancing_exposure');
  const [guidance, setGuidance] = useState<GuidanceHint>(null);
  const [limitedEscape, setLimitedEscape] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [completedProfile, setCompletedProfile] = useState<VeinProfile | null>(null);

  const cameraRef = useRef<CameraViewHandle>(null);
  const sessionRef = useRef(new AnalysisSession());
  const samplerRef = useRef<FrameSampler | null>(null);
  const analyzingRef = useRef(false);

  const stopSampling = useCallback(() => {
    samplerRef.current?.stop();
    analyzingRef.current = false;
  }, []);

  useEffect(() => () => stopSampling(), [stopSampling]);

  const beginCamera = () => {
    setError(null);
    setStillUrl(null);
    setCompletedProfile(null);
    setScores(EMPTY_SCORES);
    setProgress(0);
    setLimitedEscape(false);
    sessionRef.current.reset();
    setPhase('REQUESTING_PERMISSION');
  };

  const onCameraReady = useCallback(() => {
    setPhase((p) => {
      if (p === 'REQUESTING_PERMISSION' || p === 'CAMERA_READY' || p === 'ACQUIRING') {
        return 'ACQUIRING';
      }
      return p;
    });
  }, []);

  const onCameraError = useCallback((message: string) => {
    setError(message);
    setPhase('CAMERA_ERROR');
    stopSampling();
  }, [stopSampling]);

  const startAnalysis = useCallback(() => {
    const session = sessionRef.current;
    session.reset();
    session.start();
    analyzingRef.current = true;
    setPhase('ANALYZING');
    setCompletedProfile(null);

    const sampler = samplerRef.current ?? new FrameSampler({ width: 320, height: 240, fps: 5 });
    samplerRef.current = sampler;

    const source =
      stillUrl
        ? cameraRef.current?.getStill()
        : cameraRef.current?.getVideo();

    if (!source) {
      setError('No image source available.');
      setPhase('CAMERA_ERROR');
      return;
    }

    // For still images, wait until decoded
    const kick = () => {
      sampler.start(source, (frame) => {
        if (!analyzingRef.current) return;
        const result = session.processFrame(frame);
        setScores(result.smoothed);
        setProgress(result.progress);
        setStage(result.stage);
        setGuidance(result.guidance);
        setLimitedEscape(result.limitedEscapeAvailable);

        if (result.pausedLowQuality && !result.complete) {
          setPhase('PAUSED_LOW_QUALITY');
        } else if (!result.complete) {
          setPhase('ANALYZING');
        }

        if (result.complete) {
          analyzingRef.current = false;
          sampler.stop();
          const measured = result.smoothed;
          const profile = buildProfile({
            featureVector: result.featureVector,
            measured,
            limitedConfidence: session.isLimited(),
            label: nextSubjectLabel(),
          });
          setCompletedProfile(profile);
          setProgress(100);
          setPhase('COMPLETE');
        }
      });
    };

    if (source instanceof HTMLImageElement) {
      if (source.complete && source.naturalWidth) kick();
      else source.onload = () => kick();
    } else {
      kick();
    }
  }, [stillUrl]);

  // Auto-start analysis once acquiring with a live source
  useEffect(() => {
    if (phase === 'ACQUIRING') {
      const t = window.setTimeout(() => startAnalysis(), 350);
      return () => clearTimeout(t);
    }
  }, [phase, startAnalysis]);

  const onFile = (file: File | null) => {
    if (!file) return;
    stopSampling();
    if (stillUrl) URL.revokeObjectURL(stillUrl);
    const url = URL.createObjectURL(file);
    setStillUrl(url);
    setError(null);
    setCompletedProfile(null);
    sessionRef.current.reset();
    setScores(EMPTY_SCORES);
    setProgress(0);
    setPhase('ACQUIRING');
  };

  const useFixture = () => {
    stopSampling();
    setStillUrl('/fixtures/forearm_reference.png');
    setError(null);
    setCompletedProfile(null);
    sessionRef.current.reset();
    setScores(EMPTY_SCORES);
    setProgress(0);
    setPhase('ACQUIRING');
  };

  const continueLimited = () => {
    sessionRef.current.continueWithLimited();
    setPhase('ANALYZING');
  };

  const showMetrics =
    phase === 'ANALYZING' ||
    phase === 'PAUSED_LOW_QUALITY' ||
    phase === 'COMPLETE' ||
    phase === 'ACQUIRING';

  const cameraActive =
    (phase === 'REQUESTING_PERMISSION' ||
      phase === 'CAMERA_READY' ||
      phase === 'ACQUIRING' ||
      phase === 'ANALYZING' ||
      phase === 'PAUSED_LOW_QUALITY' ||
      phase === 'COMPLETE') &&
    !stillUrl;

  return (
    <div className="scanner">
      <CameraView
        ref={cameraRef}
        active={cameraActive}
        stillUrl={stillUrl}
        onReady={onCameraReady}
        onError={onCameraError}
      />
      <div className="scanner-gradient-top" />
      <div className="scanner-gradient-bottom" />

      <div className="scanner-ui">
        <header className="scanner-top">
          <div className="brand">
            {phase === 'ANALYZING' || phase === 'PAUSED_LOW_QUALITY' ? 'ANALYZING' : 'VEIN'}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="History"
            onClick={onOpenLibrary}
          >
            <MoreHorizontal size={20} strokeWidth={1.5} />
          </button>
        </header>

        <FloatingMetrics scores={scores} visible={showMetrics} />

        {(phase === 'INTRO' || phase === 'CAMERA_ERROR') && (
          <div className="scanner-center">
            {phase === 'CAMERA_ERROR' ? (
              <>
                <p className="error-msg">{error}</p>
                <div className="fallback-row">
                  <button type="button" onClick={beginCamera}>
                    Try again
                  </button>
                  <label>
                    Use photo
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <button type="button" onClick={useFixture}>
                    Use sample
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="intro-title">Find a visible vein</p>
                <p className="intro-sub">Natural light works best</p>
                <button type="button" className="begin-btn" onClick={beginCamera}>
                  Begin analysis
                </button>
                <div className="fallback-row">
                  <label>
                    Use photo
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) => onFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  <button type="button" onClick={useFixture}>
                    Use sample
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {(phase === 'ACQUIRING' ||
          phase === 'ANALYZING' ||
          phase === 'PAUSED_LOW_QUALITY' ||
          phase === 'COMPLETE' ||
          phase === 'REQUESTING_PERMISSION') &&
          phase !== 'COMPLETE' && (
            <div className="scanner-center" style={{ pointerEvents: 'none' }}>
              {phase === 'REQUESTING_PERMISSION' || phase === 'ACQUIRING' ? (
                <>
                  <p className="intro-title">Find a visible vein</p>
                  <p className="intro-sub">Natural light works best</p>
                </>
              ) : null}
            </div>
          )}

        {phase === 'COMPLETE' && completedProfile && (
          <div className="complete-cta-wrap">
            <div className="complete-label">Analysis complete</div>
            <button
              type="button"
              className="cta-capsule"
              onClick={() => onProfileReady(completedProfile)}
            >
              View blood profile →
            </button>
            {completedProfile.limitedConfidence ? (
              <span className="limited-btn" style={{ textDecoration: 'none' }}>
                Limited confidence · visual characteristics only
              </span>
            ) : null}
          </div>
        )}

        {limitedEscape && phase !== 'COMPLETE' && (
          <div className="complete-cta-wrap" style={{ bottom: 'calc(var(--safe-bottom) + 120px)' }}>
            <button type="button" className="limited-btn" onClick={continueLimited}>
              Continue with limited visual profile
            </button>
          </div>
        )}

        {showInfo && (
          <div className="methodology" role="dialog" aria-label="Methodology">
            <p>
              Bars reflect live image features: contrast, texture, chromatic ratios, motion, and
              capture quality. They are not medical biomarkers.
            </p>
            <p>Fictional profile · based on visible image characteristics</p>
            <button type="button" className="limited-btn" onClick={() => setShowInfo(false)}>
              Close
            </button>
          </div>
        )}

        <footer className="scanner-bottom">
          <ScanProgress
            progress={progress}
            stage={stage}
            guidance={guidance}
            analyzing={
              phase === 'ANALYZING' ||
              phase === 'PAUSED_LOW_QUALITY' ||
              phase === 'ACQUIRING'
            }
            complete={phase === 'COMPLETE'}
          />
          <button
            type="button"
            className="info-btn"
            aria-label="About measurements"
            onClick={() => setShowInfo((v) => !v)}
          >
            <Info size={16} strokeWidth={1.5} />
          </button>
        </footer>
      </div>
    </div>
  );
}
