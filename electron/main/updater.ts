import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import { IPC } from '../../src/shared/ipc/channels';

/**
 * Auto-update via GitHub Releases (configured in electron-builder.yml `publish`).
 * Only active in packaged builds. Downloads in the background and tells the
 * renderer when an update is ready so it can offer "restart to update". The
 * update also installs automatically on the next app quit.
 */
export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  if (!app.isPackaged) return; // dev runs have no update feed

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  const send = (channel: string, payload: unknown): void => {
    try { getWindow()?.webContents.send(channel, payload); } catch { /* ignore */ }
  };

  autoUpdater.on('update-available', (info) => send(IPC.UPDATE_AVAILABLE, { version: info.version }));
  autoUpdater.on('download-progress', (p) => send(IPC.UPDATE_PROGRESS, { percent: p.percent }));
  autoUpdater.on('update-downloaded', (info) => send(IPC.UPDATE_DOWNLOADED, { version: info.version }));
  autoUpdater.on('error', (err) => console.warn('[updater] error:', err?.message ?? err));

  const check = (): void => { autoUpdater.checkForUpdates().catch((e) => console.warn('[updater] check failed:', e?.message ?? e)); };
  // Check shortly after launch, then every 30 min for long sessions.
  setTimeout(check, 4000);
  setInterval(check, 30 * 60 * 1000);
}

/** Quit and install the downloaded update (called from the renderer button). */
export function quitAndInstallUpdate(): void {
  try { autoUpdater.quitAndInstall(); } catch (e) { console.warn('[updater] quitAndInstall failed:', e); }
}
