import type { MouseEventRaw, RecordingSource } from './recording';

export type { MouseEventRaw };

export type UUID = string;
export type Ms = number;

export type Easing =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'spring';

export const PROJECT_SCHEMA_VERSION = 2 as const;
export type ProjectSchemaVersion = typeof PROJECT_SCHEMA_VERSION;

/**
 * Legacy single-source descriptor. Kept exported because main process code
 * (recorder, ffmpeg) still talks in these terms when capturing a new clip;
 * we wrap it into a Clip when adding it to a Project.
 */
export interface VideoSource {
  filePath: string;
  width: number;
  height: number;
  fps: number;
  durationMs: Ms;
  recordedAt: number;
  capturedSource?: RecordingSource;
  displayBounds?: { x: number; y: number; w: number; h: number };
}

/**
 * A single piece of recorded (or imported) media in a project. The project's
 * `clips: Clip[]` are concatenated linearly in `timelineStartMs` order to form
 * the final video. Each clip carries its own mouse events, zooms and speed
 * segments — auto-zoom is computed against the clip that captured the clicks.
 */
export interface Clip {
  id: UUID;
  /**
   * What this clip plays. 'video' (default / undefined for legacy) is a real
   * recording with its own <video> + mouse/zoom events. 'image' is a still
   * (imported or a generated solid/gradient) shown for a fixed duration — it
   * behaves like a clip on the timeline (trim/reorder/split) but has no source
   * playback time, no audio and no mouse events.
   */
  kind?: 'video' | 'image';
  /** Relative path within the .vzproj folder, e.g. "assets/clip-{id}.mp4". */
  filePath: string;
  /** Pixel dims of the source file. */
  sourceWidth: number;
  sourceHeight: number;
  fps: number;
  /** Full duration of the source file, before trim. */
  durationMs: Ms;
  recordedAt: number;
  capturedSource?: RecordingSource;
  /** Bounds of the captured monitor (DIPs). Drives coord-space for auto-zoom. */
  displayBounds?: { x: number; y: number; w: number; h: number };

  mouseEvents: MouseEventRaw[];
  zoomEvents: ZoomEvent[];
  speedSegments: SpeedSegment[];

  /** Trim: in/out within the source [0..durationMs]. */
  inMs: Ms;
  outMs: Ms;
  /** Position of this clip on the global timeline (auto-computed from order). */
  timelineStartMs: Ms;
  /**
   * True if the recording stream included the system cursor (legacy default).
   * False if it was captured with `cursor: 'never'`, in which case the
   * enhanced cursor renderer is the only visible cursor in the video. Old
   * clips (pre-5F.2) backfill to `true` on load. */
  systemCursorCaptured?: boolean;
  /**
   * Crop / reframe rectangle in NORMALIZED source coordinates (0..1). When set,
   * only this sub-region of the source frame is shown (e.g. to cut the Windows
   * taskbar off the bottom). Undefined = full frame. Stored normalized so it's
   * resolution-agnostic. Click-zoom composes on top of the crop.
   */
  crop?: { x: number; y: number; w: number; h: number };
  /** True if the clip's video file has an embedded audio track (recorded with
   *  mic/system audio). */
  hasAudio?: boolean;
  /** Gain for the clip's embedded audio, 0..2 (default 1). */
  audioVolume?: number;
  /** Mute the clip's embedded audio (set when its audio is extracted to a track). */
  audioMuted?: boolean;
  /** Transition overlaid on this clip's START edge (fade/darken-in, etc.). */
  transitionIn?: Transition;
  /** Transition overlaid on this clip's END edge (fade/darken-out, etc.). */
  transitionOut?: Transition;
}

/**
 * A transition is an effect overlaid on a clip's edge (in/out) — NOT a crossfade
 * between two video textures. 'fade' ramps the clip's own alpha (reveals the
 * background); 'darken'/'flash' ramp a black/white overlay; 'pixelate' ramps a
 * pixelation filter. Pair clip-A `transitionOut` + clip-B `transitionIn` of the
 * same kind to get a "between clips" look (e.g. dip-to-black).
 */
export type TransitionKind = 'fade' | 'darken' | 'flash' | 'pixelate';

export interface Transition {
  kind: TransitionKind;
  durationMs: Ms;
}

