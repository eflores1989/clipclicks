import { desktopCapturer, app, screen } from 'electron';
import { mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { muxAudioIntoVideo } from './ffmpeg';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FFMPEG_PATH: string = ((): string => {
  const mod = require('ffmpeg-static') as unknown;
  const raw = typeof mod === 'string'
    ? mod
    : (mod && typeof (mod as { default?: unknown }).default === 'string'
        ? (mod as { default: string }).default
        : null);
  if (!raw) throw new Error('ffmpeg-static did not return a string path');
  return raw.replace('app.asar', 'app.asar.unpacked');
})();
import type {
  DesktopSource,
  MouseEventRaw,
  RecordingMeta,
  RecordingSavePayload,
  RecordingSaveResult,
  RecordingStartOptions,
  RecordingStartResult,
  RecordingStopResult,
  SourceKind,
} from '../../src/shared/types/recording';

type UiohookModule = {
  uIOhook: {
    on(event: 'mousemove' | 'mousedown' | 'mouseup' | 'wheel', cb: (e: UiohookEvent) => void): void;
    removeAllListeners(): void;
    start(): void;
    stop(): void;
  };
};

interface UiohookEvent {
  type: number;
  time: number;
  x: number;
  y: number;
  button?: number;
  rotation?: number;
}

let uiohook: UiohookModule['uIOhook'] | null = null;
let uiohookLoaded = false;

function tryLoadUiohook(): boolean {
  if (uiohookLoaded) return uiohook !== null;
  uiohookLoaded = true;
  try {
    const mod = require('uiohook-napi') as UiohookModule;
    uiohook = mod.uIOhook;
    return true;
  } catch (err) {
    console.warn('[recorder] uiohook-napi failed to load:', err);
    uiohook = null;
    return false;
  }
}

interface ActiveRecording {
  recordingId: string;
  source: { id: string; name: string; kind: SourceKind };
  startedAtEpoch: number;
  events: MouseEventRaw[];
  pausedAt: number | null;
  pausedTotalMs: number;
  hookActive: boolean;
  /**
   * Bounds of the captured monitor in global screen-space (DIPs). uiohook-napi
   * reports cursor positions in global coords; we subtract the origin to get
   * coords local to the captured region (0..size.w, 0..size.h), and drop any
   * event that lands outside that region — those happened on a *different*
   * monitor and aren't visible in the recording.
   */
  displayBounds: { x: number; y: number; w: number; h: number } | null;
}

let current: ActiveRecording | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Native video capture via ffmpeg gdigrab.
//
// The renderer's MediaRecorder path always includes the OS cursor (Chromium's
// `cursor: 'never'` constraint is not honoured by Electron's desktopCapturer
// pipeline). To genuinely exclude the cursor we spawn ffmpeg with
// `-f gdigrab -draw_mouse 0`, which composes the desktop frames without the
// cursor overlay. The output goes straight to MP4 with all-keyframes so
// `createProjectFromStaging` can skip the usual webm→mp4 transcode.
// ─────────────────────────────────────────────────────────────────────────────

interface NativeCapture {
  process: ChildProcess;
  /** Absolute path to the file ffmpeg is writing. */
  outputPath: string;
  /** Resolves with the wall-clock epoch when ffmpeg reported its first frame. */
  firstFramePromise: Promise<number>;
  resolveFirstFrame: (epoch: number) => void;
  firstFrameSeen: boolean;
  stderrTail: string;
}

let nativeCapture: NativeCapture | null = null;

export function isNativeCaptureActive(): boolean {
  return nativeCapture !== null;
}

/**
 * Spawn ffmpeg + gdigrab to capture the given display region without the
 * cursor overlay. The output lands at `outputPath` (created by the caller).
 *
 * @returns A handle whose `firstFramePromise` resolves when ffmpeg reports
 * its first encoded frame on stderr (used to align mouseEvents to video
 * time, same purpose as `requestVideoFrameCallback` in the MediaRecorder
 * path).
 */
export function startNativeCapture(args: {
  outputPath: string;
  displayBounds: { x: number; y: number; w: number; h: number };
  fps: number;
}): { firstFramePromise: Promise<number> } {
  if (nativeCapture) throw new Error('Native capture already in progress');

  // gdigrab uses screen-space coordinates. displayBounds.x/y are already in
  // virtual screen-space (the lookupDisplayBounds() helper handles that).
  const ffArgs = [
    '-y',
    '-f', 'gdigrab',
    '-framerate', String(args.fps),
    '-draw_mouse', '0',
    '-offset_x', String(args.displayBounds.x),
    '-offset_y', String(args.displayBounds.y),
    '-video_size', `${args.displayBounds.w}x${args.displayBounds.h}`,
    '-i', 'desktop',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-g', '1',          // all-keyframes — skips post-transcode for editor seek
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    args.outputPath,
  ];

  console.log('[recorder/native] spawning ffmpeg', ffArgs.join(' '));
  const proc = spawn(FFMPEG_PATH, ffArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let resolveFirstFrame!: (epoch: number) => void;
  const firstFramePromise = new Promise<number>((resolve) => {
    resolveFirstFrame = resolve;
  });

  const cap: NativeCapture = {
    process: proc,
    outputPath: args.outputPath,
    firstFramePromise,
    resolveFirstFrame,
    firstFrameSeen: false,
    stderrTail: '',
  };

  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    cap.stderrTail = (cap.stderrTail + text).slice(-4000);
    // ffmpeg writes `frame=    1 fps=...` on stderr as soon as it has encoded
    // the first frame. That's the most accurate "video time = 0" anchor we
    // can read without parsing the file. We stamp the wall clock NOW and
    // resolve the promise so the renderer can shift mouseEvents accordingly.
    if (!cap.firstFrameSeen && /frame=\s*\d/.test(text)) {
      cap.firstFrameSeen = true;
      const epoch = Date.now();
      console.log(`[recorder/native] first frame at epoch ${epoch}`);
      cap.resolveFirstFrame(epoch);
    }
  });

  proc.on('error', (err) => {
    console.error('[recorder/native] ffmpeg spawn error:', err);
  });

  // Safety: if ffmpeg dies before producing a frame, unblock the promise so
  // stop() can return rather than hanging forever.
  proc.on('exit', (code, signal) => {
    console.log(`[recorder/native] ffmpeg exited code=${code} signal=${signal}`);
    if (!cap.firstFrameSeen) {
      console.warn('[recorder/native] ffmpeg exited before first frame; stderr tail:', cap.stderrTail);
      cap.resolveFirstFrame(Date.now());
    }
  });

  nativeCapture = cap;
  return { firstFramePromise };
}

