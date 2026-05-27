import { applyPatches, produce, produceWithPatches } from 'immer';
import { create } from 'zustand';
import type { Project, ProjectRef } from '@shared/types/project';
import { recomputeTimeline } from '@shared/lib/clipTime';
import { useHistoryStore } from './history';

interface ProjectState {
  project: Project | null;
  projectPath: string | null;
  videoAssetUrl: string | null;
  thumbnailUrls: string[];
  recents: ProjectRef[];
  dirty: boolean;

  setLoaded: (p: {
    project: Project;
    projectPath: string;
    videoAssetUrl: string;
    thumbnailUrls: string[];
  }) => void;
  setRecents: (refs: ProjectRef[]) => void;
  markClean: () => void;
  markDirty: () => void;
  update: (mutator: (draft: Project) => void, opts?: { label?: string; record?: boolean }) => void;
  undo: () => boolean;
  redo: () => boolean;
  clear: () => void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  project: null,
  projectPath: null,
  videoAssetUrl: null,
  thumbnailUrls: [],
  recents: [],
  dirty: false,

  setLoaded: ({ project, projectPath, videoAssetUrl, thumbnailUrls }) => {
    // Run a fresh timeline recompute on load. This catches projects saved
    // under 5B where timeline.durationMs was source duration; under 5C+ it's
    // effective duration (sum of (out-in)/speed across clips).
    const fresh = produce(project, (draft) => { recomputeTimeline(draft); });
    useHistoryStore.getState().clear();
    set({ project: fresh, projectPath, videoAssetUrl, thumbnailUrls, dirty: false });
  },

  setRecents: (recents) => set({ recents }),

  markClean: () => set({ dirty: false }),
  markDirty: () => set({ dirty: true }),

  update: (mutator, opts) => {
    const current = get().project;
    if (!current) return;
    const [next, patches, inversePatches] = produceWithPatches(current, (draft) => {
      mutator(draft);
      // Keep clip.timelineStartMs and timeline.durationMs in sync with the
      // current clip array + per-clip trim + speed. Idempotent — if nothing
      // changed, Immer skips this in the produced patches.
      recomputeTimeline(draft);
    });
    if (patches.length === 0) return;
    if (opts?.record !== false) {
      useHistoryStore.getState().push({
        patches,
        inversePatches,
        label: opts?.label,
      });
    }
    set({ project: next as Project, dirty: true });
  },

  undo: () => {
    const entry = useHistoryStore.getState().popUndo();
    const current = get().project;
    if (!entry || !current) return false;
    const next = applyPatches(current, entry.inversePatches);
    set({ project: next as Project, dirty: true });
    return true;
  },

  redo: () => {
    const entry = useHistoryStore.getState().popRedo();
    const current = get().project;
    if (!entry || !current) return false;
    const next = applyPatches(current, entry.patches);
    set({ project: next as Project, dirty: true });
    return true;
  },

  clear: () => {
    useHistoryStore.getState().clear();
    set({
      project: null,
      projectPath: null,
      videoAssetUrl: null,
      thumbnailUrls: [],
      dirty: false,
    });
  },
}));
