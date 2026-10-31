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
  localContrast: number;
  orientation: number;
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
    sampleWidth,
    sampleHeight,
    roiX,
    roiY,
    roiW,
    roiH,
    signature: '——',
  };
}

function buildSignature(points: VeinPoint[], segments: VeinSegment[]): string {
  if (points.length === 0) return '——';
  let h = points.length * 17 + segments.length * 31;
  for (let i = 0; i < Math.min(8, points.length); i++) {
    const p = points[i];
    h = (h * 33 + Math.round(p.x * 3) + Math.round(p.y * 5) + Math.round(p.strength * 100)) >>> 0;
  }
  const hex = (h >>> 0).toString(16).toUpperCase().padStart(6, '0').slice(-6);
  return `Σ${hex.slice(0, 3)}·${hex.slice(3)}`;
}

/**
 * Sparse dark-ridge candidates → local clusters + short segments only.
 * Rejects long silhouette / axis-aligned edge chains typical of screens & desks.
 */
function extractVeinGeometry(
  gray: Float32Array,
  w: number,
  h: number,
  roiX: number,
  roiY: number,
  sampleWidth: number,
  sampleHeight: number,
  blur4: Float32Array,
): { geometry: VeinGeometry; organicScore: number; edgeRegularity: number } {
  const empty = emptyGeometry(sampleWidth, sampleHeight, roiX, roiY, w, h);
  if (w < 8 || h < 8) {
    return { geometry: empty, organicScore: 0, edgeRegularity: 1 };
  }

  const candidates: Candidate[] = [];
  const step = 2;

  for (let y = 3; y < h - 3; y += step) {
    for (let x = 3; x < w - 3; x += step) {
      const i = y * w + x;
      const local = blur4[i];
      const delta = local - gray[i];
      // Dark ridge relative to neighbourhood — screens often fail organic soft ridges
      if (delta < 6) continue;

      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy) + 1e-3;
      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      const elongation = Math.abs(ax - ay) / (ax + ay + 1e-3);
      if (elongation < 0.28) continue;

      // Soft ridge: avoid razor-sharp single-pixel edges (laptop bezels / paper)
      const sharp =
        Math.abs(gray[i] - gray[i - 1]) +
        Math.abs(gray[i] - gray[i + 1]) +
        Math.abs(gray[i] - gray[i - w]) +
        Math.abs(gray[i] - gray[i + w]);
      if (sharp > 110) continue;

      const strength = clamp01(delta / 34) * (0.3 + 0.7 * elongation);
      if (strength < 0.32) continue;

      // Tangent ≈ perpendicular to gradient
      const orientation = Math.atan2(gx / mag, -gy / mag);
      candidates.push({
        x,
        y,
        strength,
        gx,
        gy,
        localContrast: clamp01(delta / 40),
        orientation,
      });
    }
  }

  if (candidates.length === 0) {
    return { geometry: empty, organicScore: 0, edgeRegularity: 0.2 };
  }

  candidates.sort((a, b) => b.strength - a.strength);

  // Cardinal (exact H/V) concentration — screens/notebooks, not diagonal vein fields
  let cardinalHits = 0;
  let extentX = 0;
  let extentY = 0;
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  const sampleN = Math.min(60, candidates.length);
  for (const c of candidates.slice(0, sampleN)) {
    const ang = ((c.orientation % Math.PI) + Math.PI) % Math.PI;
    const toHoriz = Math.min(ang, Math.PI - ang);
    const toVert = Math.abs(ang - Math.PI / 2);
    // Tighter than before — only near-perfect cardinals count
    if (toHoriz < 0.12 || toVert < 0.12) cardinalHits += 1;
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  extentX = (maxX - minX) / Math.max(1, w);
  extentY = (maxY - minY) / Math.max(1, h);
  const cardinalShare = cardinalHits / sampleN;
  // Long span + cardinal orientation ⇒ silhouette/edge chain (laptop, paper)
  const spanFactor = Math.max(extentX, extentY) > 0.55 ? 1.2 : 0.75;
  const edgeRegularity = clamp01(cardinalShare * spanFactor * 1.1);

  // Sparsify
  const kept: Candidate[] = [];
  const minDistSq = 6 * 6;
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
      if (kept.length >= 40) break;
    }
  }

  // Require local cluster membership (2+ neighbours within radius) — kills long lonely edges
  const clusterR = 16;
  const clusterR2 = clusterR * clusterR;
  const clustered: Candidate[] = [];
  for (let i = 0; i < kept.length; i++) {
    const a = kept[i];
    let neighbors = 0;
    for (let j = 0; j < kept.length; j++) {
      if (i === j) continue;
      const dx = a.x - kept[j].x;
      const dy = a.y - kept[j].y;
      if (dx * dx + dy * dy <= clusterR2) neighbors += 1;
    }
    if (neighbors >= 1) clustered.push(a);
  }

  // Drop only near-perfect cardinal points when silhouette regularity is high
  const filtered = clustered.filter((c) => {
    if (edgeRegularity < 0.55) return true;
    const ang = ((c.orientation % Math.PI) + Math.PI) % Math.PI;
    const toHoriz = Math.min(ang, Math.PI - ang);
    const toVert = Math.abs(ang - Math.PI / 2);
    return toHoriz > 0.14 && toVert > 0.14;
  });

  const finalPts = (filtered.length >= 3 ? filtered : clustered).slice(0, 28);

  const points: VeinPoint[] = finalPts.map((c) => ({
    x: roiX + c.x,
    y: roiY + c.y,
    strength: c.strength,
    orientation: c.orientation,
    localContrast: c.localContrast,
    accepted: false,
  }));

  // Short local segments only (max ~9px) — no silhouette chains
  const segments: VeinSegment[] = [];
  const linkDist = 9;
  const linkDistSq = linkDist * linkDist;
  const used = new Set<string>();

  for (let i = 0; i < finalPts.length; i++) {
    const a = finalPts[i];
    let bestJ = -1;
    let bestD = linkDistSq;
    const mag = Math.sqrt(a.gx * a.gx + a.gy * a.gy) + 1e-3;
    const tx = -a.gy / mag;
    const ty = a.gx / mag;

    for (let j = i + 1; j < finalPts.length; j++) {
      const b = finalPts[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > linkDistSq || d2 < 4) continue;
      const dist = Math.sqrt(d2);
      const align = Math.abs((dx / dist) * tx + (dy / dist) * ty);
      if (align < 0.62) continue;
      // Reject near-perfect axis-aligned longish links
      const ang = Math.atan2(dy, dx);
      const aa = ((ang % Math.PI) + Math.PI) % Math.PI;
      const toH = Math.min(aa, Math.PI - aa);
      const toV = Math.abs(aa - Math.PI / 2);
      if ((toH < 0.15 || toV < 0.15) && dist > 6) continue;
      if (d2 < bestD) {
        bestD = d2;
        bestJ = j;
      }
    }

    if (bestJ >= 0) {
      const b = finalPts[bestJ];
      const key = `${i}-${bestJ}`;
      if (used.has(key)) continue;
      used.add(key);
      const length = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
      if (length > 10) continue;
      segments.push({
        x0: roiX + a.x,
        y0: roiY + a.y,
        x1: roiX + b.x,
        y1: roiY + b.y,
        strength: Math.min(a.strength, b.strength),
        length,
      });
      if (segments.length >= 22) break;
    }
  }

  // Organic score: cluster density + orientation diversity − axis regularity
  const orientBins = [0, 0, 0, 0];
  for (const p of finalPts) {
    const ang = ((p.orientation % Math.PI) + Math.PI) % Math.PI;
    const bin = Math.min(3, Math.floor((ang / Math.PI) * 4));
    orientBins[bin] += 1;
  }
  const totalO = finalPts.length || 1;
  let entropy = 0;
  for (const b of orientBins) {
    if (b === 0) continue;
    const p = b / totalO;
    entropy -= p * Math.log2(p);
  }
  const orientDiversity = clamp01(entropy / 2);
  const clusterRatio = kept.length ? finalPts.length / Math.max(1, kept.length) : 0;
  const densityScore = clamp01(finalPts.length / 14);

  // Collinear span: long thin chains (paper edges) vs 2-D local vein clusters
  let pMinX = w;
  let pMaxX = 0;
  let pMinY = h;
  let pMaxY = 0;
  for (const p of finalPts) {
    if (p.x < pMinX) pMinX = p.x;
    if (p.x > pMaxX) pMaxX = p.x;
    if (p.y < pMinY) pMinY = p.y;
    if (p.y > pMaxY) pMaxY = p.y;
  }
  const spanX = finalPts.length ? (pMaxX - pMinX) / Math.max(1, w) : 0;
  const spanY = finalPts.length ? (pMaxY - pMinY) / Math.max(1, h) : 0;
  const thinSpan =
    Math.max(spanX, spanY) > 0.42 &&
    Math.max(spanX, spanY) / (Math.min(spanX, spanY) + 0.04) > 3.2;

  // Veins often share one dominant direction — do not punish that heavily
  const organicScore = clamp01(
    clusterRatio * 0.38 +
      densityScore * 0.28 +
      orientDiversity * 0.18 +
      (1 - edgeRegularity) * 0.16 -
      (thinSpan ? 0.35 : 0),
  );

  const geometry: VeinGeometry = {
    points,
    segments,
    sampleWidth,
    sampleHeight,
    roiX,
    roiY,
    roiW: w,
    roiH: h,
    signature: buildSignature(points, segments),
  };

  return { geometry, organicScore, edgeRegularity };
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
  const blur4 = boxBlur(gray, w, h, 4);
  let contrastSum = 0;
  let edgeSum = 0;
  let darkLineSum = 0;
  let darkLineCount = 0;

  // Sample every other pixel for iPhone Safari throttle
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      const diff = Math.abs(blur1[i] - blur4[i]);
      contrastSum += diff;

      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy);
      edgeSum += mag;

      const local = blur4[i];
      const delta = local - gray[i];
      if (delta > 5) {
        const ax = Math.abs(gx);
        const ay = Math.abs(gy);
        const elongation = Math.abs(ax - ay) / (ax + ay + 1e-3);
        // Soft ridge weight — hard edges contribute less to "line structure"
        const sharp =
          Math.abs(gray[i] - gray[i - 1]) + Math.abs(gray[i] - gray[i + 1]);
        const soft = sharp < 90 ? 1 : 0.35;
        darkLineSum += clamp01(delta / 40) * (0.35 + 0.65 * elongation) * soft;
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

  const { geometry, organicScore, edgeRegularity } = extractVeinGeometry(
    gray,
    w,
    h,
    x0,
    y0,
    width,
    height,
    blur4,
  );

  const targetSuitability = buildTargetSuitability(
    exposureScore,
    chromaVariance,
    localContrast,
    lineStructure,
    organicScore,
    edgeRegularity,
    edgeEnergy,
    exposureOk,
    geometry.points.length,
  );

  // Hide geometry on silhouette-like scenes; keep sparse clusters on soft targets
  const gatedGeometry =
    targetSuitability.suitable ||
    (organicScore >= 0.22 &&
      edgeRegularity < 0.72 &&
      geometry.points.length >= 3)
      ? geometry
      : { ...emptyGeometry(width, height, x0, y0, w, h), signature: geometry.signature };

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
