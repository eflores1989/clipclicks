import { Timer as TimerIcon, Trash2, Bold, Italic, Plus, ArrowUp, ArrowDown, MoveHorizontal } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { usePlaybackStore } from '@/stores/playback';
import { timerText } from '@shared/lib/timerValue';
import type { Project, TimerEvent, TimerFormat } from '@shared/types/project';

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Cascadia Code (mono)', value: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { label: 'Consolas (mono)', value: 'Consolas, "Courier New", monospace' },
  { label: 'Sans (Inter)', value: 'Inter, Segoe UI, sans-serif' },
  { label: 'Bahnschrift (technical)', value: 'Bahnschrift, "DIN", sans-serif' },
  { label: 'Impact (display)', value: 'Impact, "Arial Black", sans-serif' },
];

const FORMAT_OPTIONS: { label: string; value: TimerFormat }[] = [
  { label: 'mm:ss (01:23)', value: 'mm:ss' },
  { label: 'mm:ss.cs (01:23.45)', value: 'mm:ss.cs' },
  { label: 'hh:mm:ss (00:01:23)', value: 'hh:mm:ss' },
  { label: 'ss (83)', value: 'ss' },
  { label: 'ss.cs (83.45)', value: 'ss.cs' },
];

/**
 * Properties for the selected timer overlay. Mirrors TextProperties: content is
 * the clock behaviour (direction, format, start value) plus the look, and a
 * speed-keyframe editor that drives acceleration / deceleration. Replaces the
 * right panel while a timer chip (or its canvas box) is selected.
 */
