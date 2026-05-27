import { enablePatches, type Patch } from 'immer';
import { create } from 'zustand';

enablePatches();

export interface HistoryEntry {
  patches: Patch[];
  inversePatches: Patch[];
  label?: string;
}

const MAX_STACK = 100;

interface HistoryState {
  past: HistoryEntry[];
  future: HistoryEntry[];

  push: (entry: HistoryEntry) => void;
  popUndo: () => HistoryEntry | null;
  popRedo: () => HistoryEntry | null;
  clear: () => void;
}

export const useHistoryStore = create<HistoryState>((set, get) => ({
  past: [],
  future: [],

  push: (entry) =>
    set((s) => ({
      past: [...s.past, entry].slice(-MAX_STACK),
      future: [],
    })),

  popUndo: () => {
    const past = get().past;
    if (past.length === 0) return null;
    const entry = past[past.length - 1];
    set((s) => ({
      past: s.past.slice(0, -1),
      future: [...s.future, entry],
    }));
    return entry;
  },

  popRedo: () => {
    const future = get().future;
    if (future.length === 0) return null;
    const entry = future[future.length - 1];
    set((s) => ({
      past: [...s.past, entry],
      future: s.future.slice(0, -1),
    }));
    return entry;
  },

  clear: () => set({ past: [], future: [] }),
}));
