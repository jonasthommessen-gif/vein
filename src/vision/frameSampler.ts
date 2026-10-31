/**
 * Samples video or image frames into a downscaled offscreen canvas (~320×240)
 * at a target FPS for analysis.
 */

export interface SampledFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  timestamp: number;
}

export class FrameSampler {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private targetW: number;
  private targetH: number;
  private intervalMs: number;
  private lastSample = 0;
  private rafId: number | null = null;
  private running = false;
  private source: HTMLVideoElement | HTMLImageElement | null = null;
  private onFrame: ((frame: SampledFrame) => void) | null = null;

  constructor(opts?: { width?: number; height?: number; fps?: number }) {
    this.targetW = opts?.width ?? 320;
    this.targetH = opts?.height ?? 240;
    this.intervalMs = 1000 / (opts?.fps ?? 5);
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.targetW;
    this.canvas.height = this.targetH;
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas unavailable');
    this.ctx = ctx;
  }

  start(
    source: HTMLVideoElement | HTMLImageElement,
    onFrame: (frame: SampledFrame) => void,
  ): void {
    this.stop();
    this.source = source;
    this.onFrame = onFrame;
    this.running = true;
    this.lastSample = 0;
    const tick = (t: number) => {
      if (!this.running) return;
      if (t - this.lastSample >= this.intervalMs) {
        this.lastSample = t;
        const frame = this.capture();
        if (frame && this.onFrame) this.onFrame(frame);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  /** One-shot capture (for fixtures / stills). */
  captureOnce(source: HTMLVideoElement | HTMLImageElement): SampledFrame | null {
    this.source = source;
    return this.capture();
  }

  stop(): void {
    this.running = false;
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private capture(): SampledFrame | null {
    const source = this.source;
    if (!source) return null;

    let sw = 0;
    let sh = 0;
    if (source instanceof HTMLVideoElement) {
      sw = source.videoWidth;
      sh = source.videoHeight;
      if (!sw || !sh || source.readyState < 2) return null;
    } else {
      sw = source.naturalWidth;
      sh = source.naturalHeight;
      if (!sw || !sh) return null;
    }

    // Cover-crop into target aspect
    const targetAspect = this.targetW / this.targetH;
    const srcAspect = sw / sh;
    let sx = 0;
    let sy = 0;
    let sWidth = sw;
    let sHeight = sh;
    if (srcAspect > targetAspect) {
      sWidth = sh * targetAspect;
      sx = (sw - sWidth) / 2;
    } else {
      sHeight = sw / targetAspect;
      sy = (sh - sHeight) / 2;
    }

    this.ctx.drawImage(
      source,
      sx,
      sy,
      sWidth,
      sHeight,
      0,
      0,
      this.targetW,
      this.targetH,
    );
    const imageData = this.ctx.getImageData(0, 0, this.targetW, this.targetH);
    return {
      data: imageData.data,
      width: this.targetW,
      height: this.targetH,
      timestamp: performance.now(),
    };
  }
}
