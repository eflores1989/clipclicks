import type { Clip, ImageMedia } from '@shared/types/project';

/** Default on-screen duration for a freshly-added image clip. */
export const DEFAULT_IMAGE_DURATION_MS = 3000;
/** Upper bound for the trim-out edge — lets an image be stretched arbitrarily
 *  long while reusing the clip trim machinery (which clamps outMs ≤ durationMs). */
export const IMAGE_MAX_DURATION_MS = 600_000;

/** Load an image URL and resolve its natural pixel size. */
export function loadImageDims(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
  if (!blob) throw new Error('canvas.toBlob returned null');
  return new Uint8Array(await blob.arrayBuffer());
}

/** Paint a solid color to a PNG of the given size. */
export async function paintSolidPng(color: string, w: number, h: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  return canvasToPngBytes(canvas);
}

/** Paint a linear gradient (from→to at angleDeg) to a PNG of the given size. */
export async function paintGradientPng(from: string, to: string, angleDeg: number, w: number, h: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  const rad = (angleDeg * Math.PI) / 180;
  const cx = w / 2, cy = h / 2;
  const dx = Math.cos(rad) * w / 2, dy = Math.sin(rad) * h / 2;
  const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  grad.addColorStop(0, from);
  grad.addColorStop(1, to);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  return canvasToPngBytes(canvas);
}

/** Build an image Clip from a pool entry, placed nowhere yet (timelineStartMs
 *  recomputed by recomputeTimeline). Behaves like a clip: trim/reorder/split.
 *
 *  An ANIMATED entry (a GIF, transcoded to MP4 on import) becomes a `kind:'video'`
 *  clip instead: that routes it through the normal video path, so it animates in
 *  the preview and in both export paths, with its real duration. */
export function makeImageClip(media: ImageMedia): Clip {
  if (media.animated && media.durationMs && media.durationMs > 0) {
    return {
      id: crypto.randomUUID(),
      kind: 'video',
      filePath: media.filePath,
      sourceWidth: media.width || 1920,
      sourceHeight: media.height || 1080,
      fps: media.fps || 25,
      durationMs: media.durationMs,
      recordedAt: media.addedAt,
      mouseEvents: [],
      zoomEvents: [],
      speedSegments: [],
      inMs: 0,
      outMs: media.durationMs,
      timelineStartMs: 0,
      // The converted MP4 is video-only; keep the enhanced cursor layer off.
      systemCursorCaptured: true,
      hasAudio: false,
      audioVolume: 1,
      audioMuted: true,
    };
  }
  return {
    id: crypto.randomUUID(),
    kind: 'image',
    filePath: media.filePath,
    sourceWidth: media.width || 1920,
    sourceHeight: media.height || 1080,
    fps: 30,
    durationMs: IMAGE_MAX_DURATION_MS,
    recordedAt: media.addedAt,
    mouseEvents: [],
    zoomEvents: [],
    speedSegments: [],
    inMs: 0,
    outMs: DEFAULT_IMAGE_DURATION_MS,
    timelineStartMs: 0,
  };
}
