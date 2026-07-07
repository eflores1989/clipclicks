import { useCallback, useRef } from 'react';
import { Timer as TimerIcon } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';

interface TimerTrackProps {
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

const MIN_TIMER_DURATION_MS = 300;
const EDGE_GRAB_PX = 8;

/**
 * Timeline track for timers. Like TextTrack: timers live on the GLOBAL timeline
 * so start/end map straight to pixels. Drag the body to move, edges to trim.
 */
export function TimerTrack({ durationMs }: TimerTrackProps) {
  const timers = useProjectStore((s) => s.project?.timeline.timerEvents ?? []);
  const update = useProjectStore((s) => s.update);
  const selectedTimerId = useSelectionStore((s) => s.selectedTimerId);
  const selectTimer = useSelectionStore((s) => s.selectTimer);

  const dragRef = useRef<DragState | null>(null);
  const draftRef = useRef<{ startMs: number; endMs: number } | null>(null);

  const onChipPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    selectTimer(id);
    const project = useProjectStore.getState().project;
    const t = project?.timeline.timerEvents?.find((x) => x.id === id);
    if (!t) return;
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
        const target = d.timeline.timerEvents?.find((x) => x.id === drag.id);
        if (!target) return;
        if (drag.mode === 'move') {
          const dur = drag.origEndMs - drag.origStartMs;
          const newStart = Math.max(0, drag.origStartMs + deltaMs);
          target.startMs = newStart;
          target.endMs = newStart + dur;
        } else if (drag.mode === 'resize-start') {
          target.startMs = Math.max(0, Math.min(target.endMs - MIN_TIMER_DURATION_MS, drag.origStartMs + deltaMs));
        } else {
          target.endMs = Math.max(target.startMs + MIN_TIMER_DURATION_MS, drag.origEndMs + deltaMs);
        }
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
      const final = proj?.timeline.timerEvents?.find((x) => x.id === drag.id);
      if (!final) return;
      if (final.startMs === draft.startMs && final.endMs === draft.endMs) return;
      const fs = final.startMs, fe = final.endMs;
      // Replay (snapshot → final) so the drag is one undo step.
      update((d) => {
        const t = d.timeline.timerEvents?.find((x) => x.id === drag.id);
        if (t) { t.startMs = draft.startMs; t.endMs = draft.endMs; }
      }, { record: false });
      update((d) => {
        const t = d.timeline.timerEvents?.find((x) => x.id === drag.id);
        if (t) { t.startMs = fs; t.endMs = fe; }
      }, { label: drag.mode === 'move' ? 'Move timer' : 'Resize timer' });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [durationMs, selectTimer, update]);

  if (durationMs <= 0) return null;

  return (
    <div className="text-track__chips">
      {timers.map((t) => {
        const leftPct = (t.startMs / durationMs) * 100;
        const widthPct = ((t.endMs - t.startMs) / durationMs) * 100;
        const isSelected = selectedTimerId === t.id;
        const label = t.direction === 'down' ? 'Countdown' : 'Timer';
        return (
          <div
            key={t.id}
            className={`text-chip timer-chip ${isSelected ? 'text-chip--selected' : ''}`}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            onPointerDown={(e) => onChipPointerDown(e, t.id)}
            title={`${label} · ${((t.endMs - t.startMs) / 1000).toFixed(1)}s`}
          >
            <span className="text-chip__label"><TimerIcon size={10} /> {label}</span>
          </div>
        );
      })}
    </div>
  );
}
