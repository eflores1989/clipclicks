export type SourceKind = 'screen' | 'window';

export interface DesktopSource {
  id: string;
  name: string;
  kind: SourceKind;
  thumbnail: string;
  appIcon?: string;
  displayId?: string;
}

export interface MouseEventRaw {
  t: number;
  x: number;
  y: number;
  type: 'move' | 'down' | 'up' | 'scroll';
  button?: 'left' | 'right' | 'middle';
}

export interface RecordingSource {
  id: string;
  name: string;
  kind: SourceKind;
}

export interface RecordingStartOptions {
  source: RecordingSource;
  /**
   * If true, main also spawns ffmpeg (gdigrab `-draw_mouse 0`) and writes
   * the video directly to the staging folder — no OS cursor in the result.
   * The renderer skips MediaRecorder entirely in that case.
   * Only supported when source.kind === 'screen' (gdigrab needs display bounds).
   */
  useNativeCapture?: boolean;
}

export interface RecordingStartResult {
  recordingId: string;
  startedAtEpoch: number;
  mouseHookActive: boolean;
  /**
   * Bounds of the monitor the events are anchored to, in the same coord
   * space uiohook-napi reports (DIPs on Windows). Mouse events get
   * translated by this origin in main, then filtered to stay inside
   * `(0,0)..(w,h)`. The renderer persists this so the auto-zoom algorithm
   * knows the coord space the events live in (which can differ from the
   * source video's pixel dimensions when display scaling is > 1).
   */
  displayBounds: { x: number; y: number; w: number; h: number } | null;
  /**
   * Set when main spawned an ffmpeg native capture (useNativeCapture=true).
   * Both renderer and main can read it back via `stopRecording()` to align
   * mouseEvents to the video timeline.
   */
  nativeCaptureActive: boolean;
}

export interface RecordingStopResult {
  recordingId: string;
  endedAtEpoch: number;
  durationMs: number;
  mouseEvents: MouseEventRaw[];
  /**
   * Present iff the recording used `useNativeCapture`. The MP4 already lives
   * in staging (no videoBytes round-trip), and `firstFrameOffsetMs` is the
   * delta between `startedAtEpoch` and the first encoded frame — used to
   * shift mouseEvents into the video timeline, same as the rVFC anchor for
   * MediaRecorder.
   */
  nativeCapture?: {
    stagingDir: string;
    videoFile: string;
    firstFrameOffsetMs: number;
  };
}

export interface RecordingSavePayload {
  recordingId: string;
  /**
   * MediaRecorder path: bytes of the recorded webm blob. Omitted in native
   * mode — ffmpeg already wrote the file to staging.
   */
  videoBytes?: Uint8Array;
  /**
   * Native mode only: bytes of a parallel audio-only webm recording. When
   * present, main muxes it into the gdigrab MP4 in staging.
   */
  audioBytes?: Uint8Array;
  mouseEvents: MouseEventRaw[];
  durationMs: number;
  source: RecordingSource;
}

export interface RecordingSaveResult {
  stagingPath: string;
  videoPath: string;
  eventsPath: string;
  metaPath: string;
  sizeBytes: number;
}

export interface RecordingMeta {
  recordingId: string;
  source: RecordingSource;
  startedAtEpoch: number;
  endedAtEpoch: number;
  durationMs: number;
  mouseEventCount: number;
  videoFile: string;
  eventsFile: string;
}
