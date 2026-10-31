import type {
  FeatureScores,
  FeatureVector,
  GuidanceHint,
  RawMetrics,
  ScanStage,
  TargetSuitability,
  VeinGeometry,
} from '../types';
import {
  computeRawMetrics,
  extractGrayscaleRoi,
  frameDifference,
  metricsToDisplayScores,
} from './metrics';
import type { SampledFrame } from './frameSampler';

const EMA_PREV = 0.75;
const EMA_CUR = 0.25;
const WINDOW = 12;
const LIMITED_MS = 28_000;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

function ema(prev: number, cur: number): number {
  return EMA_PREV * prev + EMA_CUR * cur;
}

export interface AnalysisResult {
  smoothed: FeatureScores;
  featureVector: FeatureVector;
  stage: ScanStage;
  progress: number;
  guidance: GuidanceHint;
  complete: boolean;
  limitedEscapeAvailable: boolean;
  elapsedMs: number;
  validSampleCount: number;
  pausedLowQuality: boolean;
  targetSuitability: TargetSuitability;
  geometry: VeinGeometry;
  /** Progress is frozen while target is unsuitable. */
  progressPaused: boolean;
}

interface StageGate {
  id: ScanStage;
  weight: number;
  met: boolean;
}

export class AnalysisSession {
  private startedAt = 0;
  private prevGray: Float32Array | null = null;
  private smoothed: FeatureScores = {
    veinVisibility: 0,
    patternDetail: 0,
    colourSignature: 0,
    frameStability: 50,
    imageConfidence: 0,
  };
  private initialized = false;
  private window: FeatureScores[] = [];
  private stabilitySamples: number[] = [];
  private warmthSamples: number[] = [];
  private validCount = 0;
  private exposureOkCount = 0;
  private structureOkCount = 0;
  private patternStableCount = 0;
  private colourStableCount = 0;
  private consistencyOkCount = 0;
  private gates: StageGate[] = [
    { id: 'calibrating_exposure', weight: 12, met: false },
    { id: 'identifying_structures', weight: 20, met: false },
    { id: 'mapping_patterns', weight: 20, met: false },
    { id: 'sampling_colour', weight: 16, met: false },
    { id: 'verifying_consistency', weight: 18, met: false },
    { id: 'analysis_complete', weight: 14, met: false },
  ];
  private forceLimited = false;
  private finalized: FeatureVector | null = null;
  private geometryStableFrames = 0;

  start(): void {
    this.startedAt = performance.now();
  }

  reset(): void {
    this.startedAt = 0;
    this.prevGray = null;
    this.smoothed = {
      veinVisibility: 0,
      patternDetail: 0,
      colourSignature: 0,
      frameStability: 50,
      imageConfidence: 0,
    };
    this.initialized = false;
    this.window = [];
    this.stabilitySamples = [];
    this.warmthSamples = [];
    this.validCount = 0;
    this.exposureOkCount = 0;
    this.structureOkCount = 0;
    this.patternStableCount = 0;
    this.colourStableCount = 0;
    this.consistencyOkCount = 0;
    this.gates.forEach((g) => {
      g.met = false;
    });
    this.forceLimited = false;
    this.finalized = null;
    this.geometryStableFrames = 0;
  }

  continueWithLimited(): void {
    this.forceLimited = true;
  }

