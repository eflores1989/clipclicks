import { useCallback, useRef } from 'react';
import { Type } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';

interface TextTrackProps {
  durationMs: number;
}

type DragMode = 'move' | 'resize-start' | 'resize-end';

interface DragState {
  id: string;
  mode: DragMode;
  pointerStartX: number;
  origStartMs: number;
  origEndMs: number;
  trackWidth: number;
}

const MIN_TEXT_DURATION_MS = 300;
const EDGE_GRAB_PX = 8;

/**
 * Timeline track for text overlays. Unlike zoom chips (per-clip, source-local),
 * text events live on the GLOBAL timeline, so start/end map straight to pixels.
 * Drag the body to move, the edges to trim.
 */
export function TextTrack({ durationMs }: TextTrackProps) {
  const texts = useProjectStore((s) => s.project?.timeline.textEvents ?? []);
  const update = useProjectStore((s) => s.update);
  const selectedTextId = useSelectionStore((s) => s.selectedTextId);
  const selectText = useSelectionStore((s) => s.selectText);

  const dragRef = useRef<DragState | null>(null);
  const draftRef = useRef<{ startMs: number; endMs: number } | null>(null);

  const onChipPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    selectText(id);
    const project = useProjectStore.getState().project;
    const t = project?.timeline.textEvents.find((x) => x.id === id);
    if (!t) return;
    // Bring the playhead into the text's range so it's visible on the canvas
    // for editing (the overlay + Pixi text only show while in range).
    const ph = usePlaybackStore.getState().currentTimeMs;
    if (ph < t.startMs || ph > t.endMs) usePlaybackStore.getState().setCurrentTime(t.startMs);

    const chip = e.currentTarget as HTMLElement;
    const rect = chip.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    let mode: DragMode = 'move';
    if (localX < EDGE_GRAB_PX) mode = 'resize-start';
    else if (rect.width - localX < EDGE_GRAB_PX) mode = 'resize-end';

    const trackEl = chip.closest('.timeline__track-area') as HTMLElement | null;
    const tw = trackEl?.clientWidth ?? 1;
    dragRef.current = { id, mode, pointerStartX: e.clientX, origStartMs: t.startMs, origEndMs: t.endMs, trackWidth: tw };
    draftRef.current = { startMs: t.startMs, endMs: t.endMs };
    chip.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent): void => {
      const drag = dragRef.current;
      if (!drag) return;
      const deltaMs = ((ev.clientX - drag.pointerStartX) / drag.trackWidth) * durationMs;
      update((d) => {
        const target = d.timeline.textEvents.find((x) => x.id === drag.id);
        if (!target) return;
        if (drag.mode === 'move') {
          const dur = drag.origEndMs - drag.origStartMs;
          const newStart = Math.max(0, drag.origStartMs + deltaMs);
          target.startMs = newStart;
          target.endMs = newStart + dur;
        } else if (drag.mode === 'resize-start') {
          target.startMs = Math.max(0, Math.min(target.endMs - MIN_TEXT_DURATION_MS, drag.origStartMs + deltaMs));
        } else {
          target.endMs = Math.max(target.startMs + MIN_TEXT_DURATION_MS, drag.origEndMs + deltaMs);
        }
        // Keep enter/exit within the new span.
        const span = target.endMs - target.startMs;
        target.enterDurationMs = Math.min(target.enterDurationMs, span * 0.6);
        target.exitDurationMs = Math.min(target.exitDurationMs, span * 0.6);
      }, { record: false });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const drag = dragRef.current;
      const draft = draftRef.current;
      dragRef.current = null;
      draftRef.current = null;
      if (!drag || !draft) return;
      const proj = useProjectStore.getState().project;
      const final = proj?.timeline.textEvents.find((x) => x.id === drag.id);
      if (!final) return;
      if (final.startMs === draft.startMs && final.endMs === draft.endMs) return;
      const fs = final.startMs, fe = final.endMs;
      const fEnter = final.enterDurationMs, fExit = final.exitDurationMs;
      // Replay (snapshot → final) so the drag is one undo step.
      update((d) => {
        const t = d.timeline.textEvents.find((x) => x.id === drag.id);
        if (t) { t.startMs = draft.startMs; t.endMs = draft.endMs; }
      }, { record: false });
      update((d) => {
        const t = d.timeline.textEvents.find((x) => x.id === drag.id);
        if (t) { t.startMs = fs; t.endMs = fe; t.enterDurationMs = fEnter; t.exitDurationMs = fExit; }
      }, { label: drag.mode === 'move' ? 'Move text' : 'Resize text' });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [durationMs, selectText, update]);

  if (durationMs <= 0) return null;

  return (
    <div className="text-track__chips">
      {texts.map((t) => {
        const leftPct = (t.startMs / durationMs) * 100;
        const widthPct = ((t.endMs - t.startMs) / durationMs) * 100;
        const isSelected = selectedTextId === t.id;
        const label = t.text.trim().split('\n')[0] || t.preset;
        return (
          <div
            key={t.id}
            className={`text-chip ${isSelected ? 'text-chip--selected' : ''}`}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            onPointerDown={(e) => onChipPointerDown(e, t.id)}
            title={`${label} · ${((t.endMs - t.startMs) / 1000).toFixed(1)}s`}
          >
            <span className="text-chip__label"><Type size={10} /> {label}</span>
          </div>
        );
      })}
    </div>
  );
}
