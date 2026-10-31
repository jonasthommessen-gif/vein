import { useCallback, useEffect, useRef, useState } from 'react';
import { Info, MoreHorizontal } from 'lucide-react';
import { CameraView, type CameraViewHandle } from '../components/CameraView';
import { FloatingMetrics } from '../components/FloatingMetrics';
import { ScanProgress } from '../components/ScanProgress';
import { VeinOverlay } from '../components/VeinOverlay';
import { buildProfile } from '../domain/profile';
import { nextSubjectLabel } from '../persistence/profiles';
import type {
  AppPhase,
  FeatureScores,
  GuidanceHint,
  ScanStage,
  VeinGeometry,
  VeinProfile,
} from '../types';
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
  // Camera-first: request permission immediately — no black INTRO
  const [phase, setPhase] = useState<AppPhase>('REQUESTING_PERMISSION');
  const [error, setError] = useState<string | null>(null);
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const [scores, setScores] = useState<FeatureScores>(EMPTY_SCORES);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<ScanStage>('calibrating_exposure');
  const [guidance, setGuidance] = useState<GuidanceHint>(null);
  const [limitedEscape, setLimitedEscape] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [completedProfile, setCompletedProfile] = useState<VeinProfile | null>(null);
  const [geometry, setGeometry] = useState<VeinGeometry | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  const cameraRef = useRef<CameraViewHandle>(null);
  const sessionRef = useRef(new AnalysisSession());
  const samplerRef = useRef<FrameSampler | null>(null);
  const analyzingRef = useRef(false);
  const frozenScoresRef = useRef<FeatureScores | null>(null);

  const stopSampling = useCallback(() => {
    samplerRef.current?.stop();
    analyzingRef.current = false;
  }, []);

  useEffect(() => () => stopSampling(), [stopSampling]);

  const beginCamera = () => {
    setError(null);
    setPermissionDenied(false);
    setStillUrl(null);
    setCompletedProfile(null);
    setScores(EMPTY_SCORES);
    setProgress(0);
    setLimitedEscape(false);
    setGeometry(null);
    frozenScoresRef.current = null;
    sessionRef.current.reset();
    setPhase('REQUESTING_PERMISSION');
  };

  const onCameraReady = useCallback(() => {
    setPermissionDenied(false);
    setPhase((p) => {
      // Stay in preview until user taps Start — do not auto-analyze
      if (p === 'REQUESTING_PERMISSION' || p === 'CAMERA_READY' || p === 'PREVIEW') {
        return 'PREVIEW';
      }
      return p;
    });
  }, []);

  const onCameraError = useCallback(
    (message: string) => {
      setError(message);
      const denied = /access is needed|denied|permission/i.test(message);
      setPermissionDenied(denied);
      setPhase('CAMERA_ERROR');
      stopSampling();
    },
    [stopSampling],
  );

  const startAnalysis = useCallback(() => {
    const session = sessionRef.current;
    session.reset();
    session.start();
    analyzingRef.current = true;
    frozenScoresRef.current = null;
    setPhase('ANALYZING');
    setCompletedProfile(null);
    setProgress(0);
    setStage('calibrating_exposure');
    setGeometry(null);

    const sampler = samplerRef.current ?? new FrameSampler({ width: 320, height: 240, fps: 5 });
    samplerRef.current = sampler;

    const source = stillUrl
      ? cameraRef.current?.getStill()
      : cameraRef.current?.getVideo();

    if (!source) {
      setError('No image source available.');
      setPhase('CAMERA_ERROR');
      return;
    }

    const kick = () => {
      sampler.start(source, (frame) => {
        if (!analyzingRef.current) return;
        const result = session.processFrame(frame);
        setScores(result.smoothed);
        setProgress(result.progress);
        setStage(result.stage);
        setGuidance(result.guidance);
        setLimitedEscape(result.limitedEscapeAvailable);
        setGeometry(result.geometry);

        if (result.pausedLowQuality && !result.complete) {
          setPhase('PAUSED_LOW_QUALITY');
        } else if (!result.complete) {
          setPhase('ANALYZING');
        }

        if (result.complete) {
          analyzingRef.current = false;
          sampler.stop();
          const measured = result.smoothed;
          frozenScoresRef.current = measured;

          // Capture compressed still from live video (keep MediaStream alive)
          let captureImage: string | null = null;
          if (!stillUrl) {
            captureImage = cameraRef.current?.captureStill({
              maxEdge: 1280,
              quality: 0.78,
              type: 'image/jpeg',
            }) ?? null;
          } else if (stillUrl) {
            captureImage = stillUrl;
          }

          void nextSubjectLabel().then((label) => {
            const profile = buildProfile({
              featureVector: result.featureVector,
              measured,
              limitedConfidence: session.isLimited(),
              label,
              captureImage,
            });
            setCompletedProfile(profile);
            setScores(measured);
            setProgress(100);
            setStage('analysis_complete');
            setPhase('COMPLETE');
          });
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

  const onStartScanning = () => {
    // MediaStream stays alive — cameraActive remains true across PREVIEW → ANALYZING
    startAnalysis();
  };

  const onFile = (file: File | null) => {
    if (!file) return;
    stopSampling();
    if (stillUrl) URL.revokeObjectURL(stillUrl);
    const url = URL.createObjectURL(file);
    setStillUrl(url);
    setError(null);
    setPermissionDenied(false);
    setCompletedProfile(null);
    sessionRef.current.reset();
    setScores(EMPTY_SCORES);
    setProgress(0);
    setGeometry(null);
    // Photo path: show preview then user starts, or auto-ready for start
    setPhase('PREVIEW');
  };

  const useFixture = () => {
    stopSampling();
    setStillUrl(`${import.meta.env.BASE_URL}fixtures/forearm_reference.png`);
    setError(null);
    setPermissionDenied(false);
    setCompletedProfile(null);
    sessionRef.current.reset();
    setScores(EMPTY_SCORES);
    setProgress(0);
    setGeometry(null);
    setPhase('PREVIEW');
  };

  const continueLimited = () => {
    sessionRef.current.continueWithLimited();
    setPhase('ANALYZING');
  };

  const isAnalyzing =
    phase === 'ANALYZING' || phase === 'PAUSED_LOW_QUALITY';

  const showMetrics = isAnalyzing || phase === 'COMPLETE';

  const showOverlay = isAnalyzing || phase === 'COMPLETE';

  // Keep camera active from permission through complete — never stop on Start
  const cameraActive =
    (phase === 'REQUESTING_PERMISSION' ||
      phase === 'CAMERA_READY' ||
      phase === 'PREVIEW' ||
      phase === 'ACQUIRING' ||
      phase === 'ANALYZING' ||
      phase === 'PAUSED_LOW_QUALITY' ||
      phase === 'COMPLETE') &&
    !stillUrl;

  const showPreviewChrome =
    phase === 'PREVIEW' ||
    phase === 'REQUESTING_PERMISSION' ||
    (phase === 'CAMERA_ERROR' && !permissionDenied);

  return (
    <div className="scanner">
      <CameraView
        ref={cameraRef}
        active={cameraActive || phase === 'CAMERA_ERROR'}
        stillUrl={stillUrl}
        onReady={onCameraReady}
        onError={onCameraError}
      />

      {showOverlay && (
        <VeinOverlay
          geometry={geometry}
          stage={stage}
          analyzing={isAnalyzing}
          complete={phase === 'COMPLETE'}
        />
      )}

      <div className="scanner-gradient-top" />
      <div className="scanner-gradient-bottom" />

      <div className="scanner-ui">
        <header className="scanner-top">
          <div className="brand">
            {isAnalyzing ? 'ANALYZING' : 'VEIN'}
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

        {phase === 'CAMERA_ERROR' && (
          <div className="scanner-center">
            <p className="error-msg">{error}</p>
            <button type="button" className="begin-btn" onClick={beginCamera}>
              {permissionDenied ? 'Enable camera' : 'Try again'}
            </button>
            <div className="fallback-row">
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
          </div>
        )}

        {showPreviewChrome && phase !== 'CAMERA_ERROR' && (
          <div className="scanner-center">
            <p className="intro-title">Find a visible vein.</p>
            {phase === 'REQUESTING_PERMISSION' && !stillUrl && (
              <p className="intro-sub">Requesting camera…</p>
            )}
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

        {limitedEscape && phase !== 'COMPLETE' && isAnalyzing && (
          <div
            className="complete-cta-wrap"
            style={{ bottom: 'calc(var(--safe-bottom) + 120px)' }}
          >
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

        {showPreviewChrome && phase !== 'CAMERA_ERROR' && (
          <div className="preview-cta-wrap">
            {(phase === 'PREVIEW' || stillUrl) && (
              <button type="button" className="start-scan-btn" onClick={onStartScanning}>
                Start scanning
              </button>
            )}
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
          </div>
        )}

        <footer className="scanner-bottom">
          {(isAnalyzing || phase === 'COMPLETE') && (
            <ScanProgress
              progress={progress}
              stage={stage}
              guidance={guidance}
              analyzing={isAnalyzing}
              complete={phase === 'COMPLETE'}
            />
          )}
          {phase === 'PREVIEW' && !stillUrl && (
            <div className="progress-block preview-hint-block">
              <div className="progress-hint">Natural light works best</div>
            </div>
          )}
          {(isAnalyzing || phase === 'COMPLETE' || phase === 'PREVIEW') && (
            <button
              type="button"
              className="info-btn"
              aria-label="About measurements"
              onClick={() => setShowInfo((v) => !v)}
            >
              <Info size={16} strokeWidth={1.5} />
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