/**
 * Gracefully stop the ffmpeg capture by writing 'q' to its stdin (ffmpeg's
 * documented quit signal — flushes buffers + closes the output cleanly,
 * unlike SIGTERM which can leave a truncated MP4).
 */
export async function stopNativeCapture(): Promise<{ outputPath: string; firstFrameEpoch: number }> {
  if (!nativeCapture) throw new Error('No native capture in progress');
  const cap = nativeCapture;

  try {
    cap.process.stdin?.write('q');
    cap.process.stdin?.end();
  } catch (err) {
    console.warn('[recorder/native] could not signal ffmpeg via stdin:', err);
  }

  await new Promise<void>((resolve) => {
    if (cap.process.exitCode !== null) { resolve(); return; }
    cap.process.once('exit', () => resolve());
    // Fallback: if ffmpeg ignores 'q' for some reason, kill after a few
    // seconds. The output may be slightly truncated but won't hang the UI.
    setTimeout(() => {
      if (cap.process.exitCode === null) {
        console.warn('[recorder/native] ffmpeg did not exit on q, sending SIGKILL');
        try { cap.process.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, 4000);
  });

  const firstFrameEpoch = await cap.firstFramePromise;
  nativeCapture = null;
  return { outputPath: cap.outputPath, firstFrameEpoch };
}

export function cancelNativeCapture(): void {
  if (!nativeCapture) return;
  try { nativeCapture.process.kill('SIGKILL'); } catch { /* ignore */ }
  // Leave the file in staging — caller will rm the dir.
  nativeCapture = null;
}

const buttonMap: Record<number, MouseEventRaw['button']> = {
  1: 'left',
  2: 'right',
  3: 'middle',
};

function pushEvent(type: MouseEventRaw['type'], e: UiohookEvent): void {
  if (!current || current.pausedAt !== null) return;
  const t = Date.now() - current.startedAtEpoch - current.pausedTotalMs;
  if (t < 0) return;

  const bounds = current.displayBounds;
  let x = e.x;
  let y = e.y;
  if (bounds) {
    x -= bounds.x;
    y -= bounds.y;
    // Drop events outside the captured monitor — they happened on a different
    // display and are not visible in the recorded video.
    if (x < 0 || y < 0 || x >= bounds.w || y >= bounds.h) return;
  }

  const ev: MouseEventRaw = { t, x, y, type };
  if (e.button !== undefined && buttonMap[e.button]) {
    ev.button = buttonMap[e.button];
  }
  current.events.push(ev);
}

function attachHookListeners(): void {
  if (!uiohook) return;
  uiohook.on('mousemove', (e) => pushEvent('move', e));
  uiohook.on('mousedown', (e) => pushEvent('down', e));
  uiohook.on('mouseup', (e) => pushEvent('up', e));
  uiohook.on('wheel', (e) => pushEvent('scroll', e));
}

function detachHookListeners(): void {
  if (!uiohook) return;
  uiohook.removeAllListeners();
}

// ─────────────────────────────────────────────────────────────────────────────
// setDisplayMediaRequestHandler: the renderer now calls getDisplayMedia() so
// it can pass the `cursor: 'never'` constraint. That API is normally gated by
// a system picker; we override it by registering this handler globally and
// feeding it whichever source the user picked in our own SourcePicker.
// `setPendingCaptureSource(id)` is called by the renderer right before
// getDisplayMedia(); the handler consumes and clears the entry.
// ─────────────────────────────────────────────────────────────────────────────
let pendingCaptureSourceId: string | null = null;

export async function setPendingCaptureSource(sourceId: string): Promise<void> {
  pendingCaptureSourceId = sourceId;
}

export async function resolvePendingDisplayMediaSource(): Promise<Electron.DesktopCapturerSource | null> {
  if (!pendingCaptureSourceId) return null;
  const id = pendingCaptureSourceId;
  pendingCaptureSourceId = null;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
    });
    return sources.find((s) => s.id === id) ?? null;
  } catch (err) {
    console.warn('[recorder] could not resolve pending display media source:', err);
    return null;
  }
}

