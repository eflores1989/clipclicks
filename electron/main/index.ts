import { app, BrowserWindow, ipcMain, shell, session, protocol, dialog, globalShortcut } from 'electron';
import { createReadStream, existsSync } from 'node:fs';
import { stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { join, resolve as resolvePath, extname } from 'node:path';
import { IPC, VZASSET_PROTOCOL } from '../../src/shared/ipc/channels';
import type {
  RecordingSavePayload,
  RecordingStartOptions,
} from '../../src/shared/types/recording';
import type {
  ExportMuxPayload,
  ExportRunPayload,
  ProjectAppendClipPayload,
  ProjectCreatePayload,
  ProjectSavePayload,
} from '../../src/shared/types/project';
import { exportWebmToMp4, muxExportToMp4, killActiveExportFfmpeg } from './ffmpeg';
import { initAutoUpdater, quitAndInstallUpdate } from './updater';
import {
  cancelRecording,
  disposeRecorder,
  listSources,
  pauseRecording,
  resolvePendingDisplayMediaSource,
  resumeRecording,
  saveRecording,
  setPendingCaptureSource,
  startRecording,
  stopRecording,
} from './recorder';
import {
  appendClipFromImport,
  appendClipFromStaging,
  cancelProcessing,
  createProjectFromImport,
  createProjectFromStaging,
  deleteAsset,
  deleteCustomBackground,
  ensureProjectsRoot,
  extractClipAudio,
  importAudio,
  importCustomBackground,
  importImage,
  saveImageAsset,
  saveRecordedAudio,
  isPathInsideAllowedRoots,
  listAllProjects,
  listCustomBackgrounds,
  listRecentProjects,
  loadProject,
  openProjectDialog,
  saveProject,
} from './projectFs';

// Lock the app name BEFORE anything else queries it. Electron derives
// `app.getPath('userData')` from this name; if we let `productName` from
// package.json override it (Clipclicks Studio), userData jumps to a new
// folder and projects saved under the old name become invisible.
app.setName('video-zoom');

const isDev = !app.isPackaged;

const NORMAL_BOUNDS = { width: 1280, height: 800 };
const RECORDING_BOUNDS = { width: 240, height: 56 };

let mainWindow: BrowserWindow | null = null;
let savedNormalBounds: Electron.Rectangle | null = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: VZASSET_PROTOCOL,
    privileges: {
      secure: true,
      standard: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

function createMainWindow(): BrowserWindow {
  // Dev/Linux window icon. In a packaged Windows build the taskbar + title-bar
  // icon come from the embedded EXE icon (electron-builder `win.icon`), so this
  // is mainly for `npm run dev`. build/icon.png isn't inside the asar → guard.
  const devIcon = join(app.getAppPath(), 'build', 'icon.png');
  const win = new BrowserWindow({
    width: NORMAL_BOUNDS.width,
    height: NORMAL_BOUNDS.height,
    minWidth: 960,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    icon: existsSync(devIcon) ? devIcon : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.on('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}

/**
 * Register global (system-wide) recording hotkeys so the user can control the
 * recording without clicking the on-screen bar — important in the native
 * gdigrab (no-cursor, full-screen) capture path, where the bar can end up
 * burned into the recording. Each press forwards an action to the renderer,
 * which owns the recording session (see RecordingBar).
 *   F9  → pause / resume (toggle)
 *   F10 → stop
 * We deliberately avoid grabbing Esc/common keys globally so we don't hijack
 * shortcuts inside whatever app is being recorded.
 */
function registerRecordingHotkeys(): void {
  const send = (action: 'toggle-pause' | 'stop'): void => {
    mainWindow?.webContents.send(IPC.RECORDER_HOTKEY, action);
  };
  try {
    globalShortcut.register('F9', () => send('toggle-pause'));
    globalShortcut.register('F10', () => send('stop'));
  } catch (err) {
    console.warn('[main] could not register recording hotkeys:', err);
  }
}

function unregisterRecordingHotkeys(): void {
  globalShortcut.unregister('F9');
  globalShortcut.unregister('F10');
}

function enterRecordingWindow(): void {
  if (!mainWindow) return;
  savedNormalBounds = mainWindow.getBounds();
  const current = mainWindow.getBounds();
  const x = current.x + current.width - RECORDING_BOUNDS.width - 24;
  const y = current.y + 24;
  mainWindow.setResizable(false);
  mainWindow.setMinimumSize(RECORDING_BOUNDS.width, RECORDING_BOUNDS.height);
  mainWindow.setBounds({ ...RECORDING_BOUNDS, x, y });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setSkipTaskbar(false);
  // Exclude the recording bar from screen capture. On Windows this maps to
  // SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE): the bar stays visible to
  // the user (so its buttons still work) but no longer appears in the recorded
  // video — for the default (Windows Graphics Capture) path and, on Win10 2004+,
  // for the gdigrab BitBlt path too. Hotkeys cover the gap if a driver ignores it.
  mainWindow.setContentProtection(true);
  registerRecordingHotkeys();
}

function exitRecordingWindow(): void {
  if (!mainWindow) return;
  unregisterRecordingHotkeys();
  mainWindow.setContentProtection(false);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setMinimumSize(960, 600);
  mainWindow.setResizable(true);
  if (savedNormalBounds) {
    mainWindow.setBounds(savedNormalBounds);
  } else {
    mainWindow.setBounds({ ...NORMAL_BOUNDS, x: 100, y: 100 });
  }
  savedNormalBounds = null;
}

const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Project assets never change once written (unique per-asset filenames), so they
 *  can be cached aggressively — see the note in the range handler below. */
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Largest slice served for a single range request. See the note in the range
 * handler: this is what keeps a seek from spawning a read over the whole file.
 *
 * Sized from measurements: the disk itself is not the constraint (a 4MB random
 * read off the SSD is ~8ms), but the per-seek cost tracked the number of bytes
 * we streamed per request — unbounded (→EOF) averaged 466-618ms per seek and got
 * worse over time, a 4MB cap brought it to a stable ~240ms. A frame is only
 * ~50-80KB, so 512KB still covers a seek plus read-ahead while cutting the
 * per-request payload 8×.
 */
const RANGE_CHUNK_BYTES = 512 * 1024;

/**
 * Rolling stats for the asset protocol, so an export's cost can be attributed
 * (requests per frame × ms per request) instead of guessed at. Logged every 500
 * requests; `bytes` counts what we actually streamed out.
 */
const assetStats = { requests: 0, bytes: 0, ms: 0 };

function noteAssetRequest(bytes: number, ms: number): void {
  assetStats.requests++;
  assetStats.bytes += bytes;
  assetStats.ms += ms;
  if (assetStats.requests % 500 === 0) {
    const { requests, bytes: b, ms: m } = assetStats;
    console.log(`[vzasset] ${requests} requests | avg ${(b / requests / 1024).toFixed(0)} KB in ${(m / requests).toFixed(1)} ms | total ${(b / 1048576).toFixed(0)} MB`);
  }
}

function nodeStreamToWeb(stream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  return Readable.toWeb(stream as Readable) as unknown as ReadableStream<Uint8Array>;
}

function registerVzAssetProtocol(): void {
  protocol.handle(VZASSET_PROTOCOL, async (request) => {
    let parsed: URL;
    try {
      parsed = new URL(request.url);
    } catch {
      return new Response('Bad URL', { status: 400 });
    }
    if (parsed.hostname !== 'video') {
      return new Response(`Bad host: ${parsed.hostname}`, { status: 400 });
    }
    const tail = parsed.pathname.replace(/^\//, '');
    let decoded: string;
    try {
      decoded = decodeURIComponent(tail);
    } catch {
      return new Response('Bad path encoding', { status: 400 });
    }
    const absPath = resolvePath(decoded);
    if (!isPathInsideAllowedRoots(absPath)) {
      return new Response('Forbidden', { status: 403 });
    }

    let stats;
    try {
      stats = await stat(absPath);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    const total = stats.size;
    const contentType = MIME_BY_EXT[extname(absPath).toLowerCase()] ?? 'application/octet-stream';
    const rangeHeader = request.headers.get('range') ?? request.headers.get('Range');

    // Validators let Chromium actually store the (immutable) responses.
    const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const lastModified = stats.mtime.toUTCString();

    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
      if (!m) return new Response('Bad range', { status: 416 });
      const start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        return new Response('Range not satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${total}` },
        });
      }
      // CAP the served range. Chromium's media stack asks for an OPEN-ENDED
      // `bytes=X-` on every seek; answering "X → EOF" opened a read stream over
      // the whole remainder of the file (hundreds of MB for our all-keyframes
      // assets) which it then abandons after a few hundred KB. The frame-by-frame
      // export seeks once per output frame, so that was thousands of abandoned
      // multi-hundred-MB reads — measured at ~700ms per seek, i.e. 99% of the
      // export time. Returning fewer bytes than requested is valid HTTP: the
      // client just asks for the next range.
      if (end - start + 1 > RANGE_CHUNK_BYTES) {
        end = Math.min(total - 1, start + RANGE_CHUNK_BYTES - 1);
      }
      const chunk = createReadStream(absPath, { start, end });
      // If the client walks away (every seek does), stop reading immediately.
      request.signal?.addEventListener('abort', () => {
        try { chunk.destroy(); } catch { /* ignore */ }
      }, { once: true });
      const t0 = performance.now();
      let sent = 0;
      chunk.on('data', (d: string | Buffer) => { sent += typeof d === 'string' ? d.length : d.length; });
      chunk.on('close', () => noteAssetRequest(sent, performance.now() - t0));
      return new Response(nodeStreamToWeb(chunk), {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(end - start + 1),
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Accept-Ranges': 'bytes',
          ETag: etag,
          'Last-Modified': lastModified,
          // Assets are IMMUTABLE (each clip/audio/image gets a unique filename, and a
          // project's recording.mp4 is written once), so let Chromium cache the
          // ranges. This matters a lot for the frame-by-frame export: it seeks
          // once per output frame over an all-keyframes file (~15 Mbps, hundreds
          // of MB), and with `no-cache` every one of those seeks round-tripped
          // back into this handler to re-read from disk.
          'Cache-Control': CACHE_IMMUTABLE,
        },
      });
    }

    const full = createReadStream(absPath);
    request.signal?.addEventListener('abort', () => {
      try { full.destroy(); } catch { /* ignore */ }
    }, { once: true });
    return new Response(nodeStreamToWeb(full), {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(total),
        'Accept-Ranges': 'bytes',
        ETag: etag,
        'Last-Modified': lastModified,
        'Cache-Control': CACHE_IMMUTABLE,
      },
    });
  });
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.APP_VERSION, () => app.getVersion());

  ipcMain.handle(IPC.RECORDER_LIST_SOURCES, async () => listSources());
  ipcMain.handle(IPC.RECORDER_SET_PENDING_SOURCE, async (_evt, sourceId: string) =>
    setPendingCaptureSource(sourceId),
  );
  ipcMain.handle(IPC.RECORDER_START, (_evt, opts: RecordingStartOptions) => startRecording(opts));
  ipcMain.handle(IPC.RECORDER_STOP, () => stopRecording());
  ipcMain.handle(IPC.RECORDER_CANCEL, () => cancelRecording());
  ipcMain.handle(IPC.RECORDER_PAUSE, () => pauseRecording());
  ipcMain.handle(IPC.RECORDER_RESUME, () => resumeRecording());
  ipcMain.handle(IPC.RECORDER_SAVE, async (_evt, payload: RecordingSavePayload) =>
    saveRecording(payload),
  );

  ipcMain.handle(IPC.WINDOW_ENTER_RECORDING, () => enterRecordingWindow());
  ipcMain.handle(IPC.WINDOW_EXIT_RECORDING, () => exitRecordingWindow());

  ipcMain.handle(IPC.STAGING_REVEAL, (_evt, p: string) => shell.showItemInFolder(p));

  ipcMain.handle(IPC.PROJECT_CREATE_FROM_STAGING, async (_evt, payload: ProjectCreatePayload) =>
    createProjectFromStaging(payload),
  );
  ipcMain.handle(IPC.PROJECT_APPEND_CLIP_FROM_STAGING, async (_evt, payload: ProjectAppendClipPayload) =>
    appendClipFromStaging(payload),
  );
  ipcMain.handle(IPC.PROJECT_CANCEL_PROCESSING, () => cancelProcessing());
  ipcMain.handle(IPC.PROJECT_IMPORT_AUDIO, async (_evt, projectPath: string) => importAudio(projectPath));
  ipcMain.handle(
    IPC.PROJECT_SAVE_RECORDED_AUDIO,
    async (_evt, args: { projectPath: string; bytes: Uint8Array; kind: 'imported' | 'mic' | 'extracted'; name: string }) =>
      saveRecordedAudio(args.projectPath, args.bytes, args.kind, args.name),
  );
  ipcMain.handle(
    IPC.PROJECT_EXTRACT_CLIP_AUDIO,
    async (_evt, args: { projectPath: string; clipRelPath: string }) =>
      extractClipAudio(args.projectPath, args.clipRelPath),
  );
  ipcMain.handle(IPC.EXPORT_SAVE_DIALOG, async (_evt, defaultName: string) => {
    const safeName = (defaultName || 'export').replace(/[\\/:*?"<>|]/g, '_');
    const opts = {
      title: 'Exportar video',
      defaultPath: `${safeName}.mp4`,
      filters: [{ name: 'MP4', extensions: ['mp4'] }],
    };
    const res = mainWindow
      ? await dialog.showSaveDialog(mainWindow, opts)
      : await dialog.showSaveDialog(opts);
    return res.canceled || !res.filePath ? null : res.filePath;
  });
  ipcMain.handle(IPC.EXPORT_RUN, async (_evt, payload: ExportRunPayload) => {
    const tmp = join(tmpdir(), `vz-export-${randomUUID()}.webm`);
    await writeFile(tmp, Buffer.from(payload.bytes));
    try {
      await exportWebmToMp4({
        input: tmp,
        output: payload.outputPath,
        durationMs: payload.durationMs,
        fps: payload.fps,
        crf: payload.crf,
        audioBitrateKbps: payload.audioBitrateKbps,
        includeAudio: payload.includeAudio,
        onProgress: (percent) => { mainWindow?.webContents.send(IPC.EXPORT_PROGRESS, { percent }); },
      });
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  });
  ipcMain.handle(IPC.EXPORT_MUX, async (_evt, payload: ExportMuxPayload) => {
    const id = randomUUID();
    const videoTmp = join(tmpdir(), `vz-export-${id}.mp4`);
    const wavTmp = payload.wavBytes ? join(tmpdir(), `vz-export-${id}.wav`) : null;
    await writeFile(videoTmp, Buffer.from(payload.mp4Bytes));
    if (wavTmp && payload.wavBytes) await writeFile(wavTmp, Buffer.from(payload.wavBytes));
    try {
      await muxExportToMp4({
        videoMp4: videoTmp,
        wavPath: wavTmp,
        output: payload.outputPath,
        audioBitrateKbps: payload.audioBitrateKbps,
        durationMs: 0,
        onProgress: (percent) => { mainWindow?.webContents.send(IPC.EXPORT_PROGRESS, { percent }); },
      });
    } finally {
      await rm(videoTmp, { force: true }).catch(() => {});
      if (wavTmp) await rm(wavTmp, { force: true }).catch(() => {});
    }
  });
  ipcMain.handle(IPC.EXPORT_CANCEL, () => killActiveExportFfmpeg());
  ipcMain.handle(IPC.EXPORT_REVEAL_FILE, (_evt, p: string) => shell.showItemInFolder(p));
  ipcMain.handle(IPC.EXPORT_OPEN_FILE, (_evt, p: string) => shell.openPath(p));
  ipcMain.handle(IPC.UPDATE_INSTALL, () => quitAndInstallUpdate());
  ipcMain.handle(IPC.CUSTOM_BG_LIST, () => listCustomBackgrounds());
  ipcMain.handle(IPC.CUSTOM_BG_IMPORT, () => importCustomBackground());
  ipcMain.handle(IPC.CUSTOM_BG_DELETE, (_evt, id: string) => deleteCustomBackground(id));
  ipcMain.handle(IPC.PROJECT_IMPORT_IMAGE, async (_evt, projectPath: string) => importImage(projectPath));
  ipcMain.handle(IPC.PROJECT_IMPORT_VIDEO, async () => createProjectFromImport());
  ipcMain.handle(IPC.PROJECT_IMPORT_VIDEO_APPEND, async (_evt, targetProjectPath: string) =>
    appendClipFromImport(targetProjectPath),
  );
  ipcMain.handle(
    IPC.PROJECT_SAVE_IMAGE_ASSET,
    async (_evt, args: { projectPath: string; bytes: Uint8Array; kind: 'imported' | 'solid' | 'gradient'; name: string; width: number; height: number }) =>
      saveImageAsset(args.projectPath, args.bytes, args.kind, args.name, args.width, args.height),
  );
  ipcMain.handle(IPC.PROJECT_LOAD, async (_evt, projectPath: string) => loadProject(projectPath));
  ipcMain.handle(IPC.PROJECT_SAVE, async (_evt, payload: ProjectSavePayload) =>
    saveProject(payload),
  );
  ipcMain.handle(IPC.PROJECT_LIST_RECENT, async () => listRecentProjects());
  ipcMain.handle(IPC.PROJECT_LIST_ALL, async () => listAllProjects());
  ipcMain.handle(IPC.PROJECT_OPEN_DIALOG, async () =>
    openProjectDialog(mainWindow ?? undefined),
  );
  ipcMain.handle(IPC.PROJECT_REVEAL, (_evt, p: string) => shell.showItemInFolder(p));
  ipcMain.handle(IPC.PROJECT_DELETE_ASSET, async (_evt, args: { projectPath: string; relativeFilePath: string }) =>
    deleteAsset(args.projectPath, args.relativeFilePath),
  );
  ipcMain.handle(IPC.PROJECT_ASSET_URL, (_evt, absPath: string) => {
    if (!isPathInsideAllowedRoots(resolvePath(absPath))) {
      throw new Error('Path outside allowed roots');
    }
    const normalized = absPath.replace(/\\/g, '/');
    // encode the whole path including the colon and slashes (encodeURIComponent
    // escapes everything except A-Z, a-z, 0-9, _.!~*'() — perfect for stuffing
    // a Windows absolute path into a URL path component without ambiguity).
    const encoded = encodeURIComponent(normalized);
    return `${VZASSET_PROTOCOL}://video/${encoded}`;
  });
}

function registerSessionPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'display-capture') {
      callback(true);
      return;
    }
    callback(false);
  });

  // The renderer calls navigator.mediaDevices.getDisplayMedia() so it can pass
  // the `cursor: 'never'` constraint when the user opted out of capturing the
  // OS cursor. Normally that triggers Chromium's system picker; we intercept
  // here and provide whichever source the user picked in our own SourcePicker.
  // The pending source id is stored ahead of time via the
  // RECORDER_SET_PENDING_SOURCE IPC. If nothing was pre-staged we deny.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    resolvePendingDisplayMediaSource()
      .then((src) => {
        if (src) callback({ video: src });
        else callback({});
      })
      .catch((err) => {
        console.warn('[main] setDisplayMediaRequestHandler error:', err);
        callback({});
      });
  });
}

app.whenReady().then(() => {
  ensureProjectsRoot();
  registerIpcHandlers();
  registerSessionPermissions();
  registerVzAssetProtocol();
  mainWindow = createMainWindow();
  initAutoUpdater(() => mainWindow);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  disposeRecorder();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
