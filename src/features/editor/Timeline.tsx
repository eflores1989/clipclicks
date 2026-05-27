import { useCallback, useEffect, useRef, useState } from 'react';
import { usePlaybackStore } from '@/stores/playback';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { ZoomTrack } from './ZoomTrack';
import { TextTrack } from './TextTrack';
import { ClipSegments } from './ClipSegments';
import { AudioSegments } from './AudioSegments';
import { getActiveVideo, setActiveClip, getVideoForClip } from './videoSession';
import { bindDropIndicator } from './dropIndicator';
// NOTE: TrimHandles from 5B is superseded by per-clip edges inside ClipSegments.
import { locateGlobal } from '@shared/lib/clipTime';

function formatTickLabel(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function pickTickInterval(durationMs: number, widthPx: number): number {
  const targetTicks = Math.max(4, Math.floor(widthPx / 80));
  const rawInterval = durationMs / 1000 / targetTicks;
  const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  for (const c of candidates) {
    if (c >= rawInterval) return c;
  }
  return candidates[candidates.length - 1];
}

export function Timeline() {
  const trackRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const rulerRef = useRef<HTMLDivElement>(null);
  const dropIndicatorRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [trackWidth, setTrackWidth] = useState(0);
  // Horizontal zoom: 1 = the whole timeline fits the viewport. Higher zooms the
  // content wider than the viewport (Ctrl+wheel), with a horizontal scrollbar.
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    bindDropIndicator(dropIndicatorRef.current);
    return () => bindDropIndicator(null);
  }, []);

  // Ctrl+wheel zooms, anchored on the cursor so the point under it stays put.
  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey) return; // plain wheel = normal scroll
    e.preventDefault();
    const scroll = scrollRef.current;
    if (!scroll) return;
    const rect = scroll.getBoundingClientRect();
    const cursorX = e.clientX - rect.left; // px within the viewport
    setZoom((old) => {
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      const next = Math.max(1, Math.min(20, old * factor));
      if (next === old) return old;
      const contentOld = scroll.clientWidth * old;
      const contentNew = scroll.clientWidth * next;
      const tRatio = (scroll.scrollLeft + cursorX) / contentOld;
      requestAnimationFrame(() => {
        scroll.scrollLeft = tRatio * contentNew - cursorX;
      });
      return next;
    });
  }, []);

  const durationMs = usePlaybackStore((s) => s.durationMs);
  const selectZoom = useSelectionStore((s) => s.selectZoom);
  const selectClip = useSelectionStore((s) => s.selectClip);
  const selectAudio = useSelectionStore((s) => s.selectAudio);

  // The timeline's VISUAL span = max(video duration, latest audio end) + a
  // small end padding, so a long audio (e.g. 4 min over a 30s video) fits in
  // view and its end is grabbable. Playback is still bounded by the video
  // (`durationMs`); scrubbing past it parks the video on its last frame while
  // audio keeps playing.
  const audioMaxEnd = useProjectStore((s) =>
    (s.project?.audioTracks ?? []).reduce((m, t) => Math.max(m, t.offsetMs + (t.outMs - t.inMs)), 0));
  const rawSpan = Math.max(durationMs, audioMaxEnd);
  const viewDurationMs = rawSpan > 0 ? rawSpan * 1.03 : 0; // 3% breathing room at the end
  const viewDurationRef = useRef(viewDurationMs);
  viewDurationRef.current = viewDurationMs;

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setTrackWidth(el.clientWidth));
    ro.observe(el);
    setTrackWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Playhead positioning rAF — reads global currentTime from the playback store.
  useEffect(() => {
    let rafId = 0;
    const tick = (): void => {
      const track = trackRef.current;
      const head = playheadRef.current;
      if (track && head) {
        const total = viewDurationRef.current;
        const now = usePlaybackStore.getState().currentTimeMs;
        const ratio = total > 0 ? Math.max(0, Math.min(1, now / total)) : 0;
        head.style.transform = `translateX(${ratio * track.clientWidth}px)`;
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, []);

  /** Seek the active clip to whatever global ms maps to. */
  const seekGlobal = useCallback((globalMs: number) => {
    const project = useProjectStore.getState().project;
    if (!project) return;
    const located = locateGlobal(project, globalMs);
    if (!located) return;
    const { clip, localMs } = located;
    // Switch active clip if needed.
    const targetVideo = getVideoForClip(clip.id);
    if (targetVideo) {
      setActiveClip(clip.id);
      targetVideo.currentTime = localMs / 1000;
    }
    usePlaybackStore.getState().setCurrentTime(globalMs);
  }, []);

  const seekToClientX = useCallback((clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const total = viewDurationRef.current;
    if (total <= 0) return;
    seekGlobal(ratio * total);
  }, [seekGlobal]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const targetEl = e.target as HTMLElement;
    if (
      targetEl.closest('.zoom-chip') ||
      targetEl.closest('.text-chip') ||
      targetEl.closest('.trim-handle') ||
      targetEl.closest('.clip-segment-edge') ||
      targetEl.closest('.audio-segment')
    ) return;
    selectZoom(null);
    selectClip(null);
    selectAudio(null);
    useSelectionStore.getState().selectText(null);
    useSelectionStore.getState().selectTransition(null);
    e.preventDefault();
    const track = trackRef.current;
    if (!track) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);

    const v = getActiveVideo();
    const wasPlaying = v ? !v.paused : false;
    if (v && wasPlaying) v.pause();
    usePlaybackStore.getState().setScrubbing(true, wasPlaying);
    seekToClientX(e.clientX);

    const onMove = (ev: PointerEvent): void => seekToClientX(ev.clientX);
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const resume = usePlaybackStore.getState().scrubResumeOnEnd;
      usePlaybackStore.getState().setScrubbing(false);
      const vv = getActiveVideo();
      if (resume && vv) vv.play().catch(() => {});
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [seekToClientX, selectZoom, selectClip, selectAudio]);

  useEffect(() => {
    const ruler = rulerRef.current;
    const track = trackRef.current;
    if (!ruler || !track) return;
    const drawTicks = (): void => {
      ruler.innerHTML = '';
      const widthPx = track.clientWidth;
      const total = viewDurationMs;
      if (total <= 0 || widthPx <= 0) return;
      const intervalSec = pickTickInterval(total, widthPx);
      const durationSec = total / 1000;
      for (let t = 0; t <= durationSec + 0.001; t += intervalSec) {
        const tick = document.createElement('div');
        tick.className = 'ruler__tick';
        tick.style.left = `${(t / durationSec) * 100}%`;
        const label = document.createElement('span');
        label.className = 'ruler__label';
        label.textContent = formatTickLabel(t);
        tick.appendChild(label);
        ruler.appendChild(tick);
      }
    };
    drawTicks();
    const ro = new ResizeObserver(drawTicks);
    ro.observe(track);
    return () => ro.disconnect();
  }, [viewDurationMs]);

  return (
    <div className="timeline">
      <div className="timeline__scroll" ref={scrollRef} onWheel={onWheel}>
        <div className="timeline__content" style={{ width: `${zoom * 100}%` }}>
          <div
            className="timeline__ruler"
            ref={rulerRef}
            onPointerDown={onPointerDown}
            title="Arrastrá para mover el playhead · Ctrl+rueda para zoom"
          />
          <div
            className="timeline__track-area"
            ref={trackRef}
            onPointerDown={onPointerDown}
            role="slider"
            aria-label="Timeline scrubber"
            aria-valuemin={0}
            aria-valuemax={durationMs}
          >
            <div className="timeline__row timeline__row--audio">
              <span className="timeline__row-label">Audio</span>
              <AudioSegments viewDurationMs={viewDurationMs} />
            </div>
            <div className="timeline__row timeline__row--video">
              <span className="timeline__row-label">Video</span>
              <ClipSegments durationMs={viewDurationMs} />
            </div>
            <div className="timeline__row timeline__row--zoom">
              <span className="timeline__row-label">Zoom</span>
              <ZoomTrack trackWidth={trackWidth} durationMs={viewDurationMs} />
            </div>
            <div className="timeline__row timeline__row--text">
              <span className="timeline__row-label">Texto</span>
              <TextTrack durationMs={viewDurationMs} />
            </div>
            <div className="timeline__playhead" ref={playheadRef}>
              <div className="timeline__playhead-handle" />
              <div className="timeline__playhead-line" />
            </div>
            <div ref={dropIndicatorRef} className="clip-drop-indicator" style={{ display: 'none' }} />
          </div>
        </div>
      </div>
      {zoom > 1 && (
        <div className="timeline__zoom-badge" title="Ctrl+rueda para zoom">
          {Math.round(zoom * 100)}% · <button onClick={() => setZoom(1)}>reset</button>
        </div>
      )}
    </div>
  );
}
