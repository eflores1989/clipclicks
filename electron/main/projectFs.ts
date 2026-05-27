import { app, dialog, BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile, rm, readdir, stat, rename, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename, extname, resolve as resolvePath } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../src/shared/ipc/channels';
import {
  PROJECT_SCHEMA_VERSION,
  type AudioMedia,
  type Clip,
  type ImageMedia,
  type Project,
  type ProjectAppendClipPayload,
  type ProjectAppendClipResult,
  type ProjectCreatePayload,
  type ProjectCreateProgress,
  type ProjectCreateResult,
  type ProjectCreateStage,
  type ProjectLoadResult,
  type ProjectRef,
  type ProjectSavePayload,
} from '../../src/shared/types/project';
import type { MouseEventRaw, RecordingSource } from '../../src/shared/types/recording';
// MouseEventRaw and RecordingSource are still referenced by the IPC payload types
// and migration logic — keep the import.
import {
  extractAudioPeaks,
  extractAudioToFile,
  generateThumbnails,
  killActiveProcessingFfmpeg,
  probeDurationMs,
  transcodeAudioToM4a,
  transcodeToMp4Allkeyframes,
} from './ffmpeg';
import { generateZooms } from '../../src/shared/lib/generateZooms';

// Set when the user hits Cancel during the "Preparing your project" view.
// createProjectFromStaging checks it at stage boundaries and bails, cleaning
// up the half-built project folder. Reset at the start of each create call.
let processingCancelled = false;

/** Signal cancellation of an in-flight createProjectFromStaging/append. */
export function cancelProcessing(): void {
  processingCancelled = true;
  killActiveProcessingFfmpeg();
}

class ProcessingCancelledError extends Error {
  constructor() { super('CANCELLED'); this.name = 'ProcessingCancelledError'; }
}

export function projectsRoot(): string {
  return join(app.getPath('userData'), 'Projects');
}

function appStatePath(): string {
  return join(app.getPath('userData'), 'app-state.json');
}

interface AppStateFile {
  recentProjects: string[];
  lastOpenedAt: Record<string, number>;
}

async function loadAppState(): Promise<AppStateFile> {
  try {
    const text = await readFile(appStatePath(), 'utf-8');
    const parsed = JSON.parse(text) as Partial<AppStateFile>;
    return {
      recentProjects: parsed.recentProjects ?? [],
      lastOpenedAt: parsed.lastOpenedAt ?? {},
    };
  } catch {
    return { recentProjects: [], lastOpenedAt: {} };
  }
}

async function saveAppState(state: AppStateFile): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFile(appStatePath(), JSON.stringify(state, null, 2));
}

async function touchRecent(projectPath: string): Promise<void> {
  const state = await loadAppState();
  state.recentProjects = [
    projectPath,
    ...state.recentProjects.filter((p) => p !== projectPath),
  ].slice(0, 10);
  state.lastOpenedAt[projectPath] = Date.now();
  await saveAppState(state);
}

