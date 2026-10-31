import type {
  FeatureScores,
  FeatureVector,
  ProfileScores,
  ToneLabel,
  VeinProfile,
} from '../types';

const SCHEMA_VERSION = 1;

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Quantize to nearest 5. */
export function roundTo5(n: number): number {
  return Math.round(n / 5) * 5;
}

function toneLabel(warmth: number, C: number): ToneLabel {
  // Prefer chromatic warmth; fall back to C bands per spec
  if (C < 0.35) return warmth < 0.45 ? 'cool' : 'neutral';
  if (C < 0.65) return warmth < 0.4 ? 'cool' : warmth > 0.6 ? 'warm' : 'neutral';
  return warmth > 0.55 ? 'warm' : 'neutral';
}

/** Deterministic V·01–V·08 from [V,P,C]. */
export function classFromFeatures(V: number, P: number, C: number): string {
  const vB = Math.min(1, Math.floor(V * 2));
  const pB = Math.min(1, Math.floor(P * 2));
  const cB = Math.min(1, Math.floor(C * 2));
  const index = vB * 4 + pB * 2 + cB; // 0..7
  return `V·0${index + 1}`;
}

function scoresFromVector(fv: FeatureVector): ProfileScores {
  const { V, P, C, S, Q } = fv;
  const desirability = roundTo5(100 * clamp(0.34 * V + 0.22 * P + 0.16 * C + 0.18 * S + 0.1 * Q));
  const richness = roundTo5(100 * clamp(0.5 * V + 0.3 * C + 0.2 * P));
  const rarity = roundTo5(100 * clamp(0.65 * P + 0.2 * C + 0.15 * V));
  const elegance = roundTo5(100 * clamp(0.5 * S + 0.3 * V + 0.2 * P));
  const clarity = roundTo5(100 * clamp(0.55 * V + 0.45 * Q));
  const complexity = roundTo5(100 * clamp(0.7 * P + 0.3 * V));
  const tone = roundTo5(100 * clamp(C));
  const consistency = roundTo5(100 * clamp(S));
  const nocturnal = roundTo5(100 * clamp(0.4 * elegance / 100 + 0.35 * richness / 100 + 0.25 * S));
  const aftertaste = roundTo5(100 * clamp(0.45 * richness / 100 + 0.35 * P + 0.2 * C));
  const finish = roundTo5(100 * clamp(0.5 * S + 0.3 * V + 0.2 * C));
  const temperament = roundTo5(100 * clamp(0.4 * elegance / 100 + 0.35 * S + 0.25 * (1 - Math.abs(C - 0.5) * 2)));
  const occasion = roundTo5(100 * clamp(0.45 * desirability / 100 + 0.3 * rarity / 100 + 0.25 * elegance / 100));

  return {
    desirability,
    richness,
    rarity,
    elegance,
    clarity,
    complexity,
    tone,
    consistency,
    nocturnal,
    aftertaste,
    finish,
    temperament,
    occasion,
  };
}

function verdictText(desirability: number, rarity: number): { verdict: string; descriptor: string } {
  let verdict: string;
  if (desirability >= 85) verdict = 'A remarkably refined selection.';
  else if (desirability >= 65) verdict = 'Balanced and easy to appreciate.';
  else verdict = 'An acquired taste, with character.';

  let descriptor: string;
  if (rarity >= 80) descriptor = 'Distinctive structure. Worth remembering.';
  else if (rarity >= 50) descriptor = 'A familiar profile with subtle variation.';
  else descriptor = 'An understated, classic profile.';

  return { verdict, descriptor };
}

function recommendationsFrom(scores: ProfileScores, fv: FeatureVector): string[] {
  const out: string[] = [];

  if (fv.S >= 0.75) out.push('Ideal for unhurried evenings.');
  else out.push('Best approached with patience.');

  if (scores.richness >= 80) out.push('Full-bodied with a lasting finish.');
  else out.push('Light, restrained, quietly elegant.');

  if (scores.desirability >= 80) out.push('An excellent choice for unhurried evenings.');
  else if (scores.desirability >= 60) out.push('Suitable for formal dining.');
  else out.push('Better suited to casual feeding.');

  if (scores.rarity >= 70) out.push('A patient acquisition is advised.');
  else if (scores.consistency < 55) out.push('Allow the selection to settle.');
  else out.push('Best after dusk.');

  // Deduplicate while preserving order; keep 3
  const unique = [...new Set(out)];
  return unique.slice(0, 3);
}

function whyText(measured: FeatureScores, scores: ProfileScores, tone: ToneLabel): string {
  const vis = measured.veinVisibility;
  const pat = measured.patternDetail;
  return (
    `Visual contrast places vein visibility near ${vis} with pattern detail around ${pat}. ` +
    `Interpreted as a ${tone} palate with desirability ${scores.desirability}/100 — a fictional reading from visible image characteristics, not a medical assessment.`
  );
}

function palateNotes(scores: ProfileScores, tone: ToneLabel): Record<string, string> {
  return {
    Richness: `${scores.richness} — derived from visibility and colour signature strength.`,
    Aftertaste: `${scores.aftertaste} — from pattern persistence and chromatic reading.`,
    Rarity: `${scores.rarity} — weighted toward local pattern complexity.`,
    Finish: `${scores.finish} — consistency and visibility combined.`,
    Temperament: `${scores.temperament} — balance of elegance and frame steadiness.`,
    Occasion: `${scores.occasion} — composite of desirability, rarity, and elegance.`,
    Tone: `${tone} — normalized channel ratios after luminance compensation (not blood chemistry).`,
  };
}

export function buildProfile(opts: {
  featureVector: FeatureVector;
  measured: FeatureScores;
  limitedConfidence?: boolean;
  label?: string;
  id?: string;
  createdAt?: string;
}): VeinProfile {
  const fv = opts.featureVector;
  const scores = scoresFromVector(fv);
  const tone = toneLabel(fv.chromaticWarmth, fv.C);
  const classCode = classFromFeatures(fv.V, fv.P, fv.C);
  const { verdict, descriptor } = verdictText(scores.desirability, scores.rarity);
  const recommendations = recommendationsFrom(scores, fv);
  const measured = { ...opts.measured };

  return {
    id: opts.id ?? `vp_${Date.now().toString(36)}_${Math.floor(fv.V * 1000)}`,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    label: opts.label ?? 'Subject 01',
    featureVector: { ...fv },
    quality: measured.imageConfidence,
    classCode,
    scores,
    toneLabel: tone,
    verdict,
    descriptor,
    why: whyText(measured, scores, tone),
    recommendations,
    palateNotes: palateNotes(scores, tone),
    limitedConfidence: Boolean(opts.limitedConfidence),
    schemaVersion: SCHEMA_VERSION,
    measured,
  };
}

/** Deterministic profile from a feature vector alone (for fixture equality tests). */
export function profileFromFeatures(
  fv: FeatureVector,
  measured?: FeatureScores,
): VeinProfile {
  const m: FeatureScores = measured ?? {
    veinVisibility: roundTo5(fv.V * 100),
    patternDetail: roundTo5(fv.P * 100),
    colourSignature: roundTo5(fv.C * 100),
    frameStability: roundTo5(fv.S * 100),
    imageConfidence: roundTo5(fv.Q * 100),
  };
  return buildProfile({
    featureVector: fv,
    measured: m,
    id: 'fixture',
    createdAt: '2026-10-31T00:00:00.000Z',
    label: 'Fixture',
  });
}
