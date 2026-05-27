import { useCallback } from 'react';
import { Blend } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';
import { clipEffectiveDurationMs, clipSpeed, locateGlobal } from '@shared/lib/clipTime';
import { setActiveClip, getVideoForClip } from './videoSession';
import { hideDropIndicator, showDropIndicator } from './dropIndicator';
import type { Clip } from '@shared/types/project';

const DRAG_THRESHOLD_PX = 5;
const DEFAULT_TRANSITION = { kind: 'fade' as const, durationMs: 400 };

/**
 * Click the body of a segment to select the clip. Drag the body to reorder
 * clips: a vertical line appears at the drop position; releasing splices the
 * clip into that slot.
 *
 * No drag-to-trim — that flow was removed because it was confusing. The
 * "split clip + delete unwanted parts" workflow replaces it.
 */
const IMAGE_TRIM_MIN_MS = 300;

export function ClipSegments({ durationMs }: { durationMs: number }) {
  const clips = useProjectStore((s) => s.project?.clips ?? []);
  const selectedClipId = useSelectionStore((s) => s.selectedClipId);
  const selectClip = useSelectionStore((s) => s.selectClip);
  const selectedTransition = useSelectionStore((s) => s.selectedTransition);
  const update = useProjectStore((s) => s.update);

  // Trim the duration of an IMAGE clip by dragging its left/right edge. (Video
  // clips use split+delete, not edge-trim — see the component note.) One undo
  // step per gesture: replay snapshot → final on release.
  const onEdgeDown = useCallback((e: React.PointerEvent<HTMLDivElement>, clipId: string, edge: 'in' | 'out') => {
    e.preventDefault();
    e.stopPropagation();
    const trackEl = (e.currentTarget as HTMLElement).closest('.timeline__track-area') as HTMLElement | null;
    const tw = trackEl?.clientWidth ?? 1;
    const proj = useProjectStore.getState().project;
    const c = proj?.clips.find((x) => x.id === clipId);
    if (!c) return;
    const origIn = c.inMs;
    const origOut = c.outMs;
    const startX = e.clientX;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);

    const onMove = (ev: PointerEvent): void => {
      const deltaMs = ((ev.clientX - startX) / tw) * durationMs;
      update((d) => {
        const cc = d.clips.find((x) => x.id === clipId);
        if (!cc) return;
        if (edge === 'out') cc.outMs = Math.max(origIn + IMAGE_TRIM_MIN_MS, Math.min(cc.durationMs, origOut + deltaMs));
        else cc.inMs = Math.max(0, Math.min(origOut - IMAGE_TRIM_MIN_MS, origIn + deltaMs));
      }, { record: false });
    };
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const cc = useProjectStore.getState().project?.clips.find((x) => x.id === clipId);
      if (!cc || (cc.inMs === origIn && cc.outMs === origOut)) return;
      const finIn = cc.inMs, finOut = cc.outMs;
      update((d) => { const x = d.clips.find((y) => y.id === clipId); if (x) { x.inMs = origIn; x.outMs = origOut; } }, { record: false });
      update((d) => { const x = d.clips.find((y) => y.id === clipId); if (x) { x.inMs = finIn; x.outMs = finOut; } }, { label: 'Resize image' });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [durationMs, update]);

  const onSegmentPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, clipId: string) => {
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const segmentEl = e.currentTarget as HTMLElement;
    const trackEl = segmentEl.closest('.timeline__track-area') as HTMLElement | null;
    if (!trackEl) return;

    let isDragging = false;
    let targetInsertIndex: number | null = null;

    const placeIndicator = (insertIdx: number, currentClips: Clip[], total: number): void => {
      let accMs = 0;
      for (let i = 0; i < insertIdx && i < currentClips.length; i++) {
        accMs += clipEffectiveDurationMs(currentClips[i]);
      }
      const pct = total > 0 ? (accMs / total) * 100 : 0;
      showDropIndicator(pct);
    };

    const onMove = (ev: PointerEvent): void => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (!isDragging && Math.max(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!isDragging) {
        isDragging = true;
        segmentEl.classList.add('clip-segment--dragging');
      }
      const project = useProjectStore.getState().project;
      if (!project) return;
      const currentClips = project.clips;
      const total = project.timeline.durationMs;
      const rect = trackEl.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const cursorMs = ratio * total;
      // Find the insertion boundary closest to the cursor.
      let bestIdx = 0;
      let bestDist = Math.abs(cursorMs);
      let acc = 0;
      for (let i = 0; i < currentClips.length; i++) {
        acc += clipEffectiveDurationMs(currentClips[i]);
        const dist = Math.abs(cursorMs - acc);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i + 1;
        }
      }
      targetInsertIndex = bestIdx;
      placeIndicator(bestIdx, currentClips, total);
    };

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      segmentEl.classList.remove('clip-segment--dragging');
      hideDropIndicator();
      if (!isDragging || targetInsertIndex === null) return;
      const project = useProjectStore.getState().project;
      if (!project) return;
      const fromIdx = project.clips.findIndex((c) => c.id === clipId);
      if (fromIdx === -1) return;
      // Adjust insertion index: if moving forward, the source slot disappears
      // before we splice in, so the target shifts left by 1.
      let adjustedTo = targetInsertIndex;
      if (adjustedTo > fromIdx) adjustedTo -= 1;
      if (adjustedTo === fromIdx) return; // no change
      useProjectStore.getState().update((d) => {
        const [moved] = d.clips.splice(fromIdx, 1);
        d.clips.splice(adjustedTo, 0, moved);
      }, { label: 'Reorder clip' });
      // Keep the visual playhead at its global position by re-seeking the
      // new clip at that position. Otherwise the active video would still be
      // playing the OLD clip's content even though the timeline shifted.
      const updatedProject = useProjectStore.getState().project;
      if (updatedProject) {
        const globalNow = usePlaybackStore.getState().currentTimeMs;
        const located = locateGlobal(updatedProject, globalNow);
        if (located) {
          const v = getVideoForClip(located.clip.id);
          if (v) {
            setActiveClip(located.clip.id);
            v.currentTime = located.localMs / 1000;
          }
        }
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const onSegmentClick = useCallback((e: React.MouseEvent<HTMLDivElement>, clipId: string) => {
    e.stopPropagation();
    selectClip(clipId);
  }, [selectClip]);

  // Toggle a transition on a clip edge. The little icon near each edge is the
  // affordance — a block would fight the image trim handles.
  //   - no transition  → create (default) + select (panel opens to edit)
  //   - exists, other  → select it (edit)
  //   - exists, selected → remove (toggle off)
  const onTransitionClick = useCallback((e: React.MouseEvent, clipId: string, edge: 'in' | 'out') => {
    e.stopPropagation();
    const proj = useProjectStore.getState().project;
    const clip = proj?.clips.find((c) => c.id === clipId);
    const has = edge === 'in' ? clip?.transitionIn : clip?.transitionOut;
    const sel = useSelectionStore.getState().selectedTransition;
    const isSelected = sel?.clipId === clipId && sel.edge === edge;
    if (has && isSelected) {
      useProjectStore.getState().update((d) => {
        const c = d.clips.find((x) => x.id === clipId);
        if (!c) return;
        if (edge === 'in') delete c.transitionIn; else delete c.transitionOut;
      }, { label: 'Remove transition' });
      useSelectionStore.getState().selectTransition(null);
      return;
    }
    if (!has) {
      useProjectStore.getState().update((d) => {
        const c = d.clips.find((x) => x.id === clipId);
        if (!c) return;
        if (edge === 'in') c.transitionIn = { ...DEFAULT_TRANSITION };
        else c.transitionOut = { ...DEFAULT_TRANSITION };
      }, { label: 'Add transition' });
    }
    useSelectionStore.getState().selectTransition({ clipId, edge });
  }, []);

  if (durationMs <= 0 || clips.length === 0) return null;

  return (
    <div className="clip-segments">
      {clips.map((c: Clip, i: number) => {
        const start = c.timelineStartMs;
        const eff = clipEffectiveDurationMs(c);
        const leftPct = (start / durationMs) * 100;
        const widthPct = (eff / durationMs) * 100;
        const isSelected = selectedClipId === c.id;
        const speed = clipSpeed(c);
        const isImage = c.kind === 'image';
        return (
          <div
            key={c.id}
            className={`clip-segment ${isSelected ? 'clip-segment--selected' : ''} ${isImage ? 'clip-segment--image' : ''}`}
            style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
            onClick={(e) => onSegmentClick(e, c.id)}
            onPointerDown={(e) => onSegmentPointerDown(e, c.id)}
            title={isImage
              ? `Imagen: ${(eff / 1000).toFixed(2)}s — arrastrá los bordes para alargar/acortar, el cuerpo para reordenar`
              : `Clip ${i + 1}: ${(eff / 1000).toFixed(2)}s${speed !== 1 ? ` (${speed}×)` : ''} — drag to reorder`}
          >
            {isImage && (
              <div className="clip-segment-edge clip-segment-edge--in" onPointerDown={(e) => onEdgeDown(e, c.id, 'in')} />
            )}
            <div className="clip-segment__body">
              <span className="clip-segment__label">
                {isImage ? 'Imagen' : `Clip ${i + 1}`}
                {speed !== 1 && <span className="clip-segment__speed">{speed}×</span>}
              </span>
            </div>
            {(['in', 'out'] as const).map((edge) => {
              const t = edge === 'in' ? c.transitionIn : c.transitionOut;
              const sel = selectedTransition?.clipId === c.id && selectedTransition.edge === edge;
              return (
                <button
                  key={edge}
                  className={`clip-transition clip-transition--${edge} ${t ? 'clip-transition--set' : ''} ${sel ? 'clip-transition--selected' : ''}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => onTransitionClick(e, c.id, edge)}
                  title={t ? `Transición ${edge === 'in' ? 'de entrada' : 'de salida'} (${t.kind}, ${(t.durationMs / 1000).toFixed(1)}s) — click para quitar` : `Agregar transición ${edge === 'in' ? 'de entrada' : 'de salida'}`}
                >
                  <Blend size={11} />
                </button>
              );
            })}
            {isImage && (
              <div className="clip-segment-edge clip-segment-edge--out" onPointerDown={(e) => onEdgeDown(e, c.id, 'out')} />
            )}
          </div>
        );
      })}
    </div>
  );
}
