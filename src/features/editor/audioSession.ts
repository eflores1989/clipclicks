import type { AudioMedia, AudioTrack } from '@shared/types/project';

/**
 * Owns one HTMLAudioElement per timeline AudioTrack and drives their playback
 * to follow the global timeline clock (the video is the master clock). Mirrors
 * videoSession.ts but for the audio pool. Elements are created lazily as
 * tracks appear and torn down when they're removed.
 */
const audioEls = new Map<string, HTMLAudioElement>();
let urlByMediaId = new Map<string, string>();
// Last time (perf clock) we forced a re-seek on an element, to throttle drift
// corrections — re-seeking every frame causes the audio to "stutter".
const lastSeekAt = new WeakMap<HTMLAudioElement, number>();

/** Provide/refresh the vzasset URLs for audio media (keyed by media id). */
export function setAudioUrls(map: Map<string, string>): void {
  urlByMediaId = map;
}

/**
 * Reconcile the element pool with the current track list. Creates elements for
 * new tracks (binding the right src), drops elements for removed tracks.
 */
export function syncAudioElements(tracks: AudioTrack[]): void {
  const live = new Set(tracks.map((t) => t.id));
  // Remove stale.
  for (const [id, el] of audioEls) {
    if (!live.has(id)) {
      try { el.pause(); } catch { /* ignore */ }
      el.src = '';
      audioEls.delete(id);
    }
  }
  // Add new.
  for (const t of tracks) {
    if (audioEls.has(t.id)) continue;
    const url = urlByMediaId.get(t.mediaId);
    if (!url) continue;
    const el = document.createElement('audio');
    el.src = url;
    el.preload = 'auto';
    audioEls.set(t.id, el);
  }
}

/** Smooth gain ramp for fade in/out at the track edges. */
function gainAt(track: AudioTrack, localMs: number, playLenMs: number): number {
  let g = track.volume;
  if (track.fadeInMs > 0 && localMs < track.fadeInMs) {
    g *= localMs / track.fadeInMs;
  }
  const fadeOutStart = playLenMs - track.fadeOutMs;
  if (track.fadeOutMs > 0 && localMs > fadeOutStart) {
    g *= Math.max(0, (playLenMs - localMs) / track.fadeOutMs);
  }
  return Math.max(0, Math.min(2, g));
}

const DRIFT_TOLERANCE_MS = 1200;

/**
 * Drive audio playback for the current global time. For each track: if the
 * playhead is within its placed range and we're playing, seek (only when drift
 * exceeds tolerance, to avoid glitches) and play with the right gain; otherwise
 * pause. When not playing (scrub/paused) we seek but keep paused.
 */
export function updateAudioPlayback(
  globalMs: number,
  isPlaying: boolean,
  tracks: AudioTrack[],
  mediaById: Map<string, AudioMedia>,
): void {
  for (const t of tracks) {
    const el = audioEls.get(t.id);
    if (!el) continue;
    const media = mediaById.get(t.mediaId);
    if (!media) { try { el.pause(); } catch { /* ignore */ } continue; }
    const playLenMs = Math.max(0, t.outMs - t.inMs);
    const start = t.offsetMs;
    const end = t.offsetMs + playLenMs;
    const inRange = globalMs >= start && globalMs < end;

    if (!inRange || t.muted) {
      if (!el.paused) { try { el.pause(); } catch { /* ignore */ } }
      continue;
    }

    const localMs = (globalMs - start) + t.inMs; // position within the source
    const expectedSec = localMs / 1000;
    // CRITICAL: HTMLMediaElement.volume only accepts [0,1]; anything outside
    // (e.g. a >100% gain) THROWS and would kill the caller's rAF loop. Boost
    // above unity needs Web Audio (post-MVP); for now clamp hard.
    const g = gainAt(t, globalMs - start, playLenMs);
    el.volume = Number.isFinite(g) ? Math.max(0, Math.min(1, g)) : 1;

    if (isPlaying) {
      if (el.paused) {
        // Just entering this track's range (or play just started): seek once
        // to the right spot, then let it run on its OWN clock.
        try { el.currentTime = expectedSec; } catch { /* ignore */ }
        lastSeekAt.set(el, performance.now());
        el.play().catch(() => { /* ignore */ });
      } else if (Math.abs(el.currentTime - expectedSec) * 1000 > DRIFT_TOLERANCE_MS) {
        // The audio runs FREE during playback — we do NOT chase the video
        // clock, because that clock jitters at clip boundaries / on freshly
        // added (still-buffering) clips and yanking the audio every frame
        // makes it stutter. We only correct a CATASTROPHIC desync (e.g. a long
        // stall), and at most once per cooldown. For music/voice over video a
        // few hundred ms of A/V drift is imperceptible; stutter is not.
        const SEEK_COOLDOWN_MS = 1500;
        if (performance.now() - (lastSeekAt.get(el) ?? 0) > SEEK_COOLDOWN_MS) {
          try { el.currentTime = expectedSec; } catch { /* ignore */ }
          lastSeekAt.set(el, performance.now());
        }
      }
    } else {
      // Scrub / paused: park at the right spot but don't play. Only re-seek if
      // the position actually moved (avoids fighting a freshly-set currentTime).
      if (!el.paused) { try { el.pause(); } catch { /* ignore */ } }
      if (Math.abs(el.currentTime - expectedSec) * 1000 > 60) {
        try { el.currentTime = expectedSec; } catch { /* ignore */ }
      }
    }
  }
}

/** Pause every audio element (used on global pause / scrub start). */
export function pauseAllAudio(): void {
  for (const el of audioEls.values()) {
    try { el.pause(); } catch { /* ignore */ }
  }
}

/** Tear down all elements (editor unmount). */
export function detachAllAudio(): void {
  for (const el of audioEls.values()) {
    try { el.pause(); } catch { /* ignore */ }
    el.src = '';
  }
  audioEls.clear();
}
