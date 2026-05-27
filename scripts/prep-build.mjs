// Windows-only build prep. electron-builder downloads `winCodeSign` (signing
// tools) and tries to extract macOS `.dylib` SYMLINKS, which fails on Windows
// without Developer Mode / admin ("client does not have a required privilege").
// We don't sign for QA, so we pre-extract winCodeSign WITHOUT the macOS folder
// (the only part with symlinks) into electron-builder's cache, so the build
// reuses it. Idempotent + safe to run on any Windows machine.
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';

if (process.platform !== 'win32') { console.log('[prep-build] not Windows, skip'); process.exit(0); }

const local = process.env.LOCALAPPDATA;
if (!local) { console.log('[prep-build] LOCALAPPDATA not set, skip'); process.exit(0); }

const cacheDir = join(local, 'electron-builder', 'Cache', 'winCodeSign');
const destDir = join(cacheDir, 'winCodeSign-2.6.0');
if (existsSync(join(destDir, 'windows-10'))) {
  console.log('[prep-build] winCodeSign already prepared');
  process.exit(0);
}

mkdirSync(cacheDir, { recursive: true });
const archive = join(cacheDir, 'winCodeSign-2.6.0.7z');
const url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z';

if (!existsSync(archive)) {
  console.log('[prep-build] downloading winCodeSign…');
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`winCodeSign download failed: ${res.status}`);
  await new Promise((resolve, reject) => {
    const f = createWriteStream(archive);
    Readable.fromWeb(res.body).pipe(f).on('finish', resolve).on('error', reject);
  });
}

const sevenZ = join('node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const r = spawnSync(sevenZ, ['x', archive, `-o${destDir}`, '-xr!darwin', '-y'], { stdio: 'inherit' });
if (r.status !== 0) throw new Error('winCodeSign extraction failed');
console.log('[prep-build] winCodeSign extracted (without macOS symlinks)');
