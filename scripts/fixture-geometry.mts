/**
 * Regression: forearm fixture polylines must sit closer to interior vein
 * valleys than to the limb silhouette; synthetic desk must be empty/near-empty.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { computeRawMetrics, extractGrayscaleRoi } from '../src/vision/metrics.ts';
import { medianDistanceToMask } from '../src/vision/veinGeometry.ts';

function coverCrop(
  png: PNG,
  tw = 320,
  th = 240,
): { data: Uint8ClampedArray; tw: number; th: number } {
  const targetAspect = tw / th;
  const srcAspect = png.width / png.height;
  let sx = 0;
  let sy = 0;
  let sw = png.width;
  let sh = png.height;
  if (srcAspect > targetAspect) {
    sw = Math.floor(png.height * targetAspect);
    sx = Math.floor((png.width - sw) / 2);
  } else {
    sh = Math.floor(png.width / targetAspect);
    sy = Math.floor((png.height - sh) / 2);
  }
  const data = new Uint8ClampedArray(tw * th * 4);
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      const srcX = sx + Math.floor((x / tw) * sw);
      const srcY = sy + Math.floor((y / th) * sh);
      const si = (srcY * png.width + srcX) << 2;
      const di = (y * tw + x) << 2;
      data[di] = png.data[si];
      data[di + 1] = png.data[si + 1];
      data[di + 2] = png.data[si + 2];
      data[di + 3] = 255;
    }
  }
  return { data, tw, th };
}

function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const out = new Float32Array(w * h);
  const tmp = new Float32Array(w * h);
  const d = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / d;
      sum +=
        src[y * w + Math.max(0, Math.min(w - 1, x + r + 1))] -
        src[y * w + Math.max(0, Math.min(w - 1, x - r))];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / d;
      sum +=
        tmp[Math.max(0, Math.min(h - 1, y + r + 1)) * w + x] -
        tmp[Math.max(0, Math.min(h - 1, y - r)) * w + x];
    }
  }
  return out;
}

/** Approximate visible vein pixels: dark + blue-green relative to local skin mean. */
function buildVeinMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { mask: Uint8Array; w: number; h: number; roiX: number; roiY: number } {
  const { gray, skin, rCh, gCh, bCh, w, h, x0, y0 } = extractGrayscaleRoi(
    data,
    width,
    height,
    0.6,
  );
  const blur5 = boxBlur(gray, w, h, 5);
  const bg = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) bg[i] = (gCh[i] + bCh[i]) * 0.5 - rCh[i];
  const bgBlur = boxBlur(bg, w, h, 4);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (skin[i] < 0.2) continue;
    const darkness = blur5[i] - gray[i];
    const chroma = bg[i] - bgBlur[i];
    if (darkness > 4 && chroma > -2) mask[i] = 1;
    else if (darkness > 7) mask[i] = 1;
  }
  return { mask, w, h, roiX: x0, roiY: y0 };
}

/** Limb silhouette ring: skin-like pixels that neighbour non-skin / ROI edge. */
function buildSilhouetteMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { mask: Uint8Array; w: number; h: number } {
  const { gray, skin, w, h } = extractGrayscaleRoi(data, width, height, 0.6);
  const skinBin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    skinBin[i] = skin[i] >= 0.22 || (gray[i] > 50 && gray[i] < 235 && skin[i] > 0.08) ? 1 : 0;
  }
  const mask = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!skinBin[i]) continue;
      let border = false;
      for (let dy = -1; dy <= 1 && !border; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!skinBin[(y + dy) * w + (x + dx)]) {
            border = true;
            break;
          }
        }
      }
      if (border) mask[i] = 1;
    }
  }
  // Dilate silhouette ring slightly
  const dil = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let hit = 0;
      for (let dy = -2; dy <= 2 && !hit; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (mask[(y + dy) * w + (x + dx)]) {
            hit = 1;
            break;
          }
        }
      }
      dil[y * w + x] = hit;
    }
  }
  return { mask: dil, w, h };
}

