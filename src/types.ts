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

export interface TargetSuitability {
  exposure: number;
  chromaVariance: number;
  localContrast: number;
  lineStructure: number;
  score: number;
  suitable: boolean;
}

export interface VeinPoint {
  x: number;
  y: number;
  strength: number;
}

export interface VeinSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  strength: number;
}

export interface VeinGeometry {
  points: VeinPoint[];
  segments: VeinSegment[];
  sampleWidth: number;
  sampleHeight: number;
  roiX: number;
  roiY: number;
  roiW: number;
  roiH: number;
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
