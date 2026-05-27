import { useCallback, useEffect } from 'react';
import { Play, Pause, SkipBack, SkipForward, RotateCcw, Scissors } from 'lucide-react';
import { usePlaybackStore } from '@/stores/playback';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { getActiveVideo, setActiveClip, getVideoForClip } from './videoSession';
import { applyEffectivePlaybackRate } from './playbackRate';
import { locateGlobal } from '@shared/lib/clipTime';
import type { Project } from '@shared/types/project';

const SPLIT_MIN_KEEP_MS = 200;

/**
 * Split the clip at `clipIndex` at source-local time `localMs`, in-place on the
 * Immer draft. Returns false (no-op) if the cut is too close to an edge.
 */
function splitClipInDraft(d: Project, clipIndex: number, localMs: number): boolean {
  const c = d.clips[clipIndex];
  if (!c) return false;
  if (localMs <= c.inMs + SPLIT_MIN_KEEP_MS || localMs >= c.outMs - SPLIT_MIN_KEEP_MS) return false;

  // Partition zooms: each goes to the side where its midpoint sits; a zoom
  // spanning the cut is clamped to the boundary (re-balancing enter/exit).
  const leftZooms: typeof c.zoomEvents = [];
  const rightZooms: typeof c.zoomEvents = [];
  for (const z of c.zoomEvents) {
    const midpoint = (z.startMs + z.endMs) / 2;
    if (midpoint < localMs) {
      if (z.endMs <= localMs) { leftZooms.push(z); continue; }
      const newDur = localMs - z.startMs;
      if (newDur < SPLIT_MIN_KEEP_MS) continue;
      const enter = Math.min(z.enterDurationMs, newDur * 0.4);
      const exit = Math.min(z.exitDurationMs, newDur * 0.4);
      leftZooms.push({ ...z, endMs: localMs, enterDurationMs: enter, exitDurationMs: exit, holdDurationMs: Math.max(0, newDur - enter - exit) });
    } else {
      if (z.startMs >= localMs) { rightZooms.push(z); continue; }
      const newDur = z.endMs - localMs;
      if (newDur < SPLIT_MIN_KEEP_MS) continue;
      const enter = Math.min(z.enterDurationMs, newDur * 0.4);
      const exit = Math.min(z.exitDurationMs, newDur * 0.4);
      rightZooms.push({ ...z, startMs: localMs, enterDurationMs: enter, exitDurationMs: exit, holdDurationMs: Math.max(0, newDur - enter - exit) });
    }
  }

  const rightHalf = {
    id: crypto.randomUUID(),
    kind: c.kind,
    filePath: c.filePath,
    sourceWidth: c.sourceWidth,
    sourceHeight: c.sourceHeight,
    fps: c.fps,
    durationMs: c.durationMs,
    recordedAt: c.recordedAt,
    capturedSource: c.capturedSource,
    displayBounds: c.displayBounds,
    mouseEvents: c.mouseEvents.filter((e) => e.t >= localMs),
    zoomEvents: rightZooms,
    speedSegments: c.speedSegments.length > 0
      ? [{ ...c.speedSegments[0], id: crypto.randomUUID(), startMs: localMs, endMs: c.outMs }]
      : [],
    inMs: localMs,
    outMs: c.outMs,
    timelineStartMs: 0,
    systemCursorCaptured: c.systemCursorCaptured,
    crop: c.crop,
    hasAudio: c.hasAudio,
    audioVolume: c.audioVolume,
    audioMuted: c.audioMuted,
    // The cut boundary gets no transition; the outer end-transition moves to
    // the right half, the start-transition stays on the left (c).
    transitionOut: c.transitionOut,
  };
  c.outMs = localMs;
  c.mouseEvents = c.mouseEvents.filter((e) => e.t < localMs);
  c.zoomEvents = leftZooms;
  if (c.speedSegments[0]) c.speedSegments[0].endMs = localMs;
  delete c.transitionOut;
  d.clips.splice(clipIndex + 1, 0, rightHalf);
  return true;
}

/**
 * Split an audio track at global time `globalMs` into two tracks. No-op if the
 * playhead is outside the track or either resulting half would be too short.
 */
