import { useEffect, useRef } from 'react';
import { useProjectStore } from '@/stores/project';

const AUTOSAVE_DEBOUNCE_MS = 1500;

export function useAutosave(): void {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef(false);

  useEffect(() => {
    const unsubscribe = useProjectStore.subscribe((state, prev) => {
      if (!state.dirty) return;
      if (state.dirty === prev.dirty && state.project === prev.project) return;
      if (!state.project || !state.projectPath) return;

      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      pendingRef.current = true;
      timeoutRef.current = setTimeout(async () => {
        const { project, projectPath } = useProjectStore.getState();
        if (!project || !projectPath) return;
        try {
          await window.videoZoom.project.save({ projectPath, project });
          useProjectStore.getState().markClean();
        } catch (err) {
          console.error('[autosave] failed', err);
        } finally {
          pendingRef.current = false;
        }
      }, AUTOSAVE_DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);
}
