import type { RawMetrics, TargetSuitability, VeinGeometry } from '../types';
import { extractInteriorVeinGeometry } from './veinGeometry';

/** Pure image metrics from RGBA pixel buffer (deterministic). */

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function sampleRoiBounds(
  width: number,
  height: number,
  frac = 0.6,
): { x0: number; y0: number; x1: number; y1: number } {
  const rw = Math.floor(width * frac);
  const rh = Math.floor(height * frac);
  const x0 = Math.floor((width - rw) / 2);
  const y0 = Math.floor((height - rh) / 2);
  return { x0, y0, x1: x0 + rw, y1: y0 + rh };
}

/** Box blur of grayscale into out (same size as ROI). */
function boxBlur(
  gray: Float32Array,
  w: number,
  h: number,
  radius: number,
): Float32Array {
  const out = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  const diam = radius * 2 + 1;

  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -radius; x <= radius; x++) {
      const xx = Math.max(0, Math.min(w - 1, x));
      sum += gray[y * w + xx];
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / diam;
      const remove = Math.max(0, Math.min(w - 1, x - radius));
      const add = Math.max(0, Math.min(w - 1, x + radius + 1));
      sum += gray[y * w + add] - gray[y * w + remove];
    }
  }

  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -radius; y <= radius; y++) {
      const yy = Math.max(0, Math.min(h - 1, y));
      sum += tmp[yy * w + x];
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / diam;
      const remove = Math.max(0, Math.min(h - 1, y - radius));
      const add = Math.max(0, Math.min(h - 1, y + radius + 1));
      sum += tmp[add * w + x] - tmp[remove * w + x];
    }
  }
  return out;
}

export function extractGrayscaleRoi(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  frac = 0.6,
): {
  gray: Float32Array;
  /** Soft skin-like affinity 0–1 per ROI pixel (warm mid-tone flesh). */
  skin: Float32Array;
  rCh: Float32Array;
  gCh: Float32Array;
  bCh: Float32Array;
  w: number;
  h: number;
  meanR: number;
  meanG: number;
  meanB: number;
  chromaVariance: number;
  x0: number;
  y0: number;
} {
  const { x0, y0, x1, y1 } = sampleRoiBounds(width, height, frac);
  const w = x1 - x0;
  const h = y1 - y0;
  const gray = new Float32Array(w * h);
  const skin = new Float32Array(w * h);
  const rCh = new Float32Array(w * h);
  const gCh = new Float32Array(w * h);
  const bCh = new Float32Array(w * h);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let n = 0;

  let sumRg = 0;
  let sumYb = 0;
  let sumRgSq = 0;
  let sumYbSq = 0;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const li = (y - y0) * w + (x - x0);
      const lum = luminance(r, g, b);
      gray[li] = lum;
      rCh[li] = r;
      gCh[li] = g;
      bCh[li] = b;
      // Soft skin gate: mid luminance, R≥G≥B-ish, not gray desk / dark sleeve
      const rg = r - g;
      const rb = r - b;
      const gb = g - b;
      const toneOk = r > 55 && g > 35 && b > 20 && r >= g - 8 && g >= b - 15;
      const notSleeve = lum > 48 && lum < 235;
      const warm = clamp01((rg + rb * 0.55) / 55);
      const notGray = clamp01((Math.abs(rg) + Math.abs(rb) + Math.abs(gb)) / 40);
      skin[li] = toneOk && notSleeve ? clamp01(0.35 + 0.45 * warm + 0.2 * notGray) : 0;
      sumR += r;
      sumG += g;
      sumB += b;
      const rgN = (r - g) / 255;
      const yb = (0.5 * (r + g) - b) / 255;
      sumRg += rgN;
      sumYb += yb;
      sumRgSq += rgN * rgN;
      sumYbSq += yb * yb;
      n++;
    }
  }

  const meanRg = n ? sumRg / n : 0;
  const meanYb = n ? sumYb / n : 0;
  const varRg = n ? Math.max(0, sumRgSq / n - meanRg * meanRg) : 0;
  const varYb = n ? Math.max(0, sumYbSq / n - meanYb * meanYb) : 0;
  const chromaVariance = clamp01(Math.sqrt(varRg + varYb) / 0.08);

  return {
    gray,
    skin,
    rCh,
    gCh,
    bCh,
    w,
    h,
    meanR: n ? sumR / n : 0,
    meanG: n ? sumG / n : 0,
    meanB: n ? sumB / n : 0,
    chromaVariance,
    x0,
    y0,
  };
}

function emptyGeometry(
  sampleWidth: number,
  sampleHeight: number,
  roiX = 0,
  roiY = 0,
  roiW = 0,
  roiH = 0,
): VeinGeometry {
  return {
    points: [],
    segments: [],
    polylines: [],
    junctions: [],
    sampleWidth,
    sampleHeight,
    roiX,
    roiY,
    roiW,
    roiH,
    signature: '——',
  };
}

