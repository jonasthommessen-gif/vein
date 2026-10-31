import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { computeRawMetrics } from '../src/vision/metrics.ts';

function load(path: string, tw = 320, th = 240) {
  const png = PNG.sync.read(readFileSync(path));
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

const arm = load('public/fixtures/forearm_reference.png');
const r = computeRawMetrics(arm.data, arm.tw, arm.th);
const g = r.geometry;
let nearBorder = 0;
let nearCenter = 0;
for (const p of g.points) {
  const edge = Math.min(
    p.x - g.roiX,
    g.roiX + g.roiW - p.x,
    p.y - g.roiY,
    g.roiY + g.roiH - p.y,
  );
  if (edge < 8) nearBorder += 1;
  else nearCenter += 1;
}

console.log(
  'ARM',
  JSON.stringify(
    {
      suitable: r.targetSuitability.suitable,
      score: +r.targetSuitability.score.toFixed(3),
      organic: +r.organicScore.toFixed(3),
      edgeReg: +r.edgeRegularity.toFixed(3),
      lineStructure: +r.lineStructure.toFixed(3),
      points: g.points.length,
      segments: g.segments.length,
      polylines: g.polylines.length,
      junctions: g.junctions.length,
      polyLens: g.polylines.map((p) => p.points.length),
      nearBorder,
      nearCenter,
      junctionDegrees: g.junctions.map((j) => j.degree).slice(0, 12),
    },
    null,
    2,
  ),
);

const desk = new Uint8ClampedArray(320 * 240 * 4);
for (let y = 0; y < 240; y++) {
  for (let x = 0; x < 320; x++) {
    const i = (y * 320 + x) * 4;
    const inside = x > 80 && x < 240 && y > 40 && y < 200;
    const v = inside ? 210 : 140;
    desk[i] = v;
    desk[i + 1] = v;
    desk[i + 2] = v;
    desk[i + 3] = 255;
  }
}
const d = computeRawMetrics(desk, 320, 240);
console.log(
  'DESK',
  JSON.stringify({
    suitable: d.targetSuitability.suitable,
    organic: +d.organicScore.toFixed(3),
    edgeReg: +d.edgeRegularity.toFixed(3),
    polylines: d.geometry.polylines.length,
    points: d.geometry.points.length,
    segments: d.geometry.segments.length,
  }),
);
