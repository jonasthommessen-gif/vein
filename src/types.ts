export type AppPhase =
  | 'PREVIEW'
  | 'REQUESTING_PERMISSION'
  | 'CAMERA_READY'
  | 'CAMERA_ERROR'
  | 'ACQUIRING'
  | 'ANALYZING'
  | 'PAUSED_LOW_QUALITY'
  | 'COMPLETE'
  | 'PROFILE'
  | 'DETAILS'
  | 'LIBRARY';

export type ScanStage =
  | 'calibrating_exposure'
  | 'identifying_structures'
  | 'mapping_patterns'
  | 'sampling_colour'
  | 'verifying_consistency'
  | 'analysis_complete';

/** Visual computation phases driving overlay systems (mapped from ScanStage). */
export type ComputationPhase =
  | 'acquisition'
  | 'extraction'
  | 'analysis'
  | 'verification'
  | 'completion';

export interface TargetSuitability {
  exposure: number;
  chromaVariance: number;
  localContrast: number;
  lineStructure: number;
  /** 0–1: share of geometry that is organic/clustered vs axis-aligned silhouettes. */
  organicScore: number;
  /** 0–1: penalty for screen/edge-like regularity. */
  edgeRegularity: number;
  score: number;
  suitable: boolean;
}

export interface VeinPoint {
  x: number;
  y: number;
  strength: number;
  /** Ridge tangent angle in radians (sample space). */
  orientation: number;
  /** Local dark-ridge contrast 0–1. */
  localContrast: number;
  /** True when multi-frame evidence accepted this feature. */
  accepted: boolean;
}

export interface VeinSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  strength: number;
  /** Euclidean length in sample pixels. */
  length: number;
  /** Relative stroke weight 0–1 (trunk vs branch). */
  weight: number;
}

/** Ordered ridge centreline — may branch via shared endpoints / junctions. */
export interface VeinPolyline {
  /** Sample-space vertices along the ridge. */
  points: Array<{ x: number; y: number }>;
  strength: number;
  /** Relative stroke weight 0–1 (thicker trunk / thinner branch). */
  weight: number;
  /** Fade 0–1 for unstable / low-evidence paths. */
  stability: number;
}

export interface VeinJunction {
  x: number;
  y: number;
  strength: number;
  /** Number of incident ridge branches (3+ = true junction). */
  degree: number;
}

export interface VeinGeometry {
  points: VeinPoint[];
  segments: VeinSegment[];
  /** Branching ridge polylines following vein centrelines (preferred for draw). */
  polylines: VeinPolyline[];
  /** White junction nodes where ridges meet / branch. */
  junctions: VeinJunction[];
  sampleWidth: number;
  sampleHeight: number;
  roiX: number;
  roiY: number;
  roiW: number;
  roiH: number;
  /** Compact feature signature derived from accepted geometry. */
  signature: string;
}

export interface ComputationSample {
  x: number;
  y: number;
  /** Short numeric label from real local measurement. */
  label: string;
  /** Remaining life 0–1 for ephemeral markers. */
  life: number;
}

/** Measured computation state for overlay math viz (separate from rendering). */
export interface ComputationViz {
  phase: ComputationPhase;
  luminanceHist: number[];
  stabilityHistory: number[];
  density: number;
  contrast: number;
  confidence: number;
  samples: ComputationSample[];
  signature: string;
  validAnalysisMs: number;
  evidenceSettled: FeatureSettleFlags;
}

export interface FeatureSettleFlags {
  veinVisibility: boolean;
  patternDetail: boolean;
  colourSignature: boolean;
  frameStability: boolean;
  imageConfidence: boolean;
}

export interface RawMetrics {
  meanLuminance: number;
  luminanceSpread: number;
  localContrast: number;
  lineStructure: number;
  chromaVariance: number;
  chromaticWarmth: number;
  chromaticStrength: number;
  edgeEnergy: number;
  organicScore: number;
  edgeRegularity: number;
  luminanceHist: number[];
  exposureOk: boolean;
  underExposed: boolean;
  overExposed: boolean;
  targetSuitability: TargetSuitability;
  geometry: VeinGeometry;
}

export interface FeatureScores {
  veinVisibility: number;
  patternDetail: number;
  colourSignature: number;
  frameStability: number;
  imageConfidence: number;
}

export interface FeatureVector {
  V: number;
  P: number;
  C: number;
  S: number;
  Q: number;
  chromaticWarmth: number;
}

export interface ProfileScores {
  desirability: number;
  richness: number;
  rarity: number;
  elegance: number;
  clarity: number;
  complexity: number;
  tone: number;
  consistency: number;
  nocturnal: number;
  aftertaste: number;
  finish: number;
  temperament: number;
  occasion: number;
}

/** Six-axis radar — never medical biomarkers. */
export interface RadarValues {
  clarity: number;
  complexity: number;
  tonalRichness: number;
  consistency: number;
  rarity: number;
  nocturnal: number;
}

export type ToneLabel = 'cool' | 'neutral' | 'warm';

export interface VeinProfile {
  id: string;
  createdAt: string;
  label: string;
  featureVector: FeatureVector;
  quality: number;
  classCode: string;
  scores: ProfileScores;
  radar: RadarValues;
  toneLabel: ToneLabel;
  verdict: string;
  descriptor: string;
  assessment: string;
  tastingNotes: string[];
  why: string;
  recommendations: string[];
  palateNotes: Record<string, string>;
  limitedConfidence: boolean;
  schemaVersion: number;
  measured: FeatureScores;
  /** Compressed JPEG/WebP data URL of the capture still. */
  captureImage?: string | null;
}

export type GuidanceHint =
  | 'hold_steady'
  | 'better_light'
  | 'find_vein'
  | 'move_closer'
  | 'even_light'
  | 'too_dark'
  | 'too_bright'
  | null;

export interface SessionSnapshot {
  phase: AppPhase;
  stage: ScanStage;
  progress: number;
  smoothed: FeatureScores;
  guidance: GuidanceHint;
  limitedEscapeAvailable: boolean;
  elapsedMs: number;
  validSampleCount: number;
}
