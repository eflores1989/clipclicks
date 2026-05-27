import { useRef } from 'react';
import { Lock, LockOpen, Trash2, Crosshair, MousePointer2 } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
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
          <Crosshair size={12} style={{ verticalAlign: 'middle' }} /> Focal point
        </h4>
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