  processFrame(frame: SampledFrame): AnalysisResult {
    if (!this.startedAt) this.startedAt = frame.timestamp;
    const elapsedMs = frame.timestamp - this.startedAt;

    const raw = computeRawMetrics(frame.data, frame.width, frame.height);
    const { gray } = extractGrayscaleRoi(frame.data, frame.width, frame.height, 0.6);

    let motion = 0.15;
    if (this.prevGray && this.prevGray.length === gray.length) {
      motion = frameDifference(this.prevGray, gray);
    }
    this.prevGray = gray;

    const stabilityInstant = Math.max(0, Math.min(1, 1 - motion / 0.08));
    this.stabilitySamples.push(stabilityInstant);
    if (this.stabilitySamples.length > WINDOW) this.stabilitySamples.shift();
    const stability =
      this.stabilitySamples.reduce((a, b) => a + b, 0) / this.stabilitySamples.length;

    const display = metricsToDisplayScores(raw, stability);
    this.warmthSamples.push(raw.chromaticWarmth);
    if (this.warmthSamples.length > WINDOW) this.warmthSamples.shift();

    if (!this.initialized) {
      this.smoothed = { ...display };
      this.initialized = true;
    } else {
      this.smoothed = {
        veinVisibility: ema(this.smoothed.veinVisibility, display.veinVisibility),
        patternDetail: ema(this.smoothed.patternDetail, display.patternDetail),
        colourSignature: ema(this.smoothed.colourSignature, display.colourSignature),
        frameStability: ema(this.smoothed.frameStability, display.frameStability),
        imageConfidence: ema(this.smoothed.imageConfidence, display.imageConfidence),
      };
    }

    const rounded: FeatureScores = {
      veinVisibility: Math.round(this.smoothed.veinVisibility),
      patternDetail: Math.round(this.smoothed.patternDetail),
      colourSignature: Math.round(this.smoothed.colourSignature),
      frameStability: Math.round(this.smoothed.frameStability),
      imageConfidence: Math.round(this.smoothed.imageConfidence),
    };

    // Track consecutive frames with real structure (not just edges)
    if (
      raw.targetSuitability.suitable &&
      raw.geometry.points.length >= 4 &&
      raw.lineStructure >= 0.14
    ) {
      this.geometryStableFrames += 1;
    } else {
      this.geometryStableFrames = Math.max(0, this.geometryStableFrames - 1);
    }

    const qualityOk = this.frameQualityOk(raw, stability);
    const progressPaused = !raw.targetSuitability.suitable;

    if (qualityOk && raw.targetSuitability.suitable) {
      this.validCount += 1;
      this.window.push({ ...rounded });
      if (this.window.length > WINDOW) this.window.shift();
      this.updateGates(raw, stability, rounded);
    }

    const guidance = this.computeGuidance(raw, stability, qualityOk);
    const pausedLowQuality =
      (!qualityOk || progressPaused) && this.validCount < 3 && elapsedMs > 1500;
    const limitedEscapeAvailable = elapsedMs >= LIMITED_MS && !this.allGatesMet();

    let complete = false;
    // Never auto-complete confidently without structure — limited escape is explicit
    if (this.forceLimited) {
      this.gates[5].met = true;
      this.finalized = this.buildFeatureVector();
      complete = true;
    } else if (this.allGatesMet()) {
      this.gates[5].met = true;
      this.finalized = this.buildFeatureVector();
      complete = true;
    }

    const progress = complete
      ? 100
      : progressPaused
        ? this.computeProgress() // freeze at current (no bonus while paused)
        : this.computeProgress();

    return {
      smoothed: rounded,
      featureVector: this.finalized ?? this.buildFeatureVector(),
      stage: complete ? 'analysis_complete' : this.currentStage(),
      progress,
      guidance,
      complete,
      limitedEscapeAvailable,
      elapsedMs,
      validSampleCount: this.validCount,
      pausedLowQuality,
      targetSuitability: raw.targetSuitability,
      geometry: raw.geometry,
      progressPaused,
    };
  }

  /** Process a still image repeatedly until complete (fixture path). */
  processStillToCompletion(frame: SampledFrame, maxFrames = 40): AnalysisResult {
    this.reset();
    this.start();
    let result: AnalysisResult | null = null;
    for (let i = 0; i < maxFrames; i++) {
      const f = { ...frame, timestamp: performance.now() + i * 200 };
      result = this.processFrame(f);
      if (result.complete) break;
    }
    if (!result?.complete) {
      this.continueWithLimited();
      result = this.processFrame({
        ...frame,
        timestamp: performance.now() + maxFrames * 200,
      });
    }
    return result!;
  }

  getFinalFeatureVector(): FeatureVector | null {
    return this.finalized;
  }

  isLimited(): boolean {
    return this.forceLimited;
  }

  private frameQualityOk(raw: RawMetrics, stability: number): boolean {
    if (raw.underExposed || raw.overExposed) return false;
    if (stability < 0.35) return false;
    if (raw.luminanceSpread < 4 && raw.localContrast < 0.05) return false;
    return true;
  }

