import { useEffect, useRef } from 'react';
import type { ComputationViz, VeinGeometry } from '../types';

interface Props {
  geometry: VeinGeometry | null;
  computation: ComputationViz | null;
  analyzing: boolean;
  complete: boolean;
}

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
 * Computational visualization overlay — spatial clusters, math readouts,
 * and ephemeral detail. Driven only by measured session data.
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
    // Throttle ~18fps for iPhone Safari
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

      // —— B. Math viz (compact, over-camera, no cards) ——
      if (comp && (phase === 'analysis' || phase === 'verification' || phase === 'completion')) {
        drawMathHud(ctx, comp, dw, phase === 'completion' ? 0.55 : 0.85);
      } else if (comp && phase === 'acquisition') {
        drawCalibration(ctx, dw, dh, comp, 0.5);
      }

      if (!geom || geom.points.length === 0) {
        if (comp?.signature && phase === 'completion') {
          drawSignature(ctx, comp.signature, dw, dh, 0.7);
        }
        return;
      }

      const sw = geom.sampleWidth || 320;
      const sh = geom.sampleHeight || 240;
      const ice = '216, 234, 244';

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      // —— A. Spatial features (subtle local clusters) ——
      const showSegments =
        phase === 'extraction' ||
        phase === 'analysis' ||
        phase === 'verification' ||
        phase === 'completion';
      const showOri =
        phase === 'extraction' || phase === 'analysis' || phase === 'verification';
      const quiet = phase === 'verification' || phase === 'completion';

      if (showSegments) {
        ctx.lineCap = 'round';
        for (const s of geom.segments) {
          if (s.length > 10) continue;
          if (quiet && s.strength < 0.4) continue;
          const a = sampleToDisplay(s.x0, s.y0, sw, sh, dw, dh);
          const b = sampleToDisplay(s.x1, s.y1, sw, sh, dw, dh);
          const alpha = quiet ? 0.28 * s.strength : 0.38 * s.strength;
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${ice}, ${alpha * 0.35})`;
          ctx.lineWidth = 1.6;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
          ctx.beginPath();
          ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
          ctx.lineWidth = 0.9;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      for (const p of geom.points) {
        if (quiet && !p.accepted && p.strength < 0.42) continue;
        const { x, y } = sampleToDisplay(p.x, p.y, sw, sh, dw, dh);
        const alpha =
          phase === 'acquisition'
            ? 0.25 + 0.3 * p.strength
            : phase === 'completion'
              ? 0.4 * p.strength
              : p.accepted
                ? 0.55 * p.strength
                : 0.32 * p.strength;

        ctx.beginPath();
        ctx.fillStyle = `rgba(${ice}, ${alpha * 0.2})`;
        ctx.arc(x, y, quiet ? 1.6 : 2.1, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        ctx.arc(x, y, p.accepted ? 1.15 : 0.9, 0, Math.PI * 2);
        ctx.fill();

        // Orientation ticks near features
        if (showOri && p.orientation != null) {
          const len = 4.5;
          const tx = Math.cos(p.orientation) * len;
          const ty = Math.sin(p.orientation) * len;
          ctx.beginPath();
          ctx.strokeStyle = `rgba(${ice}, ${alpha * 0.55})`;
          ctx.lineWidth = 0.7;
          ctx.moveTo(x - tx, y - ty);
          ctx.lineTo(x + tx, y + ty);
          ctx.stroke();
        }
      }

      // —— D. Computational detail ——
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
          ctx.strokeStyle = `rgba(${ice}, ${a * 0.7})`;
          ctx.lineWidth = 0.8;
          ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      ctx.restore();

      if (comp?.signature && (phase === 'verification' || phase === 'completion')) {
        drawSignature(ctx, comp.signature, dw, dh, phase === 'completion' ? 0.75 : 0.45);
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
  ctx.strokeStyle = 'rgba(216, 234, 244, 0.35)';
  ctx.lineWidth = 0.8;
  // Sparse calibration ticks — not a scan rectangle
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

function drawMathHud(
  ctx: CanvasRenderingContext2D,
  comp: ComputationViz,
  dw: number,
  alpha: number,
) {
  const x0 = 16;
  const y0 = 72;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = 'source-over';

  // Tiny luminance histogram
  const hist = comp.luminanceHist;
  const hw = 52;
  const hh = 18;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
  for (let i = 0; i < hist.length; i++) {
    const bw = hw / hist.length;
    const bh = Math.max(1, hist[i] * hh);
    ctx.fillRect(x0 + i * bw, y0 + hh - bh, bw * 0.75, bh);
  }
  ctx.strokeStyle = 'rgba(216, 234, 244, 0.25)';
  ctx.lineWidth = 0.6;
  ctx.strokeRect(x0, y0, hw, hh);

  // Stabilization sparkline
  const histY = y0 + hh + 10;
  const spark = comp.stabilityHistory;
  if (spark.length > 1) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(216, 234, 244, 0.55)';
    ctx.lineWidth = 0.9;
    for (let i = 0; i < spark.length; i++) {
      const sx = x0 + (i / (spark.length - 1)) * hw;
      const sy = histY + 14 - spark[i] * 12;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.stroke();
  }

  // Tiny density / contrast / confidence readouts
  ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = 'rgba(230, 236, 240, 0.7)';
  const ty = histY + 28;
  ctx.fillText(`ρ ${(comp.density * 100).toFixed(0)}`, x0, ty);
  ctx.fillText(`κ ${(comp.contrast * 100).toFixed(0)}`, x0 + 36, ty);
  ctx.fillText(`ĉ ${(comp.confidence * 100).toFixed(0)}`, x0, ty + 12);

  // Right-edge subtle mark so HUD doesn't collide with bars
  void dw;
  ctx.restore();
}

function drawSignature(
  ctx: CanvasRenderingContext2D,
  signature: string,
  dw: number,
  dh: number,
  alpha: number,
) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillStyle = 'rgba(216, 234, 244, 0.75)';
  ctx.textAlign = 'left';
  ctx.fillText(signature, 16, dh - 110);
  ctx.restore();
  void dw;
}