/**
 * Audio media available in the pool — an imported file, a mic recording made
 * in the editor, or audio extracted from a clip. Lives in `Project.audioPool`.
 * Placing one on the timeline creates an `AudioTrack` that references it.
 */
export interface AudioMedia {
  id: UUID;
  /** Relative path within the .vzproj, e.g. "assets/audio-{id}.m4a". */
  filePath: string;
  name: string;
  durationMs: Ms;
  kind: 'imported' | 'mic' | 'extracted';
  /** Downsampled waveform peaks (abs amplitude 0..1) for timeline display. */
  peaks?: number[];
  addedAt: number;
}

/**
 * A still image available in the pool — imported, or a generated solid/gradient
 * swatch. Lives in `Project.imagePool`. Adding one to the timeline creates a
 * Clip with `kind: 'image'` whose `filePath` points at this asset.
 */
export interface ImageMedia {
  id: UUID;
  /** Relative path within the .vzproj, e.g. "assets/image-{id}.png". */
  filePath: string;
  name: string;
  width: number;
  height: number;
  kind: 'imported' | 'solid' | 'gradient';
  addedAt: number;
}

/**
 * An audio clip placed on the timeline. References an `AudioMedia` by id and
 * carries timeline placement + per-instance edits (trim, gain, fades). Plays
 * over the video; independent of any clip's embedded audio.
 */
export interface AudioTrack {
  id: UUID;
  /** → AudioMedia.id in `Project.audioPool`. */
  mediaId: UUID;
  /** Start position on the GLOBAL timeline. */
  offsetMs: Ms;
  /** Trim within the source media [0..media.durationMs]. */
  inMs: Ms;
  outMs: Ms;
  /** Linear gain, 0..2 (1 = unity). */
  volume: number;
  muted: boolean;
  fadeInMs: Ms;
  fadeOutMs: Ms;
}

export interface KeyEventRaw {
  t: Ms;
  type: 'keydown' | 'keyup';
  key: string;
}

export interface Cut {
  id: UUID;
  startMs: Ms;
  endMs: Ms;
}

export interface Marker {
  id: UUID;
  t: Ms;
  label?: string;
  color?: string;
}

export interface SpeedSegment {
  id: UUID;
  startMs: Ms;
  endMs: Ms;
  speed: number;
  easing?: Easing;
}

export interface ZoomTarget {
  mode: 'point' | 'region' | 'cursor';
  nx?: number;
  ny?: number;
  region?: { nx: number; ny: number; nw: number; nh: number };
}

export interface ZoomEvent {
  id: UUID;
  source: 'auto' | 'manual';
  startMs: Ms;
  endMs: Ms;
  enterDurationMs: Ms;
  holdDurationMs: Ms;
  exitDurationMs: Ms;
  enterEasing: Easing;
  exitEasing: Easing;
  scale: number;
  target: ZoomTarget;
  cursorBehavior: 'follow' | 'static' | 'smoothed';
  smoothing?: number;
  triggerEventIds?: number[];
  locked?: boolean;
}

/**
 * Global timeline metadata. Per-clip data (trim, speed, zooms) lives on Clip;
 * what's here is information that spans the whole composed timeline.
 */
export interface Timeline {
  /** Sum of clip out-in (adjusted for speed in 5D) across all clips. */
  durationMs: Ms;
  markers: Marker[];
  textEvents: TextEvent[];
}

/** The three text "blocks" offered in the media pool. Drives the defaults. */
export type TextPreset = 'title' | 'subtitle' | 'paragraph';
/** Entrance animation: plain appear, fade-in, or typewriter (chars typed out). */
export type TextEnterAnim = 'none' | 'fade' | 'type';
export type TextExitAnim = 'none' | 'fade';

/**
 * A text overlay on the GLOBAL timeline (lives in `Timeline.textEvents`, not on
 * a clip — it composites on top of the whole timeline and survives clip cuts,
 * like an audio track). Position + size are normalized to the output canvas so
 * they're resolution-independent (preview and export agree).
 */
export interface TextEvent {
  id: UUID;
  startMs: Ms;
  endMs: Ms;
  text: string;
  /** Center of the text box in normalized canvas coords (0..1). */
  nx: number;
  ny: number;
  /** Font size as a fraction of canvas HEIGHT (e.g. 0.08 = 8% of height). */
  fontScale: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  color: string;
  /** Multi-line justification within the box. */
  align: 'left' | 'center' | 'right';
  /** Soft drop shadow for legibility over busy backgrounds. */
  shadow: boolean;
  enterAnim: TextEnterAnim;
  exitAnim: TextExitAnim;
  enterDurationMs: Ms;
  exitDurationMs: Ms;
  preset: TextPreset;
}

