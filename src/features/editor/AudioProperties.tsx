import { useRef } from 'react';
import { Music, Trash2, Volume2, VolumeX } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useSelectionStore } from '@/stores/selection';
import type { AudioTrack, Project } from '@shared/types/project';

function fmt(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Properties for the selected timeline AudioTrack: gain, mute, fades, delete.
 * Mirrors ZoomProperties (replaces the right panel while an audio chip is
 * selected). Trim + drag-reposition land in 5D.3.
 */
export function AudioProperties() {
  const selectedAudioId = useSelectionStore((s) => s.selectedAudioId);
  const selectAudio = useSelectionStore((s) => s.selectAudio);
  const update = useProjectStore((s) => s.update);
  const track = useProjectStore((s) =>
    s.project?.audioTracks.find((t) => t.id === selectedAudioId));
  const media = useProjectStore((s) =>
    s.project?.audioPool.find((m) => m.id === track?.mediaId));

  if (!track || !media) return null;
  const lenMs = Math.max(0, track.outMs - track.inMs);

  const patch = (fn: (t: AudioTrack) => void, label: string, record = true): void => {
    update((d: Project) => {
      const t = d.audioTracks.find((x) => x.id === track.id);
      if (t) fn(t);
    }, record ? { label } : { record: false });
  };

  const remove = (): void => {
    update((d: Project) => {
      d.audioTracks = d.audioTracks.filter((t) => t.id !== track.id);
    }, { label: 'Delete audio clip' });
    selectAudio(null);
  };

  return (
    <aside className="properties">
      <section className="properties__section">
        <div className="zoom-prop__header">
          <h3 className="panel__title"><Music size={13} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Audio</h3>
          <button className="icon-btn icon-btn--danger" onClick={remove} title="Quitar del timeline" aria-label="Delete audio clip">
            <Trash2 size={14} />
          </button>
        </div>
        <p className="panel__hint" style={{ wordBreak: 'break-word' }}>{media.name}</p>
        <div className="audio-prop__rows">
          <div className="audio-prop__row">
            <span className="audio-prop__row-label">Posición</span>
            <span className="audio-prop__row-value">{fmt(track.offsetMs)}</span>
          </div>
          <div className="audio-prop__row">
            <span className="audio-prop__row-label">Duración</span>
            <span className="audio-prop__row-value">{fmt(lenMs)}</span>
          </div>
        </div>
      </section>

      <section className="properties__section">
        <label className="panel__checkbox">
          <input
            type="checkbox"
            checked={track.muted}
            onChange={(e) => patch((t) => { t.muted = e.target.checked; }, 'Mute audio')}
          />
          {track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />} Silenciar
        </label>

        <GainSlider track={track} patch={patch} />

        <FadeSlider label="Fade in" field="fadeInMs" value={track.fadeInMs} maxMs={Math.min(5000, lenMs)} patch={patch} />
        <FadeSlider label="Fade out" field="fadeOutMs" value={track.fadeOutMs} maxMs={Math.min(5000, lenMs)} patch={patch} />
      </section>
    </aside>
  );
}

function GainSlider({ track, patch }: { track: AudioTrack; patch: (fn: (t: AudioTrack) => void, label: string, record?: boolean) => void }) {
  const snap = useRef<number | null>(null);
  return (
    <div className="panel__field">
      <label className="panel__label">Volumen <span className="panel__num">{Math.round(track.volume * 100)}%</span></label>
      <input
        type="range" min={0} max={100} step={1}
        value={Math.round(Math.min(1, track.volume) * 100)}
        onPointerDown={() => { snap.current = track.volume; }}
        onChange={(e) => patch((t) => { t.volume = Number(e.target.value) / 100; }, 'Volume', false)}
        onPointerUp={() => {
          const s = snap.current; snap.current = null;
          if (s === null) return;
          const cur = useProjectStore.getState().project?.audioTracks.find((x) => x.id === track.id)?.volume ?? 1;
          if (s === cur) return;
          patch((t) => { t.volume = s; }, '', false);
          patch((t) => { t.volume = cur; }, 'Volume');
        }}
      />
    </div>
  );
}

function FadeSlider({
  label, field, value, maxMs, patch,
}: {
  label: string;
  field: 'fadeInMs' | 'fadeOutMs';
  value: number;
  maxMs: number;
  patch: (fn: (t: AudioTrack) => void, label: string, record?: boolean) => void;
}) {
  const snap = useRef<number | null>(null);
  return (
    <div className="panel__field">
      <label className="panel__label">{label} <span className="panel__num">{(value / 1000).toFixed(1)}s</span></label>
      <input
        type="range" min={0} max={Math.max(0, Math.round(maxMs))} step={50}
        value={Math.min(value, maxMs)}
        onPointerDown={() => { snap.current = value; }}
        onChange={(e) => patch((t) => { t[field] = Number(e.target.value); }, label, false)}
        onPointerUp={() => {
          // `value` is the live prop (record:false updates re-render us), so on
          // release it holds the final drag value. Replay snapshot → final for
          // a single history entry.
          const s = snap.current; snap.current = null;
          if (s === null || s === value) return;
          patch((t) => { t[field] = s; }, '', false);
          patch((t) => { t[field] = value; }, label);
        }}
      />
    </div>
  );
}