function buildLuminanceHist(gray: Float32Array, bins = 12): number[] {
  const hist = new Array(bins).fill(0);
  if (gray.length === 0) return hist;
  for (let i = 0; i < gray.length; i++) {
    const b = Math.min(bins - 1, Math.floor((gray[i] / 255) * bins));
    hist[b] += 1;
  }
  let max = 1;
  for (const v of hist) if (v > max) max = v;
  return hist.map((v) => v / max);
}

function buildTargetSuitability(
  exposureScore: number,
  chromaVariance: number,
  localContrast: number,
  lineStructure: number,
  organicScore: number,
  edgeRegularity: number,
  edgeEnergy: number,
  exposureOk: boolean,
  geometryPoints: number,
): TargetSuitability {
  // Screens/desks: cardinal regularity spanning the frame, or hard edges >> soft ridges
  const hardEdgeExcess = Math.max(0, edgeEnergy - lineStructure * 1.15);
  const silhouettePenalty = clamp01(edgeRegularity * 0.5 + hardEdgeExcess * 1.1);

  const score = clamp01(
    exposureScore * 0.14 +
      chromaVariance * 0.1 +
      localContrast * 0.14 +
      lineStructure * 0.32 +
      organicScore * 0.3 -
      silhouettePenalty * 0.28,
  );

  // Reject silhouettes even if they produce dark lines; allow directional vein fields
  const looksLikeSilhouette =
    (edgeRegularity >= 0.7 && organicScore < 0.35) ||
    (edgeRegularity >= 0.8 && organicScore < 0.5) ||
    (edgeRegularity >= 0.85 && hardEdgeExcess > 0.05) ||
    silhouettePenalty >= 0.65 ||
    organicScore < 0.18;

  const suitable =
    exposureOk &&
    lineStructure >= 0.12 &&
    localContrast >= 0.06 &&
    organicScore >= 0.22 &&
    geometryPoints >= 3 &&
    score >= 0.22 &&
    !looksLikeSilhouette;

  return {
    exposure: exposureScore,
    chromaVariance,
    localContrast,
    lineStructure,
    organicScore,
    edgeRegularity,
    score,
    suitable,
  };
}

