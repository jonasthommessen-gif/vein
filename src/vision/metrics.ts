import type {
  RawMetrics,
  TargetSuitability,
  VeinGeometry,
  VeinJunction,
  VeinPoint,
  VeinPolyline,
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
  /** Soft skin-like affinity 0–1 per ROI pixel (warm mid-tone flesh). */
  skin: Float32Array;
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

interface RidgeSeed {
  x: number;
  y: number;
  strength: number;
  gx: number;
  gy: number;
  localContrast: number;
  orientation: number;
  /** Distance to nearest silhouette edge in ROI px. */
  interiorDist: number;
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

function buildSignature(
  points: VeinPoint[],
  segments: VeinSegment[],
  polylines: VeinPolyline[],
): string {
  if (points.length === 0 && polylines.length === 0) return '——';
  let h = points.length * 17 + segments.length * 31 + polylines.length * 47;
  for (let i = 0; i < Math.min(8, points.length); i++) {
    const p = points[i];
    h = (h * 33 + Math.round(p.x * 3) + Math.round(p.y * 5) + Math.round(p.strength * 100)) >>> 0;
  }
  for (let i = 0; i < Math.min(4, polylines.length); i++) {
    h = (h * 19 + polylines[i].points.length * 7 + Math.round(polylines[i].strength * 50)) >>> 0;
  }
  const hex = (h >>> 0).toString(16).toUpperCase().padStart(6, '0').slice(-6);
  return `Σ${hex.slice(0, 3)}·${hex.slice(3)}`;
}

/** Dilate a binary-ish mask by radius (approx box). */
function dilateMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[yy * w + xx]) {
            hit = 1;
            break;
          }
        }
      }
      out[y * w + x] = hit;
    }
  }
  return out;
}

/**
 * Interior dark-valley ridge detection → branching polylines + junction nodes.
 * Suppresses limb/background silhouette edges; prefers soft elongated valleys on skin.
 */
