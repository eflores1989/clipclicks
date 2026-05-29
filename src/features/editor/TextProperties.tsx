import { useRef } from 'react';
import { Type, Trash2, Bold, Italic, AlignLeft, AlignCenter, AlignRight } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import type { Project, TextEvent } from '@shared/types/project';

const FONT_OPTIONS: { label: string; value: string }[] = [
  { label: 'Sans (Inter)', value: 'Inter, Segoe UI, sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Serif (Georgia)', value: 'Georgia, serif' },
  // Técnicas / cyberpunk (vienen con Windows 11, renderizan sin bundlear).
  { label: 'Consolas (mono)', value: 'Consolas, "Courier New", monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", "Cascadia Mono", Consolas, monospace' },
  { label: 'Bahnschrift (technical)', value: 'Bahnschrift, "DIN", sans-serif' },
  { label: 'Impact (display)', value: 'Impact, "Arial Black", sans-serif' },
];

/**
 * Properties for the selected text overlay: content, font, weight/italic, size,
 * color, alignment and the enter/exit animation. Replaces the right panel while
 * a text chip (or the canvas text box) is selected.
 */
export function TextProperties() {
  const selectedTextId = useSelectionStore((s) => s.selectedTextId);
  const selectText = useSelectionStore((s) => s.selectText);
  const update = useProjectStore((s) => s.update);
  const t = useProjectStore((s) => s.project?.timeline.textEvents.find((x) => x.id === selectedTextId));
  const contentSnap = useRef<string | null>(null);
  const sizeSnap = useRef<number | null>(null);

  if (!t) return null;

  const patch = (fn: (e: TextEvent) => void, label: string, record = true): void => {
    update((d: Project) => {
      const ev = d.timeline.textEvents.find((x) => x.id === t.id);
      if (ev) fn(ev);
    }, record ? { label } : { record: false });
  };

  const remove = (): void => {
    update((d: Project) => { d.timeline.textEvents = d.timeline.textEvents.filter((x) => x.id !== t.id); }, { label: 'Delete text' });
    selectText(null);
  };

  return (
    <aside className="properties">
      <section className="properties__section">
        <div className="zoom-prop__header">
          <h3 className="panel__title"><Type size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Text</h3>
          <button className="icon-btn icon-btn--danger" onClick={remove} title="Delete text" aria-label="Delete text">
            <Trash2 size={14} />
          </button>
        </div>

        <div className="panel__field">
          <label className="panel__label">Content</label>
          <textarea
            className="text-prop__textarea"
            value={t.text}
            rows={3}
            spellCheck={false}
            onFocus={() => { contentSnap.current = t.text; }}
            onChange={(e) => patch((ev) => { ev.text = e.target.value; }, 'Edit text', false)}
            onBlur={() => {
              const snap = contentSnap.current; contentSnap.current = null;
              const cur = useProjectStore.getState().project?.timeline.textEvents.find((x) => x.id === t.id)?.text ?? '';
              if (snap === null || snap === cur) return;
              patch((ev) => { ev.text = snap; }, '', false);
              patch((ev) => { ev.text = cur; }, 'Edit text');
            }}
          />
        </div>
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
          <span className="text-prop__divider" />
          <button className={`text-prop__btn ${t.align === 'left' ? 'text-prop__btn--on' : ''}`} onClick={() => patch((ev) => { ev.align = 'left'; }, 'Align')} title="Left"><AlignLeft size={14} /></button>
          <button className={`text-prop__btn ${t.align === 'center' ? 'text-prop__btn--on' : ''}`} onClick={() => patch((ev) => { ev.align = 'center'; }, 'Align')} title="Center"><AlignCenter size={14} /></button>
          <button className={`text-prop__btn ${t.align === 'right' ? 'text-prop__btn--on' : ''}`} onClick={() => patch((ev) => { ev.align = 'right'; }, 'Align')} title="Right"><AlignRight size={14} /></button>
        </div>

        <div className="panel__field">
          <label className="panel__label">Size <span className="panel__num">{Math.round(t.fontScale * 100)}%</span></label>
          <input
            type="range" min={2} max={25} step={1}
            value={Math.round(t.fontScale * 100)}
            onPointerDown={() => { sizeSnap.current = t.fontScale; }}
            onChange={(e) => patch((ev) => { ev.fontScale = Number(e.target.value) / 100; }, 'Size', false)}
            onPointerUp={() => {
              const s = sizeSnap.current; sizeSnap.current = null;
              const cur = useProjectStore.getState().project?.timeline.textEvents.find((x) => x.id === t.id)?.fontScale ?? t.fontScale;
              if (s === null || s === cur) return;
              patch((ev) => { ev.fontScale = s; }, '', false);
              patch((ev) => { ev.fontScale = cur; }, 'Size');
            }}
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
      </section>

      <section className="properties__section">
        <div className="panel__field">
          <label className="panel__label">Entrance</label>
          <select className="panel__select" value={t.enterAnim} onChange={(e) => patch((ev) => { ev.enterAnim = e.target.value as TextEvent['enterAnim']; }, 'Enter anim')}>
            <option value="none">No animation</option>
            <option value="fade">Fade in</option>
            <option value="type">Typewriter</option>
          </select>
        </div>
        <div className="panel__field">
          <label className="panel__label">Exit</label>
          <select className="panel__select" value={t.exitAnim} onChange={(e) => patch((ev) => { ev.exitAnim = e.target.value as TextEvent['exitAnim']; }, 'Exit anim')}>
            <option value="none">No animation</option>
            <option value="fade">Fade out</option>
          </select>
        </div>
        <p className="panel__hint">Drag the text over the video to position it; the corners resize.</p>
      </section>
    </aside>
  );
}
