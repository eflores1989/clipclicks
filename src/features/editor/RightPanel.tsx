import { useState } from 'react';
import { FolderTree, Film } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { PropertiesPanel } from './PropertiesPanel';
import { MediaPool } from './MediaPool';

type Tab = 'project' | 'media';
type MediaSubtab = 'video' | 'audio' | 'images' | 'text' | 'timer';

/**
 * Container for the right-side panel. Two top-level tabs:
 *   - Project: background controls, selected-clip props, autosave hint.
 *   - Media: the media pool. Sub-tabs for Video / Audio / Images (the latter
 *     two empty until 5D / future phases).
 *
 * When a zoom event is selected, the panel is replaced upstream by
 * ZoomProperties (Editor handles that switch). This component is only
 * mounted when no zoom is selected.
 */
export function RightPanel() {
  const [tab, setTab] = useState<Tab>('project');
  const [mediaSubtab, setMediaSubtab] = useState<MediaSubtab>('video');
  const poolCount = useProjectStore((s) => s.project?.mediaPool.length ?? 0);

  return (
    <div className="right-panel">
      <div className="right-panel__tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === 'project'}
          className={`right-panel__tab ${tab === 'project' ? 'right-panel__tab--active' : ''}`}
          onClick={() => setTab('project')}
        >
          <FolderTree size={14} /> Project
        </button>
        <button
          role="tab"
          aria-selected={tab === 'media'}
          className={`right-panel__tab ${tab === 'media' ? 'right-panel__tab--active' : ''}`}
          onClick={() => setTab('media')}
        >
          <Film size={14} /> Media{poolCount > 0 && <span className="right-panel__tab-count">{poolCount}</span>}
        </button>
      </div>

      <div className="right-panel__content">
        {tab === 'project' && <PropertiesPanel />}
        {tab === 'media' && (
          <>
            <div className="media-pool__subtabs" role="tablist">
              <SubtabButton id="video" current={mediaSubtab} onClick={setMediaSubtab} label="Video" />
              <SubtabButton id="audio" current={mediaSubtab} onClick={setMediaSubtab} label="Audio" />
              <SubtabButton id="text" current={mediaSubtab} onClick={setMediaSubtab} label="Text" />
              <SubtabButton id="timer" current={mediaSubtab} onClick={setMediaSubtab} label="Timer" />
              <SubtabButton id="images" current={mediaSubtab} onClick={setMediaSubtab} label="Images" />
            </div>
            <MediaPool subtab={mediaSubtab} />
          </>
        )}
      </div>
    </div>
  );
}

function SubtabButton({
  id, current, onClick, label, disabled,
}: { id: MediaSubtab; current: MediaSubtab; onClick: (s: MediaSubtab) => void; label: string; disabled?: boolean }) {
  return (
    <button
      role="tab"
      aria-selected={current === id}
      disabled={disabled}
      className={`media-pool__subtab ${current === id ? 'media-pool__subtab--active' : ''}`}
      onClick={() => onClick(id)}
      title={disabled ? 'Coming in a future phase' : undefined}
    >
      {label}
    </button>
  );
}
