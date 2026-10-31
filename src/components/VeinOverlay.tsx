import { useEffect, useRef } from 'react';
import type { ScanStage, VeinGeometry } from '../types';

export type OverlayReveal = 'A' | 'B' | 'C' | 'D' | 'hidden';

interface Props {
  geometry: VeinGeometry | null;
  stage: ScanStage;
  analyzing: boolean;
  complete: boolean;
  /** Video or still element for object-fit:cover mapping (optional — uses sample→viewport cover). */
  videoEl?: HTMLVideoElement | HTMLImageElement | null;
}

function stageToReveal(stage: ScanStage, analyzing: boolean, complete: boolean): OverlayReveal {
  if (complete) return 'D';
  if (!analyzing) return 'hidden';
  switch (stage) {
    case 'calibrating_exposure':
      return 'hidden';
    case 'identifying_structures':
      return 'A';
    case 'mapping_patterns':
      return 'B';
    case 'sampling_colour':
      return 'C';
    case 'verifying_consistency':
      return 'C';
    case 'analysis_complete':
      return 'D';
    default:
      return 'hidden';
  }
}

/**
 * Map sample-space coords (cover-cropped analysis frame) onto the displayed
 * object-fit:cover video element.
 */
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

  // Analysis frame already cover-crops source → display also cover-crops same source.
  // Map sample coords as if sample fills the cover rectangle of the display.
  let scale: number;
  let ox = 0;
  let oy = 0;
  if (displayAspect > sampleAspect) {
    // Display wider: sample height maps to display height; width overflows
    scale = displayH / sampleH;
    ox = (displayW - sampleW * scale) / 2;
  } else {
    scale = displayW / sampleW;
    oy = (displayH - sampleH * scale) / 2;
  }
  return { x: sx * scale + ox, y: sy * scale + oy };
}

export function VeinOverlay({ geometry, stage, analyzing, complete, videoEl }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reveal = stageToReveal(stage, analyzing, complete);
  const animRef = useRef(0);
  const startRef = useRef(0);
  const prevReveal = useRef<OverlayReveal>('hidden');

  useEffect(() => {
    if (reveal !== prevReveal.current) {
      startRef.current = performance.now();
      prevReveal.current = reveal;
    }
  }, [reveal]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const draw = (now: number) => {
      if (cancelled) return;
      const parent = canvas.parentElement;
      const dw = parent?.clientWidth ?? window.innerWidth;
      const dh = parent?.clientHeight ?? window.innerHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);

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

      if (reveal === 'hidden' || !geometry || geometry.points.length === 0) {
        animRef.current = requestAnimationFrame(draw);
        return;
      }

      const elapsed = reduced ? 2000 : now - startRef.current;
      const sw = geometry.sampleWidth || 320;
      const sh = geometry.sampleHeight || 240;

      // Prefer mapping via video element size when available (same cover math)
      void videoEl;

      const ice = getComputedStyle(document.documentElement)
        .getPropertyValue('--trace-ice')
        .trim() || '#D8EAF4';

      const points = geometry.points;
      const segments = geometry.segments;

      // Stage reveal progress
      const tA = Math.min(1, elapsed / 400);
      const tB = Math.min(1, Math.max(0, (elapsed - 200) / 600));
      const tC = Math.min(1, Math.max(0, (elapsed - 100) / 500));
      const tD = Math.min(1, elapsed / 450);

      const strengthThresh =
        reveal === 'C' || reveal === 'D' ? 0.38 : 0.22;

      // Soft bloom (restrained)
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      if (reveal === 'A' || reveal === 'B' || reveal === 'C' || reveal === 'D') {
        const pointCount =
          reveal === 'A'
            ? Math.ceil(points.length * tA)
            : points.length;

        for (let i = 0; i < pointCount; i++) {
          const p = points[i];
          if (reveal === 'C' && p.strength < strengthThresh) {
            // Fade unstable
            const fade = 0.15 * (1 - tC);
            if (fade < 0.05) continue;
            const { x, y } = sampleToDisplay(p.x, p.y, sw, sh, dw, dh);
            ctx.beginPath();
            ctx.fillStyle = `rgba(216, 234, 244, ${fade})`;
            ctx.arc(x, y, 1.2, 0, Math.PI * 2);
            ctx.fill();
            continue;
          }
          if (reveal === 'D' && p.strength < strengthThresh) continue;

          const { x, y } = sampleToDisplay(p.x, p.y, sw, sh, dw, dh);
          const alpha =
            reveal === 'D'
              ? 0.55 * tD * p.strength
              : reveal === 'C'
                ? 0.5 * p.strength
                : 0.35 + 0.35 * p.strength * (reveal === 'A' ? tA : 1);

          // Tiny bloom
          ctx.beginPath();
          ctx.fillStyle = `rgba(216, 234, 244, ${alpha * 0.25})`;
          ctx.arc(x, y, 2.4, 0, Math.PI * 2);
          ctx.fill();

          ctx.beginPath();
          ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
          ctx.arc(x, y, 1.1, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      if (reveal === 'B' || reveal === 'C' || reveal === 'D') {
        const segLimit =
          reveal === 'B' ? Math.ceil(segments.length * tB) : segments.length;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (let i = 0; i < segLimit; i++) {
          const s = segments[i];
          if ((reveal === 'C' || reveal === 'D') && s.strength < strengthThresh) {
            if (reveal === 'C') {
              const a = sampleToDisplay(s.x0, s.y0, sw, sh, dw, dh);
              const b = sampleToDisplay(s.x1, s.y1, sw, sh, dw, dh);
              ctx.beginPath();
              ctx.strokeStyle = `rgba(216, 234, 244, ${0.08 * (1 - tC)})`;
              ctx.lineWidth = 1;
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
            }
            continue;
          }

          const a = sampleToDisplay(s.x0, s.y0, sw, sh, dw, dh);
          const b = sampleToDisplay(s.x1, s.y1, sw, sh, dw, dh);
          const alpha =
            reveal === 'D'
              ? 0.5 * tD * s.strength
              : reveal === 'B'
                ? 0.4 * s.strength * tB
                : 0.45 * s.strength;

          // Bloom stroke
          ctx.beginPath();
          ctx.strokeStyle = ice.replace(')', `, ${alpha * 0.35})`).startsWith('#')
            ? `rgba(216, 234, 244, ${alpha * 0.3})`
            : `rgba(216, 234, 244, ${alpha * 0.3})`;
          ctx.lineWidth = 2;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();

          ctx.beginPath();
          ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
          ctx.lineWidth = 1.15;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }

      ctx.restore();
      animRef.current = requestAnimationFrame(draw);
    };

    animRef.current = requestAnimationFrame(draw);
    return () => {
      cancelled = true;
      cancelAnimationFrame(animRef.current);
    };
  }, [geometry, reveal, videoEl]);

  return (
    <canvas
      ref={canvasRef}
      className="vein-overlay"
      aria-hidden
    />
  );
}
