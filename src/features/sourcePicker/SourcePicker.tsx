import { useEffect, useState } from 'react';
import { ArrowLeft, Monitor, AppWindow, Loader2, Mic } from 'lucide-react';
import { useUiStore } from '@/stores/ui';
import { useRecordingStore } from '@/stores/recording';
import { useRecorder } from '../recorder/useRecorder';
import type { DesktopSource, SourceKind } from '@shared/types/recording';

type Tab = 'screen' | 'window';

const COUNTDOWN_SECONDS = 3;

export function SourcePicker() {
  const setView = useUiStore((s) => s.setView);
  const sources = useRecordingStore((s) => s.sources);
  const setSources = useRecordingStore((s) => s.setSources);
  const { start } = useRecorder();

  const [tab, setTab] = useState<Tab>('screen');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 5D.5: optional audio capture. Off by default — opt in per recording.
  const [captureMic, setCaptureMic] = useState(false);
  const [captureSystemAudio, setCaptureSystemAudio] = useState(false);
  // 5F.4: cursor exclusion works for SCREEN sources via the native ffmpeg
  // gdigrab path. Window captures still go through MediaRecorder + chromeMediaSource
  // which always burns the cursor in. We expose the toggle and disable it
  // when a window source is picked.
  const [captureSystemCursor, setCaptureSystemCursor] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.videoZoom.recorder.listSources()
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        const firstOfKind = list.find((s) => s.kind === tab);
        if (firstOfKind) setSelectedId(firstOfKind.id);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [setSources]);

  const filtered = sources.filter((s) => s.kind === tab);

  const handleStart = () => {
    const picked = sources.find((s) => s.id === selectedId);
    if (!picked) return;
    setCountdown(COUNTDOWN_SECONDS);
  };

  useEffect(() => {
    if (countdown === null) return;
    if (countdown === 0) {
      const picked = sources.find((s) => s.id === selectedId);
      if (picked) {
        start(
          { id: picked.id, name: picked.name, kind: picked.kind },
          { captureSystemCursor, captureMic, captureSystemAudio },
        ).catch((err: Error) => {
          setError(err.message);
          setCountdown(null);
        });
      }
      return;
    }
    const id = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(id);
  }, [countdown, selectedId, sources, start, captureSystemCursor, captureMic, captureSystemAudio]);

  if (countdown !== null) {
    return (
      <div className="countdown">
        <div className="countdown__number">{countdown === 0 ? 'Go' : countdown}</div>
        <div className="countdown__hint">Recording starts in…</div>
      </div>
    );
  }

  return (
    <div className="picker">
      <header className="picker__header">
        <button className="icon-btn" onClick={() => setView('launcher')} aria-label="Back">
          <ArrowLeft size={18} />
        </button>
        <h2>Choose what to record</h2>
        <div style={{ width: 32 }} />
      </header>

      <div className="picker__tabs">
        <TabButton active={tab === 'screen'} onClick={() => setTab('screen')} kind="screen" label="Screen" />
        <TabButton active={tab === 'window'} onClick={() => setTab('window')} kind="window" label="Window" />
      </div>

      <div className="picker__body">
        {loading && <div className="picker__loading"><Loader2 className="spin" size={20} /> Loading sources…</div>}
        {error && <div className="picker__error">{error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="picker__empty">No {tab} sources detected.</div>
        )}
        <div className="picker__grid">
          {filtered.map((s) => (
            <SourceCard
              key={s.id}
              source={s}
              selected={s.id === selectedId}
              onSelect={() => setSelectedId(s.id)}
            />
          ))}
        </div>
      </div>

      <div className="picker__options">
        <div className="picker__opt-group">
          <span className="picker__opt-group-title"><Monitor size={12} /> Cursor</span>
          <label className={`picker__option ${tab === 'window' ? 'picker__option--disabled' : ''}`} title={tab === 'window' ? 'Only available when capturing the full screen' : undefined}>
            <input
              type="checkbox"
              checked={tab === 'window' ? true : captureSystemCursor}
              disabled={tab === 'window'}
              onChange={(e) => setCaptureSystemCursor(e.target.checked)}
            />
            <span>
              Capture the system cursor
              <span className="picker__option-hint">
                {tab === 'window'
                  ? 'In window mode the system cursor is always recorded. To exclude it, record the full screen.'
                  : (captureSystemCursor
                      ? 'The Windows pointer will appear in the recording. In the editor, choose the "Pulse" or "Hidden" cursor style.'
                      : 'Record without the Windows pointer. In the editor, choose the "Arrow" or "Dot" cursor style.')}
              </span>
            </span>
          </label>
        </div>

        <div className="picker__opt-group">
          <span className="picker__opt-group-title"><Mic size={12} /> Audio</span>
          {tab === 'window' ? (
            <p className="picker__option-hint" style={{ margin: 0 }}>
              Audio capture is only available when recording the <strong>full screen</strong>.
            </p>
          ) : (
            <>
              <label className="picker__option">
                <input type="checkbox" checked={captureMic} onChange={(e) => setCaptureMic(e.target.checked)} />
                <span>Microphone<span className="picker__option-hint">Your voice, mixed into the clip's audio.</span></span>
              </label>
              <label className={`picker__option ${!captureSystemCursor ? 'picker__option--disabled' : ''}`}
                title={!captureSystemCursor ? 'Not available without the system cursor' : undefined}>
                <input
                  type="checkbox"
                  checked={captureSystemAudio}
                  disabled={!captureSystemCursor}
                  onChange={(e) => setCaptureSystemAudio(e.target.checked)}
                />
                <span>System audio<span className="picker__option-hint">The sound from your PC (loopback). If your device doesn't support it, the recording proceeds without it.</span></span>
              </label>
            </>
          )}
        </div>
      </div>

      <footer className="picker__footer">
        <button className="btn btn--ghost" onClick={() => setView('launcher')}>Cancel</button>
        <button
          className="btn btn--record"
          onClick={handleStart}
          disabled={!selectedId || loading}
        >
          Record
        </button>
      </footer>
    </div>
  );
}

function TabButton({ active, onClick, kind, label }: { active: boolean; onClick: () => void; kind: SourceKind; label: string }) {
  const Icon = kind === 'screen' ? Monitor : AppWindow;
  return (
    <button
      className={`tab ${active ? 'tab--active' : ''}`}
      onClick={onClick}
    >
      <Icon size={16} />
      {label}
    </button>
  );
}

function SourceCard({ source, selected, onSelect }: { source: DesktopSource; selected: boolean; onSelect: () => void }) {
  return (
    <button
      className={`source-card ${selected ? 'source-card--selected' : ''}`}
      onClick={onSelect}
      title={source.name}
    >
      <div className="source-card__thumb-wrap">
        <img src={source.thumbnail} alt={source.name} className="source-card__thumb" />
      </div>
      <div className="source-card__label">
        {source.appIcon && (
          <img src={source.appIcon} alt="" className="source-card__icon" />
        )}
        <span className="source-card__name">{source.name}</span>
      </div>
    </button>
  );
}