function splitAudioInDraft(d: Project, trackId: string, globalMs: number): boolean {
  const t = d.audioTracks.find((x) => x.id === trackId);
  if (!t) return false;
  const lenMs = t.outMs - t.inMs;
  const startG = t.offsetMs;
  const endG = t.offsetMs + lenMs;
  if (globalMs <= startG + SPLIT_MIN_KEEP_MS || globalMs >= endG - SPLIT_MIN_KEEP_MS) return false;
  const splitIn = t.inMs + (globalMs - startG); // source-local cut point
  const right = {
    id: crypto.randomUUID(),
    mediaId: t.mediaId,
    offsetMs: globalMs,
    inMs: splitIn,
    outMs: t.outMs,
    volume: t.volume,
    muted: t.muted,
    fadeInMs: 0,
    fadeOutMs: t.fadeOutMs,
  };
  // Shrink the left half + keep only its fade-in.
  t.outMs = splitIn;
  t.fadeOutMs = 0;
  d.audioTracks.push(right);
  return true;
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  const cs = String(Math.floor((ms % 1000) / 10)).padStart(2, '0');
  return `${mm}:${ss}.${cs}`;
}

/** Map a global timeline ms to the right clip and seek its video. Returns the
 * active video after the switch (or null if no project). */
function seekGlobal(globalMs: number): HTMLVideoElement | null {
  const project = useProjectStore.getState().project;
  if (!project) return null;
  // Any explicit seek cancels an in-progress audio tail (the rAF restores the
  // video + content visibility when it sees the flag clear).
  usePlaybackStore.getState().setAudioTail(false);
  const located = locateGlobal(project, globalMs);
  if (!located) return null;
  const v = getVideoForClip(located.clip.id);
  if (!v) return null;
  setActiveClip(located.clip.id);
  v.currentTime = located.localMs / 1000;
  usePlaybackStore.getState().setCurrentTime(globalMs);
  return v;
}

