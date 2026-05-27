export const IPC = {
  APP_VERSION: 'app:version',

  RECORDER_LIST_SOURCES: 'recorder:list-sources',
  RECORDER_SET_PENDING_SOURCE: 'recorder:set-pending-source',
  RECORDER_START: 'recorder:start',
  RECORDER_STOP: 'recorder:stop',
  RECORDER_CANCEL: 'recorder:cancel',
  RECORDER_SAVE: 'recorder:save',
  RECORDER_PAUSE: 'recorder:pause',
  RECORDER_RESUME: 'recorder:resume',

  WINDOW_ENTER_RECORDING: 'window:enter-recording',
  WINDOW_EXIT_RECORDING: 'window:exit-recording',

  STAGING_REVEAL: 'staging:reveal',

  PROJECT_CREATE_FROM_STAGING: 'project:create-from-staging',
  PROJECT_APPEND_CLIP_FROM_STAGING: 'project:append-clip-from-staging',
  PROJECT_CANCEL_PROCESSING: 'project:cancel-processing',
  PROJECT_CREATE_PROGRESS: 'project:create-progress',
  PROJECT_LOAD: 'project:load',
  PROJECT_SAVE: 'project:save',
  PROJECT_LIST_RECENT: 'project:list-recent',
  PROJECT_LIST_ALL: 'project:list-all',
  PROJECT_OPEN_DIALOG: 'project:open-dialog',
  PROJECT_REVEAL: 'project:reveal',
  PROJECT_ASSET_URL: 'project:asset-url',
  PROJECT_DELETE_ASSET: 'project:delete-asset',
  PROJECT_IMPORT_AUDIO: 'project:import-audio',
  PROJECT_SAVE_RECORDED_AUDIO: 'project:save-recorded-audio',
  PROJECT_EXTRACT_CLIP_AUDIO: 'project:extract-clip-audio',
  PROJECT_IMPORT_IMAGE: 'project:import-image',
  PROJECT_SAVE_IMAGE_ASSET: 'project:save-image-asset',

  EXPORT_SAVE_DIALOG: 'export:save-dialog',
  EXPORT_RUN: 'export:run',
  EXPORT_MUX: 'export:mux',
  EXPORT_PROGRESS: 'export:progress',
  EXPORT_CANCEL: 'export:cancel',
  EXPORT_REVEAL_FILE: 'export:reveal-file',
  EXPORT_OPEN_FILE: 'export:open-file',

  UPDATE_AVAILABLE: 'update:available',
  UPDATE_PROGRESS: 'update:progress',
  UPDATE_DOWNLOADED: 'update:downloaded',
  UPDATE_INSTALL: 'update:install',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

export const VZASSET_PROTOCOL = 'vzasset';
