import { useRef, useState, type ReactNode } from 'react';
import { MousePointerClick, Clock, Maximize, Save, Image as ImageIcon, Gauge, Trash2, Film, MousePointer2, Crop, ChevronDown, Music, Upload, Video } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useHistoryStore } from '@/stores/history';
import { useSelectionStore } from '@/stores/selection';
import { useUiStore } from '@/stores/ui';
import { BACKGROUND_PRESETS } from './backgrounds';
import { customPresetId, useCustomBackgrounds } from './useCustomBackgrounds';
import type { Project } from '@shared/types/project';

const SPEED_PRESETS = [0.5, 1, 1.5, 2, 3, 4];

// Remember which accordion sections are open ACROSS remounts (switching the
// Project/Media tabs unmounts this panel). Module-level so it survives within
// a session without a store.
const sectionOpen: Record<string, boolean> = {};

/**
 * Collapsible accordion section for the properties panel. The panel grew long
 * (Clip, Backgrounds, Layout, Shadow, Crop, Cursor, Audio…), so each section
 * collapses to keep the sidebar scannable.
 */
function CollapsibleSection({
  id, title, icon, defaultOpen = false, children,
}: {
  id: string;
  title: string;
  icon: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(sectionOpen[id] ?? defaultOpen);
  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    sectionOpen[id] = next;
  };
  return (
    <section className="properties__section properties__section--collapsible">
      <button className="properties__acc-header" onClick={toggle} aria-expanded={open}>
        <span className="properties__acc-title">{icon}{title}</span>
        <ChevronDown size={15} className={`properties__acc-chevron ${open ? 'is-open' : ''}`} />
      </button>
      {open && <div className="properties__acc-body">{children}</div>}
    </section>
  );
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Hook that lets a slider commit ONE history entry per drag instead of one
 * per pixel. We capture the value at pointerDown, write live updates without
 * recording, then on pointerUp we replay (snapshot → final) so the diff lands
 * in history as a single entry.
 */
function useCoalescedSlider<K extends keyof Project['background']>(
  field: K,
  label: string,
) {
  const snapshotRef = useRef<Project['background'][K] | null>(null);
  const update = useProjectStore.getState().update;

  const onPointerDown = (): void => {
    const project = useProjectStore.getState().project;
    if (!project) return;
    snapshotRef.current = project.background[field];
  };

  const onChange = (value: Project['background'][K]): void => {
    update((d) => {
      d.background[field] = value;
    }, { record: false });
  };

  const onPointerUp = (): void => {
    const snap = snapshotRef.current;
    snapshotRef.current = null;
    const project = useProjectStore.getState().project;
    if (snap === null || !project) return;
    const final = project.background[field];
    if (snap === final) return;
    // Replay the transition so it lands as one entry in history.
    update((d) => {
      d.background[field] = snap;
    }, { record: false });
    update((d) => {
      d.background[field] = final;
    }, { label });
  };

  return { onPointerDown, onChange, onPointerUp };
}

export function PropertiesPanel() {
  const project = useProjectStore((s) => s.project);
  const update = useProjectStore((s) => s.update);
  const dirty = useProjectStore((s) => s.dirty);
  const _undoCount = useHistoryStore((s) => s.past.length); // re-render on history change
  void _undoCount;

  const padding = useCoalescedSlider('paddingPct', 'Padding');
  const radius = useCoalescedSlider('cornerRadiusPx', 'Corner radius');

  if (!project) return null;
  const bg = project.background;
  // The Clip section operates on the SELECTED clip; if none is selected, it
  // falls back to the first clip (the project always has at least one).
  const clickCount = project.clips.reduce((sum, c) => sum + c.mouseEvents.filter((e) => e.type === 'down').length, 0);
  const firstClip = project.clips[0];

  return (
    <aside className="properties">
      <section className="properties__section">
        <h3 className="panel__title">Project</h3>
        <div className="panel__stats">
          <Stat icon={<Clock size={14} />} label="Duration" value={formatDuration(project.timeline.durationMs)} />
          <Stat icon={<Film size={14} />} label="Clips" value={String(project.clips.length)} />
          <Stat icon={<Maximize size={14} />} label="Resolution" value={firstClip ? `${firstClip.sourceWidth}×${firstClip.sourceHeight}` : '—'} />
          <Stat icon={<MousePointerClick size={14} />} label="Clicks captured" value={String(clickCount)} />
        </div>
      </section>

      <ClipSection />

      <CollapsibleSection id="bg" title="Backgrounds" icon={<ImageIcon size={14} />} defaultOpen>
        <BackgroundLibrary activeId={bg.presetId} onPick={(id, label) => update((d) => { d.background.presetId = id; }, { label: `Background: ${label}` })} />
      </CollapsibleSection>

      <CollapsibleSection id="layout" title="Layout" icon={<Maximize size={14} />}>
        <div className="panel__field">
          <label className="panel__label">Padding <span className="panel__num">{bg.paddingPct}%</span></label>
          <input
            type="range"
            min={0}
            max={30}
            value={bg.paddingPct}
            onPointerDown={padding.onPointerDown}
            onPointerUp={padding.onPointerUp}
            onChange={(e) => padding.onChange(Number(e.target.value))}
          />
        </div>

        <div className="panel__field">
          <label className="panel__label">Corner radius <span className="panel__num">{bg.cornerRadiusPx}px</span></label>
          <input
            type="range"
            min={0}
            max={48}
            value={bg.cornerRadiusPx}
            onPointerDown={radius.onPointerDown}
            onPointerUp={radius.onPointerUp}
            onChange={(e) => radius.onChange(Number(e.target.value))}
          />
        </div>
      </CollapsibleSection>

      <CollapsibleSection id="shadow" title="Shadow" icon={<Maximize size={14} />}>
        <label className="panel__checkbox">
          <input
            type="checkbox"
            checked={bg.shadow.enabled}
            onChange={(e) => update((d) => { d.background.shadow.enabled = e.target.checked; }, { label: 'Shadow toggle' })}
          />
          Enabled
        </label>

        {bg.shadow.enabled && (
          <>
            <ShadowSlider field="blur" label="Blur" displayLabel="Blur" value={bg.shadow.blur} min={0} max={120} />
            <ShadowSlider field="y" label="Y offset" displayLabel="Y offset" value={bg.shadow.y} min={0} max={80} />
            <ShadowSlider field="opacity" label="Opacity" displayLabel="Opacity" value={bg.shadow.opacity} min={0} max={1} step={0.01} percent />
          </>
        )}
      </CollapsibleSection>

      <CropSection />

      <CursorSection />

      <div className="panel__phase">
        <Save size={14} />
        <span>{dirty ? 'Saving…' : 'All changes saved'}</span>
      </div>
    </aside>
  );
}

interface ShadowSliderProps {
  field: 'blur' | 'y' | 'opacity';
  label: string;
  displayLabel: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  percent?: boolean;
}

function ShadowSlider({ field, label, displayLabel, value, min, max, step, percent }: ShadowSliderProps) {
  const update = useProjectStore.getState().update;
  const snapshotRef = useRef<number | null>(null);

  const onPointerDown = (): void => {
    const project = useProjectStore.getState().project;
    if (!project) return;
    snapshotRef.current = project.background.shadow[field];
  };
  const onPointerUp = (): void => {
    const snap = snapshotRef.current;
    snapshotRef.current = null;
    const project = useProjectStore.getState().project;
    if (snap === null || !project) return;
    const final = project.background.shadow[field];
    if (snap === final) return;
    update((d) => { d.background.shadow[field] = snap; }, { record: false });
    update((d) => { d.background.shadow[field] = final; }, { label: `Shadow ${label}` });
  };
  const onChange = (n: number): void => {
    update((d) => { d.background.shadow[field] = n; }, { record: false });
  };

  const display = percent ? `${Math.round(value * 100)}%` : `${value}${field === 'y' ? 'px' : ''}`;
  const inputValue = percent ? Math.round(value * 100) : value;
  const inputMin = percent ? min * 100 : min;
  const inputMax = percent ? max * 100 : max;

  return (
    <div className="panel__field">
      <label className="panel__label">{displayLabel} <span className="panel__num">{display}</span></label>
      <input
        type="range"
        min={inputMin}
        max={inputMax}
        step={step ?? 1}
        value={inputValue}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onChange={(e) => onChange(percent ? Number(e.target.value) / 100 : Number(e.target.value))}
      />
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="panel-stat">
      <span className="panel-stat__icon">{icon}</span>
      <span className="panel-stat__label">{label}</span>
      <span className="panel-stat__value">{value}</span>
    </div>
  );
}

/**
 * Crop & aspect section (Phase 5G). Toggles the full-screen crop editor over
 * the preview (the actual dragging lives in CropOverlay). Operates on the clip
 * currently shown in the preview.
 */
function CropSection() {
  const cropEditMode = useUiStore((s) => s.cropEditMode);
  const setCropEditMode = useUiStore((s) => s.setCropEditMode);
  const clipsCount = useProjectStore((s) => s.project?.clips.length ?? 0);
  if (clipsCount === 0) return null;
  return (
    <CollapsibleSection id="crop" title="Crop & aspect" icon={<Crop size={14} />}>
      <p className="panel__hint">
        Crop the frame to hide anything you don't want on screen (taskbar, browser chrome, etc). Drag the handles on the preview — free-form or with a locked aspect ratio.
      </p>
      <button
        className={`btn btn--small ${cropEditMode ? 'btn--accent' : ''}`}
        style={{ width: '100%', justifyContent: 'center' }}
        onClick={() => setCropEditMode(!cropEditMode)}
      >
        <Crop size={14} /> {cropEditMode ? 'Finish crop' : 'Edit crop / aspect ratio'}
      </button>
    </CollapsibleSection>
  );
}

/**
 * Cursor enhancement section (Phase 5F): a halo follows the captured cursor
 * trajectory, and an optional click pulse animates over each `down` event.
 * All controls operate on `project.cursor`; the renderer reads them every
 * frame from `PixiScene.updateCursor`.
 */
function CursorSection() {
  const cursor = useProjectStore((s) => s.project?.cursor);
  const update = useProjectStore((s) => s.update);
  if (!cursor) return null;
  const style = cursor.style;
  const isFollower = style === 'dot' || style === 'arrow';
  return (
    <CollapsibleSection id="cursor" title="Cursor" icon={<MousePointer2 size={14} />}>
      <div className="panel__field">
        <label className="panel__label">Estilo</label>
        <div className="cursor-style-grid">
          <CursorStyleBtn current={style} value="hidden" label="Hidden"
            onPick={(v) => update((d) => { d.cursor.style = v; }, { label: 'Cursor style' })} />
          <CursorStyleBtn current={style} value="pulse" label="Pulse"
            onPick={(v) => update((d) => { d.cursor.style = v; }, { label: 'Cursor style' })} />
          <CursorStyleBtn current={style} value="dot" label="Dot"
            onPick={(v) => update((d) => { d.cursor.style = v; }, { label: 'Cursor style' })} />
          <CursorStyleBtn current={style} value="arrow" label="Arrow"
            onPick={(v) => update((d) => { d.cursor.style = v; }, { label: 'Cursor style' })} />
        </div>
      </div>

      {(isFollower || style === 'pulse') && (
        <p className="panel__hint">
          {style === 'pulse' && 'Animated ring on each click. No follower — best when the recording already shows the system cursor.'}
          {style === 'dot' && 'A dot follows the mouse and scales up on click.'}
          {style === 'arrow' && 'A pointer arrow follows the mouse and scales up on click. Pair with recordings made WITHOUT the system cursor.'}
        </p>
      )}

      {isFollower && (
        <>
          <ColorField
            label={style === 'arrow' ? 'Fill color' : 'Color'}
            value={cursor.color}
            onCommit={(v) => update((d) => { d.cursor.color = v; }, { label: 'Cursor color' })}
          />
          {style === 'arrow' && (
            <ColorField
              label="Outline color"
              value={cursor.outlineColor}
              onCommit={(v) => update((d) => { d.cursor.outlineColor = v; }, { label: 'Cursor outline color' })}
            />
          )}
          <CursorSlider
            label="Opacity"
            value={cursor.opacity}
            min={0} max={1} step={0.01} percent
            read={(c) => c.opacity}
            write={(d, n) => { d.cursor.opacity = n; }}
          />
          <CursorSlider
            label="Size"
            value={cursor.size}
            min={0.5} max={3} step={0.05} suffix="×"
            read={(c) => c.size}
            write={(d, n) => { d.cursor.size = n; }}
          />
          <CursorSlider
            label="Smoothing"
            value={cursor.smoothing}
            min={0} max={0.9} step={0.05} percent
            read={(c) => c.smoothing}
            write={(d, n) => { d.cursor.smoothing = n; }}
          />
        </>
      )}

      {style !== 'hidden' && (
        <>
          <label className="panel__checkbox" style={{ marginTop: 14 }}>
            <input
              type="checkbox"
              checked={cursor.click.enabled}
              onChange={(e) => update((d) => { d.cursor.click.enabled = e.target.checked; }, { label: 'Click animation toggle' })}
            />
            Click animation
          </label>

          {cursor.click.enabled && (
            <>
              <CursorSlider
                label="Duration"
                value={cursor.click.durationMs}
                min={150} max={800} step={10} suffix="ms"
                read={(c) => c.click.durationMs}
                write={(d, n) => { d.cursor.click.durationMs = n; }}
              />
              {style === 'pulse' && (
                <>
                  <ColorField
                    label="Ring color"
                    value={cursor.click.pulseColor}
                    onCommit={(v) => update((d) => { d.cursor.click.pulseColor = v; }, { label: 'Pulse color' })}
                  />
                  <CursorSlider
                    label="Max radius"
                    value={cursor.click.pulseMaxSizePx}
                    min={10} max={120} step={1} suffix="px"
                    read={(c) => c.click.pulseMaxSizePx}
                    write={(d, n) => { d.cursor.click.pulseMaxSizePx = n; }}
                  />
                </>
              )}
              {isFollower && (
                <CursorSlider
                  label="Peak scale"
                  value={cursor.click.peakScale}
                  min={1} max={2.5} step={0.05} suffix="×"
                  read={(c) => c.click.peakScale}
                  write={(d, n) => { d.cursor.click.peakScale = n; }}
                />
              )}
            </>
          )}
        </>
      )}
    </CollapsibleSection>
  );
}

function CursorStyleBtn({
  current, value, label, onPick,
}: {
  current: Project['cursor']['style'];
  value: Project['cursor']['style'];
  label: string;
  onPick: (v: Project['cursor']['style']) => void;
}) {
  return (
    <button
      type="button"
      className={`cursor-style-btn ${current === value ? 'cursor-style-btn--active' : ''}`}
      onClick={() => onPick(value)}
    >
      {label}
    </button>
  );
}

interface CursorSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  percent?: boolean;
  suffix?: string;
  read: (c: Project['cursor']) => number;
  write: (d: Project, n: number) => void;
}

