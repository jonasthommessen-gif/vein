import {
  useEffect,
  useRef,
  useState,
  forwardRef,
  useImperativeHandle,
  useCallback,
} from 'react';

export interface CameraViewHandle {
  getVideo: () => HTMLVideoElement | null;
  getStill: () => HTMLImageElement | null;
  /** Capture compressed still from live video; max edge ~1280, quality 0.7–0.85. */
  captureStill: (opts?: { maxEdge?: number; quality?: number; type?: string }) => string | null;
}

interface Props {
  active: boolean;
  stillUrl?: string | null;
  onReady?: () => void;
  onError?: (message: string) => void;
  onStreamEnded?: () => void;
}

export const CameraView = forwardRef<CameraViewHandle, Props>(function CameraView(
  { active, stillUrl, onReady, onError, onStreamEnded },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const stillRef = useRef<HTMLImageElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [hasVideo, setHasVideo] = useState(false);

  const onReadyRef = useRef(onReady);
  const onErrorRef = useRef(onError);
  const onStreamEndedRef = useRef(onStreamEnded);

  useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
    onStreamEndedRef.current = onStreamEnded;
  }, [onReady, onError, onStreamEnded]);

  const stopTracks = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const captureStill = useCallback(
    (opts?: { maxEdge?: number; quality?: number; type?: string }): string | null => {
      const video = videoRef.current;
      if (!video || !video.videoWidth || !video.videoHeight) return null;

      const maxEdge = opts?.maxEdge ?? 1280;
      const quality = opts?.quality ?? 0.78;
      const type = opts?.type ?? 'image/jpeg';

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      const scale = Math.min(1, maxEdge / Math.max(vw, vh));
      const tw = Math.round(vw * scale);
      const th = Math.round(vh * scale);

      const canvas = document.createElement('canvas');
      canvas.width = tw;
      canvas.height = th;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, tw, th);
      try {
        return canvas.toDataURL(type, quality);
      } catch {
        return canvas.toDataURL('image/jpeg', quality);
      }
    },
    [],
  );

  useImperativeHandle(ref, () => ({
    getVideo: () => videoRef.current,
    getStill: () => stillRef.current,
    captureStill,
  }));

  // Start / keep MediaStream while active && !stillUrl — do not restart on parent re-renders
  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (stillUrl || !active) {
        stopTracks();
        setHasVideo(false);
        return;
      }

      const existing = streamRef.current;
      if (existing?.getVideoTracks().some((t) => t.readyState === 'live')) {
        const video = videoRef.current;
        if (video && video.srcObject !== existing) {
          video.srcObject = existing;
          try {
            await video.play();
          } catch {
            /* already playing */
          }
        }
        setHasVideo(true);
        onReadyRef.current?.();
        return;
      }

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          onErrorRef.current?.('Camera is not available in this browser.');
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.muted = true;
          video.playsInline = true;
          const play = async () => {
            try {
              await video.play();
              setHasVideo(true);
              onReadyRef.current?.();
            } catch {
              onErrorRef.current?.('Unable to start the camera preview.');
            }
          };
          if (video.readyState >= 2) void play();
          else video.onloadedmetadata = () => void play();
        }
        stream.getVideoTracks().forEach((track) => {
          track.addEventListener('ended', () => onStreamEndedRef.current?.());
        });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          onErrorRef.current?.('Camera access is needed to analyse a vein');
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          onErrorRef.current?.('No camera was found on this device.');
        } else {
          onErrorRef.current?.('Camera access is needed to analyse a vein');
        }
      }
    }

    void start();

    return () => {
      cancelled = true;
      // Only tear down when leaving camera mode (active false or still set).
      // Keeping the stream across PREVIEW → ANALYZING is intentional.
      if (!active || stillUrl) {
        stopTracks();
        setHasVideo(false);
      }
    };
  }, [active, stillUrl, stopTracks]);

  // Hard stop on unmount
  useEffect(() => () => stopTracks(), [stopTracks]);

  if (stillUrl) {
    return (
      <img
        ref={stillRef}
        className="scanner-still"
        src={stillUrl}
        alt="Analysis subject"
        onLoad={() => onReadyRef.current?.()}
      />
    );
  }

  return (
    <video
      ref={videoRef}
      className="scanner-video"
      playsInline
      muted
      autoPlay
      style={{ opacity: hasVideo ? 1 : 0.15 }}
    />
  );
});
