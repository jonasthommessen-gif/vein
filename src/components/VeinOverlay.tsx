import { useEffect, useRef } from 'react';
import type { ComputationViz, VeinGeometry } from '../types';

interface Props {
  geometry: VeinGeometry | null;
  computation: ComputationViz | null;
  analyzing: boolean;
  complete: boolean;
}

/** Bright ice-blue vein fill — readable on skin / camera, not neon red. */
const ICE = '126, 200, 240'; // #7EC8F0
const ICE_HI = '184, 232, 255'; // #B8E8FF
const NEAR_WHITE = '245, 251, 255'; // #F5FBFF

function sampleToDisplay(
  sx: number,
  sy: number,
  sampleW: number,
  sampleH: number,
  displayW: number,
  displayH: number,
): { x: number; y: number } {
  const sampleAspect = sampleW / sampleH;
  const displayAspect = displayW / displayH;
  let scale: number;
  let ox = 0;
  let oy = 0;
  if (displayAspect > sampleAspect) {
    scale = displayH / sampleH;
    ox = (displayW - sampleW * scale) / 2;
  } else {
    scale = displayW / sampleW;
    oy = (displayH - sampleH * scale) / 2;
  }
  return { x: sx * scale + ox, y: sy * scale + oy };
}

/**
 * Computational visualization overlay — saturated ice/cyan ridge polylines,
 * junction markers on stable lines, math HUD near metric bars (right).
 */
