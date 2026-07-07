import { useCallback, useRef } from 'react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';
import { locateGlobal } from '@shared/lib/clipTime';
import { focusFromKeyframes } from '@shared/lib/computeZoomState';
import type { Clip, FocusKeyframe, Project, ZoomEvent } from '@shared/types/project';

/** Treat the current time as "on" a keyframe if within this many ms of it. */
const SAME_POINT_TOL_MS = 120;

function findZoom(p: Project, zoomId: string): { clip: Clip; zoom: ZoomEvent } | null {
  for (const c of p.clips) {
    const z = c.zoomEvents.find((zz) => zz.id === zoomId);
    if (z) return { clip: c, zoom: z };
  }
  return null;
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, v)); }

/**
 * Focus-path editor over the full (uncropped) frame while `trackEditMode` is on.
 * Time-based workflow: scrub the zoom's own time bar (in the panel) to the
 * moment you want, then drag the dot onto the subject — the point is anchored to
 * THAT time. Existing points are numbered markers (drag to reposition; their
 * time stays). When the playhead sits on a point, that marker is the handle;
 * otherwise a dashed "ghost" dot lets you drop a new point at the current time.
 */
export function ZoomFocusOverlay({ paddingPct }: { paddingPct: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedZoomId = useSelectionStore((s) => s.selectedZoomId);
  const playhead = usePlaybackStore((s) => s.currentTimeMs);
  const snapRef = useRef<FocusKeyframe[] | null>(null);

  const found = project && selectedZoomId ? findZoom(project, selectedZoomId) : null;

  const writeLive = useCallback((mut: (z: ZoomEvent) => void) => {
    update((d) => {
      const f = findZoom(d, selectedZoomId ?? '');
      if (f) mut(f.zoom);
    }, { record: false });
  }, [update, selectedZoomId]);

  const commitDrag = useCallback((onMove: (ev: PointerEvent) => void, onUp: () => void) => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    const snap = snapRef.current; snapRef.current = null;
    const cur = findZoom(useProjectStore.getState().project as Project, selectedZoomId ?? '')?.zoom.focusKeyframes;
    if (!snap || !cur) return;
    const finalKfs = cur.map((k) => ({ ...k }));
    update((d) => { const f = findZoom(d, selectedZoomId ?? ''); if (f) f.zoom.focusKeyframes = snap; }, { record: false });
    update((d) => { const f = findZoom(d, selectedZoomId ?? ''); if (f) f.zoom.focusKeyframes = finalKfs; }, { label: 'Set tracking point' });
  }, [update, selectedZoomId]);

  if (!project || !found) return null;
  const { clip, zoom } = found;
  const kfs = zoom.focusKeyframes ?? [];
  if (zoom.locked) return null;

  const padFrac = paddingPct / 100;
  const inner = 1 - 2 * padFrac;
  const toCanvas = (n: number): number => padFrac + n * inner;
  const toFrame = (canvasFrac: number): number => (inner > 0 ? clamp01((canvasFrac - padFrac) / inner) : 0.5);

  // Clip-local authoring time = the playhead within this zoom's clip, clamped to
  // the zoom's span. Points are stored at THIS time (not speed-scaled).
  const located = locateGlobal(project, playhead);
  const overThisClip = located?.clip.id === clip.id;
  const localMs = overThisClip ? located!.localMs : zoom.startMs;
  const t = Math.max(zoom.startMs, Math.min(zoom.endMs, localMs));
  const activeIdx = kfs.findIndex((k) => Math.abs(k.t - t) <= SAME_POINT_TOL_MS);
  const ghost = activeIdx === -1
    ? (kfs.length ? focusFromKeyframes(kfs, t) : { nx: zoom.target.nx ?? 0.5, ny: zoom.target.ny ?? 0.5 })
    : null;

  // Drag an existing marker: move its position, keep its time.
  const onMarkerDown = (e: React.PointerEvent, idx: number): void => {
    e.preventDefault(); e.stopPropagation();
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    snapRef.current = kfs.map((k) => ({ ...k }));
    const onMove = (ev: PointerEvent): void => {
      const nx = toFrame((ev.clientX - box.left) / box.width);
      const ny = toFrame((ev.clientY - box.top) / box.height);
      writeLive((z) => { if (z.focusKeyframes?.[idx]) { z.focusKeyframes[idx].nx = nx; z.focusKeyframes[idx].ny = ny; } });
    };
    const onUp = (): void => commitDrag(onMove, onUp);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Drag the ghost: create a NEW point at the current time, then position it.
  const onGhostDown = (e: React.PointerEvent): void => {
    e.preventDefault(); e.stopPropagation();
    const box = rootRef.current?.getBoundingClientRect();
    if (!box) return;
    snapRef.current = kfs.map((k) => ({ ...k }));
    const seed = ghost ?? { nx: 0.5, ny: 0.5 };
    const upsertAtT = (z: ZoomEvent, nx: number, ny: number): void => {
      if (!z.focusKeyframes) z.focusKeyframes = [];
      const i = z.focusKeyframes.findIndex((k) => Math.abs(k.t - t) <= SAME_POINT_TOL_MS);
      if (i >= 0) { z.focusKeyframes[i].nx = nx; z.focusKeyframes[i].ny = ny; }
      else z.focusKeyframes.push({ t, nx, ny });
      z.focusKeyframes.sort((a, b) => a.t - b.t);
    };
    writeLive((z) => upsertAtT(z, seed.nx, seed.ny));
    const onMove = (ev: PointerEvent): void => {
      const nx = toFrame((ev.clientX - box.left) / box.width);
      const ny = toFrame((ev.clientY - box.top) / box.height);
      writeLive((z) => upsertAtT(z, nx, ny));
    };
    const onUp = (): void => commitDrag(onMove, onUp);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="zoomfocus-overlay" ref={rootRef}>
      {kfs.map((k, i) => (
        <div
          key={i}
          className={`zoomfocus-dot ${i === activeIdx ? 'zoomfocus-dot--active' : ''}`}
          style={{ left: `${toCanvas(k.nx) * 100}%`, top: `${toCanvas(k.ny) * 100}%` }}
          onPointerDown={(e) => onMarkerDown(e, i)}
          title={`Point ${i + 1} @ +${((k.t - zoom.startMs) / 1000).toFixed(1)}s — drag to reposition`}
        >
          <span className="zoomfocus-dot__n">{i + 1}</span>
        </div>
      ))}
      {ghost && (
        <div
          className="zoomfocus-dot zoomfocus-dot--ghost"
          style={{ left: `${toCanvas(ghost.nx) * 100}%`, top: `${toCanvas(ghost.ny) * 100}%` }}
          onPointerDown={onGhostDown}
          title="Drag onto the subject to drop a point at the current time"
        >
          <span className="zoomfocus-dot__plus">+</span>
        </div>
      )}
    </div>
  );
}