export interface BackgroundShadow {
  enabled: boolean;
  blur: number;
  opacity: number;
  y: number;
}

export interface BackgroundConfig {
  /**
   * Either a built-in preset id from `BACKGROUND_PRESETS`, or the id of an
   * imported custom background. Custom ids are prefixed with `custom:` (the
   * suffix matches `CustomBackground.id` stored in the app config).
   */
  presetId: string;
  paddingPct: number;
  cornerRadiusPx: number;
  shadow: BackgroundShadow;
  customColor?: string;
  customGradient?: { from: string; to: string; angleDeg: number };
}

/**
 * A user-imported background (image or short video) persisted app-wide under
 * `%APPDATA%/VideoZoom/backgrounds/`. The renderer references them by `id`
 * (set on `BackgroundConfig.presetId` as `custom:<id>`).
 */
export interface CustomBackground {
  id: string;
  name: string;
  /** Absolute path on disk inside the app's `backgrounds/` directory. */
  filePath: string;
  /** 'image' = static (png/jpg/webp); 'video' = animated (mp4/webm). */
  kind: 'image' | 'video';
  /** ms since epoch — used to sort the library newest-first. */
  addedAt: number;
}

/**
 * Visual style for the enhanced cursor layer.
 *   - 'hidden': nothing rendered; the video's own cursor (if any) shows through.
 *   - 'pulse':  no persistent follower; only an animated ring at each click.
 *               Best when the recording already has the system cursor and you
 *               want subtle click feedback without doubling the cursor.
 *   - 'dot':    filled circle that follows the mouse position. Scales up on
 *               click. Pairs well with recordings made WITHOUT the system
 *               cursor (otherwise you'd see the dot following the OS arrow).
 *   - 'arrow':  Windows-style pointer shape that follows the mouse position
 *               and scales up on click. Designed to be used with
 *               `Clip.systemCursorCaptured = false`.
 */
export type CursorStyle = 'hidden' | 'pulse' | 'dot' | 'arrow';

export interface CursorClickAnimation {
  enabled: boolean;
  /** Total animation length. ~300-400ms feels natural. */
  durationMs: number;
  /** For 'pulse' style: ring color (hex). Other styles ignore this. */
  pulseColor: string;
  /** For 'pulse' style: ring max radius at peak. */
  pulseMaxSizePx: number;
  /** For 'dot' / 'arrow' styles: scale multiplier at peak (1.35 = 35% bigger). */
  peakScale: number;
}

export interface CursorConfig {
  /** Which visual style to render — drives the renderer branch in PixiScene. */
  style: CursorStyle;
  /** Base size multiplier (applies to 'dot' and 'arrow'; 'pulse' uses pulseMaxSizePx). */
  size: number;
  /** Main color (hex). Used as dot fill, arrow fill, or — for 'pulse' — fallback. */
  color: string;
  /** Outline color (hex) for the 'arrow' style. Ignored by other styles. */
  outlineColor: string;
  /** Base opacity (0-1) for dot/arrow body. */
  opacity: number;
  /** LERP alpha per frame for position smoothing (0=snap, 1=very smooth). */
  smoothing: number;
  click: CursorClickAnimation;
}

export interface AutoZoomConfig {
  enabled: boolean;
  defaultScale: number;
  defaultDurationMs: Ms;
  enterMs: Ms;
  exitMs: Ms;
  enterEasing: Easing;
  exitEasing: Easing;
  clickGroupingWindowMs: Ms;
  minGapBetweenZoomsMs: Ms;
  ignoreEdgeClicks: boolean;
  followCursor: boolean;
  sensitivity: number;
}

export type ExportResolution = '720p' | '1080p' | '1440p' | '4k' | 'source';
export type ExportFps = 30 | 60;
export type ExportFormat = 'mp4' | 'webm' | 'gif';
export type ExportCodec = 'h264' | 'hevc' | 'vp9';

export interface ExportSettings {
  resolution: ExportResolution;
  fps: ExportFps;
  format: ExportFormat;
  bitrateMbps?: number;
  codec: ExportCodec;
  includeAudio: boolean;
}