export async function listSources(): Promise<DesktopSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });

  return sources.map((s) => {
    const kind: SourceKind = s.id.startsWith('screen:') ? 'screen' : 'window';
    return {
      id: s.id,
      name: s.name,
      kind,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : undefined,
      displayId: s.display_id || undefined,
    };
  });
}

async function lookupDisplayBounds(opts: RecordingStartOptions): Promise<{ x: number; y: number; w: number; h: number } | null> {
  // For screen captures we know which Display matches the picked source via
  // its display_id. We then read its bounds in the global screen-space.
  // Window captures don't expose their on-screen position in Electron's API,
  // so we fall back to the nearest cursor display — usually correct since the
  // user is interacting with the window they just chose.
  if (opts.source.kind === 'screen') {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const match = sources.find((s) => s.id === opts.source.id);
      if (match && match.display_id) {
        const display = screen.getAllDisplays().find((d) => String(d.id) === match.display_id);
        if (display) {
          const b = display.bounds;
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        }
      }
    } catch (err) {
      console.warn('[recorder] could not look up display bounds:', err);
    }
  }
  // Window capture: anchor to the display under the cursor at start time.
  // Imperfect but the alternative is to leave bounds null (no filtering),
  // which lets clicks from other monitors leak in.
  const cursor = screen.getCursorScreenPoint();
  const nearest = screen.getDisplayNearestPoint(cursor);
  const b = nearest.bounds;
  return { x: b.x, y: b.y, w: b.width, h: b.height };
}

