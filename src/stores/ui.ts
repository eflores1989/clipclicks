import { create } from 'zustand';

export type AppView =
  | 'launcher'
  | 'sourcePicker'
  | 'countdown'
  | 'recording'
  | 'saving'
  | 'processing'
  | 'editor';

interface UiState {
  view: AppView;
  /**
   * When set, the next recording will be appended to this project instead of
   * creating a brand-new one. Set by the editor's "Add recording" button
   * before navigating to the source picker.
   */
  pendingAppendToProjectPath: string | null;
  /**
   * True while the user is editing the crop/aspect of the active clip. The
   * preview renders the full uncropped frame and shows the draggable crop
   * overlay; click-zoom + cursor overlays are suspended.
   */
  cropEditMode: boolean;
  setView: (view: AppView) => void;
  setPendingAppendTarget: (path: string | null) => void;
  setCropEditMode: (on: boolean) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: 'launcher',
  pendingAppendToProjectPath: null,
  cropEditMode: false,
  setView: (view) => set({ view }),
  setPendingAppendTarget: (path) => set({ pendingAppendToProjectPath: path }),
  setCropEditMode: (on) => set({ cropEditMode: on }),
}));
