import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from 'react';

export interface CameraViewHandle {
  getVideo: () => HTMLVideoElement | null;
  getStill: () => HTMLImageElement | null;
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

  useImperativeHandle(ref, () => ({
    getVideo: () => videoRef.current,
    getStill: () => stillRef.current,
  }));

  useEffect(() => {
    let cancelled = false;

    async function start() {
      if (stillUrl) {
        setHasVideo(false);
        stopTracks();
        return;
      }
      if (!active) {
        stopTracks();
        setHasVideo(false);
        return;
      }

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          onError?.('Camera is not available in this browser.');
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
              onReady?.();
            } catch {
              onError?.('Unable to start the camera preview.');
            }
          };
          if (video.readyState >= 2) void play();
          else video.onloadedmetadata = () => void play();
        }
        stream.getVideoTracks().forEach((track) => {
          track.addEventListener('ended', () => onStreamEnded?.());
        });
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          onError?.('Camera access is needed to analyse a vein');
        } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          onError?.('No camera was found on this device.');
        } else {
          onError?.('Camera access is needed to analyse a vein');
        }
      }
    }

    function stopTracks() {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    }

    void start();

    const onVisibility = () => {
      if (document.hidden) {
        // Keep stream but pause analysis upstream; optional soft pause
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      stopTracks();
    };
  }, [active, stillUrl, onReady, onError, onStreamEnded]);

  if (stillUrl) {
    return (
      <img
        ref={stillRef}
        className="scanner-still"
        src={stillUrl}
        alt="Analysis subject"
        onLoad={() => onReady?.()}
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
