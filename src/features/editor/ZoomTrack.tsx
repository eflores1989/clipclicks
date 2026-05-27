import { useCallback, useRef } from 'react';
import { Lock } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { clipSpeed, localToGlobal } from '@shared/lib/clipTime';
import type { ZoomEvent } from '@shared/types/project';

interface ZoomTrackProps {
  trackWidth: number;
  durationMs: number;
}

type DragMode = 'move' | 'resize-start' | 'resize-end';

interface DragState {
  zoomId: string;
  clipId: string;
  mode: DragMode;
  pointerStartX: number;
  origLocalStartMs: number;
  origLocalEndMs: number;
  clipInMs: number;
  clipOutMs: number;
  clipSpeed: number;
  trackWidth: number;
}

const MIN_ZOOM_DURATION_MS = 300;
const EDGE_GRAB_PX = 8;

interface FlatZoom {
  zoom: ZoomEvent;
  clipId: string;
  globalStartMs: number;
  globalEndMs: number;
}

export function ZoomTrack({ trackWidth, durationMs }: ZoomTrackProps) {
  const clips = useProjectStore((s) => s.project?.clips ?? []);
  const update = useProjectStore((s) => s.update);
  const selectedZoomId = useSelectionStore((s) => s.selectedZoomId);
  const selectZoom = useSelectionStore((s) => s.selectZoom);

  const dragStateRef = useRef<DragState | null>(null);
  const draftStartRef = useRef<{ id: string; localStartMs: number; localEndMs: number } | null>(null);

  // Flatten all clips' zoom events to global-time positions.
  const flatZooms: FlatZoom[] = [];
  for (const c of clips) {
    const speed = clipSpeed(c);
    for (const z of c.zoomEvents) {
      // Only show zooms that intersect the visible (trimmed) range of the clip.
      if (z.endMs <= c.inMs || z.startMs >= c.outMs) continue;
      const clampedStart = Math.max(z.startMs, c.inMs);
      const clampedEnd = Math.min(z.endMs, c.outMs);
      flatZooms.push({
        zoom: z,
        clipId: c.id,
        globalStartMs: c.timelineStartMs + (clampedStart - c.inMs) / speed,
        globalEndMs: c.timelineStartMs + (clampedEnd - c.inMs) / speed,
      });
    }
  }

  const onChipPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, fz: FlatZoom) => {
    e.preventDefault();
    e.stopPropagation();
    selectZoom(fz.zoom.id);
    if (fz.zoom.locked) return;

    const chip = e.currentTarget as HTMLElement;
    const rect = chip.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    let mode: DragMode = 'move';
    if (localX < EDGE_GRAB_PX) mode = 'resize-start';
    else if (rect.width - localX < EDGE_GRAB_PX) mode = 'resize-end';

    const trackEl = chip.closest('.timeline__track-area') as HTMLElement | null;
    const tw = trackEl?.clientWidth ?? trackWidth;
    const project = useProjectStore.getState().project;
    const clip = project?.clips.find((c) => c.id === fz.clipId);
    if (!clip) return;

    dragStateRef.current = {
      zoomId: fz.zoom.id,
      clipId: fz.clipId,
      mode,
      pointerStartX: e.clientX,
      origLocalStartMs: fz.zoom.startMs,
      origLocalEndMs: fz.zoom.endMs,
      clipInMs: clip.inMs,
      clipOutMs: clip.outMs,
      clipSpeed: clipSpeed(clip),
      trackWidth: tw,
    };
    draftStartRef.current = { id: fz.zoom.id, localStartMs: fz.zoom.startMs, localEndMs: fz.zoom.endMs };
    chip.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent): void => {
      const drag = dragStateRef.current;
      if (!drag) return;
      const deltaPx = ev.clientX - drag.pointerStartX;
      // Pixels → global ms → clip-local ms (multiply by clip speed).
      const deltaGlobalMs = (deltaPx / drag.trackWidth) * durationMs;
      const deltaLocalMs = deltaGlobalMs * drag.clipSpeed;
      update((d) => {
        const c = d.clips.find((cc) => cc.id === drag.clipId);
        const target = c?.zoomEvents.find((zz) => zz.id === drag.zoomId);
        if (!c || !target) return;
        if (drag.mode === 'move') {
          const dur = drag.origLocalEndMs - drag.origLocalStartMs;
          let newStart = drag.origLocalStartMs + deltaLocalMs;
          newStart = Math.max(c.inMs, Math.min(c.outMs - dur, newStart));
          target.startMs = newStart;
          target.endMs = newStart + dur;
        } else if (drag.mode === 'resize-start') {
          let newStart = drag.origLocalStartMs + deltaLocalMs;
          newStart = Math.max(c.inMs, Math.min(target.endMs - MIN_ZOOM_DURATION_MS, newStart));
          target.startMs = newStart;
          const t = target.endMs - target.startMs;
          const maxEnter = Math.max(50, t / 3);
          const maxExit = Math.max(50, t / 3);
          target.enterDurationMs = Math.min(target.enterDurationMs, maxEnter);
          target.exitDurationMs = Math.min(target.exitDurationMs, maxExit);
          target.holdDurationMs = Math.max(0, t - target.enterDurationMs - target.exitDurationMs);
        } else {
          let newEnd = drag.origLocalEndMs + deltaLocalMs;
          newEnd = Math.max(target.startMs + MIN_ZOOM_DURATION_MS, Math.min(c.outMs, newEnd));
          target.endMs = newEnd;
          const t = target.endMs - target.startMs;
          const maxEnter = Math.max(50, t / 3);
          const maxExit = Math.max(50, t / 3);
          target.enterDurationMs = Math.min(target.enterDurationMs, maxEnter);
          target.exitDurationMs = Math.min(target.exitDurationMs, maxExit);
          target.holdDurationMs = Math.max(0, t - target.enterDurationMs - target.exitDurationMs);
        }
      }, { record: false });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const drag = dragStateRef.current;
      const draft = draftStartRef.current;
      dragStateRef.current = null;
      draftStartRef.current = null;
      if (!drag || !draft) return;
      const project = useProjectStore.getState().project;
      const finalClip = project?.clips.find((c) => c.id === drag.clipId);
      const final = finalClip?.zoomEvents.find((zz) => zz.id === drag.zoomId);
      if (!final) return;
      if (final.startMs === draft.localStartMs && final.endMs === draft.localEndMs) return;
      const finalStart = final.startMs;
      const finalEnd = final.endMs;
      const finalEnter = final.enterDurationMs;
      const finalExit = final.exitDurationMs;
      const finalHold = final.holdDurationMs;
      update((d) => {
        const c = d.clips.find((cc) => cc.id === drag.clipId);
        const t = c?.zoomEvents.find((zz) => zz.id === drag.zoomId);
        if (t) {
          t.startMs = draft.localStartMs;
          t.endMs = draft.localEndMs;
        }
      }, { record: false });
      update((d) => {
        const c = d.clips.find((cc) => cc.id === drag.clipId);
        const t = c?.zoomEvents.find((zz) => zz.id === drag.zoomId);
        if (t) {
          t.startMs = finalStart;
          t.endMs = finalEnd;
          t.enterDurationMs = finalEnter;
          t.exitDurationMs = finalExit;
          t.holdDurationMs = finalHold;
        }
      }, { label: drag.mode === 'move' ? 'Move zoom' : 'Resize zoom' });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [durationMs, selectZoom, update, trackWidth]);

  if (durationMs <= 0) return null;

  return (
    <div className="zoom-track__chips">
      {flatZooms.map((fz) => {
        const leftPct = (fz.globalStartMs / durationMs) * 100;
        const widthPct = ((fz.globalEndMs - fz.globalStartMs) / durationMs) * 100;
        const isSelected = selectedZoomId === fz.zoom.id;
        const isManual = fz.zoom.source === 'manual';
        return (
          <div
            key={fz.zoom.id}
            className={`zoom-chip ${isSelected ? 'zoom-chip--selected' : ''} ${isManual ? 'zoom-chip--manual' : 'zoom-chip--auto'} ${fz.zoom.locked ? 'zoom-chip--locked' : ''}`}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            onPointerDown={(e) => onChipPointerDown(e, fz)}
            title={`${fz.zoom.scale.toFixed(1)}× · ${((fz.zoom.endMs - fz.zoom.startMs) / 1000).toFixed(1)}s`}
          >
            <span className="zoom-chip__label">
              {fz.zoom.locked && <Lock size={10} />}
              {fz.zoom.scale.toFixed(1)}×
            </span>
          </div>
        );
      })}
    </div>
  );
}
