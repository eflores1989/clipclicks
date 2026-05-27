import { useEffect, useState } from 'react';
import { Square, Pause, Play, X, Circle } from 'lucide-react';
import { useRecordingStore } from '@/stores/recording';
import { useRecorder } from './useRecorder';

function formatTime(ms: number): string {
  const total = Math.floor(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function RecordingBar() {
  const status = useRecordingStore((s) => s.status);
  const startedAt = useRecordingStore((s) => s.startedAtEpoch);
  const pausedMs = useRecordingStore((s) => s.pausedMs);
  const pausedAt = useRecordingStore((s) => s.pausedAt);
  const hookActive = useRecordingStore((s) => s.mouseHookActive);

  const { pause, resume, stop, cancel } = useRecorder();

  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  let elapsedMs = 0;
  if (startedAt !== null) {
    const currentPaused = pausedAt !== null ? now - pausedAt : 0;
    elapsedMs = Math.max(0, now - startedAt - pausedMs - currentPaused);
  }

  const isPaused = status === 'paused';
  const isRecording = status === 'recording' || isPaused;

  return (
    <div className={`rec-bar ${isPaused ? 'rec-bar--paused' : ''}`}>
      <div className="rec-bar__drag">
        <Circle
          className={`rec-bar__dot ${isPaused ? '' : 'rec-bar__dot--pulse'}`}
          size={10}
          fill="currentColor"
        />
        <span className="rec-bar__time">{formatTime(elapsedMs)}</span>
        {!hookActive && isRecording && (
          <span className="rec-bar__warn" title="Global mouse hook is not active — auto-zoom will be empty">!</span>
        )}
      </div>

      <div className="rec-bar__controls">
        {!isPaused ? (
          <button className="rec-btn" onClick={() => pause()} aria-label="Pause" title="Pause">
            <Pause size={14} />
          </button>
        ) : (
          <button className="rec-btn" onClick={() => resume()} aria-label="Resume" title="Resume">
            <Play size={14} />
          </button>
        )}
        <button className="rec-btn rec-btn--stop" onClick={() => stop()} aria-label="Stop" title="Stop">
          <Square size={12} fill="currentColor" />
        </button>
        <button className="rec-btn rec-btn--cancel" onClick={() => cancel()} aria-label="Cancel" title="Cancel">
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
