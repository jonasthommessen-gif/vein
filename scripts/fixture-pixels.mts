/**
 * Load forearm fixture twice through metrics + profile pipeline; assert identical scores.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createRequire } from 'node:module';

// Dynamic import after ensuring pngjs — metrics via compiled approach:
// Re-implement minimal bridge by importing compiled? Use vite-node instead.
const require = createRequire(import.meta.url);

async function main() {
  // Prefer running through vite-node for TS imports
  const { computeRawMetrics, metricsToDisplayScores } = await import('../src/vision/metrics.ts');
  const { profileFromFeatures } = await import('../src/domain/profile.ts');
  const { AnalysisSession } = await import('../src/vision/session.ts');

  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const buf = readFileSync(join(root, 'public/fixtures/forearm_reference.png'));
  const png = PNG.sync.read(buf);

  // Downscale to ~320x240 cover crop for analysis
  const tw = 320;
  const th = 240;
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

  function runOnce() {
    const session = new AnalysisSession();
    const frame = { data, width: tw, height: th, timestamp: 0 };
    const result = session.processStillToCompletion(frame, 80);
    const profile = profileFromFeatures(result.featureVector, result.smoothed);
    return {
      scores: profile.scores,
      classCode: profile.classCode,
      measured: profile.measured,
      verdict: profile.verdict,
      recommendations: profile.recommendations,
    };
  }

  const a = runOnce();
  const b = runOnce();
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(same ? 'PASS fixture identical twice' : 'FAIL mismatch');
  console.log(JSON.stringify(a, null, 2));
  // Sanity: raw metrics also stable
  const r1 = computeRawMetrics(data, tw, th);
  const r2 = computeRawMetrics(data, tw, th);
  const d1 = metricsToDisplayScores(r1, 1);
  const d2 = metricsToDisplayScores(r2, 1);
  const rawSame = JSON.stringify(d1) === JSON.stringify(d2);
  console.log(rawSame ? 'PASS raw metrics stable' : 'FAIL raw metrics');
  if (!same || !rawSame) process.exit(1);
  // Bars must not all be 100
  const vals = Object.values(a.measured);
  if (vals.every((v) => v === 100)) {
    console.error('FAIL all measured bars at 100');
    process.exit(1);
  }
  console.log('PASS bars not uniformly 100');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