  private updateGates(raw: RawMetrics, stability: number, scores: FeatureScores): void {
    if (raw.exposureOk) this.exposureOkCount += 1;
    if (raw.exposureOk && this.exposureOkCount >= 3) this.gates[0].met = true;

    // Identifying visible structures — requires real lineStructure, not contrast alone
    if (
      this.gates[0].met &&
      raw.lineStructure >= 0.14 &&
      scores.veinVisibility >= 32 &&
      raw.geometry.points.length >= 3
    ) {
      this.structureOkCount += 1;
      if (this.structureOkCount >= 5) this.gates[1].met = true;
    }

    if (
      this.gates[1].met &&
      scores.patternDetail >= 26 &&
      raw.lineStructure >= 0.16 &&
      this.geometryStableFrames >= 3
    ) {
      this.patternStableCount += 1;
      if (this.patternStableCount >= 5) this.gates[2].met = true;
    }

    if (this.gates[2].met && scores.colourSignature >= 18) {
      this.colourStableCount += 1;
      if (this.colourStableCount >= 4) this.gates[3].met = true;
    }

    if (this.gates[3].met && stability >= 0.55 && this.window.length >= 8) {
      this.consistencyOkCount += 1;
      if (this.consistencyOkCount >= 5) this.gates[4].met = true;
    }
  }

  private allGatesMet(): boolean {
    return this.gates.slice(0, 5).every((g) => g.met) && this.validCount >= 12;
  }

  private currentStage(): ScanStage {
    for (const g of this.gates) {
      if (!g.met) return g.id;
    }
    return 'analysis_complete';
  }

  private computeProgress(): number {
    let done = 0;
    let total = 0;
    for (const g of this.gates) {
      total += g.weight;
      if (g.met) done += g.weight;
    }
    const sampleBonus = Math.min(8, this.validCount * 0.5);
    const pct = Math.round(((done + sampleBonus) / total) * 100);
    return clamp(pct, 0, 99);
  }

  private computeGuidance(
    raw: RawMetrics,
    stability: number,
    qualityOk: boolean,
  ): GuidanceHint {
    if (raw.underExposed) return 'too_dark';
    if (raw.overExposed) return 'too_bright';
    if (stability < 0.4) return 'hold_steady';
    if (!raw.exposureOk) return 'even_light';

    const suit = raw.targetSuitability;
    if (!suit.suitable) {
      if (suit.lineStructure < 0.12) return 'move_closer';
      if (suit.exposure < 0.45) return 'even_light';
      if (stability < 0.5) return 'hold_steady';
      return 'move_closer';
    }

    if (qualityOk && this.smoothed.veinVisibility < 24) return 'find_vein';
    if (!qualityOk) return 'even_light';
    return null;
  }

  private buildFeatureVector(): FeatureVector {
    const avg = this.averageWindow();
    const warmth =
      this.warmthSamples.reduce((a, b) => a + b, 0) /
      Math.max(1, this.warmthSamples.length);

    return {
      V: clamp(avg.veinVisibility, 0, 100) / 100,
      P: clamp(avg.patternDetail, 0, 100) / 100,
      C: clamp(avg.colourSignature, 0, 100) / 100,
      S: clamp(avg.frameStability, 0, 100) / 100,
      Q: clamp(avg.imageConfidence, 0, 100) / 100,
      chromaticWarmth: warmth,
    };
  }

  private averageWindow(): FeatureScores {
    if (this.window.length === 0) return { ...this.smoothed };
    const acc: FeatureScores = {
      veinVisibility: 0,
      patternDetail: 0,
      colourSignature: 0,
      frameStability: 0,
      imageConfidence: 0,
    };
    for (const s of this.window) {
      acc.veinVisibility += s.veinVisibility;
      acc.patternDetail += s.patternDetail;
      acc.colourSignature += s.colourSignature;
      acc.frameStability += s.frameStability;
      acc.imageConfidence += s.imageConfidence;
    }
    const n = this.window.length;
    return {
      veinVisibility: acc.veinVisibility / n,
      patternDetail: acc.patternDetail / n,
      colourSignature: acc.colourSignature / n,
      frameStability: acc.frameStability / n,
      imageConfidence: acc.imageConfidence / n,
    };
  }
}

export const STAGE_LABELS: Record<ScanStage, string> = {
  calibrating_exposure: 'Calibrating exposure',
  identifying_structures: 'Identifying visible structures',
  mapping_patterns: 'Mapping local patterns',
  sampling_colour: 'Sampling colour characteristics',
  verifying_consistency: 'Verifying consistency',
  analysis_complete: 'Analysis complete',
};

export const GUIDANCE_LABELS: Record<Exclude<GuidanceHint, null>, string> = {
  hold_steady: 'Hold steady in even light',
  better_light: 'Move into better light',
  find_vein: 'Find a visible vein',
  move_closer: 'Move closer to a visible vein',
  even_light: 'Hold steady in even light',
  too_dark: 'Too dark — find better light',
  too_bright: 'Too bright — soften the light',
};
