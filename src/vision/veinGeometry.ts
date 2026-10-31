import type {
  VeinGeometry,
  VeinJunction,
  VeinPoint,
  VeinPolyline,
  VeinSegment,
} from '../types';

/** Interior dark blue-green valley → centreline geometry. Never silhouette. */

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export interface VeinChannelBuffers {
  gray: Float32Array;
  /** Soft skin-like affinity 0–1. */
  skin: Float32Array;
  /** Packed R channel 0–255. */
  rCh: Float32Array;
  gCh: Float32Array;
  bCh: Float32Array;
  w: number;
  h: number;
  roiX: number;
  roiY: number;
  sampleWidth: number;
  sampleHeight: number;
}

interface RidgeSeed {
  x: number;
  y: number;
  strength: number;
  gx: number;
  gy: number;
  localContrast: number;
  orientation: number;
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
    h =
      (h * 33 +
        Math.round(p.x * 3) +
        Math.round(p.y * 5) +
        Math.round(p.strength * 100)) >>>
      0;
  }
  for (let i = 0; i < Math.min(4, polylines.length); i++) {
    h =
      (h * 19 +
        polylines[i].points.length * 7 +
        Math.round(polylines[i].strength * 50)) >>>
      0;
  }
  const hex = (h >>> 0).toString(16).toUpperCase().padStart(6, '0').slice(-6);
  return `Σ${hex.slice(0, 3)}·${hex.slice(3)}`;
}

function boxBlur(gray: Float32Array, w: number, h: number, radius: number): Float32Array {
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

/** Binary erode by radius (box). */
function erodeMask(mask: Uint8Array, w: number, h: number, radius: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let ok = 1;
      for (let dy = -radius; dy <= radius && ok; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) {
          ok = 0;
          break;
        }
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || !mask[yy * w + xx]) {
            ok = 0;
            break;
          }
        }
      }
      out[y * w + x] = ok;
    }
  }
  return out;
}

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
 * Approximate Euclidean distance to nearest zero in mask (coarse ring search).
 * mask=1 is interior; distance 0 on exterior / boundary.
 */
function distanceToExterior(
  interior: Uint8Array,
  w: number,
  h: number,
  maxR = 28,
): Float32Array {
  const dist = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!interior[i]) {
        dist[i] = 0;
        continue;
      }
      let minD = maxR;
      for (let r = 1; r <= maxR; r += 1) {
        let found = false;
        // Sample 12 directions
        for (let t = 0; t < 12 && !found; t++) {
          const ang = (t / 12) * Math.PI * 2;
          const xx = Math.round(x + Math.cos(ang) * r);
          const yy = Math.round(y + Math.sin(ang) * r);
          if (xx < 0 || yy < 0 || xx >= w || yy >= h || !interior[yy * w + xx]) {
            found = true;
            minD = r;
          }
        }
        if (found) break;
      }
      dist[i] = minD;
    }
  }
  return dist;
}

/**
 * Detect interior vein centrelines from dark blue-green valleys on a
 * morphologically eroded skin-like ROI. Explicitly bans silhouette/perimeter.
 */
