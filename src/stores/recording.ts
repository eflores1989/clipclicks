import { create } from 'zustand';
import type {
  DesktopSource,
  RecordingSaveResult,
  RecordingSource,
} from '@shared/types/recording';

export type RecorderStatus = 'idle' | 'starting' | 'recording' | 'paused' | 'stopping' | 'saving' | 'error';

interface RecordingState {
  status: RecorderStatus;
  sources: DesktopSource[];
  selectedSource: RecordingSource | null;
  startedAtEpoch: number | null;
  pausedMs: number;
  pausedAt: number | null;
  mouseHookActive: boolean;
  mouseEventCount: number;
  lastSave: RecordingSaveResult | null;
  errorMessage: string | null;

  setStatus: (s: RecorderStatus) => void;
  setSources: (sources: DesktopSource[]) => void;
  setSelectedSource: (s: RecordingSource | null) => void;
  setStart: (epoch: number, hookActive: boolean) => void;
  pause: () => void;
  resume: () => void;
  setMouseEventCount: (n: number) => void;
  setLastSave: (r: RecordingSaveResult | null) => void;
  setError: (msg: string | null) => void;
  reset: () => void;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  status: 'idle',
  sources: [],
  selectedSource: null,
  startedAtEpoch: null,
  pausedMs: 0,
  pausedAt: null,
  mouseHookActive: false,
  mouseEventCount: 0,
  lastSave: null,
  errorMessage: null,

  setStatus: (status) => set({ status }),
  setSources: (sources) => set({ sources }),
  setSelectedSource: (selectedSource) => set({ selectedSource }),
  setStart: (epoch, hookActive) => set({
    startedAtEpoch: epoch,
    mouseHookActive: hookActive,
    pausedMs: 0,
    pausedAt: null,
  }),
  pause: () => {
    if (get().pausedAt !== null) return;
    set({ pausedAt: Date.now(), status: 'paused' });
  },
  resume: () => {
    const { pausedAt, pausedMs } = get();
    if (pausedAt === null) return;
    set({
      pausedMs: pausedMs + (Date.now() - pausedAt),
      pausedAt: null,
      status: 'recording',
    });
  },
  setMouseEventCount: (n) => set({ mouseEventCount: n }),
  setLastSave: (lastSave) => set({ lastSave }),
  setError: (errorMessage) => set({ errorMessage, status: errorMessage ? 'error' : get().status }),
  reset: () => set({
    status: 'idle',
    selectedSource: null,
    startedAtEpoch: null,
    pausedMs: 0,
    pausedAt: null,
    mouseHookActive: false,
    mouseEventCount: 0,
    lastSave: null,
    errorMessage: null,
  }),
}));