function extractVeinGeometry(
  gray: Float32Array,
  skin: Float32Array,
  w: number,
  h: number,
  roiX: number,
  roiY: number,
  sampleWidth: number,
  sampleHeight: number,
  blur2: Float32Array,
  blur5: Float32Array,
): { geometry: VeinGeometry; organicScore: number; edgeRegularity: number } {
  const empty = emptyGeometry(sampleWidth, sampleHeight, roiX, roiY, w, h);
  if (w < 12 || h < 12) {
    return { geometry: empty, organicScore: 0, edgeRegularity: 1 };
  }

  // —— 1. Silhouette / hard-discontinuity mask (limb vs table, sleeve, screen) ——
  const silMask = new Uint8Array(w * h);
  const gradMag = new Float32Array(w * h);
  let hardEdgeSum = 0;
  let hardEdgeN = 0;

  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy);
      gradMag[i] = mag;

      // Large step across a short baseline ⇒ background discontinuity
      const stepH = Math.abs(gray[i + 2] - gray[i - 2]);
      const stepV = Math.abs(gray[i + 2 * w] - gray[i - 2 * w]);
      const step = Math.max(stepH, stepV);
      const sharp =
        Math.abs(gray[i] - gray[i - 1]) +
        Math.abs(gray[i] - gray[i + 1]) +
        Math.abs(gray[i] - gray[i - w]) +
        Math.abs(gray[i] - gray[i + w]);

      if (mag > 42 && step > 48) {
        silMask[i] = 1;
        hardEdgeSum += 1;
      } else if (sharp > 140 && mag > 55) {
        silMask[i] = 1;
        hardEdgeSum += 1;
      }
      hardEdgeN += 1;
    }
  }

  const silDilated = dilateMask(silMask, w, h, 3);
  // Slightly wider keep-out for silhouette hugging
  const silKeepOut = dilateMask(silMask, w, h, 5);

  // Approximate distance-to-silhouette (coarse, step 2)
  const interiorDist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (silDilated[i]) {
        interiorDist[i] = 0;
        continue;
      }
      let minD = 24;
      for (let r = 2; r <= 22; r += 2) {
        let found = false;
        for (let t = 0; t < 8 && !found; t++) {
          const ang = (t / 8) * Math.PI * 2;
          const xx = Math.round(x + Math.cos(ang) * r);
          const yy = Math.round(y + Math.sin(ang) * r);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) {
            found = true;
            minD = Math.min(minD, r);
            break;
          }
          if (silDilated[yy * w + xx]) {
            found = true;
            minD = Math.min(minD, r);
          }
        }
        if (found) break;
      }
      interiorDist[i] = minD;
    }
  }

  // —— 2. Difference-of-Gaussians dark valleys (interior) ——
  const dog = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // Positive where fine structure is darker than broad neighbourhood
    dog[i] = Math.max(0, blur5[i] - blur2[i]);
  }

  // —— 3. Ridge seeds: NMS along gradient on soft elongated interior valleys ——
  const seeds: RidgeSeed[] = [];
  const step = 2;

  for (let y = 4; y < h - 4; y += step) {
    for (let x = 4; x < w - 4; x += step) {
      const i = y * w + x;
      if (silKeepOut[i]) continue;
      if (skin[i] < 0.28) continue;
      if (interiorDist[i] < 4) continue;

      const valley = dog[i];
      const delta = blur5[i] - gray[i];
      if (valley < 2.2 && delta < 5) continue;

      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy) + 1e-3;

      // Soft ridge: reject razor edges
      const sharp =
        Math.abs(gray[i] - gray[i - 1]) +
        Math.abs(gray[i] - gray[i + 1]) +
        Math.abs(gray[i] - gray[i - w]) +
        Math.abs(gray[i] - gray[i + w]);
      if (sharp > 95) continue;

      // Elongation / ridge-ness: valley stronger along tangent than gradient
      const nx = gx / mag;
      const ny = gy / mag;
      const tx = -ny;
      const ty = nx;
      const iAlong =
        Math.max(
          0,
          Math.min(w * h - 1, Math.round(y + ty) * w + Math.round(x + tx)),
        );
      const iOpp =
        Math.max(
          0,
          Math.min(w * h - 1, Math.round(y - ty) * w + Math.round(x - tx)),
        );
      const iNormP =
        Math.max(
          0,
          Math.min(w * h - 1, Math.round(y + ny) * w + Math.round(x + nx)),
        );
      const iNormM =
        Math.max(
          0,
          Math.min(w * h - 1, Math.round(y - ny) * w + Math.round(x - nx)),
        );

      // Non-max along normal: centre of dark valley
      if (dog[i] + 0.15 < dog[iNormP] || dog[i] + 0.15 < dog[iNormM]) continue;

      const along = 0.5 * (dog[iAlong] + dog[iOpp]);
      const across = 0.5 * (dog[iNormP] + dog[iNormM]);
      const ridgeShape = along + 0.35 - across;
      if (ridgeShape < 0.4) continue;

      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      const elongation = Math.abs(ax - ay) / (ax + ay + 1e-3);
      // Allow near-isotropic soft valleys if DoG is strong (branching nodes)
      if (elongation < 0.12 && valley < 4) continue;

      const darkness = clamp01(Math.max(valley / 10, delta / 28));
      const interiorBoost = clamp01(interiorDist[i] / 14);
      const strength = clamp01(
        darkness * (0.4 + 0.35 * elongation + 0.25 * clamp01(ridgeShape / 3)) *
          (0.55 + 0.45 * skin[i]) *
          (0.7 + 0.3 * interiorBoost),
      );
      if (strength < 0.28) continue;

      const orientation = Math.atan2(tx, ty);
      seeds.push({
        x,
        y,
        strength,
        gx,
        gy,
        localContrast: clamp01(Math.max(valley / 12, delta / 36)),
        orientation,
        interiorDist: interiorDist[i],
      });
    }
  }

  if (seeds.length === 0) {
    return { geometry: empty, organicScore: 0, edgeRegularity: 0.15 };
  }

  seeds.sort((a, b) => b.strength - a.strength);

  // Cardinal regularity among top seeds (screens / desk edges)
  let cardinalHits = 0;
  let minX = w;
  let maxX = 0;
  let minY = h;
  let maxY = 0;
  const sampleN = Math.min(80, seeds.length);
  for (const c of seeds.slice(0, sampleN)) {
    const ang = ((c.orientation % Math.PI) + Math.PI) % Math.PI;
    const toHoriz = Math.min(ang, Math.PI - ang);
    const toVert = Math.abs(ang - Math.PI / 2);
    if (toHoriz < 0.1 || toVert < 0.1) cardinalHits += 1;
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  const extentX = (maxX - minX) / Math.max(1, w);
  const extentY = (maxY - minY) / Math.max(1, h);
  const cardinalShare = cardinalHits / sampleN;
  const spanFactor = Math.max(extentX, extentY) > 0.6 ? 1.15 : 0.7;
  const hardEdgeRate = hardEdgeN ? hardEdgeSum / hardEdgeN : 0;
  const edgeRegularity = clamp01(
    cardinalShare * spanFactor * 1.05 + hardEdgeRate * 0.8,
  );

  // Sparsify seeds
  const kept: RidgeSeed[] = [];
  const minDistSq = 5 * 5;
  for (const c of seeds) {
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
      if (kept.length >= 72) break;
    }
  }

  // Drop silhouette-adjacent leftovers + near-perfect cardinals when regularity high
  const interior = kept.filter((c) => {
    if (c.interiorDist < 3.5) return false;
    if (edgeRegularity >= 0.5) {
      const ang = ((c.orientation % Math.PI) + Math.PI) % Math.PI;
      const toHoriz = Math.min(ang, Math.PI - ang);
      const toVert = Math.abs(ang - Math.PI / 2);
      if (toHoriz < 0.12 || toVert < 0.12) return false;
    }
    return true;
  });

  const work = (interior.length >= 4 ? interior : kept).slice(0, 56);

  // —— 4. Link seeds into branching polylines along ridge tangent ——
  const adj: number[][] = Array.from({ length: work.length }, () => []);
  const linkDist = 14;
  const linkDistSq = linkDist * linkDist;

  for (let i = 0; i < work.length; i++) {
    const a = work[i];
    const mag = Math.sqrt(a.gx * a.gx + a.gy * a.gy) + 1e-3;
    const tx = -a.gy / mag;
    const ty = a.gx / mag;
    const candidates: Array<{ j: number; score: number }> = [];

    for (let j = 0; j < work.length; j++) {
      if (i === j) continue;
      const b = work[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > linkDistSq || d2 < 4) continue;
      const dist = Math.sqrt(d2);
      const align = Math.abs((dx / dist) * tx + (dy / dist) * ty);
      if (align < 0.55) continue;

      // Midpoint must stay interior (reject outline-hugging chords)
      const mx = Math.round((a.x + b.x) / 2);
      const my = Math.round((a.y + b.y) / 2);
      if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
      const mi = my * w + mx;
      if (silKeepOut[mi] || interiorDist[mi] < 3) continue;
      if (skin[mi] < 0.2) continue;

      // Soft valley continuity along the link
      const midValley = dog[mi];
      if (midValley < 1.2 && Math.min(a.strength, b.strength) < 0.45) continue;

      candidates.push({
        j,
        score: align * (1.2 - dist / linkDist) * (0.5 + 0.5 * Math.min(a.strength, b.strength)),
      });
    }

    candidates.sort((u, v) => v.score - u.score);
    // Degree ≤ 3 → allow branching without mesh spam
    for (let k = 0; k < Math.min(3, candidates.length); k++) {
      const j = candidates[k].j;
      if (!adj[i].includes(j)) adj[i].push(j);
      if (!adj[j].includes(i)) adj[j].push(i);
    }
  }

  // Walk connected components into polylines
  const edgeUsed = new Set<string>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const polylinesRaw: Array<{ indices: number[]; strength: number }> = [];

  const walk = (start: number, next: number): number[] => {
    const path = [start, next];
    edgeUsed.add(edgeKey(start, next));
    let prev = start;
    let cur = next;
    while (true) {
      const nbrs = adj[cur].filter((n) => n !== prev && !edgeUsed.has(edgeKey(cur, n)));
      if (nbrs.length === 0) break;
      // Prefer continuation aligned with incoming direction
      const incoming = {
        x: work[cur].x - work[prev].x,
        y: work[cur].y - work[prev].y,
      };
      const inLen = Math.sqrt(incoming.x * incoming.x + incoming.y * incoming.y) + 1e-3;
      let best = nbrs[0];
      let bestAlign = -1;
      for (const n of nbrs) {
        const ox = work[n].x - work[cur].x;
        const oy = work[n].y - work[cur].y;
        const ol = Math.sqrt(ox * ox + oy * oy) + 1e-3;
        const al = (ox / ol) * (incoming.x / inLen) + (oy / ol) * (incoming.y / inLen);
        if (al > bestAlign) {
          bestAlign = al;
          best = n;
        }
      }
      // At junctions (degree≥3), stop this chain so branches become separate polylines
      if (adj[cur].length >= 3 && path.length >= 2) break;
      edgeUsed.add(edgeKey(cur, best));
      path.push(best);
      prev = cur;
      cur = best;
      if (path.length > 40) break;
    }
    return path;
  };

  // Seed walks from endpoints and junctions
  const startOrder = [...Array(work.length).keys()].sort(
    (a, b) => work[b].strength - work[a].strength,
  );
  for (const i of startOrder) {
    if (adj[i].length === 0) continue;
    for (const j of adj[i]) {
      const k = edgeKey(i, j);
      if (edgeUsed.has(k)) continue;
      // Prefer starting at degree 1 or junction
      if (adj[i].length !== 1 && adj[i].length < 3 && adj[j].length === 1) continue;
      const path = walk(i, j);
      if (path.length < 2) continue;
      let str = 0;
      for (const idx of path) str += work[idx].strength;
      str /= path.length;
      polylinesRaw.push({ indices: path, strength: str });
      if (polylinesRaw.length >= 28) break;
    }
    if (polylinesRaw.length >= 28) break;
  }

  // Filter outline-like polylines: too many low-interior points or hugging ROI border
  const polylines: VeinPolyline[] = [];
  const segments: VeinSegment[] = [];

  for (const pl of polylinesRaw) {
    let interiorHits = 0;
    let borderHits = 0;
    for (const idx of pl.indices) {
      const p = work[idx];
      if (p.interiorDist >= 5) interiorHits += 1;
      if (p.x < 6 || p.y < 6 || p.x > w - 7 || p.y > h - 7) borderHits += 1;
    }
    const interiorRatio = interiorHits / pl.indices.length;
    if (interiorRatio < 0.45 && pl.indices.length > 3) continue;
    if (borderHits / pl.indices.length > 0.55) continue;

    // Length in sample px
    let len = 0;
    for (let k = 1; k < pl.indices.length; k++) {
      const a = work[pl.indices[k - 1]];
      const b = work[pl.indices[k]];
      len += Math.hypot(b.x - a.x, b.y - a.y);
    }
    // Relative weight: longer + stronger = trunk
    const weight = clamp01(0.35 + 0.4 * pl.strength + 0.35 * clamp01(len / 55));
    const stability = clamp01(0.45 + 0.55 * interiorRatio * pl.strength);

    const verts = pl.indices.map((idx) => ({
      x: roiX + work[idx].x,
      y: roiY + work[idx].y,
    }));

    polylines.push({
      points: verts,
      strength: pl.strength,
      weight,
      stability,
    });

    for (let k = 1; k < pl.indices.length; k++) {
      const a = work[pl.indices[k - 1]];
      const b = work[pl.indices[k]];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      segments.push({
        x0: roiX + a.x,
        y0: roiY + a.y,
        x1: roiX + b.x,
        y1: roiY + b.y,
        strength: Math.min(a.strength, b.strength),
        length: segLen,
        weight,
      });
    }
  }

  // —— 5. Junction nodes (degree ≥ 3) + strong ridge samples as points ——
  const junctions: VeinJunction[] = [];
  const points: VeinPoint[] = [];

  for (let i = 0; i < work.length; i++) {
    const c = work[i];
    const deg = adj[i].length;
    if (deg >= 3) {
      junctions.push({
        x: roiX + c.x,
        y: roiY + c.y,
        strength: c.strength,
        degree: deg,
      });
    }
    // Emit points for temporal accumulator + HUD samples (interior only)
    if (c.interiorDist >= 4 && (deg >= 1 || c.strength > 0.4)) {
      points.push({
        x: roiX + c.x,
        y: roiY + c.y,
        strength: c.strength,
        orientation: c.orientation,
        localContrast: c.localContrast,
        accepted: false,
      });
    }
  }

  // Endpoints of strong polylines also get soft nodes
  for (const pl of polylines) {
    if (pl.points.length < 2 || pl.strength < 0.38) continue;
    for (const end of [pl.points[0], pl.points[pl.points.length - 1]]) {
      const nearJ = junctions.some(
        (j) => (j.x - end.x) ** 2 + (j.y - end.y) ** 2 < 36,
      );
      if (nearJ) continue;
      // Lightweight terminal tick via points already covered; add junction only for longer trunks
      if (pl.weight > 0.55 && pl.points.length >= 4) {
        junctions.push({
          x: end.x,
          y: end.y,
          strength: pl.strength * 0.85,
          degree: 1,
        });
      }
    }
  }

  // Cap density for Safari
  const finalPolylines = polylines
    .sort((a, b) => b.strength * b.weight - a.strength * a.weight)
    .slice(0, 18);
  const finalJunctions = junctions
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 22);
  const finalPoints = points.sort((a, b) => b.strength - a.strength).slice(0, 40);
  const finalSegments = segments
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 48);

  // Organic score from interior ridge field (not silhouette chains)
  const orientBins = [0, 0, 0, 0];
  for (const p of work) {
    const ang = ((p.orientation % Math.PI) + Math.PI) % Math.PI;
    const bin = Math.min(3, Math.floor((ang / Math.PI) * 4));
    orientBins[bin] += 1;
  }
  const totalO = work.length || 1;
  let entropy = 0;
  for (const b of orientBins) {
    if (b === 0) continue;
    const p = b / totalO;
    entropy -= p * Math.log2(p);
  }
  const orientDiversity = clamp01(entropy / 2);
  const densityScore = clamp01(finalPolylines.length / 8 + finalPoints.length / 28);
  const branchScore = clamp01(finalJunctions.filter((j) => j.degree >= 3).length / 4);
  const skinCover =
    work.length > 0
      ? work.reduce((s, c) => s + (c.interiorDist >= 5 ? 1 : 0), 0) / work.length
      : 0;

  let pMinX = w;
  let pMaxX = 0;
  let pMinY = h;
  let pMaxY = 0;
  for (const p of work) {
    if (p.x < pMinX) pMinX = p.x;
    if (p.x > pMaxX) pMaxX = p.x;
    if (p.y < pMinY) pMinY = p.y;
    if (p.y > pMaxY) pMaxY = p.y;
  }
  const spanX = work.length ? (pMaxX - pMinX) / Math.max(1, w) : 0;
  const spanY = work.length ? (pMaxY - pMinY) / Math.max(1, h) : 0;
  const thinSpan =
    Math.max(spanX, spanY) > 0.5 &&
    Math.max(spanX, spanY) / (Math.min(spanX, spanY) + 0.04) > 3.5;

  const organicScore = clamp01(
    densityScore * 0.28 +
      orientDiversity * 0.14 +
      branchScore * 0.22 +
      skinCover * 0.22 +
      (1 - edgeRegularity) * 0.14 -
      (thinSpan ? 0.4 : 0),
  );

  const geometry: VeinGeometry = {
    points: finalPoints,
    segments: finalSegments,
    polylines: finalPolylines,
    junctions: finalJunctions,
    sampleWidth,
    sampleHeight,
    roiX,
    roiY,
    roiW: w,
    roiH: h,
    signature: buildSignature(finalPoints, finalSegments, finalPolylines),
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

  const { gray, skin, w, h, meanR, meanG, meanB, chromaVariance, x0, y0 } =
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

  const { geometry, organicScore, edgeRegularity } = extractVeinGeometry(
    gray,
    skin,
    w,
    h,
    x0,
    y0,
    width,
    height,
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
