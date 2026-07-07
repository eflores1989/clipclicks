import { useEffect, useRef } from 'react';
import { Lock, LockOpen, Trash2, Crosshair, MousePointer2, Move, Plus } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { useUiStore } from '@/stores/ui';
import { usePlaybackStore } from '@/stores/playback';
import { locateGlobal } from '@shared/lib/clipTime';
import { focusFromKeyframes } from '@shared/lib/computeZoomState';
import type { Easing, Project, ZoomEvent } from '@shared/types/project';

// Locate a zoom across all clips' zoomEvents. Works on either the live
// project state OR an Immer draft — children remain valid drafts so mutations
// applied to the returned proxy propagate as expected.
function findZoomAcrossClips(p: Project, zoomId: string): ZoomEvent | null {
  for (const c of p.clips) {
    const z = c.zoomEvents.find((zz) => zz.id === zoomId);
    if (z) return z;
  }
  return null;
}

const EASINGS: Easing[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'spring'];
type CursorBehavior = ZoomEvent['cursorBehavior'];
const CURSOR_BEHAVIORS: Array<{ id: CursorBehavior; label: string; hint: string }> = [
  { id: 'static', label: 'Static', hint: 'Focal stays at the click point' },
  { id: 'follow', label: 'Follow', hint: 'Focal tracks the live cursor' },
  { id: 'smoothed', label: 'Smoothed', hint: 'Follows with a gentle lag (recommended)' },
];

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function useZoomSlider(zoomId: string, label: string) {
  const update = useProjectStore.getState().update;
  const snapshotRef = useRef<ZoomEvent | null>(null);

  const onPointerDown = (): void => {
    const project = useProjectStore.getState().project;
    if (!project) return;
    const z = (project.clips.flatMap((cc) => cc.zoomEvents)).find((zz) => zz.id === zoomId);
    if (!z) return;
    snapshotRef.current = { ...z, target: { ...z.target } };
  };
  const onPointerUp = (): void => {
    const snap = snapshotRef.current;
    snapshotRef.current = null;
    const project = useProjectStore.getState().project;
    if (!snap || !project) return;
    const z = (project.clips.flatMap((cc) => cc.zoomEvents)).find((zz) => zz.id === zoomId);
    if (!z) return;
    // Coalesce: revert to snapshot then apply current, all without recording
    // (with one recording at the end).
    const finalScale = z.scale;
    const finalEnter = z.enterDurationMs;
    const finalExit = z.exitDurationMs;
    const finalHold = z.holdDurationMs;
    const finalNx = z.target.nx;
    const finalNy = z.target.ny;
    update((d) => {
      const t = findZoomAcrossClips(d, zoomId);
      if (!t) return;
      t.scale = snap.scale;
      t.enterDurationMs = snap.enterDurationMs;
      t.exitDurationMs = snap.exitDurationMs;
      t.holdDurationMs = snap.holdDurationMs;
      t.target.nx = snap.target.nx;
      t.target.ny = snap.target.ny;
    }, { record: false });
    update((d) => {
      const t = findZoomAcrossClips(d, zoomId);
      if (!t) return;
      t.scale = finalScale;
      t.enterDurationMs = finalEnter;
      t.exitDurationMs = finalExit;
      t.holdDurationMs = finalHold;
      t.target.nx = finalNx;
      t.target.ny = finalNy;
    }, { label });
  };

  return { onPointerDown, onPointerUp };
}

