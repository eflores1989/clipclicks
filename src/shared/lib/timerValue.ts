import type { TimerEvent, TimerFormat, TimerRateKeyframe } from '@shared/types/project';

/**
 * The timer's clock is `startValueMs ± ∫ rate(τ) dτ`, where τ is the offset from
 * the timer's `startMs` and `rate` is a piecewise-LINEAR curve defined by the
 * keyframes. Linear interpolation between keyframes is what gives smooth
 * acceleration / deceleration; before the first and after the last keyframe the
 * rate holds flat. This module computes that integral (elapsed clock ms) and
 * formats the resulting value — shared by the Pixi renderer (preview + export)
 * and the properties panel so they always agree.
 */

/** Instantaneous rate at offset `tau` (ms from the timer start). Flat outside
 *  the keyframe span; linear between. No keyframes ⇒ real time (rate 1). */
export function rateAtOffset(sorted: TimerRateKeyframe[], tau: number): number {
  if (sorted.length === 0) return 1;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (tau <= first.tMs) return first.rate;
  if (tau >= last.tMs) return last.rate;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (tau >= a.tMs && tau <= b.tMs) {
      const span = b.tMs - a.tMs;
      if (span <= 0) return b.rate;
      const f = (tau - a.tMs) / span;
      return a.rate + (b.rate - a.rate) * f;
    }
  }
  return last.rate;
}

/** ∫₀ˣ rate(τ) dτ — the elapsed CLOCK time after x ms of timeline time.
 *  Trapezoidal over the piecewise-linear rate curve (exact for it). */
export function integrateRate(keyframes: TimerRateKeyframe[], x: number): number {
  if (x <= 0) return 0;
  const sorted = keyframes
    .filter((k) => Number.isFinite(k.tMs) && Number.isFinite(k.rate))
    .slice()
    .sort((a, b) => a.tMs - b.tMs);
  if (sorted.length === 0) return x; // constant real-time rate
  // Break the integral at 0, every interior keyframe, and x. The rate is linear
  // between consecutive breakpoints, so each slice is an exact trapezoid.
  const cuts = new Set<number>([0, x]);
  for (const k of sorted) if (k.tMs > 0 && k.tMs < x) cuts.add(k.tMs);
  const points = [...cuts].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const t0 = points[i];
    const t1 = points[i + 1];
    const r0 = Math.max(0, rateAtOffset(sorted, t0));
    const r1 = Math.max(0, rateAtOffset(sorted, t1));
    area += ((r0 + r1) / 2) * (t1 - t0);
  }
  return area;
}

/** Elapsed clock ms of a timer at a given GLOBAL timeline ms. */
export function timerElapsedMs(t: TimerEvent, globalMs: number): number {
  const off = globalMs - t.startMs;
  if (off <= 0) return 0;
  const span = Math.max(0, t.endMs - t.startMs);
  return integrateRate(t.rateKeyframes ?? [], Math.min(off, span));
}

/** The displayed clock value (ms) of a timer at a given GLOBAL timeline ms. */
export function timerValueMs(t: TimerEvent, globalMs: number): number {
  const elapsed = timerElapsedMs(t, globalMs);
  let v = t.direction === 'down' ? t.startValueMs - elapsed : t.startValueMs + elapsed;
  if (t.direction === 'down' && t.stopAtZero) v = Math.max(0, v);
  return Math.max(0, v);
}

/** Format a clock value (ms) per the timer's chosen format. */
export function formatTimerValue(ms: number, format: TimerFormat): string {
  const totalMs = Math.max(0, Math.round(ms));
  const cs = Math.floor((totalMs % 1000) / 10);
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const p2 = (n: number): string => String(n).padStart(2, '0');
  switch (format) {
    case 'hh:mm:ss': return `${p2(h)}:${p2(m)}:${p2(s)}`;
    case 'mm:ss.cs': return `${p2(totalMin)}:${p2(s)}.${p2(cs)}`;
    case 'ss': return `${totalSec}`;
    case 'ss.cs': return `${totalSec}.${p2(cs)}`;
    case 'mm:ss':
    default: return `${p2(totalMin)}:${p2(s)}`;
  }
}

/** The formatted string a timer shows at a given GLOBAL timeline ms. */
export function timerText(t: TimerEvent, globalMs: number): string {
  return formatTimerValue(timerValueMs(t, globalMs), t.format);
}

const DEFAULT_TIMER_DURATION_MS = 5000;

/** Build a new timer at the playhead with sensible defaults (counts up from 0,
 *  constant real-time rate, centered, white). */
export function makeTimerEvent(startMs: number): TimerEvent {
  return {
    id: crypto.randomUUID(),
    startMs,
    endMs: startMs + DEFAULT_TIMER_DURATION_MS,
    startValueMs: 0,
    direction: 'up',
    format: 'mm:ss',
    rateKeyframes: [],
    stopAtZero: true,
    nx: 0.5,
    ny: 0.15,
    fontScale: 0.12,
    fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
    bold: true,
    italic: false,
    color: '#ffffff',
    shadow: true,
  };
}