export function VeinOverlay({ geometry, computation, analyzing, complete }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const geomRef = useRef(geometry);
  const compRef = useRef(computation);
  const stateRef = useRef({ analyzing, complete });

  geomRef.current = geometry;
  compRef.current = computation;
  stateRef.current = { analyzing, complete };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let raf = 0;
    let lastDraw = 0;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const minInterval = reduced ? 80 : 55;

    const draw = (now: number) => {
      if (cancelled) return;
      raf = requestAnimationFrame(draw);
      if (now - lastDraw < minInterval) return;
      lastDraw = now;

      const parent = canvas.parentElement;
      const dw = parent?.clientWidth ?? window.innerWidth;
      const dh = parent?.clientHeight ?? window.innerHeight;
      const dpr = Math.min(1.75, window.devicePixelRatio || 1);

      if (canvas.width !== Math.floor(dw * dpr) || canvas.height !== Math.floor(dh * dpr)) {
        canvas.width = Math.floor(dw * dpr);
        canvas.height = Math.floor(dh * dpr);
        canvas.style.width = `${dw}px`;
        canvas.style.height = `${dh}px`;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, dw, dh);

      const { analyzing: isAn, complete: isDone } = stateRef.current;
      if (!isAn && !isDone) return;

      const geom = geomRef.current;
      const comp = compRef.current;
      const phase = comp?.phase ?? (isDone ? 'completion' : 'acquisition');

      // Math HUD — right side under metric-bar cluster (NOT under % / stage on left)
      if (comp && (phase === 'analysis' || phase === 'verification' || phase === 'completion')) {
        drawMathHud(ctx, comp, dw, phase === 'completion' ? 0.55 : 0.85);
      } else if (comp && phase === 'acquisition') {
        drawCalibration(ctx, dw, dh, comp, 0.5);
      }

      const hasRidge =
        geom &&
        ((geom.polylines?.length ?? 0) > 0 ||
          geom.segments.length > 0 ||
          (geom.junctions?.length ?? 0) > 0);

      if (!hasRidge || !geom) {
        if (comp?.signature && phase === 'completion') {
          drawSignature(ctx, comp.signature, dw, 0.7);
        }
        return;
      }

      const sw = geom.sampleWidth || 320;
      const sh = geom.sampleHeight || 240;

      const showPaths =
        phase === 'extraction' ||
        phase === 'analysis' ||
        phase === 'verification' ||
        phase === 'completion';
      // Keep lines bright through verification/completion — no quiet fade-out
      const holdBright = phase === 'verification' || phase === 'completion';

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (showPaths) {
        const polylines = geom.polylines ?? [];
        if (polylines.length > 0) {
          for (const pl of polylines) {
            if (pl.points.length < 2) continue;
            // Only skip truly unverified ephemeral paths late in the scan
            if (holdBright && pl.stability < 0.4) continue;

            const vis = Math.max(0.72, pl.stability);
            const alpha = (holdBright ? 0.95 : 0.88) * Math.max(0.55, pl.strength) * vis;
            const trunk = 1.35 + pl.weight * 3.2;

            const path = () => {
              ctx.beginPath();
              for (let i = 0; i < pl.points.length; i++) {
                const p = sampleToDisplay(pl.points[i].x, pl.points[i].y, sw, sh, dw, dh);
                if (i === 0) ctx.moveTo(p.x, p.y);
                else ctx.lineTo(p.x, p.y);
              }
            };

            // Soft bloom halo
            path();
            ctx.strokeStyle = `rgba(${ICE}, ${Math.min(0.55, alpha * 0.42)})`;
            ctx.lineWidth = trunk * 3.4;
            ctx.stroke();

            // Saturated ice-blue body
            path();
            ctx.strokeStyle = `rgba(${ICE_HI}, ${Math.min(0.95, alpha * 0.92)})`;
            ctx.lineWidth = trunk * 1.15;
            ctx.stroke();

            // Near-white core — high read on skin
            path();
            ctx.strokeStyle = `rgba(${NEAR_WHITE}, ${Math.min(1, alpha)})`;
            ctx.lineWidth = Math.max(1.1, trunk * 0.42);
            ctx.stroke();
          }
        } else {
          // Segment fallback only when no polylines yet
          for (const s of geom.segments) {
            if (holdBright && s.strength < 0.35) continue;
            const a = sampleToDisplay(s.x0, s.y0, sw, sh, dw, dh);
            const b = sampleToDisplay(s.x1, s.y1, sw, sh, dw, dh);
            const wt = s.weight ?? 0.5;
            const alpha = (holdBright ? 0.85 : 0.75) * Math.max(0.5, s.strength);
            ctx.beginPath();
            ctx.strokeStyle = `rgba(${ICE}, ${alpha * 0.5})`;
            ctx.lineWidth = 2.2 + wt * 2.4;
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
            ctx.beginPath();
            ctx.strokeStyle = `rgba(${NEAR_WHITE}, ${alpha})`;
            ctx.lineWidth = 1.1 + wt * 0.7;
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }

      // Dots only as junction markers on stable lines — not the primary viz
      const junctions = geom.junctions ?? [];
      if (showPaths && junctions.length > 0) {
        for (const j of junctions) {
          if (holdBright && j.strength < 0.28) continue;
          const { x, y } = sampleToDisplay(j.x, j.y, sw, sh, dw, dh);
          const r = j.degree >= 3 ? 3.1 : 2.2;
          const a = (holdBright ? 0.9 : 0.8) * Math.max(0.5, j.strength);

          ctx.beginPath();
          ctx.fillStyle = `rgba(${ICE}, ${a * 0.45})`;
          ctx.arc(x, y, r * 2.4, 0, Math.PI * 2);
          ctx.fill();

          ctx.beginPath();
          ctx.fillStyle = `rgba(${NEAR_WHITE}, ${Math.min(1, a)})`;
          ctx.arc(x, y, r * 0.95, 0, Math.PI * 2);
          ctx.fill();

          const angles = j.angles ?? [];
          if (angles.length > 0) {
            const tick = j.degree >= 3 ? 9 : 6;
            ctx.strokeStyle = `rgba(${NEAR_WHITE}, ${a * 0.85})`;
            ctx.lineWidth = 1.15;
            for (const ang of angles) {
              ctx.beginPath();
              ctx.moveTo(x + Math.cos(ang) * (r + 1), y + Math.sin(ang) * (r + 1));
              ctx.lineTo(
                x + Math.cos(ang) * (r + tick),
                y + Math.sin(ang) * (r + tick),
              );
              ctx.stroke();
            }
          }
        }
      }

      if (
        comp &&
        (phase === 'analysis' || phase === 'verification') &&
        comp.samples.length > 0
      ) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
        for (const s of comp.samples) {
          const { x, y } = sampleToDisplay(s.x, s.y, sw, sh, dw, dh);
          const a = 0.55 * s.life;
          ctx.fillStyle = `rgba(220, 230, 236, ${a})`;
          ctx.fillText(s.label, x + 6, y - 4);
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${ICE_HI}, ${a * 0.7})`;
          ctx.lineWidth = 0.8;
          ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      ctx.restore();

      if (comp?.signature && (phase === 'verification' || phase === 'completion')) {
        drawSignature(ctx, comp.signature, dw, phase === 'completion' ? 0.75 : 0.45);
      }
    };

    raf = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={canvasRef} className="vein-overlay" aria-hidden />;
}

function drawCalibration(
  ctx: CanvasRenderingContext2D,
  dw: number,
  dh: number,
  comp: ComputationViz,
  alpha: number,
) {
  const cx = dw * 0.5;
  const cy = dh * 0.48;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = 'rgba(126, 200, 240, 0.45)';
  ctx.lineWidth = 0.8;
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + comp.contrast * 2;
    const r = 28 + i * 2;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * (r - 4), cy + Math.sin(ang) * (r - 4));
    ctx.lineTo(cx + Math.cos(ang) * (r + 4), cy + Math.sin(ang) * (r + 4));
    ctx.stroke();
  }
  ctx.restore();
}

/** Compact math HUD aligned with floating metric bars (top-right cluster). */
function drawMathHud(
  ctx: CanvasRenderingContext2D,
  comp: ComputationViz,
  dw: number,
  alpha: number,
) {
  const marginX = 16;
  const hw = 52;
  // Right edge of metric column (~158px wide metrics + margin)
  const x0 = dw - marginX - Math.max(hw, 72);
  // Sit just under the five metric rows (top safe + brand + metrics stack)
  const y0 = 56 + 5 * 36 + 8;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'source-over';

  const hist = comp.luminanceHist;
  const hh = 16;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  for (let i = 0; i < hist.length; i++) {
    const bw = hw / hist.length;
    const bh = Math.max(1, hist[i] * hh);
    ctx.fillRect(x0 + i * bw, y0 + hh - bh, bw * 0.75, bh);
  }
  ctx.strokeStyle = 'rgba(126, 200, 240, 0.3)';
  ctx.lineWidth = 0.6;
  ctx.strokeRect(x0, y0, hw, hh);

  const histY = y0 + hh + 8;
  const spark = comp.stabilityHistory;
  if (spark.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(184, 232, 255, 0.65)';
    ctx.lineWidth = 0.9;
    for (let i = 0; i < spark.length; i++) {
      const sx = x0 + (i / (spark.length - 1)) * hw;
      const sy = histY + 12 - spark[i] * 10;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }

  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = 'rgba(230, 236, 240, 0.65)';
  ctx.textAlign = 'left';
  const ty = histY + 24;
  ctx.fillText(`ρ ${(comp.density * 100).toFixed(0)}`, x0, ty);
  ctx.fillText(`κ ${(comp.contrast * 100).toFixed(0)}`, x0 + 34, ty);
  ctx.fillText(`ĉ ${(comp.confidence * 100).toFixed(0)}`, x0, ty + 11);

  ctx.restore();
}

function drawSignature(
  ctx: CanvasRenderingContext2D,
  signature: string,
  dw: number,
  alpha: number,
) {
  const marginX = 16;
  // Same right cluster as math HUD / metric bars — never under left % copy
  const x = dw - marginX;
  const y = 56 + 5 * 36 + 8 + 16 + 8 + 24 + 22;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = 'rgba(184, 232, 255, 0.8)';
  ctx.textAlign = 'right';
  ctx.fillText(signature, x, y);
  ctx.restore();
}
