import type { VeinGeometry } from '../types';

/**
 * Map sample-space coords (analysis buffer, object-fit:cover) onto a capture
 * still that was scaled from the same source with the same cover crop.
 */
function sampleToStill(
  sx: number,
  sy: number,
  sampleW: number,
  sampleH: number,
  stillW: number,
  stillH: number,
): { x: number; y: number } {
  const sampleAspect = sampleW / sampleH;
  const stillAspect = stillW / stillH;
  let scale: number;
  let ox = 0;
  let oy = 0;
  if (stillAspect > sampleAspect) {
    scale = stillH / sampleH;
    ox = (stillW - sampleW * scale) / 2;
  } else {
    scale = stillW / sampleW;
    oy = (stillH - sampleH * scale) / 2;
  }
  return { x: sx * scale + ox, y: sy * scale + oy };
}

function paintGeometry(
  ctx: CanvasRenderingContext2D,
  geometry: VeinGeometry,
  stillW: number,
  stillH: number,
): void {
  const sw = geometry.sampleWidth || 320;
  const sh = geometry.sampleHeight || 240;
  const ice = '180, 220, 236';

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const polylines = geometry.polylines ?? [];
  for (const pl of polylines) {
    if (pl.points.length < 2 || pl.stability < 0.28) continue;
    const alpha = 0.55 * pl.strength * pl.stability;
    const trunk = 1.1 + pl.weight * 2.6;
    const pts = pl.points.map((p) =>
      sampleToStill(p.x, p.y, sw, sh, stillW, stillH),
    );

    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = `rgba(${ice}, ${alpha * 0.3})`;
    ctx.lineWidth = trunk * 2.8;
    ctx.stroke();

    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = `rgba(${ice}, ${alpha * 0.9})`;
    ctx.lineWidth = trunk;
    ctx.stroke();

    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.strokeStyle = `rgba(255, 255, 255, ${alpha * 0.55})`;
    ctx.lineWidth = Math.max(0.6, trunk * 0.28);
    ctx.stroke();
  }

  if (polylines.length === 0) {
    for (const s of geometry.segments) {
      if (s.strength < 0.3) continue;
      const a = sampleToStill(s.x0, s.y0, sw, sh, stillW, stillH);
      const b = sampleToStill(s.x1, s.y1, sw, sh, stillW, stillH);
      const alpha = 0.45 * s.strength;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${ice}, ${alpha * 0.45})`;
      ctx.lineWidth = 1.6 + (s.weight ?? 0.5) * 1.8;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  for (const j of geometry.junctions ?? []) {
    if (j.strength < 0.28) continue;
    const { x, y } = sampleToStill(j.x, j.y, sw, sh, stillW, stillH);
    const r = j.degree >= 3 ? 2.8 : 1.8;
    const a = 0.65 * j.strength;

    ctx.beginPath();
    ctx.fillStyle = `rgba(${ice}, ${a * 0.35})`;
    ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = `rgba(255, 255, 255, ${a})`;
    ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
    ctx.fill();

    // Angle / orientation ticks
    const angles = j.angles ?? [];
    if (angles.length > 0) {
      const tick = j.degree >= 3 ? 9 : 6;
      ctx.strokeStyle = `rgba(255, 255, 255, ${a * 0.75})`;
      ctx.lineWidth = 1.1;
      for (const ang of angles) {
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(ang) * (r + 1), y + Math.sin(ang) * (r + 1));
        ctx.lineTo(x + Math.cos(ang) * (r + tick), y + Math.sin(ang) * (r + tick));
        ctx.stroke();
      }
    }
  }

  ctx.restore();
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load capture still'));
    img.src = src;
  });
}

/**
 * Bake vein geometry (ice centrelines + junction ticks) into a capture still.
 * Returns a JPEG/WebP data URL; falls back to the original src on failure.
 */
export async function bakeVeinOverlayOntoStill(
  stillSrc: string,
  geometry: VeinGeometry | null | undefined,
  opts?: { quality?: number; type?: string },
): Promise<string> {
  if (!geometry) return stillSrc;
  const has =
    (geometry.polylines?.length ?? 0) > 0 ||
    geometry.segments.length > 0 ||
    (geometry.junctions?.length ?? 0) > 0 ||
    geometry.points.length > 0;
  if (!has) return stillSrc;

  try {
    const img = await loadImage(stillSrc);
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width;
    canvas.height = img.naturalHeight || img.height;
    if (!canvas.width || !canvas.height) return stillSrc;
    const ctx = canvas.getContext('2d');
    if (!ctx) return stillSrc;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    paintGeometry(ctx, geometry, canvas.width, canvas.height);
    const type = opts?.type ?? 'image/jpeg';
    const quality = opts?.quality ?? 0.82;
    try {
      return canvas.toDataURL(type, quality);
    } catch {
      return canvas.toDataURL('image/jpeg', quality);
    }
  } catch {
    return stillSrc;
  }
}
