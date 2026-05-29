import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, FolderOpen, Undo2, Redo2, RefreshCcw, Plus, Download } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';
import { useHistoryStore } from '@/stores/history';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useAutosave } from '../project/useAutosave';
import { detachAllVideos } from './videoSession';
import { PreviewCanvas } from './PreviewCanvas';
import { Transport } from './Transport';
import { Timeline } from './Timeline';
import { ZoomProperties } from './ZoomProperties';
import { AudioProperties } from './AudioProperties';
import { TextProperties } from './TextProperties';
import { TransitionProperties } from './TransitionProperties';
import { RightPanel } from './RightPanel';
import { ExportDialog } from '../export/ExportDialog';
import { useExportStore } from '@/stores/export';
import { generateZooms } from '@shared/lib/generateZooms';
import { makeTextEvent } from '@shared/lib/textPresets';
import { locateGlobal } from '@shared/lib/clipTime';

export function Editor() {
  useAutosave();
  const project = useProjectStore((s) => s.project);
  const projectPath = useProjectStore((s) => s.projectPath);
  const dirty = useProjectStore((s) => s.dirty);
  const update = useProjectStore((s) => s.update);
  const undo = useProjectStore((s) => s.undo);
  const redo = useProjectStore((s) => s.redo);
  const clear = useProjectStore((s) => s.clear);
  const canUndo = useHistoryStore((s) => s.past.length > 0);
  const canRedo = useHistoryStore((s) => s.future.length > 0);
  const setView = useUiStore((s) => s.setView);
  const selectedZoomId = useSelectionStore((s) => s.selectedZoomId);
  const selectZoom = useSelectionStore((s) => s.selectZoom);
  const selectedClipId = useSelectionStore((s) => s.selectedClipId);
  const selectClip = useSelectionStore((s) => s.selectClip);
  const selectedAudioId = useSelectionStore((s) => s.selectedAudioId);
  const selectAudio = useSelectionStore((s) => s.selectAudio);
  const selectedTextId = useSelectionStore((s) => s.selectedTextId);
  const selectText = useSelectionStore((s) => s.selectText);
  const selectedTransition = useSelectionStore((s) => s.selectedTransition);
  const selectTransition = useSelectionStore((s) => s.selectTransition);

  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Cleanup the video pool on unmount so nothing keeps streaming.
  useEffect(() => {
    // Never enter the editor stuck in crop-edit mode (e.g. from a prior project).
    useUiStore.getState().setCropEditMode(false);
    return () => {
      detachAllVideos();
      usePlaybackStore.getState().reset();
      useUiStore.getState().setCropEditMode(false);
    };
  }, []);

  // Keyboard shortcuts: undo/redo, Z to add manual zoom at playhead,
  // Delete to remove selected zoom.
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const mod = e.ctrlKey || e.metaKey;

      if (mod && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if (mod && ((e.key === 'y') || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
      }
      if (!mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        addManualZoomAtPlayhead();
        return;
      }
      if (!mod && (e.key === 't' || e.key === 'T')) {
        e.preventDefault();
        addTitleAtPlayhead();
        return;
      }
      if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
        const project = useProjectStore.getState().project;
        if (!project) return;
        const selZoomId = useSelectionStore.getState().selectedZoomId;
        const selClipId = useSelectionStore.getState().selectedClipId;
        const selAudioId = useSelectionStore.getState().selectedAudioId;
        const selTextId = useSelectionStore.getState().selectedTextId;
        const selTrans = useSelectionStore.getState().selectedTransition;
        if (selZoomId) {
          e.preventDefault();
          deleteSelectedZoom(selZoomId);
        } else if (selClipId) {
          e.preventDefault();
          deleteSelectedClip(selClipId);
        } else if (selAudioId) {
          e.preventDefault();
          update((d) => { d.audioTracks = d.audioTracks.filter((t) => t.id !== selAudioId); }, { label: 'Delete audio clip' });
          selectAudio(null);
        } else if (selTextId) {
          e.preventDefault();
          update((d) => { d.timeline.textEvents = d.timeline.textEvents.filter((t) => t.id !== selTextId); }, { label: 'Delete text' });
          selectText(null);
        } else if (selTrans) {
          e.preventDefault();
          update((d) => {
            const c = d.clips.find((x) => x.id === selTrans.clipId);
            if (!c) return;
            if (selTrans.edge === 'in') delete c.transitionIn; else delete c.transitionOut;
          }, { label: 'Remove transition' });
          selectTransition(null);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  const addManualZoomAtPlayhead = (): void => {
    const project = useProjectStore.getState().project;
    if (!project) return;
    const playhead = usePlaybackStore.getState().currentTimeMs;
    const located = locateGlobal(project, playhead);
    if (!located) return;
    const { clip, localMs } = located;
    // The new zoom lives in the active clip in source-local time.
    const defaultDur = Math.min(2000, Math.max(500, clip.outMs - localMs));
    const config = project.autoZoomConfig;
    const enter = Math.min(config.enterMs, defaultDur / 3);
    const exit = Math.min(config.exitMs, defaultDur / 3);
    const newZoom = {
      id: crypto.randomUUID(),
      source: 'manual' as const,
      startMs: localMs,
      endMs: Math.min(clip.outMs, localMs + defaultDur),
      enterDurationMs: enter,
      holdDurationMs: defaultDur - enter - exit,
      exitDurationMs: exit,
      enterEasing: config.enterEasing,
      exitEasing: config.exitEasing,
      scale: config.defaultScale,
      target: { mode: 'point' as const, nx: 0.5, ny: 0.5 },
      cursorBehavior: 'static' as const,
    };
    update((d) => {
      const c = d.clips.find((cc) => cc.id === clip.id);
      if (!c) return;
      c.zoomEvents.push(newZoom);
      c.zoomEvents.sort((a, b) => a.startMs - b.startMs);
    }, { label: 'Add manual zoom' });
    selectZoom(newZoom.id);
  };

  const addTitleAtPlayhead = (): void => {
    const playhead = Math.max(0, Math.round(usePlaybackStore.getState().currentTimeMs));
    const ev = makeTextEvent('title', playhead, playhead + 3000);
    update((d) => { d.timeline.textEvents.push(ev); }, { label: 'Add text' });
    selectText(ev.id);
  };

  const deleteSelectedZoom = (id: string): void => {
    update((d) => {
      for (const c of d.clips) {
        if (c.zoomEvents.some((z) => z.id === id)) {
          c.zoomEvents = c.zoomEvents.filter((z) => z.id !== id);
          break;
        }
      }
    }, { label: 'Delete zoom' });
    selectZoom(null);
  };

  const deleteSelectedClip = (id: string): void => {
    const project = useProjectStore.getState().project;
    if (!project) return;
    if (project.clips.length <= 1) {
      window.alert('Cannot delete the last clip — the project needs at least one clip.');
      return;
    }
    // Video clips move to mediaPool (re-insertable from the Media tab). Image
    // clips are just dropped — their source still lives in the Images pool, so
    // there's nothing to preserve here.
    update((d) => {
      const idx = d.clips.findIndex((c) => c.id === id);
      if (idx === -1) return;
      const [removed] = d.clips.splice(idx, 1);
      if (removed && removed.kind !== 'image') d.mediaPool.push(removed);
    }, { label: 'Delete clip' });
    selectClip(null);
  };

  const regenerateAutoZooms = (): void => {
    const project = useProjectStore.getState().project;
    if (!project) return;
    if (project.clips.length === 0) return;
    const anyZooms = project.clips.some((c) => c.zoomEvents.length > 0);
    if (anyZooms) {
      const ok = window.confirm(
        'Re-generate zoom events from clicks?\nManual and locked zooms will be kept.',
      );
      if (!ok) return;
    }
    // Compute fresh zooms per clip and apply in one update.
    const freshByClip = new Map<string, ReturnType<typeof generateZooms>>();
    for (const c of project.clips) {
      const preserve = c.zoomEvents.filter((z) => z.source === 'manual' || z.locked);
      const bounds = c.displayBounds;
      const coordSpace = bounds
        ? { width: bounds.w, height: bounds.h }
        : { width: c.sourceWidth, height: c.sourceHeight };
      const fresh = generateZooms(c.mouseEvents, project.autoZoomConfig, coordSpace, { preserve });
      freshByClip.set(c.id, fresh);
    }
    update((d) => {
      for (const c of d.clips) {
        const fresh = freshByClip.get(c.id);
        if (fresh) c.zoomEvents = fresh;
      }
    }, { label: 'Regenerate auto-zooms' });
  };

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  if (!project || !projectPath) {
    return (
      <div className="editor-empty">
        <p>No project loaded.</p>
        <button className="btn" onClick={() => setView('launcher')}>Back</button>
      </div>
    );
  }

  const handleBack = (): void => {
    clear();
    setView('launcher');
  };

  const handleReveal = (): void => {
    if (projectPath) window.videoZoom.project.reveal(projectPath);
  };

  const startRename = (): void => {
    setDraftName(project.name);
    setEditing(true);
  };

  const commitRename = (): void => {
    const next = draftName.trim();
    if (next && next !== project.name) {
      update((d) => { d.name = next; }, { label: 'Rename project' });
    }
    setEditing(false);
  };

  return (
    <div className="editor">
      <header className="editor__header">
        <button className="icon-btn" onClick={handleBack} aria-label="Back to launcher">
          <ArrowLeft size={18} />
        </button>
        <div className="editor__title-wrap">
          {editing ? (
            <input
              ref={inputRef}
              className="editor__name-input"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                else if (e.key === 'Escape') setEditing(false);
              }}
              spellCheck={false}
            />
          ) : (
            <button className="editor__name" onClick={startRename} title="Click to rename">
              {project.name}
              {dirty && <span className="editor__dirty" title="Unsaved changes">●</span>}
            </button>
          )}
          <span className="editor__path">{projectPath}</span>
        </div>
        <div className="editor__header-actions">
          <button
            className="btn btn--small btn--accent"
            onClick={() => {
              if (!projectPath) return;
              useUiStore.getState().setPendingAppendTarget(projectPath);
              setView('sourcePicker');
            }}
            title="Record a new clip and append it to this project"
          >
            <Plus size={14} /> Add recording
          </button>
          <button
            className="btn btn--small btn--export"
            onClick={() => { useExportStore.getState().reset(); useExportStore.getState().setOpen(true); }}
            title="Export the project to MP4"
          >
            <Download size={14} /> Export
          </button>
          <button
            className="icon-btn"
            onClick={regenerateAutoZooms}
            title="Regenerate auto-zooms from clicks"
            aria-label="Regenerate zooms"
          >
            <RefreshCcw size={16} />
          </button>
          <button
            className="icon-btn"
            onClick={() => undo()}
            disabled={!canUndo}
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
          >
            <Undo2 size={18} />
          </button>
          <button
            className="icon-btn"
            onClick={() => redo()}
            disabled={!canRedo}
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
          >
            <Redo2 size={18} />
          </button>
          <button className="icon-btn" onClick={handleReveal} title="Reveal in folder" aria-label="Reveal in folder">
            <FolderOpen size={18} />
          </button>
        </div>
      </header>

      <main className="editor__main">
        <section className="editor__stage">
          <div className="editor__preview-wrap">
            <PreviewCanvas
              projectPath={projectPath}
              sourceWidth={project.clips[0]?.sourceWidth ?? 1920}
              sourceHeight={project.clips[0]?.sourceHeight ?? 1080}
            />
          </div>
          <Transport />
        </section>
        {selectedZoomId ? <ZoomProperties /> : selectedAudioId ? <AudioProperties /> : selectedTextId ? <TextProperties /> : selectedTransition ? <TransitionProperties /> : <RightPanel />}
      </main>

      <Timeline />
      <ExportDialog />
    </div>
  );
}
