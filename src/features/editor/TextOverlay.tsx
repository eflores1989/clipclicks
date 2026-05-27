import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';
import type { Project, TextEvent } from '@shared/types/project';

const MIN_SCALE = 0.02;
const MAX_SCALE = 0.30;

// One offscreen 2D context, reused for text measurement.
let measureCtx: CanvasRenderingContext2D | null = null;
function ctx(): CanvasRenderingContext2D {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx as CanvasRenderingContext2D;
}

/** Measure a (possibly multi-line) string at a given pixel font, in screen px. */
function measure(t: TextEvent, fontPx: number): { w: number; h: number } {
  const c = ctx();
  c.font = `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${fontPx}px ${t.fontFamily}`;
  const lines = t.text.split('\n');
  let w = 0;
  for (const ln of lines) w = Math.max(w, c.measureText(ln || ' ').width);
  const lineH = fontPx * 1.25;
  return { w: w + fontPx * 0.3, h: lineH * lines.length };
}

/**
 * On-canvas editor for the selected text overlay. Shown over `.preview-canvas`
 * while a text is selected and the playhead is within its range. Drag the box
 * to reposition (updates normalized center nx/ny); drag a corner to resize
 * (scales fontScale around the center). Mirrors CropOverlay's drag/commit model
 * (one undo step per gesture).
 */
export function TextOverlay() {
  const rootRef = useRef<HTMLDivElement>(null);
  const update = useProjectStore((s) => s.update);
  const selectedTextId = useSelectionStore((s) => s.selectedTextId);
  const t = useProjectStore((s) => s.project?.timeline.textEvents.find((x) => x.id === selectedTextId));
  // Re-render as the playhead moves so we hide when it leaves the text's range.
  const playhead = usePlaybackStore((s) => s.currentTimeMs);
  const snap = useRef<{ nx: number; ny: number; fontScale: number } | null>(null);
  // The box size is measured from the live canvas rect, which isn't available on
  // the very first render (ref not attached yet) — and when paused the playhead
  // doesn't tick to re-render. Bump on mount/selection + observe size changes.
  const [, force] = useState(0);
  useLayoutEffect(() => {
    force((v) => v + 1);
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => force((v) => v + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, [selectedTextId]);

  const write = useCallback((fn: (e: TextEvent) => void, opts: { record: boolean; label?: string }) => {
    update((d: Project) => {
      const ev = d.timeline.textEvents.find((x) => x.id === selectedTextId);
      if (ev) fn(ev);
    }, opts.record ? { label: opts.label } : { record: false });
  }, [update, selectedTextId]);

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
    const onUp = (): void => commit(onMove, onUp, 'Move text');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [t, write]);

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
    const onUp = (): void => commit(onMove, onUp, 'Resize text');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [t, write]);

  const commit = useCallback((onMove: (ev: PointerEvent) => void, onUp: () => void, label: string) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const s = snap.current; snap.current = null;
    const cur = useProjectStore.getState().project?.timeline.textEvents.find((x) => x.id === selectedTextId);
    if (!s || !cur) return;
    if (s.nx === cur.nx && s.ny === cur.ny && s.fontScale === cur.fontScale) return;
    const final = { nx: cur.nx, ny: cur.ny, fontScale: cur.fontScale };
    write((x) => { x.nx = s.nx; x.ny = s.ny; x.fontScale = s.fontScale; }, { record: false });
    write((x) => { x.nx = final.nx; x.ny = final.ny; x.fontScale = final.fontScale; }, { record: true, label });
  }, [selectedTextId, write]);

  if (!t) return null;
  if (playhead < t.startMs || playhead > t.endMs) return null;

  // Box geometry in % of the preview-canvas. Measure with the on-screen font px
  // (fontScale is a fraction of canvas height ≈ the rendered overlay height).
  const box = rootRef.current?.getBoundingClientRect();
  const heightPx = box?.height ?? 0;
  const widthPx = box?.width ?? 1;
  const fontPx = t.fontScale * heightPx;
  const { w, h } = heightPx > 0 ? measure(t, fontPx) : { w: 0, h: 0 };
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
        {(['nw', 'ne', 'se', 'sw'] as const).map((h) => (
          <div key={h} className={`text-overlay__handle text-overlay__handle--${h}`} onPointerDown={onResizeDown} />
        ))}
      </div>
    </div>
  );
}
