import { useEffect, useState } from 'react';
import { Loader2, Film, Image, Sparkles, Check, X } from 'lucide-react';
import type { ProjectCreateProgress, ProjectCreateStage } from '@shared/types/project';

const STAGES: { id: ProjectCreateStage; label: string; icon: typeof Film }[] = [
  { id: 'transcoding', label: 'Transcoding video to MP4', icon: Film },
  { id: 'thumbnails', label: 'Generating thumbnails', icon: Image },
  { id: 'finalizing', label: 'Saving project', icon: Sparkles },
];

export function ProcessingView() {
  const [current, setCurrent] = useState<ProjectCreateStage>('transcoding');
  const [percent, setPercent] = useState(0);
  const [done, setDone] = useState<Set<ProjectCreateStage>>(new Set());
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const unsubscribe = window.videoZoom.project.onCreateProgress((p: ProjectCreateProgress) => {
      setCurrent(p.stage);
      setPercent(p.percent);
      if (p.stage === 'done') {
        setDone(new Set(['transcoding', 'thumbnails', 'finalizing']));
        return;
      }
      if (p.percent >= 100) {
        setDone((prev) => new Set(prev).add(p.stage));
      }
    });
    return unsubscribe;
  }, []);

  // Cancel discards the recording: main kills the ffmpeg processing, removes
  // the half-built project + staging, and the create promise rejects with
  // CANCELLED — useRecorder.stop() catches that and routes back to launcher.
  const handleCancel = (): void => {
    if (cancelling) return;
    setCancelling(true);
    window.videoZoom.project.cancelProcessing().catch(() => { /* ignore */ });
  };

  return (
    <div className="processing">
      <div className="processing__card">
        <h2 className="processing__title">Preparing your project</h2>
        <p className="processing__sub">
          {cancelling ? 'Cancelling…' : 'This usually takes a few seconds.'}
        </p>

        <ul className="processing__stages">
          {STAGES.map((s) => {
            const isDone = done.has(s.id);
            const isCurrent = current === s.id && !isDone;
            const Icon = isDone ? Check : isCurrent ? Loader2 : s.icon;
            return (
              <li
                key={s.id}
                className={`stage ${isCurrent ? 'stage--active' : ''} ${isDone ? 'stage--done' : ''}`}
              >
                <span className="stage__icon">
                  <Icon size={16} className={isCurrent ? 'spin' : ''} />
                </span>
                <span className="stage__label">{s.label}</span>
                {isCurrent && (
                  <span className="stage__percent">{Math.round(percent)}%</span>
                )}
              </li>
            );
          })}
        </ul>

        <button
          className="btn btn--ghost processing__cancel"
          onClick={handleCancel}
          disabled={cancelling}
        >
          <X size={14} /> {cancelling ? 'Cancelling…' : 'Cancel & discard'}
        </button>
      </div>
    </div>
  );
}
