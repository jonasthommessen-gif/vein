import type {
  RawMetrics,
  TargetSuitability,
  VeinGeometry,
  VeinPoint,
  VeinSegment,
} from '../types';

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
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let n = 0;

  // Chromatic axes without skin-hue cutoffs: red-green and yellow-blue proxies
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
      gray[(y - y0) * w + (x - x0)] = luminance(r, g, b);
      sumR += r;
      sumG += g;
      sumB += b;
      const rg = (r - g) / 255;
      const yb = (0.5 * (r + g) - b) / 255;
      sumRg += rg;
      sumYb += yb;
      sumRgSq += rg * rg;
      sumYbSq += yb * yb;
      n++;
    }
  }

  const meanRg = n ? sumRg / n : 0;
  const meanYb = n ? sumYb / n : 0;
  const varRg = n ? Math.max(0, sumRgSq / n - meanRg * meanRg) : 0;
  const varYb = n ? Math.max(0, sumYbSq / n - meanYb * meanYb) : 0;
  // Typical skin/arm chroma variance is modest; screens/blank walls skew differently
  const chromaVariance = clamp01(Math.sqrt(varRg + varYb) / 0.08);

  return {
    gray,
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

interface Candidate {
  x: number;
  y: number;
  strength: number;
  gx: number;
  gy: number;
}

/** Sparse dark-line candidates → points + short segments in full sample space. */
function extractVeinGeometry(
  gray: Float32Array,
  w: number,
  h: number,
  roiX: number,
  roiY: number,
  sampleWidth: number,
  sampleHeight: number,
  blur4: Float32Array,
): VeinGeometry {
  const empty: VeinGeometry = {
    points: [],
    segments: [],
    sampleWidth,
    sampleHeight,
    roiX,
    roiY,
    roiW: w,
    roiH: h,
  };

  if (w < 8 || h < 8) return empty;

  const candidates: Candidate[] = [];
  const step = 2;

  for (let y = 2; y < h - 2; y += step) {
    for (let x = 2; x < w - 2; x += step) {
      const i = y * w + x;
      const local = blur4[i];
      const delta = local - gray[i];
      if (delta < 5) continue;

      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      const elongation = Math.abs(ax - ay) / (ax + ay + 1e-3);
      // Require elongated dark structure — generic edges alone do not qualify
      if (elongation < 0.22) continue;

      const strength = clamp01(delta / 36) * (0.35 + 0.65 * elongation);
      if (strength < 0.28) continue;

      candidates.push({ x, y, strength, gx, gy });
    }
  }

  if (candidates.length === 0) return empty;

  // Sort strongest first; sparsify by minimum distance
  candidates.sort((a, b) => b.strength - a.strength);
  const kept: Candidate[] = [];
  const minDistSq = 5 * 5;
  for (const c of candidates) {
    let ok = true;
    for (const k of kept) {
      const dx = c.x - k.x;
      const dy = c.y - k.y;
      if (dx * dx + dy * dy < minDistSq) {
        ok = false;
        break;
      }
    }
    if (ok) {
      kept.push(c);
      if (kept.length >= 48) break;
    }
  }

  const points: VeinPoint[] = kept.map((c) => ({
    x: roiX + c.x,
    y: roiY + c.y,
    strength: c.strength,
  }));

  // Short segments along the weaker gradient axis (ridge direction)
  const segments: VeinSegment[] = [];
  const linkDist = 14;
  const linkDistSq = linkDist * linkDist;

  for (let i = 0; i < kept.length; i++) {
    const a = kept[i];
    let bestJ = -1;
    let bestD = linkDistSq;
    const mag = Math.sqrt(a.gx * a.gx + a.gy * a.gy) + 1e-3;
    // Tangent ≈ perpendicular to gradient
    const tx = -a.gy / mag;
    const ty = a.gx / mag;

    for (let j = i + 1; j < kept.length; j++) {
      const b = kept[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > linkDistSq || d2 < 4) continue;
      const dist = Math.sqrt(d2);
      const align = Math.abs((dx / dist) * tx + (dy / dist) * ty);
      if (align < 0.55) continue;
      if (d2 < bestD) {
        bestD = d2;
        bestJ = j;
      }
    }

    if (bestJ >= 0) {
      const b = kept[bestJ];
      segments.push({
        x0: roiX + a.x,
        y0: roiY + a.y,
        x1: roiX + b.x,
        y1: roiY + b.y,
        strength: Math.min(a.strength, b.strength),
      });
      if (segments.length >= 36) break;
    }
  }

  return {
    points,
    segments,
    sampleWidth,
    sampleHeight,
    roiX,
    roiY,
    roiW: w,
    roiH: h,
  };
}

function buildTargetSuitability(
  exposureScore: number,
  chromaVariance: number,
  localContrast: number,
  lineStructure: number,
  exposureOk: boolean,
): TargetSuitability {
  // Composite heavily weighted toward line structure — kitchen/screens fail here
  const score = clamp01(
    exposureScore * 0.2 +
      chromaVariance * 0.12 +
      localContrast * 0.18 +
      lineStructure * 0.5,
  );
  const suitable =
    exposureOk &&
    lineStructure >= 0.14 &&
    localContrast >= 0.07 &&
    score >= 0.22;
  return {
    exposure: exposureScore,
    chromaVariance,
    localContrast,
    lineStructure,
    score,
    suitable,
  };
}

export function computeRawMetrics(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): RawMetrics {
  const emptyGeom: VeinGeometry = {
    points: [],
    segments: [],
    sampleWidth: width,
    sampleHeight: height,
    roiX: 0,
    roiY: 0,
    roiW: 0,
    roiH: 0,
  };

  const { gray, w, h, meanR, meanG, meanB, chromaVariance, x0, y0 } =
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
      exposureOk: false,
      underExposed: true,
      overExposed: false,
      targetSuitability: buildTargetSuitability(0, 0, 0, 0, false),
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
  const blur4 = boxBlur(gray, w, h, 4);
  let contrastSum = 0;
  let edgeSum = 0;
  let darkLineSum = 0;
  let darkLineCount = 0;

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const diff = Math.abs(blur1[i] - blur4[i]);
      contrastSum += diff;

      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy);
      edgeSum += mag;

      const local = blur4[i];
      const delta = local - gray[i];
      if (delta > 4) {
        const ax = Math.abs(gx);
        const ay = Math.abs(gy);
        const elongation = Math.abs(ax - ay) / (ax + ay + 1e-3);
        darkLineSum += clamp01(delta / 40) * (0.4 + 0.6 * elongation);
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

  // Peak exposure score near mid-tones with usable spread
  const exposureScore = clamp01(
    exposureOk
      ? 1 - Math.abs(meanLuminance - 120) / 140
      : underExposed || overExposed
        ? 0.15
        : 0.4,
  );

  const targetSuitability = buildTargetSuitability(
    exposureScore,
    chromaVariance,
    localContrast,
    lineStructure,
    exposureOk,
  );

  const geometry = extractVeinGeometry(
    gray,
    w,
    h,
    x0,
    y0,
    width,
    height,
    blur4,
  );

  return {
    meanLuminance,
    luminanceSpread,
    localContrast,
    lineStructure,
    chromaVariance,
    chromaticWarmth: warmth,
    chromaticStrength,
    edgeEnergy,
    exposureOk,
    underExposed,
    overExposed,
    targetSuitability,
    geometry,
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
  // Visibility requires line structure — generic contrast alone stays low
  const visibilityProxy = raw.localContrast * 0.35 + raw.lineStructure * 0.65;
  const patternProxy = raw.lineStructure * 0.6 + raw.edgeEnergy * 0.4;
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
    : 0.45 + 0.35 * raw.targetSuitability.score;
  const imageConfidence = Math.round(
    100 *
      clamp01(
        exposureFactor *
          suitabilityFactor *
          (0.28 * (veinVisibility / 100) +
            0.22 * (patternDetail / 100) +
            0.18 * (colourSignature / 100) +
            0.32 * stability),
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