/**
 * Slider that coalesces a drag into ONE history entry: snapshots at
 * pointerDown, writes live without recording, then on pointerUp replays
 * (snapshot → final) so undo collapses the whole drag.
 */
function CursorSlider({ label, value, min, max, step, percent, suffix, read, write }: CursorSliderProps) {
  const update = useProjectStore.getState().update;
  const snapshotRef = useRef<number | null>(null);

  const onPointerDown = (): void => {
    const project = useProjectStore.getState().project;
    if (!project) return;
    snapshotRef.current = read(project.cursor);
  };
  const onPointerUp = (): void => {
    const snap = snapshotRef.current;
    snapshotRef.current = null;
    const project = useProjectStore.getState().project;
    if (snap === null || !project) return;
    const final = read(project.cursor);
    if (snap === final) return;
    update((d) => { write(d, snap); }, { record: false });
    update((d) => { write(d, final); }, { label: `Cursor ${label.toLowerCase()}` });
  };
  const onChange = (n: number): void => {
    update((d) => { write(d, n); }, { record: false });
  };

  const display = percent
    ? `${Math.round(value * 100)}%`
    : `${suffix === '×' ? value.toFixed(2) : value}${suffix ?? ''}`;
  const inputValue = percent ? Math.round(value * 100) : value;
  const inputMin = percent ? min * 100 : min;
  const inputMax = percent ? max * 100 : max;

  return (
    <div className="panel__field">
      <label className="panel__label">{label} <span className="panel__num">{display}</span></label>
      <input
        type="range"
        min={inputMin}
        max={inputMax}
        step={step ?? 1}
        value={inputValue}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onChange={(e) => onChange(percent ? Number(e.target.value) / 100 : Number(e.target.value))}
      />
    </div>
  );
}