export function Transport() {
  const playing = usePlaybackStore((s) => s.playing);
  const currentTimeMs = usePlaybackStore((s) => s.currentTimeMs);
  const durationMs = usePlaybackStore((s) => s.durationMs);
  const playbackRate = usePlaybackStore((s) => s.playbackRate);

  const togglePlay = useCallback(() => {
    const ps = usePlaybackStore.getState();
    const project = useProjectStore.getState().project;
    if (!project) return;
    const videoTimelineMs = project.timeline.durationMs;
    const total = ps.durationMs; // full timeline (max of video + audio)
    const globalNow = ps.currentTimeMs;
    const isPlayingNow = ps.playing || ps.audioTail;

    // ── PAUSE (works everywhere, including the audio tail) ──
    if (isPlayingNow) {
      ps.setAudioTail(false);
      ps.setPlaying(false);
      const v = getActiveVideo();
      if (v && !v.paused) { try { v.pause(); } catch { /* ignore */ } }
      return;
    }

    // ── PLAY / RESUME ──
    // At the very end of the timeline → loop back to the start.
    if (globalNow >= total - 16) {
      const v = seekGlobal(0);
      if (v) v.play().catch(() => {});
      ps.setPlaying(true);
      return;
    }
    // Paused in the audio-only zone (past the video) → just flip the flag; the
    // rAF audio-zone block drives playback from here (video stays black).
    if (globalNow >= videoTimelineMs - 1 && total > videoTimelineMs) {
      ps.setPlaying(true);
      return;
    }
    // Normal: play the active video from the current position.
    const v = getActiveVideo();
    if (v) {
      const located = locateGlobal(project, globalNow);
      if (located && v.currentTime * 1000 < located.clip.inMs) {
        v.currentTime = located.clip.inMs / 1000;
      }
      v.play().catch(() => {});
    }
    ps.setPlaying(true);
  }, []);

  const jumpStart = useCallback(() => { seekGlobal(0); }, []);

  const jumpEnd = useCallback(() => {
    const totalDur = usePlaybackStore.getState().durationMs;
    seekGlobal(Math.max(0, totalDur - 50));
  }, []);

  const stepBack = useCallback(() => {
    const now = usePlaybackStore.getState().currentTimeMs;
    seekGlobal(Math.max(0, now - 1000));
  }, []);

  const stepForward = useCallback(() => {
    const now = usePlaybackStore.getState().currentTimeMs;
    const totalDur = usePlaybackStore.getState().durationMs;
    seekGlobal(Math.min(totalDur, now + 1000));
  }, []);

  const setRate = useCallback((r: number) => {
    usePlaybackStore.getState().setPlaybackRate(r);
    applyEffectivePlaybackRate();
  }, []);

  const splitAtPlayhead = useCallback(() => {
    const project = useProjectStore.getState().project;
    if (!project) return;
    const globalMs = usePlaybackStore.getState().currentTimeMs;
    const sel = useSelectionStore.getState();
    const update = useProjectStore.getState().update;

    // Selection-aware: an audio clip selected → split only it; a video clip
    // selected → split only it; nothing selected → split video + every audio
    // crossing the playhead (cut everything at the line).
    if (sel.selectedAudioId) {
      const id = sel.selectedAudioId;
      update((d) => { splitAudioInDraft(d, id, globalMs); }, { label: 'Split audio' });
      return;
    }

    const located = locateGlobal(project, globalMs);
    if (sel.selectedClipId) {
      if (!located || located.clip.id !== sel.selectedClipId) {
        console.warn('[split] playhead is not within the selected clip');
        return;
      }
      const idx = located.clipIndex;
      const local = located.localMs;
      update((d) => { splitClipInDraft(d, idx, local); }, { label: 'Split clip' });
      return;
    }

    // Nothing selected → cut everything at the playhead.
    update((d) => {
      if (located) splitClipInDraft(d, located.clipIndex, located.localMs);
      // Snapshot ids first — the array grows as we push right-halves.
      const ids = d.audioTracks.map((t) => t.id);
      for (const id of ids) splitAudioInDraft(d, id, globalMs);
    }, { label: 'Split at playhead' });
  }, []);

  // Space toggles playback when no input is focused.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.code !== 'Space') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [togglePlay]);

  // 'S' splits at playhead.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 's' && e.key !== 'S') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      e.preventDefault();
      splitAtPlayhead();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [splitAtPlayhead]);

  return (
    <div className="transport">
      <div className="transport__group">
        <button className="t-btn" onClick={jumpStart} title="Jump to start (Home)" aria-label="Jump to start">
          <RotateCcw size={14} />
        </button>
        <button className="t-btn" onClick={stepBack} title="Back 1s (←)" aria-label="Back 1 second">
          <SkipBack size={14} />
        </button>
        <button className="t-btn t-btn--primary" onClick={togglePlay} title="Play / Pause (Space)" aria-label="Play or pause">
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
        </button>
        <button className="t-btn" onClick={stepForward} title="Forward 1s (→)" aria-label="Forward 1 second">
          <SkipForward size={14} />
        </button>
        <button className="t-btn" onClick={jumpEnd} title="Jump to end" aria-label="Jump to end">
          <RotateCcw size={14} style={{ transform: 'scaleX(-1)' }} />
        </button>
        <span className="transport__sep" />
        <button
          className="t-btn t-btn--split"
          onClick={splitAtPlayhead}
          title="Split en el playhead (S) — sin selección corta todo; con un clip/audio seleccionado, solo ese"
          aria-label="Split"
        >
          <Scissors size={14} />
        </button>
      </div>

      <div className="transport__time">
        <span className="transport__time-now">{formatTime(currentTimeMs)}</span>
        <span className="transport__time-sep">/</span>
        <span className="transport__time-total">{formatTime(durationMs)}</span>
      </div>

      <div className="transport__rate">
        {[0.5, 1, 1.5, 2].map((r) => (
          <button
            key={r}
            className={`t-rate ${playbackRate === r ? 't-rate--active' : ''}`}
            onClick={() => setRate(r)}
            title={`${r}× playback`}
          >
            {r}×
          </button>
        ))}
      </div>
    </div>
  );
}