export function extractInteriorVeinGeometry(
  buf: VeinChannelBuffers,
  blur2: Float32Array,
  blur5: Float32Array,
): { geometry: VeinGeometry; organicScore: number; edgeRegularity: number } {
  const { gray, skin, rCh, gCh, bCh, w, h, roiX, roiY, sampleWidth, sampleHeight } =
    buf;
  const empty = emptyGeometry(sampleWidth, sampleHeight, roiX, roiY, w, h);
  if (w < 16 || h < 16) {
    return { geometry: empty, organicScore: 0, edgeRegularity: 1 };
  }

  // —— 1. Morphological skin-like interior (ban silhouette) ——
  const skinBin = new Uint8Array(w * h);
  let skinCount = 0;
  for (let i = 0; i < w * h; i++) {
    // Soft limb ROI: skin affinity OR mid-tone with some chroma (avoid hard race thresholds)
    const r = rCh[i];
    const g = gCh[i];
    const b = bCh[i];
    const lum = gray[i];
    const chroma = Math.abs(r - g) + Math.abs(r - b) + Math.abs(g - b);
    const midTone = lum > 42 && lum < 240;
    const notFlatGray = chroma > 12 || skin[i] > 0.2;
    const ok = midTone && (skin[i] >= 0.22 || (notFlatGray && r + g + b > 140));
    if (ok) {
      skinBin[i] = 1;
      skinCount += 1;
    }
  }

  if (skinCount < w * h * 0.08) {
    return { geometry: empty, organicScore: 0, edgeRegularity: 0.2 };
  }

  // Close small holes then erode hard — interior only
  const closed = dilateMask(erodeMask(dilateMask(skinBin, w, h, 2), w, h, 2), w, h, 1);
  // Border keep-out ≈ 7–9 px at 320-wide sample (~2% of frame)
  const BORDER_N = Math.max(7, Math.round(Math.min(w, h) * 0.045));
  const interior = erodeMask(closed, w, h, BORDER_N);
  let interiorCount = 0;
  for (let i = 0; i < w * h; i++) if (interior[i]) interiorCount += 1;
  if (interiorCount < 40) {
    return { geometry: empty, organicScore: 0, edgeRegularity: 0.25 };
  }

  const interiorDist = distanceToExterior(interior, w, h, 30);

  // Contour normal ≈ gradient of distance (points outward when negative of grad)
  const distNx = new Float32Array(w * h);
  const distNy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!interior[i]) continue;
      const gx = interiorDist[i + 1] - interiorDist[i - 1];
      const gy = interiorDist[i + w] - interiorDist[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy) + 1e-3;
      distNx[i] = gx / mag;
      distNy[i] = gy / mag;
    }
  }

  // Hard discontinuity / silhouette rim (for regularity + extra ban)
  const silMask = new Uint8Array(w * h);
  let hardEdgeSum = 0;
  let hardEdgeN = 0;
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const i = y * w + x;
      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy);
      const step = Math.max(
        Math.abs(gray[i + 2] - gray[i - 2]),
        Math.abs(gray[i + 2 * w] - gray[i - 2 * w]),
      );
      hardEdgeN += 1;
      if (mag > 40 && step > 44) {
        silMask[i] = 1;
        hardEdgeSum += 1;
      }
    }
  }
  const silKeepOut = dilateMask(silMask, w, h, Math.max(4, Math.round(BORDER_N * 0.7)));

  // —— 2. Vein response: local darkness × soft blue-green cue ——
  const blur3 = boxBlur(gray, w, h, 3);
  const veinResp = new Float32Array(w * h);
  const bgCue = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    // Positive when GB exceeds R (cyan/blue-green depression vs local peach skin)
    bgCue[i] = (gCh[i] + bCh[i]) * 0.5 - rCh[i];
  }
  const bgBlur = boxBlur(bgCue, w, h, 4);

  for (let i = 0; i < w * h; i++) {
    if (!interior[i] || silKeepOut[i]) {
      veinResp[i] = 0;
      continue;
    }
    const darkness = Math.max(0, blur5[i] - gray[i]);
    const dog = Math.max(0, blur5[i] - blur2[i]);
    const localDark = Math.max(0, blur3[i] - gray[i]);
    // Soft chrominance boost: more blue-green than neighbourhood (no hard race gate)
    const bgDelta = bgCue[i] - bgBlur[i];
    const chromaBoost = 0.65 + 0.55 * clamp01((bgDelta + 4) / 18);
    const darkCombo = Math.max(darkness * 0.55, dog * 0.9, localDark * 0.4);
    veinResp[i] = darkCombo * chromaBoost;
  }

  // —— 3. Ridge seeds: NMS on veinResp, deep interior only ——
  const MIN_INTERIOR = Math.max(BORDER_N * 0.85, 6);
  const seeds: RidgeSeed[] = [];
  const step = 2;

  for (let y = 4; y < h - 4; y += step) {
    for (let x = 4; x < w - 4; x += step) {
      const i = y * w + x;
      if (!interior[i] || silKeepOut[i]) continue;
      if (interiorDist[i] < MIN_INTERIOR) continue;
      if (skin[i] < 0.15 && veinResp[i] < 5) continue;

      const v = veinResp[i];
      if (v < 2.4) continue;

      // Reject razor-sharp edges (silhouette leftovers)
      const sharp =
        Math.abs(gray[i] - gray[i - 1]) +
        Math.abs(gray[i] - gray[i + 1]) +
        Math.abs(gray[i] - gray[i - w]) +
        Math.abs(gray[i] - gray[i + w]);
      if (sharp > 88) continue;

      const gx = gray[i + 1] - gray[i - 1];
      const gy = gray[i + w] - gray[i - w];
      const mag = Math.sqrt(gx * gx + gy * gy) + 1e-3;
      const nx = gx / mag;
      const ny = gy / mag;
      const tx = -ny;
      const ty = nx;

      const iNormP = Math.max(
        0,
        Math.min(w * h - 1, Math.round(y + ny) * w + Math.round(x + nx)),
      );
      const iNormM = Math.max(
        0,
        Math.min(w * h - 1, Math.round(y - ny) * w + Math.round(x - nx)),
      );
      // Non-max along intensity gradient (valley centre)
      if (veinResp[i] + 0.2 < veinResp[iNormP] || veinResp[i] + 0.2 < veinResp[iNormM]) {
        continue;
      }

      const iAlong = Math.max(
        0,
        Math.min(w * h - 1, Math.round(y + ty) * w + Math.round(x + tx)),
      );
      const iOpp = Math.max(
        0,
        Math.min(w * h - 1, Math.round(y - ty) * w + Math.round(x - tx)),
      );
      const along = 0.5 * (veinResp[iAlong] + veinResp[iOpp]);
      const across = 0.5 * (veinResp[iNormP] + veinResp[iNormM]);
      const ridgeShape = along + 0.4 - across;
      if (ridgeShape < 0.35) continue;

      // Ban ridges whose tangent is parallel to the outer contour (silhouette hug)
      const contourTx = -distNy[i];
      const contourTy = distNx[i];
      const parallel = Math.abs(tx * contourTx + ty * contourTy);
      if (interiorDist[i] < MIN_INTERIOR + 5 && parallel > 0.82) continue;
      if (parallel > 0.92 && interiorDist[i] < MIN_INTERIOR + 10) continue;

      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      const elongation = Math.abs(ax - ay) / (ax + ay + 1e-3);
      if (elongation < 0.1 && v < 4.5) continue;

      const strength = clamp01(
        (v / 11) *
          (0.4 + 0.35 * elongation + 0.25 * clamp01(ridgeShape / 3)) *
          (0.5 + 0.5 * clamp01(skin[i] + 0.2)) *
          (0.65 + 0.35 * clamp01(interiorDist[i] / 16)),
      );
      if (strength < 0.26) continue;

      seeds.push({
        x,
        y,
        strength,
        gx,
        gy,
        localContrast: clamp01(v / 14),
        orientation: Math.atan2(tx, ty),
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

  // Sparsify
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
      if (kept.length >= 64) break;
    }
  }

  // Drop near-perimeter leftovers; never keep silhouette-adjacent seeds
  const interiorSeeds = kept.filter((c) => {
    if (c.interiorDist < MIN_INTERIOR) return false;
    if (!interior[c.y * w + c.x]) return false;
    if (silKeepOut[c.y * w + c.x]) return false;
    if (edgeRegularity >= 0.5) {
      const ang = ((c.orientation % Math.PI) + Math.PI) % Math.PI;
      const toHoriz = Math.min(ang, Math.PI - ang);
      const toVert = Math.abs(ang - Math.PI / 2);
      if (toHoriz < 0.12 || toVert < 0.12) return false;
    }
    return true;
  });

  // Low confidence → sparse interior samples only (never silhouette fallback)
  const work =
    interiorSeeds.length >= 3
      ? interiorSeeds.slice(0, 52)
      : interiorSeeds.length > 0
        ? interiorSeeds.slice(0, 12)
        : [];

  if (work.length === 0) {
    return { geometry: empty, organicScore: 0, edgeRegularity };
  }

  // —— 4. Link along valley tangent into branching polylines ——
  const adj: number[][] = Array.from({ length: work.length }, () => []);
  const linkDist = 13;
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
      if (align < 0.52) continue;

      const mx = Math.round((a.x + b.x) / 2);
      const my = Math.round((a.y + b.y) / 2);
      if (mx < 0 || my < 0 || mx >= w || my >= h) continue;
      const mi = my * w + mx;
      if (!interior[mi] || silKeepOut[mi] || interiorDist[mi] < MIN_INTERIOR - 1) continue;
      if (veinResp[mi] < 1.1 && Math.min(a.strength, b.strength) < 0.42) continue;

      // Reject chords that run parallel to contour near the keep-out
      const chordTx = dx / dist;
      const chordTy = dy / dist;
      const cTx = -distNy[mi];
      const cTy = distNx[mi];
      const cordParallel = Math.abs(chordTx * cTx + chordTy * cTy);
      if (interiorDist[mi] < MIN_INTERIOR + 4 && cordParallel > 0.85) continue;

      candidates.push({
        j,
        score:
          align *
          (1.2 - dist / linkDist) *
          (0.5 + 0.5 * Math.min(a.strength, b.strength)),
      });
    }

    candidates.sort((u, v) => v.score - u.score);
    for (let k = 0; k < Math.min(3, candidates.length); k++) {
      const j = candidates[k].j;
      if (!adj[i].includes(j)) adj[i].push(j);
      if (!adj[j].includes(i)) adj[j].push(i);
    }
  }

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
        const al =
          (ox / ol) * (incoming.x / inLen) + (oy / ol) * (incoming.y / inLen);
        if (al > bestAlign) {
          bestAlign = al;
          best = n;
        }
      }
      if (adj[cur].length >= 3 && path.length >= 2) break;
      edgeUsed.add(edgeKey(cur, best));
      path.push(best);
      prev = cur;
      cur = best;
      if (path.length > 40) break;
    }
    return path;
  };

  const startOrder = [...Array(work.length).keys()].sort(
    (a, b) => work[b].strength - work[a].strength,
  );
  for (const i of startOrder) {
    if (adj[i].length === 0) continue;
    for (const j of adj[i]) {
      const k = edgeKey(i, j);
      if (edgeUsed.has(k)) continue;
      if (adj[i].length !== 1 && adj[i].length < 3 && adj[j].length === 1) continue;
      const path = walk(i, j);
      if (path.length < 2) continue;
      let str = 0;
      for (const idx of path) str += work[idx].strength;
      str /= path.length;
      polylinesRaw.push({ indices: path, strength: str });
      if (polylinesRaw.length >= 24) break;
    }
    if (polylinesRaw.length >= 24) break;
  }

  const polylines: VeinPolyline[] = [];
  const segments: VeinSegment[] = [];

  for (const pl of polylinesRaw) {
    let deepHits = 0;
    let borderHits = 0;
    let parallelHits = 0;
    for (let k = 0; k < pl.indices.length; k++) {
      const p = work[pl.indices[k]];
      if (p.interiorDist >= MIN_INTERIOR + 2) deepHits += 1;
      if (p.x < 5 || p.y < 5 || p.x > w - 6 || p.y > h - 6) borderHits += 1;
      if (k > 0) {
        const a = work[pl.indices[k - 1]];
        const b = work[pl.indices[k]];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy) + 1e-3;
        const mi = Math.round((a.y + b.y) / 2) * w + Math.round((a.x + b.x) / 2);
        if (mi >= 0 && mi < w * h) {
          const cTx = -distNy[mi];
          const cTy = distNx[mi];
          if (Math.abs((dx / len) * cTx + (dy / len) * cTy) > 0.88) parallelHits += 1;
        }
      }
    }
    const deepRatio = deepHits / pl.indices.length;
    // Ban outline-like / contour-parallel chains
    if (deepRatio < 0.55) continue;
    if (borderHits / pl.indices.length > 0.35) continue;
    if (parallelHits / Math.max(1, pl.indices.length - 1) > 0.55 && deepRatio < 0.85) {
      continue;
    }

    let len = 0;
    for (let k = 1; k < pl.indices.length; k++) {
      const a = work[pl.indices[k - 1]];
      const b = work[pl.indices[k]];
      len += Math.hypot(b.x - a.x, b.y - a.y);
    }
    // Long chains hugging perimeter → discard
    if (len > Math.min(w, h) * 0.55 && deepRatio < 0.7) continue;

    const weight = clamp01(0.35 + 0.4 * pl.strength + 0.35 * clamp01(len / 55));
    const stability = clamp01(0.45 + 0.55 * deepRatio * pl.strength);
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
      segments.push({
        x0: roiX + a.x,
        y0: roiY + a.y,
        x1: roiX + b.x,
        y1: roiY + b.y,
        strength: Math.min(a.strength, b.strength),
        length: Math.hypot(b.x - a.x, b.y - a.y),
        weight,
      });
    }
  }

  // —— 5. Junctions with angle ticks + interior points ——
  const junctions: VeinJunction[] = [];
  const points: VeinPoint[] = [];

  for (let i = 0; i < work.length; i++) {
    const c = work[i];
    const deg = adj[i].length;
    if (deg >= 3) {
      const angles: number[] = [];
      for (const j of adj[i]) {
        angles.push(Math.atan2(work[j].y - c.y, work[j].x - c.x));
      }
      junctions.push({
        x: roiX + c.x,
        y: roiY + c.y,
        strength: c.strength,
        degree: deg,
        angles,
      });
    }
    if (c.interiorDist >= MIN_INTERIOR && (deg >= 1 || c.strength > 0.4)) {
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

  // Terminal ticks on strong trunks
  for (const pl of polylines) {
    if (pl.points.length < 2 || pl.strength < 0.38) continue;
    for (let endIdx = 0; endIdx < 2; endIdx++) {
      const end = endIdx === 0 ? pl.points[0] : pl.points[pl.points.length - 1];
      const prev =
        endIdx === 0 ? pl.points[1] : pl.points[pl.points.length - 2];
      const nearJ = junctions.some(
        (j) => (j.x - end.x) ** 2 + (j.y - end.y) ** 2 < 36,
      );
      if (nearJ) continue;
      if (pl.weight > 0.55 && pl.points.length >= 4) {
        const ang = Math.atan2(end.y - prev.y, end.x - prev.x);
        junctions.push({
          x: end.x,
          y: end.y,
          strength: pl.strength * 0.85,
          degree: 1,
          angles: [ang, ang + Math.PI],
        });
      }
    }
  }

  const finalPolylines = polylines
    .sort((a, b) => b.strength * b.weight - a.strength * a.weight)
    .slice(0, 16);
  const finalJunctions = junctions
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 20);
  const finalPoints = points.sort((a, b) => b.strength - a.strength).slice(0, 36);
  const finalSegments = segments
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 40);

  // If almost nothing survived filters → empty (never silhouette)
  if (finalPolylines.length === 0 && finalPoints.length < 3) {
    return {
      geometry: {
        ...empty,
        points: finalPoints.slice(0, 8),
        signature: buildSignature(finalPoints, [], []),
      },
      organicScore: finalPoints.length >= 3 ? 0.2 : 0,
      edgeRegularity,
    };
  }

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
  const densityScore = clamp01(
    finalPolylines.length / 8 + finalPoints.length / 28,
  );
  const branchScore = clamp01(
    finalJunctions.filter((j) => j.degree >= 3).length / 4,
  );
  const deepCover =
    work.length > 0
      ? work.reduce((s, c) => s + (c.interiorDist >= MIN_INTERIOR + 2 ? 1 : 0), 0) /
        work.length
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
      deepCover * 0.22 +
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