export function computeRawMetrics(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): RawMetrics {
  const emptyGeom = emptyGeometry(width, height);

  const { gray, skin, rCh, gCh, bCh, w, h, meanR, meanG, meanB, chromaVariance, x0, y0 } =
    extractGrayscaleRoi(data, width, height, 0.6);
  const n = w * h;
  if (n === 0) {
    return {
      meanLuminance: 0,
      luminanceSpread: 0,
      localContrast: 0,
      lineStructure: 0,
      chromaVariance: 0,
      chromaticWarmth: 0.5,
      chromaticStrength: 0,
      edgeEnergy: 0,
      organicScore: 0,
      edgeRegularity: 0,
      luminanceHist: new Array(12).fill(0),
      exposureOk: false,
      underExposed: true,
      overExposed: false,
      targetSuitability: buildTargetSuitability(0, 0, 0, 0, 0, 0, 0, false, 0),
      geometry: emptyGeom,
    };
  }

  let sum = 0;
  let sumSq = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < n; i++) {
    const v = gray[i];
    sum += v;
    sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const meanLuminance = sum / n;
  const variance = Math.max(0, sumSq / n - meanLuminance * meanLuminance);
  const luminanceSpread = Math.sqrt(variance);

  const blur1 = boxBlur(gray, w, h, 1);
  const blur2 = boxBlur(gray, w, h, 2);
  const blur5 = boxBlur(gray, w, h, 5);
  let contrastSum = 0;
  let edgeSum = 0;
  let darkLineSum = 0;
  let darkLineCount = 0;

  // Sample interior-weighted soft valleys for line structure (skip hard silhouettes)
  for (let y = 2; y < h - 2; y += 1) {
    for (let x = 2; x < w - 2; x += 1) {
      const i = y * w + x;
      const diff = Math.abs(blur1[i] - blur5[i]);
      contrastSum += diff;

      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy);
      edgeSum += mag;

      const local = blur5[i];
      const delta = local - gray[i];
      const dog = Math.max(0, blur5[i] - blur2[i]);
      if (delta > 4 || dog > 2) {
        const ax = Math.abs(gx);
        const ay = Math.abs(gy);
        const elongation = Math.abs(ax - ay) / (ax + ay + 1e-3);
        const sharp =
          Math.abs(gray[i] - gray[i - 1]) +
          Math.abs(gray[i] - gray[i + 1]) +
          Math.abs(gray[i] - gray[i - w]) +
          Math.abs(gray[i] - gray[i + w]);
        // Hard silhouette edges contribute almost nothing to lineStructure
        const soft = sharp < 85 ? 1 : sharp < 120 ? 0.25 : 0.05;
        const skinW = 0.35 + 0.65 * skin[i];
        darkLineSum +=
          clamp01(Math.max(delta / 36, dog / 10)) *
          (0.3 + 0.7 * elongation) *
          soft *
          skinW;
        darkLineCount++;
      }
    }
  }

  const pixelsInner = Math.max(1, (w - 2) * (h - 2));
  const localContrast = clamp01(contrastSum / pixelsInner / 25);
  const edgeEnergy = clamp01(edgeSum / pixelsInner / 80);
  const lineStructure = clamp01(
    darkLineCount > 0
      ? (darkLineSum / darkLineCount) * Math.min(1, darkLineCount / (pixelsInner * 0.08))
      : 0,
  );

  const lum = Math.max(1, meanLuminance);
  const rN = meanR / lum;
  const gN = meanG / lum;
  const bN = meanB / lum;
  const chromaMag = Math.sqrt(
    (rN - 1) * (rN - 1) + (gN - 1) * (gN - 1) + (bN - 1) * (bN - 1),
  );
  const warmth = clamp01(
    0.5 + ((meanR - meanB) / ((2 * (meanR + meanG + meanB + 1e-3)) / 3)) * 2,
  );
  const chromaticStrength = clamp01(chromaMag / 0.35);

  const underExposed = meanLuminance < 35;
  const overExposed =
    meanLuminance > 230 || (meanLuminance > 200 && luminanceSpread < 12);
  const exposureOk = !underExposed && !overExposed && luminanceSpread > 6;

  const exposureScore = clamp01(
    exposureOk
      ? 1 - Math.abs(meanLuminance - 120) / 140
      : underExposed || overExposed
        ? 0.15
        : 0.4,
  );

  const { geometry, organicScore, edgeRegularity } = extractInteriorVeinGeometry(
    {
      gray,
      skin,
      rCh,
      gCh,
      bCh,
      w,
      h,
      roiX: x0,
      roiY: y0,
      sampleWidth: width,
      sampleHeight: height,
    },
    blur2,
    blur5,
  );

  const ridgeEvidence =
    geometry.polylines.length + Math.floor(geometry.points.length / 3);

  const targetSuitability = buildTargetSuitability(
    exposureScore,
    chromaVariance,
    localContrast,
    lineStructure,
    organicScore,
    edgeRegularity,
    edgeEnergy,
    exposureOk,
    Math.max(geometry.points.length, geometry.polylines.length * 2),
  );

  // Gate overlay: skin-like ROI + enough interior ridge evidence; never silhouette-only
  const gatedGeometry =
    (targetSuitability.suitable ||
      (organicScore >= 0.24 &&
        edgeRegularity < 0.68 &&
        ridgeEvidence >= 2 &&
        geometry.polylines.length >= 1)) &&
    ridgeEvidence >= 1
      ? geometry
      : {
          ...emptyGeometry(width, height, x0, y0, w, h),
          signature: geometry.signature,
        };

  return {
    meanLuminance,
    luminanceSpread,
    localContrast,
    lineStructure,
    chromaVariance,
    chromaticWarmth: warmth,
    chromaticStrength,
    edgeEnergy,
    organicScore,
    edgeRegularity,
    luminanceHist: buildLuminanceHist(gray, 12),
    exposureOk,
    underExposed,
    overExposed,
    targetSuitability,
    geometry: gatedGeometry,
  };
}

/** Mean absolute difference between two grayscale ROI buffers. */
export function frameDifference(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n / 255;
}

/** Soft gain so typical arm contrast maps into mid/high display range. */
function displayCurve(x: number, gain = 3.4): number {
  return clamp01(1 - Math.exp(-gain * Math.max(0, x)));
}

export function metricsToDisplayScores(
  raw: RawMetrics,
  stability: number,
): {
  veinVisibility: number;
  patternDetail: number;
  colourSignature: number;
  frameStability: number;
  imageConfidence: number;
} {
  const visibilityProxy =
    raw.localContrast * 0.25 + raw.lineStructure * 0.5 + raw.organicScore * 0.25;
  const patternProxy =
    raw.lineStructure * 0.45 + raw.organicScore * 0.35 + raw.edgeEnergy * 0.2;
  const veinVisibility = Math.round(100 * displayCurve(visibilityProxy, 3.6));
  const patternDetail = Math.round(100 * displayCurve(patternProxy, 3.5));
  const colourSignature = Math.round(
    100 * displayCurve(raw.chromaticStrength * 0.55 + raw.chromaVariance * 0.15, 2.8),
  );
  const frameStability = Math.round(100 * clamp01(stability));
  const exposureFactor = raw.exposureOk
    ? 1
    : raw.underExposed || raw.overExposed
      ? 0.35
      : 0.6;
  const suitabilityFactor = raw.targetSuitability.suitable
    ? 1
    : 0.4 + 0.3 * raw.targetSuitability.score;
  const imageConfidence = Math.round(
    100 *
      clamp01(
        exposureFactor *
          suitabilityFactor *
          (0.26 * (veinVisibility / 100) +
            0.2 * (patternDetail / 100) +
            0.16 * (colourSignature / 100) +
            0.18 * raw.organicScore +
            0.2 * stability),
      ),
  );

  return {
    veinVisibility,
    patternDetail,
    colourSignature,
    frameStability,
    imageConfidence,
  };
}