export interface Project {
  id: UUID;
  schemaVersion: ProjectSchemaVersion;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Clips currently on the timeline, in order. */
  clips: Clip[];
  /**
   * Clips removed from the timeline but kept available for re-insertion.
   * Deleting from timeline moves a clip here (preserving its zoomEvents,
   * mouseEvents, speedSegments, trim — everything). "Delete forever" from
   * the pool actually drops the asset file and the entry.
   */
  mediaPool: Clip[];
  /** Audio clips placed on the timeline (imports, mic recordings, extracted). */
  audioTracks: AudioTrack[];
  /** Audio media available to drop on the timeline (the "Audio" media-pool tab). */
  audioPool: AudioMedia[];
  /** Still images available to drop on the video track (the "Images" media-pool tab). */
  imagePool: ImageMedia[];
  timeline: Timeline;
  background: BackgroundConfig;
  cursor: CursorConfig;
  exportSettings: ExportSettings;
  autoZoomConfig: AutoZoomConfig;
  keyboardEvents?: KeyEventRaw[];
}

export interface ProjectRef {
  path: string;
  name: string;
  updatedAt: number;
  durationMs: Ms;
  thumbnailRelPath?: string;
}

export interface ProjectCreatePayload {
  stagingPath: string;
  videoMeta: { width: number; height: number; fps: number; durationMs: Ms };
  mouseEvents: MouseEventRaw[];
  source: RecordingSource;
  projectName?: string;
  /**
   * Bounds of the captured monitor in event coordinate space (typically DIPs).
   * When present, used as the normalization space for the auto-zoom algorithm
   * — important when display scaling makes pixel dims (sourceVideo.width/height)
   * differ from the DIP space the events were recorded in.
   */
  displayBounds?: { x: number; y: number; w: number; h: number } | null;
  /** True if the recording stream included the OS cursor (default true). */
  systemCursorCaptured?: boolean;
  /** True if the recording captured audio (mic/system) into the clip. */
  hasAudio?: boolean;
}

export interface ProjectCreateResult {
  projectPath: string;
  project: Project;
  videoAssetPath: string;
}

export interface ProjectAppendClipPayload {
  /** Absolute path to the .vzproj this new clip should be added to. */
  targetProjectPath: string;
  /** Staging folder with the new recording, will be removed after success. */
  stagingPath: string;
  videoMeta: { width: number; height: number; fps: number; durationMs: Ms };
  mouseEvents: MouseEventRaw[];
  source: RecordingSource;
  displayBounds?: { x: number; y: number; w: number; h: number } | null;
  /** True if the recording stream included the OS cursor (default true). */
  systemCursorCaptured?: boolean;
  /** True if the recording captured audio (mic/system) into the clip. */
  hasAudio?: boolean;
}

export interface ProjectAppendClipResult {
  clip: Clip;
  /** Absolute path of the transcoded MP4 inside the target project. */
  videoAssetPath: string;
}

export type ProjectCreateStage = 'transcoding' | 'thumbnails' | 'finalizing' | 'done';

export interface ProjectCreateProgress {
  stage: ProjectCreateStage;
  percent: number;
}

export interface ProjectLoadResult {
  projectPath: string;
  project: Project;
  videoAssetPath: string;
  thumbnails: string[];
}

export interface ProjectSavePayload {
  projectPath: string;
  project: Project;
}

/** Payload for the final export transcode (renderer → main). `bytes` are the
 *  captured WebM (composed timeline + audio mix) at the target res/fps. */
export interface ExportRunPayload {
  bytes: Uint8Array;
  outputPath: string;
  durationMs: Ms;
  fps: ExportFps;
  crf: number;
  audioBitrateKbps: number;
  includeAudio: boolean;
}

/** Deterministic export mux (renderer → main): a video-only MP4 (from the
 *  WebCodecs + mp4-muxer path) + the offline audio WAV → final MP4 (video copied,
 *  audio to AAC). */
export interface ExportMuxPayload {
  mp4Bytes: Uint8Array;
  wavBytes: Uint8Array | null;
  outputPath: string;
  audioBitrateKbps: number;
}

/** ffmpeg transcode progress (main → renderer). */
export interface ExportProgressMsg {
  percent: number;
}