export function TimerProperties() {
  const selectedTimerId = useSelectionStore((s) => s.selectedTimerId);
  const selectTimer = useSelectionStore((s) => s.selectTimer);
  const update = useProjectStore((s) => s.update);
  const t = useProjectStore((s) => s.project?.timeline.timerEvents?.find((x) => x.id === selectedTimerId));
  const timelineDurationMs = useProjectStore((s) => s.project?.timeline.durationMs ?? 0);
  const playhead = usePlaybackStore((s) => s.currentTimeMs);

  if (!t) return null;

  const patch = (fn: (e: TimerEvent) => void, label: string): void => {
    update((d: Project) => {
      const ev = d.timeline.timerEvents?.find((x) => x.id === t.id);
      if (ev) fn(ev);
    }, { label });
  };

  const remove = (): void => {
    update((d: Project) => {
      if (d.timeline.timerEvents) d.timeline.timerEvents = d.timeline.timerEvents.filter((x) => x.id !== t.id);
    }, { label: 'Delete timer' });
    selectTimer(null);
  };

  const spanMs = Math.max(0, t.endMs - t.startMs);

  const addKeyframeAtPlayhead = (): void => {
    const off = Math.max(0, Math.min(spanMs, Math.round(playhead - t.startMs)));
    patch((ev) => {
      const kept = ev.rateKeyframes.filter((k) => Math.abs(k.tMs - off) > 1);
      // Seed the new keyframe's rate with the current constant (last kf) so it
      // doesn't jump — user then tunes it.
      const seedRate = ev.rateKeyframes.length ? ev.rateKeyframes[ev.rateKeyframes.length - 1].rate : 1;
      ev.rateKeyframes = [...kept, { tMs: off, rate: seedRate }].sort((a, b) => a.tMs - b.tMs);
    }, 'Add speed keyframe');
  };

  const setRate = (idx: number, rate: number): void => {
    patch((ev) => { if (ev.rateKeyframes[idx]) ev.rateKeyframes[idx].rate = rate; }, 'Set timer speed');
  };
  const removeKeyframe = (idx: number): void => {
    patch((ev) => { ev.rateKeyframes = ev.rateKeyframes.filter((_, i) => i !== idx); }, 'Remove speed keyframe');
  };

  return (
    <aside className="properties">
      <section className="properties__section">
        <div className="zoom-prop__header">
          <h3 className="panel__title"><TimerIcon size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Timer</h3>
          <button className="icon-btn icon-btn--danger" onClick={remove} title="Delete timer" aria-label="Delete timer">
            <Trash2 size={14} />
          </button>
        </div>

        <div className="panel__field">
          <label className="panel__label">Current value <span className="panel__num">{timerText(t, Math.round(playhead))}</span></label>
        </div>

        <div className="panel__field">
          <label className="panel__label">On screen <span className="panel__num">{((t.endMs - t.startMs) / 1000).toFixed(1)}s</span></label>
          <button
            className="btn btn--small"
            style={{ width: '100%', justifyContent: 'center' }}
            onClick={() => patch((ev) => { ev.endMs = Math.max(ev.startMs + 300, timelineDurationMs); }, 'Extend timer to end')}
            title="Make the timer last until the end of the video"
          >
            <MoveHorizontal size={14} /> Extend to end of video
          </button>
          <p className="panel__hint" style={{ marginTop: 6 }}>
            Or drag the timer chip's right edge on the timeline to set the exact length.
          </p>
        </div>

        <div className="text-prop__btnrow">
          <button className={`text-prop__btn ${t.direction === 'up' ? 'text-prop__btn--on' : ''}`} onClick={() => patch((ev) => { ev.direction = 'up'; }, 'Count up')} title="Count up"><ArrowUp size={14} /> Up</button>
          <button className={`text-prop__btn ${t.direction === 'down' ? 'text-prop__btn--on' : ''}`} onClick={() => patch((ev) => { ev.direction = 'down'; }, 'Count down')} title="Count down"><ArrowDown size={14} /> Down</button>
        </div>

        <div className="panel__field">
          <label className="panel__label">Format</label>
          <select className="panel__select" value={t.format} onChange={(e) => patch((ev) => { ev.format = e.target.value as TimerFormat; }, 'Timer format')}>
            {FORMAT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>

        <div className="panel__field">
          <label className="panel__label">Start value (seconds)</label>
          <input
            type="number" min={0} step={1}
            className="panel__input"
            value={Math.round(t.startValueMs / 1000)}
            onChange={(e) => patch((ev) => { ev.startValueMs = Math.max(0, Number(e.target.value)) * 1000; }, 'Timer start value')}
          />
        </div>

        {t.direction === 'down' && (
          <label className="panel__checkbox">
            <input type="checkbox" checked={t.stopAtZero} onChange={(e) => patch((ev) => { ev.stopAtZero = e.target.checked; }, 'Stop at zero')} />
            Stop at zero (don't go negative)
          </label>
        )}
      </section>

      <section className="properties__section">
        <div className="panel__field">
          <label className="panel__label">Speed keyframes</label>
          <p className="panel__hint" style={{ marginTop: 0 }}>
            No keyframes = real time (×1). Add points along the timer to change its speed; the rate ramps smoothly between them.
          </p>
          <button className="btn btn--small" onClick={addKeyframeAtPlayhead}>
            <Plus size={13} /> Add keyframe at playhead
          </button>
        </div>

        {t.rateKeyframes.length > 0 && (
          <ul className="timer-kf__list">
            {t.rateKeyframes.map((k, idx) => (
              <li key={idx} className="timer-kf__row">
                <span className="timer-kf__time">+{(k.tMs / 1000).toFixed(1)}s</span>
                <input
                  type="number" min={0} step={0.1}
                  className="panel__input timer-kf__rate"
                  value={k.rate}
                  onChange={(e) => setRate(idx, Math.max(0, Number(e.target.value)))}
                  title="Speed multiplier (1 = real time)"
                />
                <span className="timer-kf__x">×</span>
                <button className="icon-btn icon-btn--danger" onClick={() => removeKeyframe(idx)} title="Remove keyframe" aria-label="Remove keyframe">
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="properties__section">
        <div className="panel__field">
          <label className="panel__label">Font</label>
          <select className="panel__select" value={t.fontFamily} onChange={(e) => patch((ev) => { ev.fontFamily = e.target.value; }, 'Font')}>
            {FONT_OPTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>

        <div className="text-prop__btnrow">
          <button className={`text-prop__btn ${t.bold ? 'text-prop__btn--on' : ''}`} onClick={() => patch((ev) => { ev.bold = !ev.bold; }, 'Bold')} title="Bold"><Bold size={14} /></button>
          <button className={`text-prop__btn ${t.italic ? 'text-prop__btn--on' : ''}`} onClick={() => patch((ev) => { ev.italic = !ev.italic; }, 'Italic')} title="Italic"><Italic size={14} /></button>
        </div>

        <div className="panel__field">
          <label className="panel__label">Size <span className="panel__num">{Math.round(t.fontScale * 100)}%</span></label>
          <input
            type="range" min={3} max={30} step={1}
            value={Math.round(t.fontScale * 100)}
            onChange={(e) => patch((ev) => { ev.fontScale = Number(e.target.value) / 100; }, 'Size')}
          />
        </div>

        <div className="panel__field">
          <label className="panel__label">Color</label>
          <input type="color" className="panel__color" value={t.color} onChange={(e) => patch((ev) => { ev.color = e.target.value; }, 'Color')} />
        </div>

        <label className="panel__checkbox">
          <input type="checkbox" checked={t.shadow} onChange={(e) => patch((ev) => { ev.shadow = e.target.checked; }, 'Shadow')} />
          Drop shadow (readability)
        </label>
        <p className="panel__hint">Drag the timer over the video to position it; the corners resize.</p>
      </section>
    </aside>
  );
}
