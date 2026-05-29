import { useCallback, useRef } from 'react';
import { useProjectStore } from '@/stores/project';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { Music } from 'lucide-react';
import { clipEffectiveDurationMs } from '@shared/lib/clipTime';
import type { AudioTrack } from '@shared/types/project';

const MIN_LEN_MS = 200;
type DragMode = 'move' | 'in' | 'out';

/**
 * Renders the audio clips on the timeline's audio row. Each AudioTrack is a
 * chip positioned by `offsetMs` and sized by its trimmed length against the
 * GLOBAL timeline duration. Click selects (opens AudioProperties). Drag the
 * body to reposition; drag an edge to trim. Edits coalesce into one undo.
 */
export function AudioSegments({ viewDurationMs }: { viewDurationMs: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const audioTracks = useProjectStore((s) => s.project?.audioTracks ?? []);
  const audioPool = useProjectStore((s) => s.project?.audioPool ?? []);
  const selectedAudioId = useSelectionStore((s) => s.selectedAudioId);
  const selectAudio = useSelectionStore((s) => s.selectAudio);

  /** px → ms using the chip container's own width (so drag is pixel-accurate). */
  const pxToMs = useCallback((dxPx: number): number => {
    const el = containerRef.current;
    if (!el || viewDurationMs <= 0) return 0;
    const w = el.getBoundingClientRect().width;
    return w > 0 ? (dxPx / w) * viewDurationMs : 0;
  }, [viewDurationMs]);

  const onPointerDown = useCallback((e: React.PointerEvent, trackId: string, mode: DragMode) => {
    e.stopPropagation();
    selectAudio(trackId);
    const proj = useProjectStore.getState().project;
    const start = proj?.audioTracks.find((t) => t.id === trackId);
    const media = proj?.audioPool.find((m) => m.id === start?.mediaId);
    if (!start || !media || !proj) return;
    const snapshot = { ...start };
    const startX = e.clientX;
    let moved = false;
    const update = useProjectStore.getState().update;

    // Magnetism: snap dragged edges to meaningful points (timeline start/end,
    // playhead, clip boundaries, and OTHER audio edges). Overlap is still
    // allowed — we only nudge toward alignment, never block.
    const snapPoints: number[] = [0, usePlaybackStore.getState().durationMs, usePlaybackStore.getState().currentTimeMs];
    for (const c of proj.clips) {
      snapPoints.push(c.timelineStartMs, c.timelineStartMs + clipEffectiveDurationMs(c));
    }
    for (const t of proj.audioTracks) {
      if (t.id === trackId) continue;
      snapPoints.push(t.offsetMs, t.offsetMs + (t.outMs - t.inMs));
    }
    const snapThresholdMs = pxToMs(8); // ~8px of magnetism
    const snap = (value: number): number => {
      let best = value;
      let bestDist = snapThresholdMs;
      for (const p of snapPoints) {
        const dist = Math.abs(value - p);
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      return best;
    };

    const onMove = (ev: PointerEvent): void => {
      const dMs = pxToMs(ev.clientX - startX);
      if (!moved && Math.abs(ev.clientX - startX) < 4) return;
      moved = true;
      update((d) => {
        const t = d.audioTracks.find((x) => x.id === trackId);
        if (!t) return;
        if (mode === 'move') {
          const len = snapshot.outMs - snapshot.inMs;
          let newOffset = Math.max(0, snapshot.offsetMs + dMs);
          // Snap whichever edge (start or end) lands closer to a snap point.
          const snappedStart = snap(newOffset);
          const snappedEnd = snap(newOffset + len) - len;
          if (Math.abs(snappedStart - newOffset) <= Math.abs(snappedEnd - newOffset)) {
            newOffset = snappedStart;
          } else {
            newOffset = snappedEnd;
          }
          t.offsetMs = Math.max(0, newOffset);
        } else if (mode === 'in') {
          // Trim the start: inMs + dMs, keep the right edge fixed by shifting
          // offset by the same amount. Clamp so 0 ≤ inMs ≤ outMs - MIN.
          const rawOffset = snapshot.offsetMs + dMs;
          const snappedOffset = snap(rawOffset);
          const applied = (snappedOffset - snapshot.offsetMs);
          let newIn = snapshot.inMs + applied;
          newIn = Math.max(0, Math.min(snapshot.outMs - MIN_LEN_MS, newIn));
          const realApplied = newIn - snapshot.inMs;
          t.inMs = newIn;
          t.offsetMs = Math.max(0, snapshot.offsetMs + realApplied);
        } else {
          // Trim the end: snap the timeline end, derive outMs.
          const rawEnd = snapshot.offsetMs + (snapshot.outMs - snapshot.inMs) + dMs;
          const snappedEnd = snap(rawEnd);
          let newOut = snapshot.inMs + (snappedEnd - snapshot.offsetMs);
          newOut = Math.max(snapshot.inMs + MIN_LEN_MS, Math.min(media.durationMs, newOut));
          t.outMs = newOut;
        }
      }, { record: false });
    };

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) return;
      // Coalesce into one history entry: replay snapshot → final.
      const finalT = useProjectStore.getState().project?.audioTracks.find((x) => x.id === trackId);
      if (!finalT) return;
      const final = { ...finalT };
      update((d) => {
        const t = d.audioTracks.find((x) => x.id === trackId);
        if (t) { t.offsetMs = snapshot.offsetMs; t.inMs = snapshot.inMs; t.outMs = snapshot.outMs; }
      }, { record: false });
      update((d) => {
        const t = d.audioTracks.find((x) => x.id === trackId);
        if (t) { t.offsetMs = final.offsetMs; t.inMs = final.inMs; t.outMs = final.outMs; }
      }, { label: mode === 'move' ? 'Move audio' : 'Trim audio' });
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [pxToMs, selectAudio]);

  if (audioTracks.length === 0) {
    return <span className="timeline__row-hint">No audio — import one from the Media › Audio panel</span>;
  }
  if (viewDurationMs <= 0) return null;

  return (
    <div className="audio-segments" ref={containerRef}>
      {audioTracks.map((t: AudioTrack) => {
        const media = audioPool.find((m) => m.id === t.mediaId);
        const lenMs = Math.max(0, t.outMs - t.inMs);
        const leftPct = (t.offsetMs / viewDurationMs) * 100;
        const widthPct = (lenMs / viewDurationMs) * 100;
        const selected = t.id === selectedAudioId;
        return (
          <div
            key={t.id}
            className={`audio-segment ${selected ? 'audio-segment--selected' : ''} ${t.muted ? 'audio-segment--muted' : ''}`}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            onPointerDown={(e) => onPointerDown(e, t.id, 'move')}
            title={`${media?.name ?? 'Audio'} — drag to move, drag the edges to trim`}
          >
            <Waveform peaks={media?.peaks} inMs={t.inMs} outMs={t.outMs} mediaDurationMs={media?.durationMs ?? 0} />
            <span className="audio-segment__label">
              <Music size={10} /> {media?.name ?? 'Audio'}
            </span>
            <div className="audio-segment__edge audio-segment__edge--in" onPointerDown={(e) => onPointerDown(e, t.id, 'in')} />
            <div className="audio-segment__edge audio-segment__edge--out" onPointerDown={(e) => onPointerDown(e, t.id, 'out')} />
          </div>
        );
      })}
    </div>
  );
}

/**
 * Inline SVG waveform. Renders only the trimmed [inMs, outMs] window of the
 * media's peaks so it tracks edge-trimming visually.
 */
function Waveform({ peaks, inMs, outMs, mediaDurationMs }: {
  peaks?: number[]; inMs: number; outMs: number; mediaDurationMs: number;
}) {
  if (!peaks || peaks.length === 0 || mediaDurationMs <= 0) return null;
  const startIdx = Math.floor((inMs / mediaDurationMs) * peaks.length);
  const endIdx = Math.ceil((outMs / mediaDurationMs) * peaks.length);
  const window = peaks.slice(Math.max(0, startIdx), Math.min(peaks.length, endIdx));
  if (window.length === 0) return null;
  const target = 120;
  const step = Math.max(1, Math.floor(window.length / target));
  const bars: number[] = [];
  for (let i = 0; i < window.length; i += step) {
    let m = 0;
    for (let j = i; j < Math.min(window.length, i + step); j++) m = Math.max(m, window[j]);
    bars.push(m);
  }
  const n = bars.length;
  return (
    <svg className="audio-segment__wave" viewBox={`0 0 ${n} 100`} preserveAspectRatio="none">
      {bars.map((v, i) => {
        const h = Math.max(2, v * 100);
        return <rect key={i} x={i} y={(100 - h) / 2} width={0.8} height={h} />;
      })}
    </svg>
  );
}