function defaultProjectName(now = Date.now()): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `Recording ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

function sanitizeFolderName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, 120) || 'Untitled';
}

function uniquifyPath(basePath: string): string {
  if (!existsSync(basePath)) return basePath;
  const root = basePath.replace(/\.vzproj$/, '');
  let i = 1;
  while (existsSync(`${root}-${i}.vzproj`)) i++;
  return `${root}-${i}.vzproj`;
}

function buildDefaultProject(opts: {
  name: string;
  clip: Clip;
}): Project {
  const now = Date.now();
  const autoZoomConfig = {
    enabled: true,
    defaultScale: 2.0,
    defaultDurationMs: 2500,
    enterMs: 500,
    exitMs: 500,
    enterEasing: 'easeOut' as const,
    exitEasing: 'easeInOut' as const,
    clickGroupingWindowMs: 600,
    minGapBetweenZoomsMs: 400,
    ignoreEdgeClicks: true,
    followCursor: false,
    sensitivity: 0.5,
  };

  return {
    id: randomUUID(),
    schemaVersion: PROJECT_SCHEMA_VERSION,
    name: opts.name,
    createdAt: now,
    updatedAt: now,
    clips: [opts.clip],
    mediaPool: [],
    audioTracks: [],
    audioPool: [],
    imagePool: [],
    timeline: {
      durationMs: opts.clip.outMs - opts.clip.inMs,
      markers: [],
      textEvents: [],
    },
    background: {
      presetId: 'sunset-gradient',
      paddingPct: 6,
      cornerRadiusPx: 16,
      shadow: { enabled: true, blur: 60, opacity: 0.35, y: 20 },
    },
    cursor: {
      // Default style depends on whether the recording captured the system
      // cursor. We can't read that here in buildDefaultProject (it runs when
      // creating a NEW project from a fresh recording), so we look at the
      // clip we're about to attach. `arrow` if we recorded without cursor;
      // `pulse` if we recorded with it (subtle feedback without doubling).
      style: opts.clip.systemCursorCaptured === false ? 'arrow' : 'pulse',
      size: 1.2,
      color: '#ffffff',
      outlineColor: '#111111',
      opacity: 0.9,
      smoothing: 0.25,
      click: {
        enabled: true,
        durationMs: 320,
        pulseColor: '#6c8cff',
        pulseMaxSizePx: 44,
        peakScale: 1.4,
      },
    },
    exportSettings: {
      resolution: '1080p',
      fps: 30,
      format: 'mp4',
      codec: 'h264',
      includeAudio: false,
    },
    autoZoomConfig,
  };
}

/** Migrate a project loaded from disk to the current schema version. */
function migrateProject(raw: unknown): Project {
  const r = raw as { schemaVersion?: number } & Record<string, unknown>;
  if (r.schemaVersion === PROJECT_SCHEMA_VERSION) return r as unknown as Project;
  if (r.schemaVersion === 1) {
    const sourceVideo = r.sourceVideo as {
      filePath: string; width: number; height: number; fps: number; durationMs: number;
      recordedAt: number; capturedSource?: unknown; displayBounds?: unknown;
    };
    const oldTimeline = r.timeline as {
      durationMs: number;
      trim?: { startMs: number; endMs: number };
      speedSegments?: unknown[];
      zoomEvents?: unknown[];
      markers?: unknown[];
    };
    const mouseEvents = (r.mouseEvents as unknown[]) ?? [];
    const inMs = oldTimeline.trim?.startMs ?? 0;
    const outMs = oldTimeline.trim?.endMs ?? sourceVideo.durationMs;
    const clip: Clip = {
      id: randomUUID(),
      filePath: sourceVideo.filePath,
      sourceWidth: sourceVideo.width,
      sourceHeight: sourceVideo.height,
      fps: sourceVideo.fps,
      durationMs: sourceVideo.durationMs,
      recordedAt: sourceVideo.recordedAt,
      capturedSource: sourceVideo.capturedSource as Clip['capturedSource'],
      displayBounds: sourceVideo.displayBounds as Clip['displayBounds'],
      mouseEvents: mouseEvents as Clip['mouseEvents'],
      zoomEvents: (oldTimeline.zoomEvents as Clip['zoomEvents']) ?? [],
      speedSegments: (oldTimeline.speedSegments as Clip['speedSegments']) ?? [],
      inMs,
      outMs,
      timelineStartMs: 0,
    };
    return {
      id: r.id as string,
      schemaVersion: PROJECT_SCHEMA_VERSION,
      name: r.name as string,
      createdAt: r.createdAt as number,
      updatedAt: r.updatedAt as number,
      clips: [clip],
      mediaPool: [],
      audioTracks: [],
      audioPool: [],
      imagePool: [],
      timeline: {
        durationMs: outMs - inMs,
        markers: (oldTimeline.markers as Project['timeline']['markers']) ?? [],
        textEvents: [],
      },
      background: r.background as Project['background'],
      cursor: r.cursor as Project['cursor'],
      exportSettings: r.exportSettings as Project['exportSettings'],
      autoZoomConfig: r.autoZoomConfig as Project['autoZoomConfig'],
      keyboardEvents: r.keyboardEvents as Project['keyboardEvents'],
    };
  }
  throw new Error(`Unsupported project schemaVersion: ${r.schemaVersion}`);
}

function emitProgress(stage: ProjectCreateStage, percent: number): void {
  const payload: ProjectCreateProgress = { stage, percent };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.PROJECT_CREATE_PROGRESS, payload);
  }
}

export async function createProjectFromStaging(
  payload: ProjectCreatePayload,
): Promise<ProjectCreateResult> {
  console.log('[projectFs] createProjectFromStaging start:', payload.stagingPath);
  processingCancelled = false;
  await mkdir(projectsRoot(), { recursive: true });

  const name = payload.projectName ?? defaultProjectName();
  const folder = sanitizeFolderName(name);
  const projectPath = uniquifyPath(join(projectsRoot(), `${folder}.vzproj`));
  console.log('[projectFs] projectPath:', projectPath);

  // Helper: bail out cleanly if the user cancelled. Removes the partial
  // project folder + the staging dir so nothing half-built is left behind.
  const bailIfCancelled = async (): Promise<void> => {
    if (!processingCancelled) return;
    console.log('[projectFs] processing cancelled — cleaning up', projectPath);
    await rm(projectPath, { recursive: true, force: true }).catch(() => {});
    await rm(payload.stagingPath, { recursive: true, force: true }).catch(() => {});
    throw new ProcessingCancelledError();
  };

  await mkdir(join(projectPath, 'assets'), { recursive: true });
  await mkdir(join(projectPath, 'thumbnails'), { recursive: true });
  await mkdir(join(projectPath, 'autosave'), { recursive: true });

  const stagingWebm = join(payload.stagingPath, 'recording.webm');
  const stagingMp4 = join(payload.stagingPath, 'recording.mp4');
  const outputMp4 = join(projectPath, 'assets', 'recording.mp4');

  emitProgress('transcoding', 0);
  if (existsSync(stagingMp4)) {
    // Native ffmpeg capture wrote an all-keyframes MP4 directly. Skip the
    // webm→mp4 transcode and just move the file into the project.
    try {
      await rename(stagingMp4, outputMp4);
    } catch (err) {
      // EXDEV on cross-volume — fall back to copy.
      await copyFile(stagingMp4, outputMp4);
      await rm(stagingMp4, { force: true });
    }
    console.log('[projectFs] using native MP4 from staging (no transcode)');
  } else if (existsSync(stagingWebm)) {
    try {
      await transcodeToMp4Allkeyframes({
        input: stagingWebm,
        output: outputMp4,
        durationMs: payload.videoMeta.durationMs,
        onProgress: (p) => emitProgress('transcoding', p),
      });
    } catch (err) {
      // A SIGKILL from Cancel surfaces as 'CANCELLED' — treat it as such.
      if ((err as Error).message === 'CANCELLED' || processingCancelled) {
        await bailIfCancelled();
      }
      console.error('[projectFs] transcoding failed:', err);
      await rm(projectPath, { recursive: true, force: true });
      throw new Error(`Transcoding failed: ${(err as Error).message}`);
    }
    console.log('[projectFs] transcoding done');
  } else {
    throw new Error(`No recording found in staging at ${payload.stagingPath}`);
  }
  emitProgress('transcoding', 100);
  await bailIfCancelled();

  emitProgress('thumbnails', 0);
  try {
    await generateThumbnails({
      input: outputMp4,
      outputDir: join(projectPath, 'thumbnails'),
      intervalSec: 2,
      width: 160,
      durationMs: payload.videoMeta.durationMs,
      onProgress: (p) => emitProgress('thumbnails', p),
    });
    console.log('[projectFs] thumbnails done');
  } catch (err) {
    // Thumbnail failure is normally non-fatal — but a Cancel kill should still
    // abort the whole create.
    if ((err as Error).message === 'CANCELLED' || processingCancelled) {
      await bailIfCancelled();
    }
    console.warn('[projectFs] thumbnail generation failed (non-fatal):', err);
  }
  emitProgress('thumbnails', 100);
  await bailIfCancelled();

  emitProgress('finalizing', 0);
  // Probe the actual MP4 duration so clip.outMs lines up with what the
  // player can really reach. MediaRecorder's wall-clock can be a few hundred
  // ms longer than the transcoded file's duration — without this the auto-
  // advance threshold sits past the end of the playable range.
  const probedMs = await probeDurationMs(outputMp4);
  const effectiveDurationMs = probedMs ?? payload.videoMeta.durationMs;

  // Coord space for auto-zoom normalization = captured monitor's DIPs if
  // known, otherwise fall back to source pixel dims.
  const coordSpace = payload.displayBounds
    ? { width: payload.displayBounds.w, height: payload.displayBounds.h }
    : { width: payload.videoMeta.width, height: payload.videoMeta.height };

  const defaultAutoZoomConfig = {
    enabled: true,
    defaultScale: 2.0,
    defaultDurationMs: 2500,
    enterMs: 500,
    exitMs: 500,
    enterEasing: 'easeOut' as const,
    exitEasing: 'easeInOut' as const,
    clickGroupingWindowMs: 600,
    minGapBetweenZoomsMs: 400,
    ignoreEdgeClicks: true,
    followCursor: false,
    sensitivity: 0.5,
  };
  const zoomEvents = generateZooms(payload.mouseEvents, defaultAutoZoomConfig, coordSpace);

  const clip: Clip = {
    id: randomUUID(),
    filePath: 'assets/recording.mp4',
    sourceWidth: payload.videoMeta.width,
    sourceHeight: payload.videoMeta.height,
    fps: payload.videoMeta.fps,
    durationMs: effectiveDurationMs,
    recordedAt: Date.now(),
    capturedSource: payload.source,
    displayBounds: payload.displayBounds ?? undefined,
    mouseEvents: payload.mouseEvents,
    zoomEvents,
    speedSegments: [],
    inMs: 0,
    outMs: effectiveDurationMs,
    timelineStartMs: 0,
    systemCursorCaptured: payload.systemCursorCaptured ?? true,
    hasAudio: payload.hasAudio ?? false,
    audioVolume: 1,
    audioMuted: false,
  };
  const project = buildDefaultProject({ name, clip });

  await writeFile(
    join(projectPath, 'project.json'),
    JSON.stringify(project, null, 2),
  );

  try {
    await rm(payload.stagingPath, { recursive: true, force: true });
  } catch (err) {
    console.warn('[projectFs] could not remove staging:', err);
  }

  registerProjectRoot(projectPath);
  await touchRecent(projectPath);
  emitProgress('done', 100);

  return {
    projectPath,
    project,
    videoAssetPath: outputMp4,
  };
}

/**
 * Add a freshly-recorded clip to an existing project. Transcodes the staging
 * WebM into the project's assets/ folder under a unique filename (so it
 * coexists with the original recording.mp4 and any other clips added via
 * this flow), runs auto-zoom over the new mouseEvents, and returns the new
 * Clip object. The renderer is in charge of pushing it onto `project.clips`
 * (autosave then persists the updated project.json).
 *
 * No thumbnails are generated here — the editor's timeline doesn't currently
 * render thumbnails per clip, so it'd be wasted work. We can add it later
 * when/if the timeline grows thumbnail strips.
 */
export async function appendClipFromStaging(
  payload: ProjectAppendClipPayload,
): Promise<ProjectAppendClipResult> {
  console.log('[projectFs] appendClipFromStaging start:', payload.stagingPath, '→', payload.targetProjectPath);
  processingCancelled = false;

  const stagingWebm = join(payload.stagingPath, 'recording.webm');
  const stagingMp4 = join(payload.stagingPath, 'recording.mp4');
  if (!existsSync(payload.targetProjectPath)) {
    throw new Error(`Target project not found at ${payload.targetProjectPath}`);
  }

  const newClipId = randomUUID();
  const newFileName = `recording-${newClipId}.mp4`;
  const outputMp4 = join(payload.targetProjectPath, 'assets', newFileName);

  // Cancel here removes the just-written asset + staging (the project itself
  // already existed, so we only clean up what this append added).
  const bailIfCancelled = async (): Promise<void> => {
    if (!processingCancelled) return;
    await rm(outputMp4, { force: true }).catch(() => {});
    await rm(payload.stagingPath, { recursive: true, force: true }).catch(() => {});
    throw new ProcessingCancelledError();
  };

  emitProgress('transcoding', 0);
  if (existsSync(stagingMp4)) {
    try {
      await rename(stagingMp4, outputMp4);
    } catch {
      await copyFile(stagingMp4, outputMp4);
      await rm(stagingMp4, { force: true });
    }
    console.log('[projectFs] append: using native MP4 from staging');
  } else if (existsSync(stagingWebm)) {
    try {
      await transcodeToMp4Allkeyframes({
        input: stagingWebm,
        output: outputMp4,
        durationMs: payload.videoMeta.durationMs,
        onProgress: (p) => emitProgress('transcoding', p),
      });
    } catch (err) {
      if ((err as Error).message === 'CANCELLED' || processingCancelled) {
        await bailIfCancelled();
      }
      console.error('[projectFs] append transcode failed:', err);
      throw new Error(`Transcoding failed: ${(err as Error).message}`);
    }
  } else {
    throw new Error(`Staging video not found at ${payload.stagingPath} (looked for recording.mp4 and recording.webm)`);
  }
  await bailIfCancelled();
  emitProgress('transcoding', 100);

  emitProgress('finalizing', 0);
  // See the matching block in createProjectFromStaging for why we probe.
  const probedMs = await probeDurationMs(outputMp4);
  const effectiveDurationMs = probedMs ?? payload.videoMeta.durationMs;

  const coordSpace = payload.displayBounds
    ? { width: payload.displayBounds.w, height: payload.displayBounds.h }
    : { width: payload.videoMeta.width, height: payload.videoMeta.height };

  const defaultAutoZoomConfig = {
    enabled: true,
    defaultScale: 2.0,
    defaultDurationMs: 2500,
    enterMs: 500,
    exitMs: 500,
    enterEasing: 'easeOut' as const,
    exitEasing: 'easeInOut' as const,
    clickGroupingWindowMs: 600,
    minGapBetweenZoomsMs: 400,
    ignoreEdgeClicks: true,
    followCursor: false,
    sensitivity: 0.5,
  };
  const zoomEvents = generateZooms(payload.mouseEvents, defaultAutoZoomConfig, coordSpace);

  const clip: Clip = {
    id: newClipId,
    filePath: `assets/${newFileName}`,
    sourceWidth: payload.videoMeta.width,
    sourceHeight: payload.videoMeta.height,
    fps: payload.videoMeta.fps,
    durationMs: effectiveDurationMs,
    recordedAt: Date.now(),
    capturedSource: payload.source,
    displayBounds: payload.displayBounds ?? undefined,
    mouseEvents: payload.mouseEvents,
    zoomEvents,
    speedSegments: [],
    inMs: 0,
    outMs: effectiveDurationMs,
    timelineStartMs: 0,
    systemCursorCaptured: payload.systemCursorCaptured ?? true,
    hasAudio: payload.hasAudio ?? false,
    audioVolume: 1,
    audioMuted: false,
  };

  try {
    await rm(payload.stagingPath, { recursive: true, force: true });
  } catch (err) {
    console.warn('[projectFs] could not remove staging:', err);
  }

  emitProgress('done', 100);
  return { clip, videoAssetPath: outputMp4 };
}

export async function loadProject(projectPath: string): Promise<ProjectLoadResult> {
  const projectFile = join(projectPath, 'project.json');
  if (!existsSync(projectFile)) {
    throw new Error(`Not a Clipclicks Studio project: ${projectPath}`);
  }
  const text = await readFile(projectFile, 'utf-8');
  const raw = JSON.parse(text) as unknown;
  const incoming = (raw as { schemaVersion?: number }).schemaVersion;
  const project = migrateProject(raw);
  if (incoming !== PROJECT_SCHEMA_VERSION) {
    console.log(`[projectFs] migrated project v${incoming} -> v${PROJECT_SCHEMA_VERSION}: ${projectPath}`);
    await writeFile(projectFile, JSON.stringify(project, null, 2));
  }

  // Reconcile each clip's `durationMs` / `outMs` with the file's REAL length.
  // Projects saved before 5C.6.C didn't have a `mediaPool`. Backfill it so
  // every code path can rely on the field being present.
  let mutated = false;
  if (!Array.isArray((project as unknown as { mediaPool?: unknown }).mediaPool)) {
    project.mediaPool = [];
    mutated = true;
  }
  // 5D: audio media pool. Backfill so the audio media-pool tab + timeline can
  // rely on the array existing.
  if (!Array.isArray((project as unknown as { audioPool?: unknown }).audioPool)) {
    project.audioPool = [];
    mutated = true;
  }
  if (!Array.isArray((project as unknown as { audioTracks?: unknown }).audioTracks)) {
    project.audioTracks = [];
    mutated = true;
  }
  // 5E-B: still-image pool. Backfill so the Images tab + timeline can rely on it.
  if (!Array.isArray((project as unknown as { imagePool?: unknown }).imagePool)) {
    project.imagePool = [];
    mutated = true;
  }
  // 5E-A: text overlays array on the timeline.
  if (!Array.isArray((project.timeline as unknown as { textEvents?: unknown }).textEvents)) {
    project.timeline.textEvents = [];
    mutated = true;
  }
  // 5F.2: migrate CursorConfig to the new `style`-based schema. The old shape
  // had `visible` + `clickHighlight` (later we added `color`/`opacity`);
  // the new shape uses `style: 'hidden'|'pulse'|'dot'|'arrow'` + a single
  // `click` animation block. Map old → new conservatively so existing projects
  // keep showing what they showed before (the dot follower → 'dot' style).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cur = project.cursor as any;
  if (!cur || typeof cur.style !== 'string') {
    // For migrated projects, the recording ALWAYS had the OS cursor (5F.2 is
    // when the toggle was introduced). The cleanest default is 'pulse' — only
    // click feedback, no follower stacked on top of the system arrow. Users
    // who want the old "dot" can switch via the panel.
    const clickWasOn = cur?.clickHighlight?.enabled !== false;
    project.cursor = {
      style: clickWasOn ? 'pulse' : 'hidden',
      size: typeof cur?.size === 'number' ? cur.size : 1.2,
      color: typeof cur?.color === 'string' ? cur.color : '#ffffff',
      outlineColor: typeof cur?.outlineColor === 'string' ? cur.outlineColor : '#111111',
      opacity: typeof cur?.opacity === 'number' ? cur.opacity : 0.85,
      smoothing: typeof cur?.smoothing === 'number' ? cur.smoothing : 0.25,
      click: {
        enabled: clickWasOn,
        durationMs: typeof cur?.clickHighlight?.durationMs === 'number'
          ? cur.clickHighlight.durationMs
          : 320,
        pulseColor: typeof cur?.clickHighlight?.color === 'string'
          ? cur.clickHighlight.color
          : '#6c8cff',
        pulseMaxSizePx: typeof cur?.clickHighlight?.sizePx === 'number'
          ? cur.clickHighlight.sizePx
          : 44,
        peakScale: 1.4,
      },
    };
    mutated = true;
  }
  // 5F.3: arrow outline color was added later. Backfill for projects that
  // already migrated to the style-based schema but predate this field.
  if (typeof (project.cursor as { outlineColor?: unknown }).outlineColor !== 'string') {
    project.cursor.outlineColor = '#111111';
    mutated = true;
  }
  // 5F.2: every clip needs a `systemCursorCaptured` flag. Old recordings
  // always included the OS cursor — backfill `true` so the renderer knows
  // whether the video already shows a cursor.
  for (const clip of project.clips) {
    if (typeof clip.systemCursorCaptured !== 'boolean') {
      clip.systemCursorCaptured = true;
      mutated = true;
    }
  }
  for (const clip of project.mediaPool) {
    if (typeof clip.systemCursorCaptured !== 'boolean') {
      clip.systemCursorCaptured = true;
      mutated = true;
    }
  }
  // Older projects (and projects created before we started probing) stored
  // the wall-clock duration from MediaRecorder, which can sit several hundred
  // ms past the actual MP4. That made auto-advance fail because the threshold
  // was unreachable. We re-probe here so the saved data matches reality.
  for (const clip of project.clips) {
    // Image clips have no playback duration (their outMs is the on-screen time,
    // and durationMs is a large cap for the trim edge). Probing a PNG would
    // return nothing/garbage and corrupt the trim — skip them.
    if (clip.kind === 'image') continue;
    const absPath = join(projectPath, clip.filePath);
    if (!existsSync(absPath)) continue;
    const probedMs = await probeDurationMs(absPath);
    if (!probedMs) continue;
    if (Math.abs(probedMs - clip.durationMs) < 50) continue;
    console.log(`[projectFs] reconciling clip ${clip.id.slice(0, 8)}: durationMs ${clip.durationMs} -> ${probedMs}`);
    const wasFullSpan = clip.outMs >= clip.durationMs - 50;
    clip.durationMs = probedMs;
    if (wasFullSpan || clip.outMs > probedMs) {
      clip.outMs = probedMs;
    }
    if (clip.inMs > probedMs) clip.inMs = 0;
    mutated = true;
  }
  if (mutated) {
    // Re-run timeline recomputation since clip durations changed.
    let acc = 0;
    for (const c of project.clips) {
      c.timelineStartMs = acc;
      const speed = c.speedSegments[0]?.speed ?? 1;
      acc += Math.max(0, (c.outMs - c.inMs) / speed);
    }
    project.timeline.durationMs = acc;
    await writeFile(projectFile, JSON.stringify(project, null, 2));
  }

  registerProjectRoot(projectPath);
  await touchRecent(projectPath);

  // Phase 5A still operates on a single active clip; multi-clip switching
  // arrives in 5C. For now we surface the first clip's video path so the rest
  // of the loader contract is unchanged.
  const firstClip = project.clips[0];
  if (!firstClip) throw new Error(`Project has no clips: ${projectPath}`);
  const videoAssetPath = join(projectPath, firstClip.filePath);
  const thumbnailDir = join(projectPath, 'thumbnails');
  let thumbnails: string[] = [];
  try {
    const files = await readdir(thumbnailDir);
    thumbnails = files
      .filter((f) => /^thumb-\d+\.jpg$/.test(f))
      .sort()
      .map((f) => join(thumbnailDir, f));
  } catch {
    // no thumbnails — ok
  }

  return { projectPath, project, videoAssetPath, thumbnails };
}

export async function saveProject(payload: ProjectSavePayload): Promise<void> {
  const updated: Project = { ...payload.project, updatedAt: Date.now() };
  const projectFile = join(payload.projectPath, 'project.json');
  await writeFile(projectFile, JSON.stringify(updated, null, 2));

  const autosaveDir = join(payload.projectPath, 'autosave');
  await mkdir(autosaveDir, { recursive: true });
  try {
    const existing = (await readdir(autosaveDir))
      .filter((f) => /^project-\d+\.json\.bak$/.test(f))
      .sort();
    while (existing.length >= 3) {
      const oldest = existing.shift();
      if (oldest) await rm(join(autosaveDir, oldest), { force: true });
    }
    const backupName = `project-${Date.now()}.json.bak`;
    await writeFile(join(autosaveDir, backupName), JSON.stringify(updated, null, 2));
  } catch (err) {
    console.warn('[projectFs] rotating autosave failed:', err);
  }
}

/** Build a ProjectRef from a .vzproj path by reading its project.json. */
async function buildProjectRef(p: string): Promise<ProjectRef | null> {
  try {
    const text = await readFile(join(p, 'project.json'), 'utf-8');
    const project = JSON.parse(text) as Project;
    const thumbDir = join(p, 'thumbnails');
    let thumbnailRelPath: string | undefined;
    try {
      const files = await readdir(thumbDir);
      const first = files.find((f) => /^thumb-\d+\.jpg$/.test(f));
      if (first) thumbnailRelPath = join(thumbDir, first);
    } catch {
      /* no thumbnails */
    }
    // Show the FULL timeline (video or the longest audio tail), matching what
    // the editor plays — otherwise a 4-min audio over an 18s video reads "0:18".
    const audioEnd = (project.audioTracks ?? []).reduce(
      (m, t) => Math.max(m, t.offsetMs + (t.outMs - t.inMs)), 0);
    return {
      path: p,
      name: project.name,
      updatedAt: project.updatedAt,
      durationMs: Math.max(project.timeline.durationMs, audioEnd),
      thumbnailRelPath,
    };
  } catch {
    return null;
  }
}

export async function listRecentProjects(): Promise<ProjectRef[]> {
  const state = await loadAppState();
  const refs: ProjectRef[] = [];
  const stillValid: string[] = [];

  for (const p of state.recentProjects) {
    const ref = await buildProjectRef(p);
    if (ref) { refs.push(ref); stillValid.push(p); }
  }

  if (stillValid.length !== state.recentProjects.length) {
    state.recentProjects = stillValid;
    await saveAppState(state);
  }

  return refs;
}

/**
 * Scan the default Projects folder for every `.vzproj` and return refs sorted
 * by `updatedAt` desc. Used by the "Open project" browser so the user sees the
 * project NAMES (from project.json) rather than the original folder names.
 */
export async function listAllProjects(): Promise<ProjectRef[]> {
  const root = projectsRoot();
  let entries: string[] = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const refs: ProjectRef[] = [];
  for (const name of entries) {
    if (!name.endsWith('.vzproj')) continue;
    const full = join(root, name);
    const ref = await buildProjectRef(full);
    if (ref) refs.push(ref);
  }
  refs.sort((a, b) => b.updatedAt - a.updatedAt);
  return refs;
}

export async function openProjectDialog(window?: BrowserWindow): Promise<string | null> {
  const result = await dialog.showOpenDialog(window ?? BrowserWindow.getFocusedWindow()!, {
    title: 'Open Clipclicks Studio project',
    defaultPath: projectsRoot(),
    properties: ['openDirectory'],
    buttonLabel: 'Open',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const picked = result.filePaths[0];
  if (!picked.endsWith('.vzproj')) {
    if (existsSync(join(picked, 'project.json'))) return picked;
    throw new Error('Selected folder is not a .vzproj package');
  }
  return picked;
}

/**
 * Permanently remove an asset file from a project's `assets/` folder. Used by
 * "Delete forever" in the Media pool. The relative path must point inside the
 * project — we never traverse outside.
 */
export async function deleteAsset(projectPath: string, relativeFilePath: string): Promise<void> {
  if (relativeFilePath.includes('..')) {
    throw new Error('Refusing to delete: relative path contains ..');
  }
  const abs = resolvePath(join(projectPath, relativeFilePath));
  const projectAbs = resolvePath(projectPath);
  if (!abs.toLowerCase().startsWith(projectAbs.toLowerCase())) {
    throw new Error('Refusing to delete: target is outside the project');
  }
  try {
    await rm(abs, { force: true });
  } catch (err) {
    console.warn('[projectFs] deleteAsset failed:', err);
  }
}

export function ensureProjectsRoot(): void {
  if (!existsSync(projectsRoot())) {
    // best-effort; ignore errors
    mkdir(projectsRoot(), { recursive: true }).catch(() => {});
  }
}

const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus'];

/**
 * Open a file dialog, copy the chosen audio into the project's assets/, probe
 * its duration and compute waveform peaks. Returns the AudioMedia descriptor
 * (the renderer pushes it onto `project.audioPool`). Returns null if cancelled.
 */
export async function importAudio(projectPath: string): Promise<AudioMedia | null> {
  if (!existsSync(projectPath)) throw new Error(`Project not found: ${projectPath}`);
  const res = await dialog.showOpenDialog({
    title: 'Import audio',
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: AUDIO_EXTS }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const src = res.filePaths[0];
  const id = randomUUID();
  const ext = (extname(src).replace('.', '').toLowerCase()) || 'm4a';
  const fileName = `audio-${id}.${ext}`;
  const dest = join(projectPath, 'assets', fileName);
  await mkdir(join(projectPath, 'assets'), { recursive: true });
  await copyFile(src, dest);
  const durationMs = (await probeDurationMs(dest)) ?? 0;
  const peaks = await extractAudioPeaks(dest, 600);
  registerProjectRoot(projectPath);
  return {
    id,
    filePath: `assets/${fileName}`,
    name: basename(src),
    durationMs,
    kind: 'imported',
    peaks,
    addedAt: Date.now(),
  };
}

/**
 * Extract the audio track of a clip's video file into a standalone audio media
 * (added to the pool). Returns null if the clip has no audio. The renderer
 * then places it on the timeline and mutes the clip's embedded audio.
 */
export async function extractClipAudio(projectPath: string, clipRelPath: string): Promise<AudioMedia | null> {
  if (clipRelPath.includes('..')) throw new Error('Refusing: relative path contains ..');
  const videoAbs = join(projectPath, clipRelPath);
  if (!existsSync(videoAbs)) throw new Error(`Clip video not found: ${videoAbs}`);
  const id = randomUUID();
  const fileName = `audio-${id}.m4a`;
  const dest = join(projectPath, 'assets', fileName);
  await mkdir(join(projectPath, 'assets'), { recursive: true });
  try {
    await extractAudioToFile(videoAbs, dest);
  } catch (err) {
    // Most likely no audio stream in the clip.
    console.warn('[projectFs] extractClipAudio failed:', err);
    await rm(dest, { force: true }).catch(() => {});
    return null;
  }
  const durationMs = (await probeDurationMs(dest)) ?? 0;
  const peaks = await extractAudioPeaks(dest, 600);
  registerProjectRoot(projectPath);
  return { id, filePath: `assets/${fileName}`, name: 'Audio del clip', durationMs, kind: 'extracted', peaks, addedAt: Date.now() };
}

/**
 * Persist audio bytes recorded in the renderer (mic capture) into the project
 * and return the AudioMedia descriptor. The renderer hands us a webm/opus
 * blob; we write it, probe duration + peaks.
 */
export async function saveRecordedAudio(
  projectPath: string,
  bytes: Uint8Array,
  kind: AudioMedia['kind'],
  name: string,
): Promise<AudioMedia> {
  if (!existsSync(projectPath)) throw new Error(`Project not found: ${projectPath}`);
  const id = randomUUID();
  await mkdir(join(projectPath, 'assets'), { recursive: true });
  // The renderer hands us a MediaRecorder webm/opus blob whose container has
  // NO duration header — storing it raw makes probeDurationMs return 0 (chip
  // collapses to a sliver, no playback). Transcode to m4a so the duration is
  // written and the file seeks reliably.
  const tmpWebm = join(projectPath, 'assets', `audio-${id}.tmp.webm`);
  const fileName = `audio-${id}.m4a`;
  const dest = join(projectPath, 'assets', fileName);
  await writeFile(tmpWebm, Buffer.from(bytes));
  try {
    await transcodeAudioToM4a(tmpWebm, dest);
  } finally {
    await rm(tmpWebm, { force: true }).catch(() => {});
  }
  const durationMs = (await probeDurationMs(dest)) ?? 0;
  const peaks = await extractAudioPeaks(dest, 600);
  registerProjectRoot(projectPath);
  return { id, filePath: `assets/${fileName}`, name, durationMs, kind, peaks, addedAt: Date.now() };
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'];

/**
 * Import an image file into the project's assets. Dimensions are determined by
 * the RENDERER after it loads the asset (no image-decoding lib needed in main),
 * so we return width/height = 0 here and the renderer fills them in.
 */
export async function importImage(projectPath: string): Promise<ImageMedia | null> {
  if (!existsSync(projectPath)) throw new Error(`Project not found: ${projectPath}`);
  const res = await dialog.showOpenDialog({
    title: 'Importar imagen',
    properties: ['openFile'],
    filters: [{ name: 'Imágenes', extensions: IMAGE_EXTS }],
  });
  if (res.canceled || res.filePaths.length === 0) return null;
  const src = res.filePaths[0];
  const id = randomUUID();
  const ext = (extname(src).replace('.', '').toLowerCase()) || 'png';
  const fileName = `image-${id}.${ext}`;
  await mkdir(join(projectPath, 'assets'), { recursive: true });
  await copyFile(src, join(projectPath, 'assets', fileName));
  registerProjectRoot(projectPath);
  return { id, filePath: `assets/${fileName}`, name: basename(src), width: 0, height: 0, kind: 'imported', addedAt: Date.now() };
}

/**
 * Persist image bytes generated in the renderer (a solid color or gradient
 * painted to a canvas → PNG) into the project's assets.
 */
export async function saveImageAsset(
  projectPath: string,
  bytes: Uint8Array,
  kind: ImageMedia['kind'],
  name: string,
  width: number,
  height: number,
): Promise<ImageMedia> {
  if (!existsSync(projectPath)) throw new Error(`Project not found: ${projectPath}`);
  const id = randomUUID();
  const fileName = `image-${id}.png`;
  await mkdir(join(projectPath, 'assets'), { recursive: true });
  await writeFile(join(projectPath, 'assets', fileName), Buffer.from(bytes));
  registerProjectRoot(projectPath);
  return { id, filePath: `assets/${fileName}`, name, width, height, kind, addedAt: Date.now() };
}

/**
 * Registry of project paths that are currently "open" or recently touched.
 * The `vzasset://` protocol handler consults this so the user can load a
 * `.vzproj` from anywhere on disk — not just under our default
 * `%APPDATA%/.../Projects/` folder. A project gets registered on every
 * `loadProject` and `createProjectFromStaging` call.
 */
const allowedProjectRoots = new Set<string>();

export function registerProjectRoot(absPath: string): void {
  allowedProjectRoots.add(resolvePath(absPath).toLowerCase());
}

export function isPathInsideAllowedRoots(absPath: string): boolean {
  const resolved = resolvePath(absPath).toLowerCase();
  // Built-in roots — projects + staging under the app's userData.
  const builtIns = [
    resolvePath(projectsRoot()).toLowerCase(),
    resolvePath(join(app.getPath('userData'), 'staging')).toLowerCase(),
  ];
  if (builtIns.some((root) => resolved.startsWith(root))) return true;
  // Plus anything inside a project we've explicitly opened.
  for (const root of allowedProjectRoots) {
    if (resolved.startsWith(root)) return true;
  }
  return false;
}
