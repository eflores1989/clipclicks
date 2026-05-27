import { create } from 'zustand';

export interface TransitionSel {
  clipId: string;
  edge: 'in' | 'out';
}

interface SelectionState {
  selectedZoomId: string | null;
  selectedClipId: string | null;
  selectedAudioId: string | null;
  selectedTextId: string | null;
  selectedTransition: TransitionSel | null;
  hoveredEventId: string | null;

  selectZoom: (id: string | null) => void;
  selectClip: (id: string | null) => void;
  selectAudio: (id: string | null) => void;
  selectText: (id: string | null) => void;
  selectTransition: (sel: TransitionSel | null) => void;
  hoverEvent: (id: string | null) => void;
  clear: () => void;
}

const NONE = { selectedZoomId: null, selectedClipId: null, selectedAudioId: null, selectedTextId: null, selectedTransition: null };

export const useSelectionStore = create<SelectionState>((set) => ({
  selectedZoomId: null,
  selectedClipId: null,
  selectedAudioId: null,
  selectedTextId: null,
  selectedTransition: null,
  hoveredEventId: null,

  selectZoom: (id) => set({ ...NONE, selectedZoomId: id }),
  selectClip: (id) => set({ ...NONE, selectedClipId: id }),
  selectAudio: (id) => set({ ...NONE, selectedAudioId: id }),
  selectText: (id) => set({ ...NONE, selectedTextId: id }),
  selectTransition: (sel) => set({ ...NONE, selectedTransition: sel }),
  hoverEvent: (id) => set({ hoveredEventId: id }),
  clear: () => set({ ...NONE, hoveredEventId: null }),
}));
