import type { Clip, Project } from '../types/project';

/** Intrinsic playback speed of a clip (default 1). */
export function clipSpeed(clip: Clip): number {
  return clip.speedSegments[0]?.speed ?? 1;
}

/** Effective duration on the global timeline — (out - in) / speed. */
export function clipEffectiveDurationMs(clip: Clip): number {
  return Math.max(0, (clip.outMs - clip.inMs) / clipSpeed(clip));
}

/**
 * Walk through the clips array in order, setting each clip's `timelineStartMs`
 * to the running sum of effective durations of prior clips, and updating
 * `project.timeline.durationMs` to the total. Call this from the project
 * store's mutator after ANY change that could affect clip durations or trim.
 */
export function recomputeTimeline(project: Project): void {
  let acc = 0;
  for (const c of project.clips) {
    c.timelineStartMs = acc;
    acc += clipEffectiveDurationMs(c);
  }
  project.timeline.durationMs = acc;
}

export interface LocateResult {
  clip: Clip;
  clipIndex: number;
  /** Local time within the clip's source file (in ms, ranges over [inMs, outMs]). */
  localMs: number;
  /** Time within the clip's effective slot on the timeline (ms from clip start). */
  withinClipMs: number;
}

/**
 * Find the clip + local source time corresponding to a global timeline ms.
 * Clamps to first/last clip's edges when out of range.
 */
export function locateGlobal(project: Project, globalMs: number): LocateResult | null {
  if (project.clips.length === 0) return null;
  if (globalMs <= 0) {
    const c = project.clips[0];
    return { clip: c, clipIndex: 0, localMs: c.inMs, withinClipMs: 0 };
  }
  for (let i = 0; i < project.clips.length; i++) {
    const c = project.clips[i];
    const start = c.timelineStartMs;
    const eff = clipEffectiveDurationMs(c);
    if (globalMs <= start + eff) {
      const speed = clipSpeed(c);
      const withinClipMs = Math.max(0, globalMs - start);
      return { clip: c, clipIndex: i, localMs: c.inMs + withinClipMs * speed, withinClipMs };
    }
  }
  const lastIdx = project.clips.length - 1;
  const c = project.clips[lastIdx];
  return { clip: c, clipIndex: lastIdx, localMs: c.outMs, withinClipMs: clipEffectiveDurationMs(c) };
}

/** Map a local source time within a clip to global timeline ms. */
export function localToGlobal(clip: Clip, localMs: number): number {
  const speed = clipSpeed(clip);
  const clamped = Math.max(clip.inMs, Math.min(clip.outMs, localMs));
  return clip.timelineStartMs + (clamped - clip.inMs) / speed;
}