export async function startRecording(opts: RecordingStartOptions): Promise<RecordingStartResult> {
  if (current) throw new Error('Recording already in progress');
  const hookAvailable = tryLoadUiohook();
  const recordingId = randomUUID();
  const displayBounds = await lookupDisplayBounds(opts);
  console.log('[recorder] start. source:', opts.source.kind, opts.source.id, 'bounds:', displayBounds);

  // If the caller asked for native capture, we need the bounds AND a screen
  // source — gdigrab only knows how to capture by display offset/size.
  const wantNative = opts.useNativeCapture === true;
  const canDoNative = wantNative && opts.source.kind === 'screen' && displayBounds !== null;
  if (wantNative && !canDoNative) {
    console.warn('[recorder] native capture requested but unavailable (kind=' + opts.source.kind + ', bounds=' + (displayBounds ? 'ok' : 'null') + '); falling back to MediaRecorder path.');
  }

  current = {
    recordingId,
    source: opts.source,
    startedAtEpoch: Date.now(),
    events: [],
    pausedAt: null,
    pausedTotalMs: 0,
    hookActive: hookAvailable,
    displayBounds,
  };

  // Start uiohook FIRST so mouseEvents begin streaming the moment after
  // `startedAtEpoch` — they get aligned against the first encoded frame
  // (which arrives later) when we shift by `firstFrameOffsetMs` at save.
  if (hookAvailable && uiohook) {
    attachHookListeners();
    try {
      uiohook.start();
    } catch (err) {
      console.warn('[recorder] uiohook start failed:', err);
      current.hookActive = false;
      detachHookListeners();
    }
  }

  // Kick off the native capture if requested. The staging directory has to
  // exist before ffmpeg starts writing.
  let nativeActive = false;
  if (canDoNative && displayBounds) {
    const stagingDir = join(stagingRoot(), recordingId);
    try {
      await mkdir(stagingDir, { recursive: true });
      const outputPath = join(stagingDir, 'recording.mp4');
      const fps = 30;
      startNativeCapture({ outputPath, displayBounds, fps });
      nativeActive = true;
    } catch (err) {
      console.error('[recorder] could not start native capture, falling back:', err);
    }
  }

  return {
    recordingId,
    startedAtEpoch: current.startedAtEpoch,
    mouseHookActive: current.hookActive,
    displayBounds: current.displayBounds,
    nativeCaptureActive: nativeActive,
  };
}

export function pauseRecording(): void {
  if (!current) return;
  if (current.pausedAt !== null) return;
  current.pausedAt = Date.now();
}

export function resumeRecording(): void {
  if (!current) return;
  if (current.pausedAt === null) return;
  current.pausedTotalMs += Date.now() - current.pausedAt;
  current.pausedAt = null;
}

export async function stopRecording(): Promise<RecordingStopResult> {
  if (!current) throw new Error('No active recording');
  if (current.pausedAt !== null) {
    current.pausedTotalMs += Date.now() - current.pausedAt;
    current.pausedAt = null;
  }
  if (current.hookActive && uiohook) {
    try {
      uiohook.stop();
    } catch (err) {
      console.warn('[recorder] uiohook stop failed:', err);
    }
    detachHookListeners();
  }

  // Stop the native ffmpeg process if it was started. We do this AFTER
  // stopping uiohook so any final mouse motion still gets captured against
  // the trailing frames of the video.
  let nativeMeta: RecordingStopResult['nativeCapture'];
  if (isNativeCaptureActive()) {
    try {
      const stopped = await stopNativeCapture();
      const offset = Math.max(0, stopped.firstFrameEpoch - current.startedAtEpoch);
      const stagingDir = join(stagingRoot(), current.recordingId);
      const videoFile = 'recording.mp4';
      nativeMeta = {
        stagingDir,
        videoFile,
        firstFrameOffsetMs: offset,
      };
      console.log(`[recorder] native capture stopped. file=${stopped.outputPath} offset=${offset}ms`);
    } catch (err) {
      console.error('[recorder] stopNativeCapture failed:', err);
    }
  }

  const endedAtEpoch = Date.now();
  const durationMs = endedAtEpoch - current.startedAtEpoch - current.pausedTotalMs;
  const result: RecordingStopResult = {
    recordingId: current.recordingId,
    endedAtEpoch,
    durationMs,
    mouseEvents: current.events,
    nativeCapture: nativeMeta,
  };
  current = null;
  return result;
}

