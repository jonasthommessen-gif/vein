import type { RawMetrics } from '../types';

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
): { gray: Float32Array; w: number; h: number; meanR: number; meanG: number; meanB: number } {
  const { x0, y0, x1, y1 } = sampleRoiBounds(width, height, frac);
  const w = x1 - x0;
  const h = y1 - y0;
  const gray = new Float32Array(w * h);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let n = 0;

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
      n++;
    }
  }

  return {
    gray,
    w,
    h,
    meanR: n ? sumR / n : 0,
    meanG: n ? sumG / n : 0,
    meanB: n ? sumB / n : 0,
  };
}

export function computeRawMetrics(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): RawMetrics {
  const { gray, w, h, meanR, meanG, meanB } = extractGrayscaleRoi(data, width, height, 0.6);
  const n = w * h;
  if (n === 0) {
    return {
      meanLuminance: 0,
      luminanceSpread: 0,
      localContrast: 0,
      lineStructure: 0,
      chromaticWarmth: 0.5,
      chromaticStrength: 0,
      edgeEnergy: 0,
      exposureOk: false,
      underExposed: true,
      overExposed: false,
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

  // Local contrast via difference of blurs (small vs larger)
  const blur1 = boxBlur(gray, w, h, 1);
  const blur4 = boxBlur(gray, w, h, 4);
  let contrastSum = 0;
  let edgeSum = 0;
  let darkLineSum = 0;
  let darkLineCount = 0;

  // Directional gradients for elongated dark structures
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const diff = Math.abs(blur1[i] - blur4[i]);
      contrastSum += diff;

      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy);
      edgeSum += mag;

      // Dark relative to local blur → vein-like
      const local = blur4[i];
      const delta = local - gray[i];
      if (delta > 4) {
        // Prefer elongated: stronger along one axis
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
    darkLineCount > 0 ? (darkLineSum / darkLineCount) * Math.min(1, darkLineCount / (pixelsInner * 0.08)) : 0,
  );

  // Chromatic signature after luminance compensation
  const lum = Math.max(1, meanLuminance);
  const rN = meanR / lum;
  const gN = meanG / lum;
  const bN = meanB / lum;
  const chromaMag = Math.sqrt(
    (rN - 1) * (rN - 1) + (gN - 1) * (gN - 1) + (bN - 1) * (bN - 1),
  );
  // Warmth: higher red vs blue after normalization
  const warmth = clamp01(0.5 + (meanR - meanB) / (2 * (meanR + meanG + meanB + 1e-3) / 3) * 2);
  const chromaticStrength = clamp01(chromaMag / 0.35);

  const underExposed = meanLuminance < 35;
  const overExposed = meanLuminance > 230 || (meanLuminance > 200 && luminanceSpread < 12);
  const exposureOk = !underExposed && !overExposed && luminanceSpread > 6;

  return {
    meanLuminance,
    luminanceSpread,
    localContrast,
    lineStructure,
    chromaticWarmth: warmth,
    chromaticStrength,
    edgeEnergy,
    exposureOk,
    underExposed,
    overExposed,
  };
}

/** Mean absolute difference between two grayscale ROI buffers (0..1 stability proxy inverted externally). */
export function frameDifference(
  a: Float32Array,
  b: Float32Array,
): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / n / 255;
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
  const veinVisibility = Math.round(
    100 * clamp01(raw.localContrast * 0.55 + raw.lineStructure * 0.45),
  );
  const patternDetail = Math.round(
    100 * clamp01(raw.lineStructure * 0.6 + raw.edgeEnergy * 0.4),
  );
  const colourSignature = Math.round(100 * clamp01(raw.chromaticStrength));
  const frameStability = Math.round(100 * clamp01(stability));
  const exposureFactor = raw.exposureOk ? 1 : raw.underExposed || raw.overExposed ? 0.35 : 0.6;
  const imageConfidence = Math.round(
    100 *
      clamp01(
        exposureFactor *
          (0.28 * (veinVisibility / 100) +
            0.22 * (patternDetail / 100) +
            0.18 * (colourSignature / 100) +
            0.32 * stability),
      ),
  );

  return { veinVisibility, patternDetail, colourSignature, frameStability, imageConfidence };
}
