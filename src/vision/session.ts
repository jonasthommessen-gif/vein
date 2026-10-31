import type {
  ComputationPhase,
  ComputationSample,
  ComputationViz,
  FeatureScores,
  FeatureSettleFlags,
  FeatureVector,
  GuidanceHint,
  RawMetrics,
  ScanStage,
  TargetSuitability,
  VeinGeometry,
  VeinPoint,
} from '../types';
import {
  computeRawMetrics,
  extractGrayscaleRoi,
  frameDifference,
  metricsToDisplayScores,
} from './metrics';
import type { SampledFrame } from './frameSampler';

const WINDOW = 12;
const LIMITED_MS = 32_000;
/** Minimum usable analysis time before confident completion. */
const MIN_VALID_MS = 7_000;
/** Ideal accumulation window for multi-frame evidence. */
const IDEAL_VALID_MS = 9_000;
/** Soft ceiling — once gates + this much valid time, never block. */
const MAX_VALID_MS = 10_000;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Adaptive EMA: early frames track live signal; settled params dampen. */
function emaAdaptive(prev: number, cur: number, settled: boolean, evidence: number): number {
  const base = settled ? 0.12 : evidence > 8 ? 0.22 : 0.38;
  return (1 - base) * prev + base * cur;
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
  validAnalysisMs: number;
  pausedLowQuality: boolean;
  targetSuitability: TargetSuitability;
  geometry: VeinGeometry;
  computation: ComputationViz;
  /** Progress is frozen while target is unsuitable. */
  progressPaused: boolean;
}

interface StageGate {
  id: ScanStage;
  weight: number;
  met: boolean;
}

function stageToPhase(stage: ScanStage, complete: boolean): ComputationPhase {
  if (complete) return 'completion';
  switch (stage) {
    case 'calibrating_exposure':
      return 'acquisition';
    case 'identifying_structures':
      return 'extraction';
    case 'mapping_patterns':
    case 'sampling_colour':
      return 'analysis';
    case 'verifying_consistency':
      return 'verification';
    case 'analysis_complete':
      return 'completion';
    default:
      return 'acquisition';
  }
}

