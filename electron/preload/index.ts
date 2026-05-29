import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../../src/shared/ipc/channels';
import type {
  DesktopSource,
  RecordingSavePayload,
  RecordingSaveResult,
  RecordingStartOptions,
  RecordingStartResult,
  RecordingStopResult,
} from '../../src/shared/types/recording';
import type {
  AudioMedia,
  CustomBackground,
  ExportMuxPayload,
  ExportProgressMsg,
  ExportRunPayload,
  ImageMedia,
  ProjectAppendClipPayload,
  ProjectAppendClipResult,
  ProjectCreatePayload,
  ProjectCreateProgress,
  ProjectCreateResult,
  ProjectLoadResult,
  ProjectRef,
  ProjectSavePayload,
} from '../../src/shared/types/project';

type Unsubscribe = () => void;

const api = {
  platform: process.platform,
  appVersion: (): Promise<string> => ipcRenderer.invoke(IPC.APP_VERSION),

  recorder: {
    listSources: (): Promise<DesktopSource[]> => ipcRenderer.invoke(IPC.RECORDER_LIST_SOURCES),
    setPendingSource: (sourceId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.RECORDER_SET_PENDING_SOURCE, sourceId),
    start: (opts: RecordingStartOptions): Promise<RecordingStartResult> =>
      ipcRenderer.invoke(IPC.RECORDER_START, opts),
    stop: (): Promise<RecordingStopResult> => ipcRenderer.invoke(IPC.RECORDER_STOP),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.RECORDER_CANCEL),
    pause: (): Promise<void> => ipcRenderer.invoke(IPC.RECORDER_PAUSE),
    resume: (): Promise<void> => ipcRenderer.invoke(IPC.RECORDER_RESUME),
    save: (payload: RecordingSavePayload): Promise<RecordingSaveResult> =>
      ipcRenderer.invoke(IPC.RECORDER_SAVE, payload),
  },

  window: {
    enterRecording: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_ENTER_RECORDING),
    exitRecording: (): Promise<void> => ipcRenderer.invoke(IPC.WINDOW_EXIT_RECORDING),
  },

  staging: {
    reveal: (path: string): Promise<void> => ipcRenderer.invoke(IPC.STAGING_REVEAL, path),
  },

  project: {
    createFromStaging: (payload: ProjectCreatePayload): Promise<ProjectCreateResult> =>
      ipcRenderer.invoke(IPC.PROJECT_CREATE_FROM_STAGING, payload),
    appendClipFromStaging: (payload: ProjectAppendClipPayload): Promise<ProjectAppendClipResult> =>
      ipcRenderer.invoke(IPC.PROJECT_APPEND_CLIP_FROM_STAGING, payload),
    cancelProcessing: (): Promise<void> => ipcRenderer.invoke(IPC.PROJECT_CANCEL_PROCESSING),
    load: (projectPath: string): Promise<ProjectLoadResult> =>
      ipcRenderer.invoke(IPC.PROJECT_LOAD, projectPath),
    save: (payload: ProjectSavePayload): Promise<void> =>
      ipcRenderer.invoke(IPC.PROJECT_SAVE, payload),
    listRecent: (): Promise<ProjectRef[]> => ipcRenderer.invoke(IPC.PROJECT_LIST_RECENT),
    listAll: (): Promise<ProjectRef[]> => ipcRenderer.invoke(IPC.PROJECT_LIST_ALL),
    openDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.PROJECT_OPEN_DIALOG),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke(IPC.PROJECT_REVEAL, path),
    assetUrl: (absPath: string): Promise<string> =>
      ipcRenderer.invoke(IPC.PROJECT_ASSET_URL, absPath),
    deleteAsset: (projectPath: string, relativeFilePath: string): Promise<void> =>
      ipcRenderer.invoke(IPC.PROJECT_DELETE_ASSET, { projectPath, relativeFilePath }),
    importAudio: (projectPath: string): Promise<AudioMedia | null> =>
      ipcRenderer.invoke(IPC.PROJECT_IMPORT_AUDIO, projectPath),
    saveRecordedAudio: (
      projectPath: string,
      bytes: Uint8Array,
      kind: 'imported' | 'mic' | 'extracted',
      name: string,
    ): Promise<AudioMedia> =>
      ipcRenderer.invoke(IPC.PROJECT_SAVE_RECORDED_AUDIO, { projectPath, bytes, kind, name }),
    extractClipAudio: (projectPath: string, clipRelPath: string): Promise<AudioMedia | null> =>
      ipcRenderer.invoke(IPC.PROJECT_EXTRACT_CLIP_AUDIO, { projectPath, clipRelPath }),
    importImage: (projectPath: string): Promise<ImageMedia | null> =>
      ipcRenderer.invoke(IPC.PROJECT_IMPORT_IMAGE, projectPath),
    saveImageAsset: (
      projectPath: string,
      bytes: Uint8Array,
      kind: 'imported' | 'solid' | 'gradient',
      name: string,
      width: number,
      height: number,
    ): Promise<ImageMedia> =>
      ipcRenderer.invoke(IPC.PROJECT_SAVE_IMAGE_ASSET, { projectPath, bytes, kind, name, width, height }),
    onCreateProgress: (cb: (progress: ProjectCreateProgress) => void): Unsubscribe => {
      const wrapped = (_e: Electron.IpcRendererEvent, p: ProjectCreateProgress): void => cb(p);
      ipcRenderer.on(IPC.PROJECT_CREATE_PROGRESS, wrapped);
      return () => ipcRenderer.removeListener(IPC.PROJECT_CREATE_PROGRESS, wrapped);
    },
  },

  export: {
    saveDialog: (defaultName: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.EXPORT_SAVE_DIALOG, defaultName),
    run: (payload: ExportRunPayload): Promise<void> => ipcRenderer.invoke(IPC.EXPORT_RUN, payload),
    mux: (payload: ExportMuxPayload): Promise<void> => ipcRenderer.invoke(IPC.EXPORT_MUX, payload),
    cancel: (): Promise<void> => ipcRenderer.invoke(IPC.EXPORT_CANCEL),
    revealFile: (filePath: string): Promise<void> => ipcRenderer.invoke(IPC.EXPORT_REVEAL_FILE, filePath),
    openFile: (filePath: string): Promise<void> => ipcRenderer.invoke(IPC.EXPORT_OPEN_FILE, filePath),
    onProgress: (cb: (p: ExportProgressMsg) => void): Unsubscribe => {
      const wrapped = (_e: Electron.IpcRendererEvent, p: ExportProgressMsg): void => cb(p);
      ipcRenderer.on(IPC.EXPORT_PROGRESS, wrapped);
      return () => ipcRenderer.removeListener(IPC.EXPORT_PROGRESS, wrapped);
    },
  },

  customBackgrounds: {
    list: (): Promise<CustomBackground[]> => ipcRenderer.invoke(IPC.CUSTOM_BG_LIST),
    import: (): Promise<CustomBackground | null> => ipcRenderer.invoke(IPC.CUSTOM_BG_IMPORT),
    delete: (id: string): Promise<void> => ipcRenderer.invoke(IPC.CUSTOM_BG_DELETE, id),
  },

  update: {
    install: (): Promise<void> => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
    onAvailable: (cb: (info: { version: string }) => void): Unsubscribe => {
      const w = (_e: Electron.IpcRendererEvent, info: { version: string }): void => cb(info);
      ipcRenderer.on(IPC.UPDATE_AVAILABLE, w);
      return () => ipcRenderer.removeListener(IPC.UPDATE_AVAILABLE, w);
    },
    onProgress: (cb: (p: { percent: number }) => void): Unsubscribe => {
      const w = (_e: Electron.IpcRendererEvent, p: { percent: number }): void => cb(p);
      ipcRenderer.on(IPC.UPDATE_PROGRESS, w);
      return () => ipcRenderer.removeListener(IPC.UPDATE_PROGRESS, w);
    },
    onDownloaded: (cb: (info: { version: string }) => void): Unsubscribe => {
      const w = (_e: Electron.IpcRendererEvent, info: { version: string }): void => cb(info);
      ipcRenderer.on(IPC.UPDATE_DOWNLOADED, w);
      return () => ipcRenderer.removeListener(IPC.UPDATE_DOWNLOADED, w);
    },
  },
};

export type VideoZoomApi = typeof api;

contextBridge.exposeInMainWorld('videoZoom', api);
