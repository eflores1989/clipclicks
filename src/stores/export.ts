import { create } from 'zustand';

export type ExportStatus =
  | 'idle'
  | 'rendering'    // capturing the composed timeline in real time
  | 'transcoding'  // ffmpeg webm → mp4
  | 'done'
  | 'error'
  | 'cancelled';

interface ExportState {
  open: boolean;
  status: ExportStatus;
  /** 0..100 within the current stage. */
  percent: number;
  outputPath: string | null;
  error: string | null;

  setOpen: (open: boolean) => void;
  start: () => void;
  setStage: (status: ExportStatus, percent?: number) => void;
  setPercent: (percent: number) => void;
  finishOk: (outputPath: string) => void;
  finishErr: (error: string) => void;
  reset: () => void;
}

export const useExportStore = create<ExportState>((set) => ({
  open: false,
  status: 'idle',
  percent: 0,
  outputPath: null,
  error: null,

  setOpen: (open) => set({ open }),
  start: () => set({ status: 'rendering', percent: 0, outputPath: null, error: null }),
  setStage: (status, percent = 0) => set({ status, percent }),
  setPercent: (percent) => set({ percent }),
  finishOk: (outputPath) => set({ status: 'done', percent: 100, outputPath }),
  finishErr: (error) => set({ status: error === 'CANCELLED' ? 'cancelled' : 'error', error: error === 'CANCELLED' ? null : error }),
  reset: () => set({ status: 'idle', percent: 0, outputPath: null, error: null }),
}));