export class AnalysisSession {
  private startedAt = 0;
  private lastFrameTs = 0;
  private validAnalysisMs = 0;
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
    { id: 'identifying_structures', weight: 18, met: false },
    { id: 'mapping_patterns', weight: 18, met: false },
    { id: 'sampling_colour', weight: 14, met: false },
    { id: 'verifying_consistency', weight: 20, met: false },
    { id: 'analysis_complete', weight: 18, met: false },
  ];
  private forceLimited = false;
  private finalized: FeatureVector | null = null;
  private geometryStableFrames = 0;
  private evidenceCounts: FeatureScores = {
    veinVisibility: 0,
    patternDetail: 0,
    colourSignature: 0,
    frameStability: 0,
    imageConfidence: 0,
  };
  private settleFlags: FeatureSettleFlags = {
    veinVisibility: false,
    patternDetail: false,
    colourSignature: false,
    frameStability: false,
    imageConfidence: false,
  };
  private acceptedPoints = new Map<string, { hits: number; point: VeinPoint }>();
  private ephemeralSamples: ComputationSample[] = [];
  private lastHist: number[] = new Array(12).fill(0);
  private frozenGeometry: VeinGeometry | null = null;

  start(): void {
    this.startedAt = performance.now();
    this.lastFrameTs = 0;
  }

  reset(): void {
    this.startedAt = 0;
    this.lastFrameTs = 0;
    this.validAnalysisMs = 0;
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
    this.evidenceCounts = {
      veinVisibility: 0,
      patternDetail: 0,
      colourSignature: 0,
      frameStability: 0,
      imageConfidence: 0,
    };
    this.settleFlags = {
      veinVisibility: false,
      patternDetail: false,
      colourSignature: false,
      frameStability: false,
      imageConfidence: false,
    };
    this.acceptedPoints.clear();
    this.ephemeralSamples = [];
    this.lastHist = new Array(12).fill(0);
    this.frozenGeometry = null;
  }

  continueWithLimited(): void {
    this.forceLimited = true;
  }

  processFrame(frame: SampledFrame): AnalysisResult {
    if (!this.startedAt) this.startedAt = frame.timestamp;
    const elapsedMs = frame.timestamp - this.startedAt;
    const dt =
      this.lastFrameTs > 0
        ? Math.min(450, Math.max(0, frame.timestamp - this.lastFrameTs))
        : 0;
    this.lastFrameTs = frame.timestamp;

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
    this.lastHist = raw.luminanceHist;

    const qualityOk = this.frameQualityOk(raw, stability);
    const progressPaused = !raw.targetSuitability.suitable;
    const usable = qualityOk && raw.targetSuitability.suitable;

    if (usable && dt > 0) {
      this.validAnalysisMs += dt;
    }

    if (usable) {
      this.bumpEvidence('veinVisibility', display.veinVisibility, 6, 0.08);
      this.bumpEvidence('patternDetail', display.patternDetail, 8, 0.1);
      this.bumpEvidence('colourSignature', display.colourSignature, 10, 0.12);
      this.bumpEvidence('frameStability', display.frameStability, 7, 0.06);
      this.bumpEvidence('imageConfidence', display.imageConfidence, 12, 0.1);
      this.initialized = true;
    } else if (this.initialized) {
      this.smoothed = {
        veinVisibility: emaAdaptive(
          this.smoothed.veinVisibility,
          display.veinVisibility * 0.55,
          false,
          0,
        ),
        patternDetail: emaAdaptive(
          this.smoothed.patternDetail,
          display.patternDetail * 0.55,
          false,
          0,
        ),
        colourSignature: emaAdaptive(
          this.smoothed.colourSignature,
          display.colourSignature * 0.7,
          false,
          0,
        ),
        frameStability: emaAdaptive(
          this.smoothed.frameStability,
          display.frameStability,
          this.settleFlags.frameStability,
          this.evidenceCounts.frameStability,
        ),
        imageConfidence: emaAdaptive(
          this.smoothed.imageConfidence,
          display.imageConfidence * 0.5,
          false,
          0,
        ),
      };
    } else {
      this.smoothed = { ...display };
      this.initialized = true;
    }

    const rounded: FeatureScores = {
      veinVisibility: Math.round(this.smoothed.veinVisibility),
      patternDetail: Math.round(this.smoothed.patternDetail),
      colourSignature: Math.round(this.smoothed.colourSignature),
      frameStability: Math.round(this.smoothed.frameStability),
      imageConfidence: Math.round(this.smoothed.imageConfidence),
    };

    if (
      usable &&
      raw.geometry.points.length >= 3 &&
      raw.lineStructure >= 0.12 &&
      raw.organicScore >= 0.22
    ) {
      this.geometryStableFrames += 1;
      this.accumulateGeometry(raw.geometry);
    } else {
      this.geometryStableFrames = Math.max(0, this.geometryStableFrames - 1);
    }

    const geometry = this.mergeGeometry(raw.geometry, usable);

    if (usable) {
      this.validCount += 1;
      this.window.push({ ...rounded });
      if (this.window.length > WINDOW) this.window.shift();
      this.updateGates(raw, stability, rounded);
      this.spawnEphemeralSamples(geometry, raw);
    }

    this.tickEphemeral(dt);

    const guidance = this.computeGuidance(raw, stability, qualityOk);
    const pausedLowQuality =
      (!qualityOk || progressPaused) && this.validCount < 3 && elapsedMs > 1500;
    const limitedEscapeAvailable = elapsedMs >= LIMITED_MS && !this.allGatesMet();

    const evidenceReady = this.allGatesMet() && this.validCount >= 14;
    const enoughValidTime = this.validAnalysisMs >= MIN_VALID_MS;
    const softComplete =
      evidenceReady &&
      enoughValidTime &&
      (this.validAnalysisMs >= IDEAL_VALID_MS * 0.85 || this.geometryStableFrames >= 6);

    let complete = false;
    if (this.forceLimited) {
      this.gates[5].met = true;
      this.finalized = this.buildFeatureVector();
      this.frozenGeometry = geometry;
      complete = true;
    } else if (evidenceReady && enoughValidTime && softComplete) {
      this.gates[5].met = true;
      this.finalized = this.buildFeatureVector();
      this.frozenGeometry = geometry;
      complete = true;
    } else if (evidenceReady && this.validAnalysisMs >= MAX_VALID_MS) {
      this.gates[5].met = true;
      this.finalized = this.buildFeatureVector();
      this.frozenGeometry = geometry;
      complete = true;
    }

    const stage = complete ? 'analysis_complete' : this.currentStage();
    const progress = complete ? 100 : this.computeProgress(progressPaused);
    const outGeometry = complete && this.frozenGeometry ? this.frozenGeometry : geometry;
    const computation = this.buildComputation(stage, complete, rounded, raw, outGeometry);

    return {
      smoothed: rounded,
      featureVector: this.finalized ?? this.buildFeatureVector(),
      stage,
      progress,
      guidance,
      complete,
      limitedEscapeAvailable,
      elapsedMs,
      validSampleCount: this.validCount,
      validAnalysisMs: this.validAnalysisMs,
      pausedLowQuality,
      targetSuitability: raw.targetSuitability,
      geometry: outGeometry,
      computation,
      progressPaused,
    };
  }

  /** Process a still image repeatedly until complete (fixture path). */
  processStillToCompletion(frame: SampledFrame, maxFrames = 80): AnalysisResult {
    this.reset();
    this.start();
    let result: AnalysisResult | null = null;
    for (let i = 0; i < maxFrames; i++) {
      const f = { ...frame, timestamp: performance.now() + i * 220 };
      result = this.processFrame(f);
      if (result.complete) break;
    }
    if (!result?.complete) {
      this.continueWithLimited();
      result = this.processFrame({
        ...frame,
        timestamp: performance.now() + maxFrames * 220,
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

  private bumpEvidence(
    key: keyof FeatureScores,
    instant: number,
    settleAfter: number,
    maxDelta: number,
  ): void {
    const prev = this.smoothed[key];
    const delta = Math.abs(instant - prev);
    if (delta < maxDelta * 100 || this.evidenceCounts[key] > 3) {
      this.evidenceCounts[key] += 1;
    } else {
      this.evidenceCounts[key] = Math.max(0, this.evidenceCounts[key] - 0.35);
    }
    if (this.evidenceCounts[key] >= settleAfter && delta < maxDelta * 100) {
      this.settleFlags[key] = true;
    }
    this.smoothed[key] = emaAdaptive(
      prev,
      instant,
      this.settleFlags[key],
      this.evidenceCounts[key],
    );
  }

  private accumulateGeometry(geom: VeinGeometry): void {
    for (const p of geom.points) {
      const qx = Math.round(p.x / 4) * 4;
      const qy = Math.round(p.y / 4) * 4;
      const key = `${qx}:${qy}`;
      const prev = this.acceptedPoints.get(key);
      if (prev) {
        prev.hits += 1;
        prev.point = {
          ...p,
          strength: Math.max(prev.point.strength, p.strength),
          accepted: prev.hits >= 3,
        };
      } else if (this.acceptedPoints.size < 48) {
        this.acceptedPoints.set(key, { hits: 1, point: { ...p, accepted: false } });
      }
    }
    for (const [k, v] of this.acceptedPoints) {
      if (v.hits < 3) {
        v.hits -= 0.15;
        if (v.hits <= 0) this.acceptedPoints.delete(k);
      }
    }
  }

  private mergeGeometry(raw: VeinGeometry, usable: boolean): VeinGeometry {
    if (!usable && this.acceptedPoints.size === 0) {
      return { ...raw, points: [], segments: [] };
    }

    const accepted: VeinPoint[] = [];
    for (const v of this.acceptedPoints.values()) {
      accepted.push({ ...v.point, accepted: v.hits >= 3 });
    }

    const phasePts =
      accepted.length >= 3
        ? accepted
        : raw.points.map((p) => ({ ...p, accepted: false }));

    const segs = raw.segments.filter((s) => s.length <= 10).slice(0, 18);

    return {
      ...raw,
      points: phasePts.slice(0, 32),
      segments: segs,
      signature: raw.signature,
    };
  }

  private spawnEphemeralSamples(geometry: VeinGeometry, raw: RawMetrics): void {
    if (geometry.points.length === 0) return;
    if (this.ephemeralSamples.length > 6) return;
    if (this.validCount % 2 !== 0) return;
    const p = geometry.points[this.validCount % geometry.points.length];
    const contrast = Math.round((p.localContrast ?? raw.localContrast) * 100);
    const grad = Math.round(p.strength * 100);
    this.ephemeralSamples.push({
      x: p.x,
      y: p.y,
      label: `Δ${contrast} ∇${grad}`,
      life: 1,
    });
  }

  private tickEphemeral(dt: number): void {
    const decay = dt > 0 ? dt / 900 : 0.08;
    this.ephemeralSamples = this.ephemeralSamples
      .map((s) => ({ ...s, life: s.life - decay }))
      .filter((s) => s.life > 0);
  }

  private buildComputation(
    stage: ScanStage,
    complete: boolean,
    scores: FeatureScores,
    raw: RawMetrics,
    geometry: VeinGeometry,
  ): ComputationViz {
    const density = clamp01(geometry.points.length / 24);
    return {
      phase: stageToPhase(stage, complete),
      luminanceHist: this.lastHist.length ? this.lastHist : raw.luminanceHist,
      stabilityHistory: [...this.stabilitySamples],
      density,
      contrast: raw.localContrast,
      confidence: scores.imageConfidence / 100,
      samples: this.ephemeralSamples,
      signature: geometry.signature || raw.geometry.signature,
      validAnalysisMs: this.validAnalysisMs,
      evidenceSettled: { ...this.settleFlags },
    };
  }

  private frameQualityOk(raw: RawMetrics, stability: number): boolean {
    if (raw.underExposed || raw.overExposed) return false;
    if (stability < 0.35) return false;
    if (raw.luminanceSpread < 4 && raw.localContrast < 0.05) return false;
    return true;
  }

  private updateGates(raw: RawMetrics, stability: number, scores: FeatureScores): void {
    if (raw.exposureOk) this.exposureOkCount += 1;
    if (raw.exposureOk && this.exposureOkCount >= 4) this.gates[0].met = true;

    if (
      this.gates[0].met &&
      raw.lineStructure >= 0.12 &&
      raw.organicScore >= 0.22 &&
      scores.veinVisibility >= 28 &&
      raw.geometry.points.length >= 3
    ) {
      this.structureOkCount += 1;
      if (this.structureOkCount >= 6) this.gates[1].met = true;
    }

    if (
      this.gates[1].met &&
      scores.patternDetail >= 24 &&
      raw.lineStructure >= 0.14 &&
      raw.organicScore >= 0.24 &&
      this.geometryStableFrames >= 4
    ) {
      this.patternStableCount += 1;
      if (this.patternStableCount >= 6) this.gates[2].met = true;
    }

    if (this.gates[2].met && scores.colourSignature >= 16) {
      this.colourStableCount += 1;
      if (this.colourStableCount >= 5) this.gates[3].met = true;
    }

    if (
      this.gates[3].met &&
      stability >= 0.55 &&
      this.window.length >= 8 &&
      this.validAnalysisMs >= MIN_VALID_MS * 0.55
    ) {
      this.consistencyOkCount += 1;
      if (this.consistencyOkCount >= 6) this.gates[4].met = true;
    }
  }

  private allGatesMet(): boolean {
    return this.gates.slice(0, 5).every((g) => g.met) && this.validCount >= 14;
  }

  private currentStage(): ScanStage {
    for (const g of this.gates) {
      if (!g.met) return g.id;
    }
    return 'analysis_complete';
  }

  /**
   * Nonlinear progress from gates + valid evidence time.
   * Never hits 100 from wall-clock alone; freezes when unsuitable.
   */
  private computeProgress(paused: boolean): number {
    let done = 0;
    let total = 0;
    for (const g of this.gates) {
      total += g.weight;
      if (g.met) done += g.weight;
    }
    const unmet = this.gates.find((g) => !g.met);
    let partial = 0;
    if (unmet) {
      const idx = this.gates.indexOf(unmet);
      const counts = [
        this.exposureOkCount / 4,
        this.structureOkCount / 6,
        this.patternStableCount / 6,
        this.colourStableCount / 5,
        this.consistencyOkCount / 6,
        0,
      ];
      partial = unmet.weight * clamp01(counts[idx] ?? 0) * 0.65;
    }

    const gateFrac = (done + partial) / total;
    const timeFrac = clamp01(this.validAnalysisMs / IDEAL_VALID_MS);
    const easedGate = 1 - (1 - gateFrac) ** 1.35;
    const easedTime = 1 - (1 - timeFrac) ** 1.2;
    const evidenceFrac = clamp01(this.validCount / 28);

    let pct = (easedGate * 0.52 + easedTime * 0.38 + evidenceFrac * 0.1) * 100;

    if (this.validAnalysisMs < MIN_VALID_MS) {
      pct = Math.min(pct, 88 + (this.validAnalysisMs / MIN_VALID_MS) * 6);
    } else if (!this.allGatesMet()) {
      pct = Math.min(pct, 96);
    } else {
      pct = Math.min(pct, 99);
    }

    if (paused) {
      pct = Math.min(pct, 92);
    }

    return clamp(Math.round(pct), 0, 99);
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
      if (suit.edgeRegularity > 0.65 || suit.organicScore < 0.22) return 'move_closer';
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
  calibrating_exposure: 'Acquiring signal',
  identifying_structures: 'Extracting local features',
  mapping_patterns: 'Analyzing structure',
  sampling_colour: 'Sampling tonal field',
  verifying_consistency: 'Verifying evidence',
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
