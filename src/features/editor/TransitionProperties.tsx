import { useRef } from 'react';
import { Blend, Trash2 } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import { clipEffectiveDurationMs } from '@shared/lib/clipTime';
import type { Project, Transition, TransitionKind } from '@shared/types/project';

const KIND_OPTIONS: { value: TransitionKind; label: string }[] = [
  { value: 'fade', label: 'Fade (desvanecer)' },
  { value: 'darken', label: 'Oscurecer (a negro)' },
  { value: 'flash', label: 'Flash (a blanco)' },
  { value: 'pixelate', label: 'Pixelado' },
];

/**
 * Properties for the selected clip-edge transition: type + duration + remove.
 * Shown while a transition icon (on a clip edge) is selected.
 */
export function TransitionProperties() {
  const sel = useSelectionStore((s) => s.selectedTransition);
  const selectTransition = useSelectionStore((s) => s.selectTransition);
  const update = useProjectStore((s) => s.update);
  const clip = useProjectStore((s) => s.project?.clips.find((c) => c.id === sel?.clipId));
  const durSnap = useRef<number | null>(null);

  if (!sel || !clip) return null;
  const t: Transition | undefined = sel.edge === 'in' ? clip.transitionIn : clip.transitionOut;
  if (!t) return null;

  const effMs = clipEffectiveDurationMs(clip);
  const maxMs = Math.max(200, Math.min(2000, Math.round(effMs * 0.9)));

  const patch = (fn: (tr: Transition) => void, label: string, record = true): void => {
    update((d: Project) => {
      const c = d.clips.find((x) => x.id === sel.clipId);
      if (!c) return;
      const tr = sel.edge === 'in' ? c.transitionIn : c.transitionOut;
      if (tr) fn(tr);
    }, record ? { label } : { record: false });
  };

  const remove = (): void => {
    update((d: Project) => {
      const c = d.clips.find((x) => x.id === sel.clipId);
      if (!c) return;
      if (sel.edge === 'in') delete c.transitionIn; else delete c.transitionOut;
    }, { label: 'Remove transition' });
    selectTransition(null);
  };

  return (
    <aside className="properties">
      <section className="properties__section">
        <div className="zoom-prop__header">
          <h3 className="panel__title">
            <Blend size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Transición {sel.edge === 'in' ? '(entrada)' : '(salida)'}
          </h3>
          <button className="icon-btn icon-btn--danger" onClick={remove} title="Quitar transición" aria-label="Remove transition">
            <Trash2 size={14} />
          </button>
        </div>
        <p className="panel__hint">
          {sel.edge === 'in' ? 'Sobre el comienzo del clip.' : 'Sobre el final del clip.'} Para un cruce A→B, poné salida en A y entrada en B del mismo tipo.
        </p>

        <div className="panel__field">
          <label className="panel__label">Tipo</label>
          <select className="panel__select" value={t.kind} onChange={(e) => patch((tr) => { tr.kind = e.target.value as TransitionKind; }, 'Transition type')}>
            {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>

        <div className="panel__field">
          <label className="panel__label">Duración <span className="panel__num">{(t.durationMs / 1000).toFixed(2)}s</span></label>
          <input
            type="range" min={100} max={maxMs} step={50}
            value={Math.min(t.durationMs, maxMs)}
            onPointerDown={() => { durSnap.current = t.durationMs; }}
            onChange={(e) => patch((tr) => { tr.durationMs = Number(e.target.value); }, 'Transition duration', false)}
            onPointerUp={() => {
              const s = durSnap.current; durSnap.current = null;
              const cur = (() => {
                const c = useProjectStore.getState().project?.clips.find((x) => x.id === sel.clipId);
                return (sel.edge === 'in' ? c?.transitionIn : c?.transitionOut)?.durationMs ?? t.durationMs;
              })();
              if (s === null || s === cur) return;
              patch((tr) => { tr.durationMs = s; }, '', false);
              patch((tr) => { tr.durationMs = cur; }, 'Transition duration');
            }}
          />
        </div>
      </section>
    </aside>
  );
}
