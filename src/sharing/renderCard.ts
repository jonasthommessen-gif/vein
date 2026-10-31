import type { VeinProfile } from '../types';

const W = 1080;
const H = 1350;

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export async function renderProfileCard(profile: VeinProfile): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');

  // Warm-white background
  ctx.fillStyle = '#F7F8F7';
  ctx.fillRect(0, 0, W, H);

  const margin = 72;
  let y = 96;

  ctx.fillStyle = '#949CA1';
  ctx.font = '550 22px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.letterSpacing = '0.18em';
  ctx.fillText('VEIN', margin, y);
  y += 28;
  ctx.font = '400 20px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.letterSpacing = '0';
  ctx.fillText('Private analysis', margin, y);

  y += 72;
  ctx.fillStyle = '#171A1C';
  ctx.font = '400 64px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.fillText(`Vein class ${profile.classCode}`, margin, y);

  y += 48;
  ctx.fillStyle = '#667077';
  ctx.font = '400 28px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  wrapText(ctx, profile.verdict, margin, y, W - margin * 2, 36);
  y += 56;
  wrapText(ctx, profile.descriptor, margin, y, W - margin * 2, 36);

  y += 80;
  ctx.strokeStyle = '#E6E9E8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(margin, y);
  ctx.lineTo(W - margin, y);
  ctx.stroke();

  y += 80;
  ctx.fillStyle = '#171A1C';
  ctx.font = '300 96px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.fillText(String(profile.scores.desirability), margin, y);
  ctx.fillStyle = '#949CA1';
  ctx.font = '500 22px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.fillText('Desirability / 100', margin + 160, y - 12);

  y += 72;
  const bars: [string, number][] = [
    ['Clarity', profile.scores.clarity],
    ['Complexity', profile.scores.complexity],
    ['Tone', profile.scores.tone],
    ['Consistency', profile.scores.consistency],
    ['Rarity', profile.scores.rarity],
  ];

  for (const [label, value] of bars) {
    ctx.fillStyle = '#667077';
    ctx.font = '500 24px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
    ctx.fillText(label, margin, y);
    ctx.fillStyle = '#171A1C';
    ctx.textAlign = 'right';
    ctx.fillText(String(value), W - margin, y);
    ctx.textAlign = 'left';
    y += 18;
    ctx.fillStyle = '#DEE3E4';
    roundRect(ctx, margin, y, W - margin * 2, 8, 4);
    ctx.fill();
    ctx.fillStyle = '#65737B';
    const fillW = ((W - margin * 2) * value) / 100;
    roundRect(ctx, margin, y, Math.max(4, fillW), 8, 4);
    ctx.fill();
    y += 48;
  }

  y += 24;
  ctx.fillStyle = '#949CA1';
  ctx.font = '400 20px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
  ctx.fillText('VEIN / fictional visual profile', margin, H - 64);
  ctx.fillText('Based on visible image characteristics', margin, H - 36);

  if (profile.limitedConfidence) {
    ctx.fillStyle = '#667077';
    ctx.font = '500 20px -apple-system, BlinkMacSystemFont, Helvetica Neue, sans-serif';
    ctx.fillText('Limited confidence reading', margin, H - 96);
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG encode failed'));
    }, 'image/png');
  });
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
    // User cancel or share failure → fall through to download
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
