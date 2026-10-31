import type { RadarValues, VeinProfile } from '../types';

const W = 1080;
const H = 1350;

const RADAR_AXES: { key: keyof RadarValues; label: string }[] = [
  { key: 'clarity', label: 'Clarity' },
  { key: 'complexity', label: 'Complexity' },
  { key: 'tonalRichness', label: 'Tone' },
  { key: 'consistency', label: 'Consistency' },
  { key: 'rarity', label: 'Rarity' },
  { key: 'nocturnal', label: 'Nocturnal' },
];

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}

function drawRadar(
  ctx: CanvasRenderingContext2D,
  values: RadarValues,
  cx: number,
  cy: number,
  radius: number,
): void {
  const n = RADAR_AXES.length;
  const pointAt = (i: number, v01: number) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const r = radius * Math.max(0, Math.min(1, v01));
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
  };

  ctx.strokeStyle = '#D8DCDB';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < n; i++) {
    const tip = pointAt(i, 1);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  }

  const pts = RADAR_AXES.map((a, i) => pointAt(i, (values[a.key] ?? 0) / 100));
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(23, 26, 28, 0.08)';
  ctx.fill();
  ctx.strokeStyle = '#171A1C';
  ctx.lineWidth = 2;
  ctx.stroke();

  for (const p of pts) {
    ctx.beginPath();
    ctx.fillStyle = '#171A1C';
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = '#667077';
  ctx.font = '450 18px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  for (let i = 0; i < n; i++) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const lx = cx + Math.cos(angle) * (radius + 36);
    const ly = cy + Math.sin(angle) * (radius + 36);
    ctx.textAlign = Math.abs(lx - cx) < 8 ? 'center' : lx < cx ? 'right' : 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(RADAR_AXES[i].label, lx, ly);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
): number {
  const words = text.split(' ');
  let line = '';
  let yy = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      line = word;
      yy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, yy);
  return yy;
}

/** Portrait dossier: capture + radar + class + desirability + verdict. */
export async function renderProfileCard(profile: VeinProfile): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  ctx.fillStyle = '#F7F8F7';
  ctx.fillRect(0, 0, W, H);

  const margin = 64;
  let y = 80;

  ctx.fillStyle = '#949CA1';
  ctx.font = '550 20px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.fillText('VEIN  ·  BLOOD PROFILE', margin, y);

  y += 56;
  ctx.fillStyle = '#171A1C';
  ctx.font = '400 56px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.fillText(`Vein class ${profile.classCode}`, margin, y);

  y += 40;
  ctx.fillStyle = '#667077';
  ctx.font = '400 26px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  y = wrapText(ctx, profile.verdict, margin, y, W - margin * 2, 34) + 28;

  // Capture still
  if (profile.captureImage) {
    try {
      const img = await loadImage(profile.captureImage);
      const maxW = W - margin * 2;
      const maxH = 360;
      const scale = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight);
      const iw = Math.round(img.naturalWidth * scale);
      const ih = Math.round(img.naturalHeight * scale);
      const ix = margin;
      ctx.drawImage(img, ix, y, iw, ih);
      y += ih + 36;
    } catch {
      // skip image
    }
  }

  // Desirability
  ctx.fillStyle = '#171A1C';
  ctx.font = '300 88px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.fillText(String(profile.scores.desirability), margin, y + 70);
  ctx.fillStyle = '#949CA1';
  ctx.font = '500 20px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.fillText('Desirability / 100', margin + 200, y + 54);

  y += 110;

  // Radar
  const radarY = Math.min(y + 160, H - 280);
  drawRadar(ctx, profile.radar, W / 2, radarY, 130);

  // Footer
  ctx.fillStyle = '#949CA1';
  ctx.font = '400 18px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('VEIN / fictional visual profile', margin, H - 56);
  ctx.fillText('Based on visible image characteristics', margin, H - 30);

  if (profile.limitedConfidence) {
    ctx.fillStyle = '#667077';
    ctx.font = '500 18px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
    ctx.fillText('Limited confidence reading', margin, H - 84);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG encode failed'));
    }, 'image/png');
  });
}

export async function shareOrDownload(profile: VeinProfile): Promise<'shared' | 'downloaded'> {
  const blob = await renderProfileCard(profile);
  const file = new File([blob], `vein-${profile.classCode.replace('·', '')}.png`, {
    type: 'image/png',
  });

  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: 'VEIN profile',
        text: `${profile.classCode} · ${profile.verdict}`,
      });
      return 'shared';
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return 'downloaded';
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}
