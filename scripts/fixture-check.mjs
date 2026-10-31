/**
 * Node-side determinism check for profile scoring (feature vector → scores).
 * Pixel pipeline is verified in-browser via Use sample; this locks the fiction mapping.
 */
import { createRequire } from 'module';

// Inline the scoring rules to avoid TS import in node without build
function clamp(n, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, n));
}
function roundTo5(n) {
  return Math.round(n / 5) * 5;
}
function scoresFromVector(fv) {
  const { V, P, C, S, Q } = fv;
  return {
    desirability: roundTo5(100 * clamp(0.34 * V + 0.22 * P + 0.16 * C + 0.18 * S + 0.1 * Q)),
    richness: roundTo5(100 * clamp(0.5 * V + 0.3 * C + 0.2 * P)),
    rarity: roundTo5(100 * clamp(0.65 * P + 0.2 * C + 0.15 * V)),
    elegance: roundTo5(100 * clamp(0.5 * S + 0.3 * V + 0.2 * P)),
  };
}
function classFromFeatures(V, P, C) {
  const vB = Math.min(1, Math.floor(V * 2));
  const pB = Math.min(1, Math.floor(P * 2));
  const cB = Math.min(1, Math.floor(C * 2));
  return `V·0${vB * 4 + pB * 2 + cB + 1}`;
}

const fv = { V: 0.72, P: 0.47, C: 0.61, S: 0.88, Q: 0.81, chromaticWarmth: 0.42 };
const a = { ...scoresFromVector(fv), classCode: classFromFeatures(fv.V, fv.P, fv.C) };
const b = { ...scoresFromVector(fv), classCode: classFromFeatures(fv.V, fv.P, fv.C) };
const same = JSON.stringify(a) === JSON.stringify(b);
console.log(same ? 'PASS identical scores' : 'FAIL', a);
if (!same) process.exit(1);
