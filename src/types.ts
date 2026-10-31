export type AppPhase =
  | 'INTRO'
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
  | 'balancing_exposure'
  | 'assessing_visibility'
  | 'mapping_patterns'
  | 'reading_colour'
  | 'checking_consistency'
  | 'building_profile';

export interface RawMetrics {
  meanLuminance: number;
  luminanceSpread: number;
  localContrast: number;
  lineStructure: number;
  chromaticWarmth: number;
  chromaticStrength: number;
  edgeEnergy: number;
  exposureOk: boolean;
  underExposed: boolean;
  overExposed: boolean;
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

export type ToneLabel = 'cool' | 'neutral' | 'warm';

export interface VeinProfile {
  id: string;
  createdAt: string;
  label: string;
  featureVector: FeatureVector;
  quality: number;
  classCode: string;
  scores: ProfileScores;
  toneLabel: ToneLabel;
  verdict: string;
  descriptor: string;
  why: string;
  recommendations: string[];
  palateNotes: Record<string, string>;
  limitedConfidence: boolean;
  schemaVersion: number;
  measured: FeatureScores;
}

export type GuidanceHint =
  | 'hold_steady'
  | 'better_light'
  | 'find_vein'
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