export function ZoomProperties() {
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const selectedZoomId = useSelectionStore((s) => s.selectedZoomId);
  const selectZoom = useSelectionStore((s) => s.selectZoom);
  const trackEditMode = useUiStore((s) => s.trackEditMode);
  const setTrackEditMode = useUiStore((s) => s.setTrackEditMode);
  const playhead = usePlaybackStore((s) => s.currentTimeMs);

  // Leave track-edit mode when this panel goes away (zoom deselected).
  useEffect(() => () => setTrackEditMode(false), [setTrackEditMode]);

  // Search all clips since each owns its own zoomEvents.
  const zoom = project?.clips.flatMap((c) => c.zoomEvents).find((z) => z.id === selectedZoomId);
  const scaleSlider = useZoomSlider(selectedZoomId ?? '', 'Zoom scale');
  const enterSlider = useZoomSlider(selectedZoomId ?? '', 'Zoom enter');
  const exitSlider = useZoomSlider(selectedZoomId ?? '', 'Zoom exit');
  const focalSlider = useZoomSlider(selectedZoomId ?? '', 'Zoom focal');

  if (!zoom || !project) return null;

  const recordedUpdate = (mutator: (z: ZoomEvent) => void, label: string): void => {
    update((d) => {
      const t = findZoomAcrossClips(d, selectedZoomId ?? '');
      if (t) mutator(t);
    }, { label });
  };

  const liveUpdate = (mutator: (z: ZoomEvent) => void): void => {
    update((d) => {
      const t = findZoomAcrossClips(d, selectedZoomId ?? '');
      if (t) mutator(t);
    }, { record: false });
  };

  const deleteZoom = (): void => {
    update((d) => {
      for (const c of d.clips) {
        if (c.zoomEvents.some((z) => z.id === selectedZoomId)) {
          c.zoomEvents = c.zoomEvents.filter((z) => z.id !== selectedZoomId);
          break;
        }
      }
    }, { label: 'Delete zoom' });
    selectZoom(null);
  };

  const focusKfs = zoom.focusKeyframes ?? [];

  // The clip that owns this zoom + its playback speed, for mapping clip-local
  // time (where keyframes live) ↔ the global timeline (where the playhead is).
  const ownerClip = project.clips.find((c) => c.zoomEvents.some((z) => z.id === zoom.id));
  const clipSpeed = ownerClip?.speedSegments[0]?.speed ?? 1;
  const localToGlobal = (localMs: number): number =>
    ownerClip ? ownerClip.timelineStartMs + (localMs - ownerClip.inMs) / (clipSpeed || 1) : 0;

  // Clip-local time of the current playhead for THIS zoom's clip, clamped to the
  // zoom's span — where a tracking point is dropped / the time bar sits.
  const curLocalMs = (() => {
    const loc = locateGlobal(project, playhead);
    const l = loc && ownerClip && loc.clip.id === ownerClip.id ? loc.localMs : zoom.startMs;
    return Math.max(zoom.startMs, Math.min(zoom.endMs, l));
  })();
  const trackTimeAtPlayhead = (): number => curLocalMs;
  const setTrackTime = (localMs: number): void => {
    usePlaybackStore.getState().setCurrentTime(localToGlobal(Math.max(zoom.startMs, Math.min(zoom.endMs, localMs))));
  };

  // Drop / update a point at the CURRENT time (the time bar controls when).
  const addTrackingPoint = (): void => {
    const at = trackTimeAtPlayhead();
    recordedUpdate((z) => {
      if (!z.focusKeyframes) z.focusKeyframes = [];
      const kfs = z.focusKeyframes;
      const pos = kfs.length ? focusFromKeyframes(kfs, at) : { nx: z.target.nx ?? 0.5, ny: z.target.ny ?? 0.5 };
      const idx = kfs.findIndex((k) => Math.abs(k.t - at) <= 120);
      if (idx >= 0) { kfs[idx].nx = pos.nx; kfs[idx].ny = pos.ny; }
      else kfs.push({ t: at, nx: pos.nx, ny: pos.ny });
      kfs.sort((a, b) => a.t - b.t);
    }, 'Add tracking point');
  };

  const deleteTrackingPoint = (idx: number): void => {
    recordedUpdate((z) => { z.focusKeyframes = (z.focusKeyframes ?? []).filter((_, i) => i !== idx); }, 'Delete tracking point');
  };
  const clearTracking = (): void => {
    setTrackEditMode(false);
    recordedUpdate((z) => { z.focusKeyframes = []; }, 'Clear tracking');
  };

  const toggleTrackEdit = (): void => {
    const next = !trackEditMode;
    if (next) {
      // Bring the playhead into the zoom so the frame is visible to author on.
      const ph = usePlaybackStore.getState().currentTimeMs;
      const proj = useProjectStore.getState().project;
      const owner = proj?.clips.find((c) => c.zoomEvents.some((z) => z.id === selectedZoomId));
      if (proj && owner) {
        const loc = locateGlobal(proj, ph);
        const inRange = loc && loc.clip.id === owner.id && loc.localMs >= zoom.startMs && loc.localMs <= zoom.endMs;
        if (!inRange) {
          // Jump to the clip's start-of-zoom on the global timeline.
          usePlaybackStore.getState().setCurrentTime(owner.timelineStartMs + (zoom.startMs - owner.inMs));
        }
      }
    }
    setTrackEditMode(next);
  };

  const totalMs = zoom.endMs - zoom.startMs;
  const maxEnter = Math.max(50, totalMs - zoom.exitDurationMs - 100);
  const maxExit = Math.max(50, totalMs - zoom.enterDurationMs - 100);

  return (
    <aside className="properties">
      <section className="properties__section">
        <div className="zoom-prop__header">
          <h3 className="panel__title">
            Zoom event
            <span className={`zoom-prop__badge ${zoom.source === 'auto' ? 'zoom-prop__badge--auto' : 'zoom-prop__badge--manual'}`}>
              {zoom.source}
            </span>
          </h3>
          <div className="zoom-prop__actions">
            <button
              className="icon-btn"
              onClick={() => recordedUpdate((z) => { z.locked = !z.locked; }, zoom.locked ? 'Unlock zoom' : 'Lock zoom')}
              title={zoom.locked ? 'Unlock' : 'Lock'}
            >
              {zoom.locked ? <Lock size={14} /> : <LockOpen size={14} />}
            </button>
            <button
              className="icon-btn icon-btn--danger"
              onClick={deleteZoom}
              title="Delete (Del)"
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>

        <div className="zoom-prop__times">
          <div>start <strong>{formatMs(zoom.startMs)}</strong></div>
          <div>end <strong>{formatMs(zoom.endMs)}</strong></div>
          <div>dur <strong>{formatMs(totalMs)}</strong></div>
        </div>
      </section>

      <section className="properties__section">
        <h4 className="panel__subtitle">Scale</h4>
        <div className="panel__field">
          <label className="panel__label">Zoom level <span className="panel__num">{zoom.scale.toFixed(2)}×</span></label>
          <input
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={zoom.scale}
            onPointerDown={scaleSlider.onPointerDown}
            onPointerUp={scaleSlider.onPointerUp}
            onChange={(e) => liveUpdate((z) => { z.scale = Number(e.target.value); })}
            disabled={zoom.locked}
          />
        </div>
      </section>

      <section className="properties__section">
        <h4 className="panel__subtitle">Timing</h4>
        <div className="panel__field">
          <label className="panel__label">Enter <span className="panel__num">{formatMs(zoom.enterDurationMs)}</span></label>
          <input
            type="range"
            min={50}
            max={Math.max(50, maxEnter)}
            value={zoom.enterDurationMs}
            onPointerDown={enterSlider.onPointerDown}
            onPointerUp={enterSlider.onPointerUp}
            onChange={(e) => liveUpdate((z) => {
              const v = Number(e.target.value);
              const t = z.endMs - z.startMs;
              z.enterDurationMs = v;
              z.holdDurationMs = Math.max(0, t - v - z.exitDurationMs);
            })}
            disabled={zoom.locked}
          />
        </div>
        <div className="panel__field">
          <label className="panel__label">Enter easing</label>
          <select
            className="panel__select"
            value={zoom.enterEasing}
            onChange={(e) => recordedUpdate((z) => { z.enterEasing = e.target.value as Easing; }, 'Enter easing')}
            disabled={zoom.locked}
          >
            {EASINGS.map((es) => <option key={es} value={es}>{es}</option>)}
          </select>
        </div>
        <div className="panel__field">
          <label className="panel__label">Exit <span className="panel__num">{formatMs(zoom.exitDurationMs)}</span></label>
          <input
            type="range"
            min={50}
            max={Math.max(50, maxExit)}
            value={zoom.exitDurationMs}
            onPointerDown={exitSlider.onPointerDown}
            onPointerUp={exitSlider.onPointerUp}
            onChange={(e) => liveUpdate((z) => {
              const v = Number(e.target.value);
              const t = z.endMs - z.startMs;
              z.exitDurationMs = v;
              z.holdDurationMs = Math.max(0, t - z.enterDurationMs - v);
            })}
            disabled={zoom.locked}
          />
        </div>
        <div className="panel__field">
          <label className="panel__label">Exit easing</label>
          <select
            className="panel__select"
            value={zoom.exitEasing}
            onChange={(e) => recordedUpdate((z) => { z.exitEasing = e.target.value as Easing; }, 'Exit easing')}
            disabled={zoom.locked}
          >
            {EASINGS.map((es) => <option key={es} value={es}>{es}</option>)}
          </select>
        </div>
      </section>

      <section className="properties__section">
        <h4 className="panel__subtitle">
          <MousePointer2 size={12} style={{ verticalAlign: 'middle' }} /> Cursor behavior
        </h4>
        <div className="cursor-mode" role="radiogroup" aria-label="Cursor behavior">
          {CURSOR_BEHAVIORS.map((b) => (
            <button
              key={b.id}
              role="radio"
              aria-checked={zoom.cursorBehavior === b.id}
              className={`cursor-mode__btn ${zoom.cursorBehavior === b.id ? 'cursor-mode__btn--active' : ''}`}
              onClick={() => recordedUpdate((z) => { z.cursorBehavior = b.id; }, `Cursor: ${b.label}`)}
              disabled={zoom.locked}
              title={b.hint}
            >
              {b.label}
            </button>
          ))}
        </div>
        <p className="cursor-mode__hint">
          {CURSOR_BEHAVIORS.find((b) => b.id === zoom.cursorBehavior)?.hint}
        </p>
        {zoom.cursorBehavior === 'smoothed' && (
          <div className="panel__field">
            <label className="panel__label">
              Smoothing
              <span className="panel__num">{Math.round((zoom.smoothing ?? 0.85) * 100)}%</span>
            </label>
            <input
              type="range"
              min={0}
              max={100}
              value={(zoom.smoothing ?? 0.85) * 100}
              onChange={(e) => liveUpdate((z) => { z.smoothing = Number(e.target.value) / 100; })}
              onPointerDown={() => {
                // Snapshot for history coalescing
                const project = useProjectStore.getState().project;
                if (!project) return;
                const z = (project.clips.flatMap((cc) => cc.zoomEvents)).find((zz) => zz.id === selectedZoomId);
                if (z) (window as unknown as { __smoothingSnap: number }).__smoothingSnap = z.smoothing ?? 0.85;
              }}
              onPointerUp={() => {
                const snap = (window as unknown as { __smoothingSnap?: number }).__smoothingSnap;
                if (snap === undefined) return;
                const project = useProjectStore.getState().project;
                if (!project) return;
                const z = (project.clips.flatMap((cc) => cc.zoomEvents)).find((zz) => zz.id === selectedZoomId);
                if (!z) return;
                const final = z.smoothing ?? 0.85;
                if (final === snap) return;
                update((d) => {
                  const t = findZoomAcrossClips(d, selectedZoomId ?? '');
                  if (t) t.smoothing = snap;
                }, { record: false });
                update((d) => {
                  const t = findZoomAcrossClips(d, selectedZoomId ?? '');
                  if (t) t.smoothing = final;
                }, { label: 'Smoothing' });
              }}
              disabled={zoom.locked}
            />
          </div>
        )}
      </section>

      <section className="properties__section">
        <h4 className="panel__subtitle">
          <Move size={12} style={{ verticalAlign: 'middle' }} /> Tracking (pan)
        </h4>
        <p className="panel__hint">
          Make the camera follow a moving subject — the cinematic pan. Works on any clip, including imported videos with no recorded cursor.
        </p>
        <button
          className={`btn btn--small ${trackEditMode ? 'btn--accent' : ''}`}
          style={{ width: '100%', justifyContent: 'center' }}
          onClick={toggleTrackEdit}
          disabled={zoom.locked}
        >
          <Move size={14} /> {trackEditMode ? 'Finish tracking' : 'Track on video…'}
        </button>
        {trackEditMode && (
          <>
            <p className="panel__hint" style={{ marginTop: 8 }}>
              Move the <strong>Time</strong> bar to a moment (the frame follows), then drag the <strong>+</strong> dot onto the subject — it drops a point at that exact time. Repeat for a few moments.
            </p>
            <div className="panel__field">
              <label className="panel__label">
                Time
                <span className="panel__num">+{((curLocalMs - zoom.startMs) / 1000).toFixed(1)}s / {((zoom.endMs - zoom.startMs) / 1000).toFixed(1)}s</span>
              </label>
              <input
                type="range"
                min={zoom.startMs} max={zoom.endMs} step={10}
                value={curLocalMs}
                onChange={(e) => setTrackTime(Number(e.target.value))}
                disabled={zoom.locked}
              />
              <div className="track-scrub__ticks">
                {focusKfs.map((k, i) => (
                  <span
                    key={i}
                    className="track-scrub__tick"
                    style={{ left: `${((k.t - zoom.startMs) / Math.max(1, zoom.endMs - zoom.startMs)) * 100}%` }}
                    title={`Point ${i + 1}`}
                  >{i + 1}</span>
                ))}
              </div>
            </div>
            <button className="btn btn--small" style={{ width: '100%', justifyContent: 'center' }} onClick={addTrackingPoint} disabled={zoom.locked}>
              <Plus size={13} /> Add point at current time
            </button>
          </>
        )}
        {focusKfs.length > 0 && (
          <>
            <div className="panel__field" style={{ marginTop: 8 }}>
              <label className="panel__label">
                Approach (how close it reaches)
                <span className="panel__num">{Math.round((zoom.panTightness ?? 1) * 100)}%</span>
              </label>
              <input
                type="range" min={0} max={100}
                value={(zoom.panTightness ?? 1) * 100}
                onChange={(e) => liveUpdate((z) => { z.panTightness = Number(e.target.value) / 100; })}
                onPointerDown={() => {
                  const z = useProjectStore.getState().project?.clips.flatMap((c) => c.zoomEvents).find((zz) => zz.id === selectedZoomId);
                  (window as unknown as { __trackTightSnap?: number }).__trackTightSnap = z?.panTightness ?? 1;
                }}
                onPointerUp={() => {
                  const snap = (window as unknown as { __trackTightSnap?: number }).__trackTightSnap;
                  if (snap === undefined) return;
                  const z = useProjectStore.getState().project?.clips.flatMap((c) => c.zoomEvents).find((zz) => zz.id === selectedZoomId);
                  const final = z?.panTightness ?? 1;
                  if (final === snap) return;
                  liveUpdate((zz) => { zz.panTightness = snap; });
                  recordedUpdate((zz) => { zz.panTightness = final; }, 'Pan approach');
                }}
                disabled={zoom.locked}
              />
              <p className="panel__hint" style={{ marginTop: 4 }}>
                Higher = the camera centers on each point (reaches it). Lower = keeps it near its frame spot (subtler).
              </p>
            </div>

            <div className="panel__field">
              <label className="panel__label">
                Pan speed
                <span className="panel__num">{(zoom.panSpeed ?? 1).toFixed(2)}×</span>
              </label>
              <input
                type="range" min={0.25} max={3} step={0.05}
                value={zoom.panSpeed ?? 1}
                onChange={(e) => liveUpdate((z) => { z.panSpeed = Number(e.target.value); })}
                onPointerDown={() => {
                  const z = useProjectStore.getState().project?.clips.flatMap((c) => c.zoomEvents).find((zz) => zz.id === selectedZoomId);
                  (window as unknown as { __trackSpeedSnap?: number }).__trackSpeedSnap = z?.panSpeed ?? 1;
                }}
                onPointerUp={() => {
                  const snap = (window as unknown as { __trackSpeedSnap?: number }).__trackSpeedSnap;
                  if (snap === undefined) return;
                  const z = useProjectStore.getState().project?.clips.flatMap((c) => c.zoomEvents).find((zz) => zz.id === selectedZoomId);
                  const final = z?.panSpeed ?? 1;
                  if (final === snap) return;
                  liveUpdate((zz) => { zz.panSpeed = snap; });
                  recordedUpdate((zz) => { zz.panSpeed = final; }, 'Pan speed');
                }}
                disabled={zoom.locked}
              />
              <p className="panel__hint" style={{ marginTop: 4 }}>
                How fast the camera travels between points. The pan starts at point 1's time.
              </p>
            </div>

            <div className="panel__field">
              <label className="panel__label">
                Extra smoothing (optional)
                <span className="panel__num">{Math.round((zoom.smoothing ?? 0) * 100)}%</span>
              </label>
              <input
                type="range" min={0} max={95}
                value={(zoom.smoothing ?? 0) * 100}
                onChange={(e) => liveUpdate((z) => { z.smoothing = Number(e.target.value) / 100; })}
                onPointerDown={() => {
                  const p = useProjectStore.getState().project;
                  const z = p?.clips.flatMap((c) => c.zoomEvents).find((zz) => zz.id === selectedZoomId);
                  (window as unknown as { __trackSmoothSnap?: number }).__trackSmoothSnap = z?.smoothing ?? 0;
                }}
                onPointerUp={() => {
                  const snap = (window as unknown as { __trackSmoothSnap?: number }).__trackSmoothSnap;
                  if (snap === undefined) return;
                  const p = useProjectStore.getState().project;
                  const z = p?.clips.flatMap((c) => c.zoomEvents).find((zz) => zz.id === selectedZoomId);
                  const final = z?.smoothing ?? 0;
                  if (final === snap) return;
                  liveUpdate((zz) => { zz.smoothing = snap; });
                  recordedUpdate((zz) => { zz.smoothing = final; }, 'Tracking smoothness');
                }}
                disabled={zoom.locked}
              />
              <p className="panel__hint" style={{ marginTop: 4 }}>
                0 = the punchy feel with accel/decel and a settle at each point (recommended). Raise it only if you want a floaty, continuous glide.
              </p>
            </div>
            <ul className="timer-kf__list" style={{ marginTop: 8 }}>
              {focusKfs.map((k, idx) => (
                <li key={idx} className="timer-kf__row">
                  <span className="timer-kf__time">#{idx + 1} · +{((k.t - zoom.startMs) / 1000).toFixed(1)}s</span>
                  <span className="timer-kf__time" style={{ flex: 1 }}>{Math.round(k.nx * 100)},{Math.round(k.ny * 100)}%</span>
                  <button className="icon-btn icon-btn--danger" onClick={() => deleteTrackingPoint(idx)} title="Remove point" aria-label="Remove point">
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
            <button className="btn btn--small btn--ghost" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={clearTracking}>
              Clear tracking ({focusKfs.length})
            </button>
          </>
        )}
      </section>

      <section className="properties__section">
        <h4 className="panel__subtitle">
          <Crosshair size={12} style={{ verticalAlign: 'middle' }} /> Focal point
        </h4>
        {focusKfs.length > 0 && (
          <p className="panel__hint panel__hint--muted">
            Tracking is active ({focusKfs.length} point{focusKfs.length > 1 ? 's' : ''}) — it drives the focal. Clear tracking above to use a fixed focal.
          </p>
        )}
        {zoom.cursorBehavior !== 'static' ? (
          <p className="panel__hint panel__hint--muted">
            The focal is driven by the cursor in <strong>{zoom.cursorBehavior}</strong> mode —
            X/Y here would have no visible effect. Switch to <strong>Static</strong> above to set a fixed focal manually.
          </p>
        ) : (
          <>
            <p className="panel__hint">Where the camera centers when zoomed in.</p>
            <div className="panel__field">
              <label className="panel__label">X <span className="panel__num">{((zoom.target.nx ?? 0.5) * 100).toFixed(0)}%</span></label>
              <input
                type="range"
                min={0}
                max={100}
                value={(zoom.target.nx ?? 0.5) * 100}
                onPointerDown={focalSlider.onPointerDown}
                onPointerUp={focalSlider.onPointerUp}
                onChange={(e) => liveUpdate((z) => { z.target.nx = Number(e.target.value) / 100; })}
                disabled={zoom.locked}
              />
            </div>
            <div className="panel__field">
              <label className="panel__label">Y <span className="panel__num">{((zoom.target.ny ?? 0.5) * 100).toFixed(0)}%</span></label>
              <input
                type="range"
                min={0}
                max={100}
                value={(zoom.target.ny ?? 0.5) * 100}
                onPointerDown={focalSlider.onPointerDown}
                onPointerUp={focalSlider.onPointerUp}
                onChange={(e) => liveUpdate((z) => { z.target.ny = Number(e.target.value) / 100; })}
                disabled={zoom.locked}
              />
            </div>
          </>
        )}
      </section>
    </aside>
  );
}
