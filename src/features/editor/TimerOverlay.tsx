import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';
import { timerText } from '@shared/lib/timerValue';
import type { Project, TimerEvent } from '@shared/types/project';

const MIN_SCALE = 0.03;
const MAX_SCALE = 0.35;

let measureCtx: CanvasRenderingContext2D | null = null;
function ctx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx as CanvasRenderingContext2D;
}

function measure(t: TimerEvent, content: string, fontPx: number): { w: number; h: number } {
  const c = ctx();
  c.font = `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${fontPx}px ${t.fontFamily}`;
  const w = c.measureText(content || '0').width;
  return { w: w + fontPx * 0.3, h: fontPx * 1.25 };
}

/**
 * On-canvas editor for the selected timer overlay. Mirrors TextOverlay: drag the
 * box to reposition (nx/ny), drag a corner to resize (fontScale). The displayed
 * content is the timer's current value at the playhead so the box tracks its
 * real size as the digits change.
 */
export function TimerOverlay() {
  const rootRef = useRef<HTMLDivElement>(null);
  const update = useProjectStore((s) => s.update);
  const selectedTimerId = useSelectionStore((s) => s.selectedTimerId);
  const t = useProjectStore((s) => s.project?.timeline.timerEvents?.find((x) => x.id === selectedTimerId));
  const playhead = usePlaybackStore((s) => s.currentTimeMs);
  const snap = useRef<{ nx: number; ny: number; fontScale: number } | null>(null);
  const [, force] = useState(0);
  useLayoutEffect(() => {
    force((v) => v + 1);
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => force((v) => v + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [selectedTimerId]);

  const write = useCallback((fn: (e: TimerEvent) => void, opts: { record: boolean; label?: string }) => {
    update((d: Project) => {
      const ev = d.timeline.timerEvents?.find((x) => x.id === selectedTimerId);
      if (ev) fn(ev);
    }, opts.record ? { label: opts.label } : { record: false });
  }, [update, selectedTimerId]);

  const commit = useCallback((onMove: (ev: PointerEvent) => void, onUp: () => void, label: string) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const s = snap.current; snap.current = null;
    const cur = useProjectStore.getState().project?.timeline.timerEvents?.find((x) => x.id === selectedTimerId);
    if (!s || !cur) return;
    if (s.nx === cur.nx && s.ny === cur.ny && s.fontScale === cur.fontScale) return;
    const final = { nx: cur.nx, ny: cur.ny, fontScale: cur.fontScale };
    write((x) => { x.nx = s.nx; x.ny = s.ny; x.fontScale = s.fontScale; }, { record: false });
    write((x) => { x.nx = final.nx; x.ny = final.ny; x.fontScale = final.fontScale; }, { record: true, label });
  }, [selectedTimerId, write]);

  const onMoveDown = useCallback((e: React.PointerEvent) => {
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    snap.current = { nx: t.nx, ny: t.ny, fontScale: t.fontScale };
    const startX = e.clientX, startY = e.clientY;
    const onMove = (ev: PointerEvent): void => {
      const dx = (ev.clientX - startX) / box.width;
      const dy = (ev.clientY - startY) / box.height;
      write((x) => {
        x.nx = Math.max(0, Math.min(1, snap.current!.nx + dx));
        x.ny = Math.max(0, Math.min(1, snap.current!.ny + dy));
      }, { record: false });
    };
    const onUp = (): void => commit(onMove, onUp, 'Move timer');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [t, write, commit]);

  const onResizeDown = useCallback((e: React.PointerEvent) => {
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    snap.current = { nx: t.nx, ny: t.ny, fontScale: t.fontScale };
    const cx = box.left + t.nx * box.width;
    const cy = box.top + t.ny * box.height;
    const startDist = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    const onMove = (ev: PointerEvent): void => {
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, snap.current!.fontScale * (dist / startDist)));
      write((x) => { x.fontScale = next; }, { record: false });
    };
    const onUp = (): void => commit(onMove, onUp, 'Resize timer');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [t, write, commit]);

  if (!t) return null;
  if (playhead < t.startMs || playhead > t.endMs) return null;

  const box = rootRef.current?.getBoundingClientRect();
  const heightPx = box?.height ?? 0;
  const widthPx = box?.width ?? 1;
  const fontPx = t.fontScale * heightPx;
  const content = timerText(t, Math.round(playhead));
  const { w, h } = heightPx > 0 ? measure(t, content, fontPx) : { w: 0, h: 0 };
  const wPct = (w / widthPx) * 100;
  const hPct = (h / heightPx) * 100;
  const leftPct = t.nx * 100 - wPct / 2;
  const topPct = t.ny * 100 - hPct / 2;

  return (
    <div className="text-overlay" ref={rootRef}>
      <div
        className="text-overlay__box"
        style={{ left: `${leftPct}%`, top: `${topPct}%`, width: `${wPct}%`, height: `${hPct}%` }}
        onPointerDown={onMoveDown}
      >
        {(['nw', 'ne', 'se', 'sw'] as const).map((corner) => (
          <div key={corner} className={`text-overlay__handle text-overlay__handle--${corner}`} onPointerDown={onResizeDown} />
        ))}
      </div>
    </div>
  );
}
