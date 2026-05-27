import type { MouseEventRaw } from '../types/recording';

/**
 * Cache of the last lookup position so cursorAt() is O(1) when called with
 * monotonically increasing timestamps (the playback case). Each PixiScene has
 * its own instance.
 */
export interface CursorCursor {
  lastIndex: number;
}

export function newCursorCursor(): CursorCursor {
  return { lastIndex: 0 };
}

/**
 * Resolve cursor position at time `tMs` by linearly interpolating between the
 * two adjacent mouse events. Uses a hint cursor to skip the binary search when
 * we're stepping forward in time (the common case during playback).
 *
 * Returns null if the event array is empty.
 */
export function cursorAt(
  tMs: number,
  events: MouseEventRaw[],
  cursor?: CursorCursor,
): { x: number; y: number } | null {
  if (events.length === 0) return null;
  if (tMs <= events[0].t) return { x: events[0].x, y: events[0].y };
  const last = events[events.length - 1];
  if (tMs >= last.t) return { x: last.x, y: last.y };

  let lo = 0;
  let hi = events.length - 1;
  // Try linear scan from cursor hint for monotonic playback.
  if (cursor) {
    let i = cursor.lastIndex;
    if (i >= 0 && i < events.length - 1 && events[i].t <= tMs && events[i + 1].t > tMs) {
      // Hit.
    } else if (i + 1 < events.length - 1 && events[i + 1].t <= tMs && events[i + 2].t > tMs) {
      // Next slot — common during playback.
      i = i + 1;
    } else {
      // Fall back to binary search.
      i = -1;
    }
    if (i >= 0) {
      cursor.lastIndex = i;
      const a = events[i];
      const b = events[i + 1];
      const span = b.t - a.t || 1;
      const f = (tMs - a.t) / span;
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
    }
  }
  while (lo < hi - 1) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].t <= tMs) lo = mid;
    else hi = mid;
  }
  if (cursor) cursor.lastIndex = lo;
  const a = events[lo];
  const b = events[hi];
  const span = b.t - a.t || 1;
  const f = (tMs - a.t) / span;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}