/**
 * Color picker. Chromium's native `<input type="color">` fires `change` once
 * on dialog close with the final value, so a single onChange is enough — no
 * coalescing needed.
 */
function ColorField({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  return (
    <div className="panel__field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <span className="panel__label" style={{ flex: 1 }}>{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => { if (e.target.value !== value) onCommit(e.target.value); }}
        style={{
          width: 32,
          height: 26,
          border: '1px solid var(--border)',
          borderRadius: 4,
          background: 'transparent',
          cursor: 'pointer',
          padding: 0,
        }}
      />
    </div>
  );
}

function ClipSection() {
  const selectedClipId = useSelectionStore((s) => s.selectedClipId);
  const selectClip = useSelectionStore((s) => s.selectClip);
  const clips = useProjectStore((s) => s.project?.clips ?? []);
  const update = useProjectStore((s) => s.update);
  const speedSnapRef = useRef<number | null>(null);

  // When there's only one clip, operate on it automatically. Otherwise we
  // REQUIRE an explicit selection so the user can't accidentally apply speed
  // to "Clip 1" thinking it's "Clip 2" (a real bug we hit during 5C testing).
  if (clips.length === 0) return null;
  if (clips.length > 1 && !selectedClipId) {
    return (
      <CollapsibleSection id="clip" title="Clip" icon={<Film size={14} />} defaultOpen>
        <div className="panel__placeholder">
          <p className="panel__hint">
            Click on a clip segment in the timeline to edit its speed.
          </p>
        </div>
      </CollapsibleSection>
    );
  }
  const clip = selectedClipId ? clips.find((c) => c.id === selectedClipId) ?? clips[0] : clips[0];
  const clipIndex = clips.findIndex((c) => c.id === clip.id);

  const handleDelete = (): void => {
    if (clips.length <= 1) {
      window.alert('Cannot delete the last clip — the project needs at least one clip.');
      return;
    }
    // Move to mediaPool — see Editor.deleteSelectedClip for the rationale.
    update((d) => {
      const idx = d.clips.findIndex((c) => c.id === clip.id);
      if (idx === -1) return;
      const [removed] = d.clips.splice(idx, 1);
      d.mediaPool.push(removed);
    }, { label: 'Delete clip (moved to Media pool)' });
    selectClip(null);
  };

  const currentSpeed = clip.speedSegments[0]?.speed ?? 1;

  const projectPath = useProjectStore.getState().projectPath;
  const extractAudio = async (): Promise<void> => {
    if (!projectPath || !clip.hasAudio) return;
    try {
      const media = await window.videoZoom.project.extractClipAudio(projectPath, clip.filePath);
      if (!media) { window.alert('This clip has no audio to extract.'); return; }
      update((d) => {
        d.audioPool.push(media);
        // Place the extracted audio at the clip's timeline position, matching
        // its trim window, and mute the clip's embedded audio.
        const c = d.clips.find((cc) => cc.id === clip.id);
        if (c) {
          d.audioTracks.push({
            id: crypto.randomUUID(),
            mediaId: media.id,
            offsetMs: Math.max(0, Math.round(c.timelineStartMs)),
            inMs: 0,
            outMs: media.durationMs,
            volume: 1,
            muted: false,
            fadeInMs: 0,
            fadeOutMs: 0,
          });
          c.audioMuted = true;
        }
      }, { label: 'Extract clip audio' });
    } catch (err) {
      window.alert(`Could not extract audio: ${(err as Error).message}`);
    }
  };

  const setSpeed = (newSpeed: number, recordLabel?: string): void => {
    update((d) => {
      const c = d.clips.find((cc) => cc.id === clip.id);
      if (!c) return;
      if (newSpeed === 1) {
        c.speedSegments = [];
      } else if (c.speedSegments.length > 0) {
        c.speedSegments[0].speed = newSpeed;
        c.speedSegments[0].startMs = c.inMs;
        c.speedSegments[0].endMs = c.outMs;
      } else {
        c.speedSegments = [{
          id: crypto.randomUUID(),
          startMs: c.inMs,
          endMs: c.outMs,
          speed: newSpeed,
        }];
      }
    }, recordLabel ? { label: recordLabel } : { record: false });
  };

  return (
    <CollapsibleSection
      id="clip"
      title={`Clip ${clipIndex + 1}`}
      icon={<Film size={14} />}
      defaultOpen
    >
      <div className="clip-section__header">
        <span className="panel__subtitle" style={{ margin: 0 }}>
          {selectedClipId === clip.id && <span className="clip-section__badge">selected</span>}
        </span>
        <button
          className="icon-btn icon-btn--danger"
          onClick={handleDelete}
          disabled={clips.length <= 1}
          title={clips.length <= 1 ? 'A project needs at least one clip' : 'Delete this clip (Del)'}
          aria-label="Delete clip"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <h4 className="panel__subtitle"><Gauge size={12} style={{ verticalAlign: 'middle' }} /> Speed</h4>
      <div className="speed-presets">
        {SPEED_PRESETS.map((s) => (
          <button
            key={s}
            className={`speed-preset ${currentSpeed === s ? 'speed-preset--active' : ''}`}
            onClick={() => setSpeed(s, `Speed ${s}×`)}
          >
            {s}×
          </button>
        ))}
      </div>
      <div className="panel__field">
        <label className="panel__label">
          Custom <span className="panel__num">{currentSpeed.toFixed(2)}×</span>
        </label>
        <input
          type="range"
          min={0.25}
          max={4}
          step={0.05}
          value={currentSpeed}
          onPointerDown={() => { speedSnapRef.current = currentSpeed; }}
          onChange={(e) => setSpeed(Number(e.target.value))}
          onPointerUp={() => {
            const snap = speedSnapRef.current;
            speedSnapRef.current = null;
            if (snap === null) return;
            const final = useProjectStore.getState().project?.clips[0]?.speedSegments[0]?.speed ?? 1;
            if (final === snap) return;
            setSpeed(snap);
            setSpeed(final, 'Speed');
          }}
        />
      </div>
      <p className="panel__hint">
        The final exported video will play at this speed. Use the Transport rate buttons for preview-only slow/fast motion.
      </p>

      {clip.hasAudio && (
        <>
          <h4 className="panel__subtitle" style={{ marginTop: 14 }}>Clip audio</h4>
          <label className="panel__checkbox">
            <input
              type="checkbox"
              checked={!!clip.audioMuted}
              onChange={(e) => update((d) => {
                const c = d.clips.find((cc) => cc.id === clip.id);
                if (c) c.audioMuted = e.target.checked;
              }, { label: 'Mute clip audio' })}
            />
            Mute the clip's audio
          </label>
          <button
            className="btn btn--small"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={extractAudio}
            title="Extract this clip's audio to its own track to edit it separately"
          >
            <Music size={14} /> Extract audio to track
          </button>
        </>
      )}
    </CollapsibleSection>
  );
}

/**
 * Background library: built-in presets + user-imported images / videos.
 * Imported assets are persisted app-wide (not per project) so the user keeps
 * their library across recordings.
 */
function BackgroundLibrary({ activeId, onPick }: { activeId: string; onPick: (presetId: string, displayName: string) => void }) {
  const { entries, importBackground, deleteBackground } = useCustomBackgrounds();
  const [busy, setBusy] = useState(false);

  const onImport = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await importBackground();
      if (created) onPick(customPresetId(created.id), created.name);
    } catch (err) {
      window.alert(`Could not import background: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async (id: string, name: string): Promise<void> => {
    if (!window.confirm(`Delete custom background "${name}"? This cannot be undone.`)) return;
    try {
      await deleteBackground(id);
    } catch (err) {
      window.alert(`Could not delete background: ${(err as Error).message}`);
    }
  };

  return (
    <>
      <div className="bg-grid">
        {BACKGROUND_PRESETS.map((p) => (
          <button
            key={p.id}
            className={`bg-tile ${activeId === p.id ? 'bg-tile--active' : ''}`}
            style={{ background: p.css }}
            onClick={() => onPick(p.id, p.name)}
            title={p.name}
            aria-label={p.name}
          />
        ))}
      </div>

      {entries.length > 0 && (
        <>
          <div className="bg-library__sep">My library</div>
          <div className="bg-grid">
            {entries.map((e) => {
              const id = customPresetId(e.id);
              const isActive = activeId === id;
              return (
                <div key={e.id} className={`bg-tile-wrap ${isActive ? 'bg-tile-wrap--active' : ''}`}>
                  <button
                    className={`bg-tile bg-tile--custom ${isActive ? 'bg-tile--active' : ''}`}
                    onClick={() => onPick(id, e.name)}
                    title={e.name}
                    aria-label={e.name}
                  >
                    {e.kind === 'video' ? (
                      <video src={e.assetUrl} muted loop autoPlay playsInline className="bg-tile__media" />
                    ) : (
                      <img src={e.assetUrl} alt={e.name} className="bg-tile__media" />
                    )}
                    <span className="bg-tile__kind">{e.kind === 'video' ? <Video size={11} /> : <ImageIcon size={11} />}</span>
                  </button>
                  <button
                    className="bg-tile__delete"
                    onClick={(ev) => { ev.stopPropagation(); onDelete(e.id, e.name); }}
                    title="Remove from library"
                    aria-label="Delete custom background"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      <button
        className="btn btn--small bg-library__import"
        onClick={onImport}
        disabled={busy}
        title="Import an image or video to use as a background. Saved app-wide."
      >
        <Upload size={13} /> {busy ? 'Importing…' : 'Import image or video'}
      </button>
    </>
  );
}
