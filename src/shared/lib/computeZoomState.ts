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
  /**
   * How much to CENTER the camera on the focal (0..1). 0 = anchor the focal at
   * its frame position (classic click-zoom). 1 = center on it (clamped to keep
   * the frame filled). Set only by manual-pan tracking; click/cursor zooms use 0.
   */
  focalTightness?: number;
}

export const IDENTITY_ZOOM: ZoomState = { scale: 1, focalNx: 0.5, focalNy: 0.5, zoomId: null, focalTightness: 0 };

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
 * Interpolate the focal point from a manual pan path at clip-local `currentMs`.
 * Holds flat before the first / after the last keyframe; between two points it
 * eases (easeInOut) for that cinematic drift. Assumes `kfs` is sorted by `t`.
 */
export function focusFromKeyframes(
  kfs: NonNullable<ZoomEvent['focusKeyframes']>,
  currentMs: number,
): { nx: number; ny: number } {
  const first = kfs[0];
  if (kfs.length === 1 || currentMs <= first.t) return { nx: first.nx, ny: first.ny };
  const last = kfs[kfs.length - 1];
  if (currentMs >= last.t) return { nx: last.nx, ny: last.ny };
  // easeInOut PER SEGMENT — accelerates out of each point and decelerates into
  // the next, with a natural little "settle" at each keyframe. This is the
  // fluid, punchy feel; an optional exponential smoother (see computeZoomState)
  // can soften it into a continuous glide when the user wants.
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (currentMs >= a.t && currentMs <= b.t) {
      const span = b.t - a.t;
      const f = span > 0 ? ease((currentMs - a.t) / span, 'easeInOut') : 1;
      return { nx: a.nx + (b.nx - a.nx) * f, ny: a.ny + (b.ny - a.ny) * f };
    }
  }
  return { nx: last.nx, ny: last.ny };
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

    // Manual pan path takes precedence over both the static target and the
    // recorded-cursor behaviors. This is what powers cinematic tracking on
    // imported videos (no mouse data needed). The linear path is then run
    // through an exponential smoother (same "professional drift" as the
    // 'smoothed' cursor) so the camera glides — no hard turns at keyframes.
    if (z.focusKeyframes && z.focusKeyframes.length > 0) {
      // Pan speed: rescale time around the first keyframe. >1 reaches later
      // points sooner (faster pan); the path holds at point 1 before its time.
      const firstT = z.focusKeyframes[0].t;
      const speed = z.panSpeed && z.panSpeed > 0 ? z.panSpeed : 1;
      const eff = firstT + (currentMs - firstT) * speed;
      const f = focusFromKeyframes(z.focusKeyframes, eff);
      let nx = clamp01(f.nx);
      let ny = clamp01(f.ny);
      // Default 0: keep the punchy easeInOut-per-segment feel (accel/decel with a
      // settle at each point). Raising it blends toward a continuous floaty glide.
      const smoothing = clamp01(z.smoothing ?? 0);
      if (smoothing > 0 && options?.previousState && options.previousState.zoomId === z.id) {
        const alpha = 1 - smoothing;
        nx = options.previousState.focalNx + alpha * (nx - options.previousState.focalNx);
        ny = options.previousState.focalNy + alpha * (ny - options.previousState.focalNy);
      }
      return { scale, focalNx: nx, focalNy: ny, zoomId: z.id, focalTightness: clamp01(z.panTightness ?? 1) };
    }

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
