import type { ZoomEvent } from '../types/project';
import type { MouseEventRaw } from '../types/recording';
import { cursorAt, type CursorCursor } from './cursorAt';
import { ease } from './easings';

export interface ZoomState {
  scale: number;
  focalNx: number;
  focalNy: number;
  /** Id of the zoom that produced this state, or null if idle. */
  zoomId: string | null;
}

export const IDENTITY_ZOOM: ZoomState = { scale: 1, focalNx: 0.5, focalNy: 0.5, zoomId: null };

export interface ComputeZoomOptions {
  mouseEvents?: MouseEventRaw[];
  /** Width/height of the coord space the mouse events live in (DIPs typically). */
  coordSpace?: { width: number; height: number };
  /** Previous frame's state, used for LERP smoothing across frames. */
  previousState?: ZoomState | null;
  /** Cursor for binary-search amortization across consecutive calls. */
  cursorCursor?: CursorCursor;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Find the zoom event active at `currentMs` and compute the interpolated
 * scale + focal point.
 *
 * Cursor behavior:
 *   - 'static': focal stays at zoom.target.{nx,ny}
 *   - 'follow': focal tracks the live cursor position
 *   - 'smoothed': focal = lerp(previousFocal, cursorPos, alpha), where
 *      alpha = 1 - smoothing. Higher smoothing → smoother but laggier.
 */
export function computeZoomState(
  currentMs: number,
  zoomEvents: ZoomEvent[],
  options?: ComputeZoomOptions,
): ZoomState {
  // Iterate in reverse so the most recent overlap wins.
  for (let i = zoomEvents.length - 1; i >= 0; i--) {
    const z = zoomEvents[i];
    if (currentMs < z.startMs || currentMs > z.endMs) continue;

    const rel = currentMs - z.startMs;
    const enterEnd = z.enterDurationMs;
    const holdEnd = enterEnd + z.holdDurationMs;

    let progress: number;
    if (rel < enterEnd) {
      progress = z.enterDurationMs > 0 ? ease(rel / enterEnd, z.enterEasing) : 1;
    } else if (rel < holdEnd) {
      progress = 1;
    } else {
      const exitT = z.exitDurationMs > 0 ? (rel - holdEnd) / z.exitDurationMs : 1;
      progress = 1 - ease(Math.min(1, exitT), z.exitEasing);
    }

    const scale = 1 + (z.scale - 1) * progress;
    let focalNx = z.target.nx ?? 0.5;
    let focalNy = z.target.ny ?? 0.5;

    if (z.cursorBehavior !== 'static' && options?.mouseEvents && options?.coordSpace) {
      const cursor = cursorAt(currentMs, options.mouseEvents, options.cursorCursor);
      if (cursor) {
        const tx = clamp01(cursor.x / options.coordSpace.width);
        const ty = clamp01(cursor.y / options.coordSpace.height);

        if (z.cursorBehavior === 'follow') {
          focalNx = tx;
          focalNy = ty;
        } else {
          // 'smoothed' — exponential LERP from previous focal toward cursor.
          // Default smoothing is high (0.85) for that "professional drift".
          const smoothing = clamp01(z.smoothing ?? 0.85);
          const alpha = 1 - smoothing;
          const prev = options.previousState && options.previousState.zoomId === z.id
            ? { nx: options.previousState.focalNx, ny: options.previousState.focalNy }
            : { nx: tx, ny: ty }; // first frame of this zoom — start at cursor
          focalNx = prev.nx + alpha * (tx - prev.nx);
          focalNy = prev.ny + alpha * (ty - prev.ny);
        }
      }
    }
    return { scale, focalNx, focalNy, zoomId: z.id };
  }
  return IDENTITY_ZOOM;
}
