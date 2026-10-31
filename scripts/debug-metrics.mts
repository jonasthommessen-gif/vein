import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { computeRawMetrics, metricsToDisplayScores } from '../src/vision/metrics.ts';

function loadDownscaled(path: string, tw = 320, th = 240) {
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

const { data, tw, th } = loadDownscaled('public/fixtures/forearm_reference.png');
const raw = computeRawMetrics(data, tw, th);
console.log('forearm raw', raw);
console.log('forearm display', metricsToDisplayScores(raw, 0.95));

const blank = new Uint8ClampedArray(tw * th * 4);
for (let i = 0; i < blank.length; i += 4) {
  blank[i] = 180;
  blank[i + 1] = 180;
  blank[i + 2] = 185;
  blank[i + 3] = 255;
}
const rawB = computeRawMetrics(blank, tw, th);
console.log('blank raw', rawB);
console.log('blank display', metricsToDisplayScores(rawB, 0.95));