export function cancelRecording(): void {
  if (!current) return;
  if (current.hookActive && uiohook) {
    try {
      uiohook.stop();
    } catch {
      // ignore
    }
    detachHookListeners();
  }
  if (isNativeCaptureActive()) cancelNativeCapture();
  current = null;
}

function stagingRoot(): string {
  return join(app.getPath('userData'), 'staging');
}

export async function saveRecording(payload: RecordingSavePayload): Promise<RecordingSaveResult> {
  const dir = join(stagingRoot(), payload.recordingId);
  await mkdir(dir, { recursive: true });

  // Native ffmpeg path: the .mp4 is already in staging. MediaRecorder path:
  // the renderer hands us the webm bytes here.
  const nativeMp4 = join(dir, 'recording.mp4');
  const isNative = payload.videoBytes === undefined;
  let videoFile: string;
  let videoPath: string;
  let sizeBytes: number;
  if (isNative) {
    if (!existsSync(nativeMp4)) {
      throw new Error(`Native recording expected but file missing: ${nativeMp4}`);
    }
    videoFile = 'recording.mp4';
    videoPath = nativeMp4;
    // If the renderer captured parallel audio (gdigrab produces video-only),
    // write it and mux it into the MP4 in place. Failures are non-fatal — we
    // keep the silent video rather than losing the recording.
    if (payload.audioBytes && payload.audioBytes.byteLength > 0) {
      try {
        const audioTmp = join(dir, 'audio.webm');
        await writeFile(audioTmp, Buffer.from(payload.audioBytes));
        const muxed = join(dir, 'muxed.mp4');
        await muxAudioIntoVideo(nativeMp4, audioTmp, muxed);
        await rm(nativeMp4, { force: true });
        await rename(muxed, nativeMp4);
        await rm(audioTmp, { force: true });
        console.log('[recorder] native audio muxed into', nativeMp4);
      } catch (err) {
        console.warn('[recorder] native audio mux failed (keeping silent video):', err);
      }
    }
    // We could stat() for sizeBytes but it's only used for telemetry — skip
    // the extra syscall and report 0 in native mode.
    sizeBytes = 0;
  } else {
    videoFile = 'recording.webm';
    videoPath = join(dir, videoFile);
    const buf = Buffer.from(payload.videoBytes!);
    await writeFile(videoPath, buf);
    sizeBytes = buf.byteLength;
  }

  const eventsPath = join(dir, 'mouseEvents.json');
  const metaPath = join(dir, 'meta.json');
  await writeFile(eventsPath, JSON.stringify(payload.mouseEvents, null, 0));

  const meta: RecordingMeta = {
    recordingId: payload.recordingId,
    source: payload.source,
    startedAtEpoch: Date.now() - payload.durationMs,
    endedAtEpoch: Date.now(),
    durationMs: payload.durationMs,
    mouseEventCount: payload.mouseEvents.length,
    videoFile,
    eventsFile: 'mouseEvents.json',
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));

  return {
    stagingPath: dir,
    videoPath,
    eventsPath,
    metaPath,
    sizeBytes,
  };
}

export function disposeRecorder(): void {
  cancelRecording();
}
