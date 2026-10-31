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

const ICE = '126, 200, 240';
const ICE_HI = '184, 232, 255';
const NEAR_WHITE = '245, 251, 255';

function paintGeometry(
  ctx: CanvasRenderingContext2D,
  geometry: VeinGeometry,
  stillW: number,
  stillH: number,
): void {
  const sw = geometry.sampleWidth || 320;
  const sh = geometry.sampleHeight || 240;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const polylines = geometry.polylines ?? [];
  for (const pl of polylines) {
    if (pl.points.length < 2 || pl.stability < 0.28) continue;
    const vis = Math.max(0.75, pl.stability);
    const alpha = 0.95 * Math.max(0.55, pl.strength) * vis;
    const trunk = 1.5 + pl.weight * 3.4;
    const pts = pl.points.map((p) =>
      sampleToStill(p.x, p.y, sw, sh, stillW, stillH),
    );

    const path = () => {
      ctx.beginPath();
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    };

    path();
    ctx.strokeStyle = `rgba(${ICE}, ${Math.min(0.55, alpha * 0.42)})`;
    ctx.lineWidth = trunk * 3.6;
    ctx.stroke();

    path();
    ctx.strokeStyle = `rgba(${ICE_HI}, ${Math.min(0.95, alpha * 0.92)})`;
    ctx.lineWidth = trunk * 1.15;
    ctx.stroke();

    path();
    ctx.strokeStyle = `rgba(${NEAR_WHITE}, ${Math.min(1, alpha)})`;
    ctx.lineWidth = Math.max(1.2, trunk * 0.42);
    ctx.stroke();
  }

  if (polylines.length === 0) {
    for (const s of geometry.segments) {
      if (s.strength < 0.3) continue;
      const a = sampleToStill(s.x0, s.y0, sw, sh, stillW, stillH);
      const b = sampleToStill(s.x1, s.y1, sw, sh, stillW, stillH);
      const alpha = 0.8 * s.strength;
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${ICE}, ${alpha * 0.5})`;
      ctx.lineWidth = 2.4 + (s.weight ?? 0.5) * 2.2;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.strokeStyle = `rgba(${NEAR_WHITE}, ${alpha})`;
      ctx.lineWidth = 1.2 + (s.weight ?? 0.5) * 0.7;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  for (const j of geometry.junctions ?? []) {
    if (j.strength < 0.28) continue;
    const { x, y } = sampleToStill(j.x, j.y, sw, sh, stillW, stillH);
    const r = j.degree >= 3 ? 3.2 : 2.2;
    const a = 0.9 * Math.max(0.5, j.strength);

    ctx.beginPath();
    ctx.fillStyle = `rgba(${ICE}, ${a * 0.45})`;
    ctx.arc(x, y, r * 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.fillStyle = `rgba(${NEAR_WHITE}, ${Math.min(1, a)})`;
    ctx.arc(x, y, r * 0.95, 0, Math.PI * 2);
    ctx.fill();

    const angles = j.angles ?? [];
    if (angles.length > 0) {
      const tick = j.degree >= 3 ? 10 : 6.5;
      ctx.strokeStyle = `rgba(${NEAR_WHITE}, ${a * 0.85})`;
      ctx.lineWidth = 1.2;
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
 * Bake vein geometry (bright ice centrelines + junction ticks) into a capture still.
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