function syntheticDesk(): Uint8ClampedArray {
  const desk = new Uint8ClampedArray(320 * 240 * 4);
  for (let y = 0; y < 240; y++) {
    for (let x = 0; x < 320; x++) {
      const i = (y * 320 + x) * 4;
      // Flat wood-ish desk with a soft rectangular shadow — no veins
      const v = 168 + ((x * 3 + y * 5) % 7) - 3;
      const edge = x < 2 || y < 2 || x > 317 || y > 237 ? 90 : v;
      desk[i] = edge;
      desk[i + 1] = edge - 4;
      desk[i + 2] = edge - 10;
      desk[i + 3] = 255;
    }
  }
  return desk;
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const buf = readFileSync(join(root, 'public/fixtures/forearm_reference.png'));
  const png = PNG.sync.read(buf);
  const arm = coverCrop(png);

  const raw = computeRawMetrics(arm.data, arm.tw, arm.th);
  const g = raw.geometry;

  const vein = buildVeinMask(arm.data, arm.tw, arm.th);
  const sil = buildSilhouetteMask(arm.data, arm.tw, arm.th);

  const dVein = medianDistanceToMask(g, vein.mask, vein.w, vein.h);
  const dSil = medianDistanceToMask(g, sil.mask, sil.w, sil.h);

  const armSummary = {
    suitable: raw.targetSuitability.suitable,
    organic: +raw.organicScore.toFixed(3),
    edgeReg: +raw.edgeRegularity.toFixed(3),
    polylines: g.polylines.length,
    points: g.points.length,
    junctions: g.junctions.length,
    medianDistVein: dVein,
    medianDistSilhouette: dSil,
  };
  console.log('ARM', JSON.stringify(armSummary, null, 2));

  let failed = false;
  if (g.polylines.length + g.points.length === 0) {
    console.error('FAIL forearm produced empty geometry');
    failed = true;
  }
  if (!(dVein < dSil)) {
    console.error(
      `FAIL forearm median dist to veins (${dVein}) must be < silhouette (${dSil})`,
    );
    failed = true;
  } else {
    console.log('PASS forearm closer to vein pixels than silhouette');
  }

  // Share of polyline vertices near silhouette ring must be low
  let nearSil = 0;
  let totalV = 0;
  for (const pl of g.polylines) {
    for (const p of pl.points) {
      totalV += 1;
      const lx = Math.round(p.x - g.roiX);
      const ly = Math.round(p.y - g.roiY);
      if (lx >= 0 && ly >= 0 && lx < sil.w && ly < sil.h && sil.mask[ly * sil.w + lx]) {
        nearSil += 1;
      }
    }
  }
  const silShare = totalV ? nearSil / totalV : 0;
  console.log(`silhouette-vertex share ${silShare.toFixed(3)} (${nearSil}/${totalV})`);
  if (silShare > 0.35) {
    console.error('FAIL too many polyline vertices on silhouette ring');
    failed = true;
  } else {
    console.log('PASS silhouette-vertex share low');
  }

  const desk = syntheticDesk();
  const dRaw = computeRawMetrics(desk, 320, 240);
  const deskGeom =
    dRaw.geometry.polylines.length +
    dRaw.geometry.points.length +
    dRaw.geometry.segments.length;
  console.log(
    'DESK',
    JSON.stringify({
      suitable: dRaw.targetSuitability.suitable,
      polylines: dRaw.geometry.polylines.length,
      points: dRaw.geometry.points.length,
      segments: dRaw.geometry.segments.length,
      organic: +dRaw.organicScore.toFixed(3),
    }),
  );
  if (dRaw.targetSuitability.suitable || deskGeom > 2) {
    console.error('FAIL desk must be empty/near-empty and unsuitable');
    failed = true;
  } else {
    console.log('PASS desk empty/near-empty');
  }

  // Write a tiny debug summary for the ship report
  const out = join(root, 'scripts/.geometry-check.json');
  writeFileSync(
    out,
    JSON.stringify({ arm: armSummary, deskGeom, silShare, ok: !failed }, null, 2),
  );

  if (failed) process.exit(1);
  console.log('PASS fixture geometry regression');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