/** Median distance from polyline vertices to a binary target mask (sample space). */
export function medianDistanceToMask(
  geometry: VeinGeometry,
  mask: Uint8Array,
  maskW: number,
  maskH: number,
): number {
  const pts: Array<{ x: number; y: number }> = [];
  for (const pl of geometry.polylines) {
    for (const p of pl.points) pts.push(p);
  }
  for (const p of geometry.points) pts.push(p);
  if (pts.length === 0) return Infinity;

  const dists: number[] = [];
  for (const p of pts) {
    const lx = Math.round(p.x - geometry.roiX);
    const ly = Math.round(p.y - geometry.roiY);
    let minD = 64;
    for (let r = 0; r <= 48; r += 1) {
      let found = false;
      for (let t = 0; t < (r === 0 ? 1 : 16) && !found; t++) {
        const ang = (t / 16) * Math.PI * 2;
        const xx = Math.round(lx + Math.cos(ang) * r);
        const yy = Math.round(ly + Math.sin(ang) * r);
        if (xx < 0 || yy < 0 || xx >= maskW || yy >= maskH) continue;
        if (mask[yy * maskW + xx]) {
          found = true;
          minD = r;
        }
      }
      if (found) break;
    }
    dists.push(minD);
  }
  dists.sort((a, b) => a - b);
  return dists[Math.floor(dists.length / 2)] ?? Infinity;
}
