import type {
  FeatureScores,
  FeatureVector,
  ProfileScores,
  RadarValues,
  ToneLabel,
  VeinProfile,
} from '../types';

const SCHEMA_VERSION = 2;

function clamp(n: number, lo = 0, hi = 1): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Quantize to nearest 5. */
export function roundTo5(n: number): number {
  return Math.round(n / 5) * 5;
}

function toneLabel(warmth: number, C: number): ToneLabel {
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
  const desirability = roundTo5(
    100 * clamp(0.34 * V + 0.22 * P + 0.16 * C + 0.18 * S + 0.1 * Q),
  );
  const richness = roundTo5(100 * clamp(0.5 * V + 0.3 * C + 0.2 * P));
  const rarity = roundTo5(100 * clamp(0.65 * P + 0.2 * C + 0.15 * V));
  const elegance = roundTo5(100 * clamp(0.5 * S + 0.3 * V + 0.2 * P));
  const clarity = roundTo5(100 * clamp(0.55 * V + 0.45 * Q));
  const complexity = roundTo5(100 * clamp(0.7 * P + 0.3 * V));
  const tone = roundTo5(100 * clamp(C));
  const consistency = roundTo5(100 * clamp(S));
  const nocturnal = roundTo5(
    100 * clamp(0.4 * (elegance / 100) + 0.35 * (richness / 100) + 0.25 * S),
  );
  const aftertaste = roundTo5(
    100 * clamp(0.45 * (richness / 100) + 0.35 * P + 0.2 * C),
  );
  const finish = roundTo5(100 * clamp(0.5 * S + 0.3 * V + 0.2 * C));
  const temperament = roundTo5(
    100 *
      clamp(
        0.4 * (elegance / 100) + 0.35 * S + 0.25 * (1 - Math.abs(C - 0.5) * 2),
      ),
  );
  const occasion = roundTo5(
    100 *
      clamp(
        0.45 * (desirability / 100) + 0.3 * (rarity / 100) + 0.25 * (elegance / 100),
      ),
  );

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

/** Radar axes — Clarity, Complexity, Tonal richness, Consistency, Rarity, Nocturnal. */
export function radarFromScores(scores: ProfileScores): RadarValues {
  return {
    clarity: scores.clarity,
    complexity: scores.complexity,
    tonalRichness: scores.tone,
    consistency: scores.consistency,
    rarity: scores.rarity,
    nocturnal: scores.nocturnal,
  };
}

/** Party-funny vampire dining verdict — fictional, never medical. */
function verdictText(
  desirability: number,
  rarity: number,
  consistency: number,
): { verdict: string; descriptor: string } {
  let verdict: string;
  if (desirability >= 85) {
    verdict = 'VIP bottle service energy. This vintage has been… celebrated.';
  } else if (desirability >= 65) {
    verdict = 'Solid party pour — alcohol signature: suspiciously festive.';
  } else if (consistency < 50) {
    verdict = 'Shaken, not stirred. Restless night, questionable decisions.';
  } else {
    verdict = 'An acquired taste — like the third cocktail you didn’t need.';
  }

  let descriptor: string;
  if (rarity >= 80) {
    descriptor = 'Rare enough to brag about. Worth remembering. Barely.';
  } else if (rarity >= 50) {
    descriptor = 'Familiar profile with a hint of last call.';
  } else {
    descriptor = 'House red energy. Reliable. Mildly dangerous after midnight.';
  }

  return { verdict, descriptor };
}

function assessmentText(scores: ProfileScores, tone: ToneLabel, fv: FeatureVector): string {
  if (scores.desirability >= 85 && scores.rarity >= 70) {
    return `Bottle-service ${tone} profile — distinct structure, quiet chaos, exceptional after-party aftertaste.`;
  }
  if (fv.C >= 0.65 && fv.chromaticWarmth > 0.55) {
    return `Warm ${tone} reading with notes of last night’s tequila and questionable optimism.`;
  }
  if (scores.consistency < 50) {
    return `Restless ${tone} character — shaken, not stirred. Pair with bad decisions after midnight.`;
  }
  if (scores.desirability >= 70) {
    return `A composed ${tone} pour with clear structure and a finish that still wants one more round.`;
  }
  if (scores.complexity >= 70) {
    return `Intricate ${tone} character; rewards a patient vampire and a messy guest list.`;
  }
  return `A reserved ${tone} profile — understated, serviceable, still somehow at the party.`;
}

/** Party tasting notes from deterministic score rules. */
function tastingNotesFrom(scores: ProfileScores, fv: FeatureVector, tone: ToneLabel): string[] {
  const notes: string[] = [];

  if (scores.richness >= 80) {
    notes.push('Full-bodied with a lasting finish — like the night itself.');
  } else if (scores.richness >= 55) {
    notes.push('Medium body; clean mid-palate. Hangover pending.');
  } else {
    notes.push('Light, restrained, quietly dangerous.');
  }

  // High warmth / colour → cocktail jokes
  if (fv.C >= 0.6 && fv.chromaticWarmth >= 0.55) {
    notes.push('Notes of last night’s tequila. Alcohol signature: suspiciously festive.');
  } else if (tone === 'warm') {
    notes.push('Soft warmth on the finish — punch-bowl adjacent.');
  } else if (tone === 'cool') {
    notes.push('A cool mineral edge. Best after the ice melts.');
  } else {
    notes.push('Neutral temperament. Low drama until someone suggests shots.');
  }

  if (scores.rarity >= 75) {
    notes.push('An uncommon arrangement. A patient (and festive) acquisition is advised.');
  } else if (scores.consistency < 55) {
    notes.push('Shaken, not stirred. Restless night written all over it.');
  } else if (scores.consistency >= 70) {
    notes.push('Remarkably steady — somehow still standing at last call.');
  } else {
    notes.push('Allow the selection to settle… or don’t. Party rules apply.');
  }

  if (scores.desirability >= 80) {
    notes.push('Pair with bad decisions after midnight. VIP bottle service optional.');
  } else if (scores.nocturnal >= 70) {
    notes.push('Particularly suited to nocturnal dining and regrettable karaoke.');
  } else if (fv.S < 0.55) {
    notes.push('This vintage has been… celebrated. Approach with snacks.');
  } else {
    notes.push('A clean finish. Best after dusk, worse before brunch.');
  }

  return [...new Set(notes)].slice(0, 4);
}

function recommendationsFrom(scores: ProfileScores, fv: FeatureVector): string[] {
  const out: string[] = [];

  if (scores.desirability >= 80) {
    out.push('Pair with bad decisions after midnight.');
  } else if (fv.S >= 0.75) {
    out.push('Ideal for unhurried evenings that somehow become chaotic.');
  } else {
    out.push('Best approached with patience — and water.');
  }

  if (fv.C >= 0.6 && fv.chromaticWarmth >= 0.5) {
    out.push('Notes of last night’s tequila. Serve chilled, spirits optional.');
  } else if (scores.richness >= 80) {
    out.push('Full-bodied with a lasting finish. Hangover not included.');
  } else {
    out.push('Light pour. Still somehow ends up on the dance floor.');
  }

  if (scores.desirability >= 80) {
    out.push('VIP bottle service energy. This vintage has been… celebrated.');
  } else if (scores.consistency < 55) {
    out.push('Shaken, not stirred. Restless night — settle before serving.');
  } else if (scores.rarity >= 70) {
    out.push('A patient (and festive) acquisition is advised.');
  } else {
    out.push('Alcohol signature: suspiciously festive. Best after dusk.');
  }

  const unique = [...new Set(out)];
  return unique.slice(0, 3);
}

function whyText(measured: FeatureScores, scores: ProfileScores, tone: ToneLabel): string {
  const vis = measured.veinVisibility;
  const pat = measured.patternDetail;
  return (
    `Visual contrast places vein visibility near ${vis} with pattern detail around ${pat}. ` +
    `Interpreted as a ${tone} palate with desirability ${scores.desirability}/100 — ` +
    `a fictional party reading from visible image characteristics, not a medical assessment. ` +
    `Any “alcohol signature” is pure vampire dining theatre.`
  );
}

function palateNotes(scores: ProfileScores, tone: ToneLabel, fv: FeatureVector): Record<string, string> {
  const festive =
    fv.C >= 0.55
      ? 'colour signature reads suspiciously festive (fictional).'
      : 'quiet house-pour energy (fictional).';
  return {
    Richness: `${scores.richness} — derived from visibility and colour strength. ${festive}`,
    Aftertaste: `${scores.aftertaste} — from pattern persistence; may include notes of last night’s tequila (joke).`,
    Rarity: `${scores.rarity} — weighted toward local pattern complexity, not actual exclusivity.`,
    Finish: `${scores.finish} — consistency and visibility combined. Hangover optional.`,
    Temperament: `${scores.temperament} — balance of elegance and frame steadiness (shaken vs stirred).`,
    Occasion: `${scores.occasion} — composite of desirability, rarity, and elegance. After-midnight friendly.`,
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
  captureImage?: string | null;
}): VeinProfile {
  const fv = opts.featureVector;
  const scores = scoresFromVector(fv);
  const tone = toneLabel(fv.chromaticWarmth, fv.C);
  const classCode = classFromFeatures(fv.V, fv.P, fv.C);
  const { verdict, descriptor } = verdictText(
    scores.desirability,
    scores.rarity,
    scores.consistency,
  );
  const recommendations = recommendationsFrom(scores, fv);
  const measured = { ...opts.measured };
  const radar = radarFromScores(scores);
  const tastingNotes = tastingNotesFrom(scores, fv, tone);
  const assessment = assessmentText(scores, tone, fv);

  return {
    id: opts.id ?? `vp_${Date.now().toString(36)}_${Math.floor(fv.V * 1000)}`,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    label: opts.label ?? 'Subject 01',
    featureVector: { ...fv },
    quality: measured.imageConfidence,
    classCode,
    scores,
    radar,
    toneLabel: tone,
    verdict,
    descriptor,
    assessment,
    tastingNotes,
    why: whyText(measured, scores, tone),
    recommendations,
    palateNotes: palateNotes(scores, tone, fv),
    limitedConfidence: Boolean(opts.limitedConfidence),
    schemaVersion: SCHEMA_VERSION,
    measured,
    captureImage: opts.captureImage ?? null,
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
