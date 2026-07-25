/* eslint-disable @typescript-eslint/no-require-imports */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

function resolveFfmpegPath(): string {
  const mod = require('ffmpeg-static') as unknown;
  let raw: string | null = null;
  if (typeof mod === 'string') raw = mod;
  else if (mod && typeof (mod as { default?: unknown }).default === 'string') {
    raw = (mod as { default: string }).default;
  }
  if (!raw) throw new Error('ffmpeg-static did not return a string path');
  return raw.replace('app.asar', 'app.asar.unpacked');
}

const FFMPEG_PATH = resolveFfmpegPath();
console.log('[ffmpeg] binary path:', FFMPEG_PATH, '| exists:', existsSync(FFMPEG_PATH));

// Track the ffmpeg child currently doing project-processing work (transcode or
// thumbnails) so the user can cancel an in-flight "Preparing your project"
// step. Recording's own ffmpeg (native gdigrab) is tracked separately in
// recorder.ts — this is only the post-recording processing pipeline.
let activeProcessingProc: import('node:child_process').ChildProcess | null = null;

/** Kill whatever processing ffmpeg is currently running (used by Cancel). */
export function killActiveProcessingFfmpeg(): void {
  if (activeProcessingProc) {
    try { activeProcessingProc.kill('SIGKILL'); } catch { /* ignore */ }
    activeProcessingProc = null;
  }
}

function parseFfmpegTimeMs(line: string): number | null {
  const m = line.match(/time=(\d+):(\d{2}):(\d{2})\.(\d+)/);
  if (!m) return null;
  const h = Number(m[1]);
  const mn = Number(m[2]);
  const s = Number(m[3]);
  const frac = m[4];
  const fracMs = (Number(frac) * 1000) / 10 ** frac.length;
  return ((h * 60 + mn) * 60 + s) * 1000 + fracMs;
}

export interface TranscodeOptions {
  input: string;
  output: string;
  durationMs: number;
  onProgress?: (percent: number) => void;
}

/**
 * Transcode WebM to MP4 with `-g 1` so every frame is a keyframe.
 * That makes seek-by-time exact during editor scrubbing.
 */
export function transcodeToMp4Allkeyframes(opts: TranscodeOptions): Promise<void> {
  console.log('[ffmpeg] transcode start:', opts.input, '->', opts.output, 'duration:', opts.durationMs, 'ms');
  return new Promise((resolve, reject) => {
    if (!existsSync(FFMPEG_PATH)) {
      reject(new Error(`ffmpeg binary missing at ${FFMPEG_PATH}`));
      return;
    }
    if (!existsSync(opts.input)) {
      reject(new Error(`input file missing at ${opts.input}`));
      return;
    }

    // Intermediate transcode used only for editor seeking — speed >> size.
    // Final export (Phase 6) re-encodes from the timeline with higher quality.
    const args = [
      '-y',
      '-i', opts.input,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22',
      '-g', '1',
      '-pix_fmt', 'yuv420p',
      // Keep audio if the source has it (silent recordings just produce no
      // audio stream — harmless). aac is broadly compatible for MP4.
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      opts.output,
    ];

    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    activeProcessingProc = proc;
    let stderrTail = '';
    let lastReportedPct = 0;

    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split(/\r|\n/)) {
        const tMs = parseFfmpegTimeMs(line);
        if (tMs !== null && opts.durationMs > 0) {
          const pct = Math.max(0, Math.min(100, (tMs / opts.durationMs) * 100));
          if (pct - lastReportedPct >= 1 || pct >= 100) {
            lastReportedPct = pct;
            opts.onProgress?.(pct);
          }
        }
      }
    });

    proc.on('error', (err) => {
      console.error('[ffmpeg] spawn error:', err);
      if (activeProcessingProc === proc) activeProcessingProc = null;
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      console.log('[ffmpeg] transcode exit code:', code, 'signal:', signal);
      if (activeProcessingProc === proc) activeProcessingProc = null;
      if (code === 0) {
        opts.onProgress?.(100);
        resolve();
      } else if (signal === 'SIGKILL') {
        // Killed by killActiveProcessingFfmpeg() — surface a cancellation
        // sentinel so callers can clean up quietly instead of erroring.
        reject(new Error('CANCELLED'));
      } else {
        const tail = stderrTail.split('\n').slice(-12).join('\n');
        reject(new Error(`ffmpeg exited with code ${code}\nstderr tail:\n${tail}`));
      }
    });
  });
}

/**
 * Probe a media file's actual duration via ffmpeg's stderr "Duration:" line.
 * Returns null on parse failure. Use this AFTER transcoding to align the
 * project's `clip.durationMs` with what the player will actually see — the
 * `MediaRecorder`-reported wall-clock can drift from the encoded file by
 * hundreds of ms (keyframe boundaries, dropped frames).
 */
export function probeDurationMs(input: string): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, ['-i', input], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      const m = stderr.match(/Duration:\s+(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (!m) return resolve(null);
      const ms =
        (parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)) * 1000 +
        parseInt(m[4], 10) * 10;
      resolve(ms);
    });
  });
}

export interface ProbedVideoMeta {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  hasAudio: boolean;
}

/**
 * Probe an arbitrary video file's dimensions, fps, duration and audio presence
 * by parsing ffmpeg's stderr (`ffmpeg -i <file>`). Used by the "import video"
 * flow, where — unlike a fresh recording — there is no capture stream to read
 * metadata from. Returns sensible fallbacks for any field we can't parse.
 */
export function probeVideoMeta(input: string): Promise<ProbedVideoMeta> {
  return new Promise((resolve) => {
    // Zeros (not 1920×1080) mean "could not parse" — callers apply their own
    // fallback. This matters for the load-time reconcile: assuming landscape
    // here would clobber a correct portrait clip whenever a probe fails.
    const fallback: ProbedVideoMeta = { width: 0, height: 0, fps: 0, durationMs: 0, hasAudio: false };
    if (!existsSync(FFMPEG_PATH) || !existsSync(input)) { resolve(fallback); return; }
    const proc = spawn(FFMPEG_PATH, ['-i', input], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    proc.on('error', () => resolve(fallback));
    proc.on('close', () => {
      const meta: ProbedVideoMeta = { ...fallback };
      const dur = stderr.match(/Duration:\s+(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
      if (dur) {
        meta.durationMs =
          (parseInt(dur[1], 10) * 3600 + parseInt(dur[2], 10) * 60 + parseInt(dur[3], 10)) * 1000 +
          parseInt(dur[4], 10) * 10;
      }
      // First video stream: "Video: h264 ..., 1920x1080 ..., 30 fps" (the res
      // token can carry a trailing SAR/DAR in [..], so match WxH loosely).
      const v = stderr.match(/Stream #\d+:\d+.*: Video:.*?(\d{2,5})x(\d{2,5})/);
      if (v) { meta.width = parseInt(v[1], 10); meta.height = parseInt(v[2], 10); }
      const fps = stderr.match(/(\d+(?:\.\d+)?)\s*fps/);
      if (fps) { const f = Math.round(parseFloat(fps[1])); if (f > 0 && f <= 240) meta.fps = f; }
      meta.hasAudio = /Stream #\d+:\d+.*: Audio:/.test(stderr);
      resolve(meta);
    });
  });
}

/**
 * Convert an animated GIF to an all-keyframes MP4 so it can live on the timeline
 * as a normal video clip. A GIF in an `<img>` only ever uploads its FIRST frame
 * to a WebGL texture (and its DOM animation runs on wall-clock, which would make
 * a frame-by-frame export non-deterministic) — turning it into a video makes it
 * animate in the preview AND both export paths with exact timing.
 *
 * `-r 25` normalizes the GIF's variable frame delays to CFR (predictable seeks),
 * the scale filter forces even dimensions (yuv420p requires them; GIFs are often
 * odd-sized) and `-g 1` keeps every frame a keyframe for exact scrubbing.
 */
export function convertGifToMp4(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(FFMPEG_PATH)) { reject(new Error(`ffmpeg binary missing at ${FFMPEG_PATH}`)); return; }
    if (!existsSync(input)) { reject(new Error(`gif missing at ${input}`)); return; }
    const args = [
      '-y',
      '-i', input,
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-g', '1',
      '-r', '25',
      '-pix_fmt', 'yuv420p',
      '-an',
      '-movflags', '+faststart',
      '-f', 'mp4',
      output,
    ];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    proc.stderr.on('data', (c: Buffer) => { tail = (tail + c.toString('utf8')).slice(-2000); });
    proc.on('error', (err) => reject(new Error(`gif convert spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0 && existsSync(output)) resolve();
      else reject(new Error(`gif convert exited ${code}\n${tail.split('\n').slice(-6).join('\n')}`));
    });
  });
}

/**
 * Mux an audio file into a video file (copying the video stream, encoding the
 * audio to AAC) and write the result to `output`. Used by the native (gdigrab)
 * recording path, whose MP4 is video-only — the audio was captured in parallel
 * and is folded in here. `-shortest` trims to the shorter stream so a slightly
 * longer audio tail doesn't extend the clip.
 */
export function muxAudioIntoVideo(videoPath: string, audioPath: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(videoPath)) { reject(new Error(`mux: video missing ${videoPath}`)); return; }
    if (!existsSync(audioPath)) { reject(new Error(`mux: audio missing ${audioPath}`)); return; }
    const args = [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-movflags', '+faststart',
      output,
    ];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    proc.stderr.on('data', (c: Buffer) => { tail = (tail + c.toString('utf8')).slice(-2000); });
    proc.on('error', (err) => reject(new Error(`mux spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`mux ffmpeg exited ${code}\n${tail.split('\n').slice(-6).join('\n')}`));
    });
  });
}

/**
 * Transcode an audio file (e.g. a MediaRecorder webm/opus blob) to AAC/m4a.
 * Crucially this REWRITES the container so it carries a real duration —
 * MediaRecorder webm has no duration in its header, so `probeDurationMs`
 * returns 0 on the raw blob and the timeline chip collapses to a thin line.
 * The m4a output also seeks reliably in an <audio> element.
 */
export function transcodeAudioToM4a(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(input)) { reject(new Error(`audio transcode: input missing ${input}`)); return; }
    const args = ['-y', '-i', input, '-vn', '-c:a', 'aac', '-b:a', '192k', output];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    proc.stderr.on('data', (c: Buffer) => { tail = (tail + c.toString('utf8')).slice(-2000); });
    proc.on('error', (err) => reject(new Error(`audio transcode spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0 && existsSync(output)) resolve();
      else reject(new Error(`audio transcode exited ${code}\n${tail.split('\n').slice(-6).join('\n')}`));
    });
  });
}

/**
 * Extract the audio stream of a video file to a standalone AAC/m4a file.
 * Rejects if the input has no audio stream.
 */
export function extractAudioToFile(videoPath: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(videoPath)) { reject(new Error(`extract: video missing ${videoPath}`)); return; }
    const args = ['-y', '-i', videoPath, '-vn', '-c:a', 'aac', '-b:a', '192k', output];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    proc.stderr.on('data', (c: Buffer) => { tail = (tail + c.toString('utf8')).slice(-2000); });
    proc.on('error', (err) => reject(new Error(`extract spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0 && existsSync(output)) resolve();
      else reject(new Error(`extract ffmpeg exited ${code}\n${tail.split('\n').slice(-6).join('\n')}`));
    });
  });
}

/**
 * Decode an audio file to mono 8kHz PCM and downsample to `buckets` peak values
 * (abs amplitude 0..1). Used to draw a static waveform on the timeline. Returns
 * an empty array on failure (caller treats it as "no waveform yet").
 */
export function extractAudioPeaks(input: string, buckets = 600): Promise<number[]> {
  return new Promise((resolve) => {
    if (!existsSync(FFMPEG_PATH) || !existsSync(input)) { resolve([]); return; }
    // s16le mono @ 8kHz to stdout. A few minutes of audio is only a few MB.
    const args = ['-v', 'quiet', '-i', input, '-ac', '1', '-ar', '8000', '-f', 's16le', '-'];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const chunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.on('error', () => resolve([]));
    proc.on('close', () => {
      const buf = Buffer.concat(chunks);
      const sampleCount = Math.floor(buf.length / 2);
      if (sampleCount === 0) { resolve([]); return; }
      const per = Math.max(1, Math.floor(sampleCount / buckets));
      const peaks: number[] = [];
      for (let i = 0; i < sampleCount; i += per) {
        let max = 0;
        const end = Math.min(sampleCount, i + per);
        for (let j = i; j < end; j++) {
          const v = Math.abs(buf.readInt16LE(j * 2)) / 32768;
          if (v > max) max = v;
        }
        peaks.push(Math.round(max * 1000) / 1000);
      }
      resolve(peaks);
    });
  });
}

/**
 * Generate thumbnails every `intervalSec` seconds at `width` pixels wide.
 * Returns the list of filenames written into `outputDir`.
 */
export interface ThumbnailOptions {
  input: string;
  outputDir: string;
  intervalSec: number;
  width: number;
  durationMs: number;
  onProgress?: (percent: number) => void;
}

export function generateThumbnails(opts: ThumbnailOptions): Promise<string[]> {
  console.log('[ffmpeg] thumbnails start:', opts.input);
  return new Promise((resolve, reject) => {
    const interval = Math.max(0.5, opts.intervalSec);
    const args = [
      '-y',
      '-i', opts.input,
      '-vf', `fps=1/${interval},scale=${opts.width}:-2:flags=lanczos`,
      '-q:v', '4',
      join(opts.outputDir, 'thumb-%03d.jpg'),
    ];
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    activeProcessingProc = proc;
    let stderrTail = '';
    let lastReportedPct = 0;
    proc.stderr.on('data', (c: Buffer) => {
      const text = c.toString('utf8');
      stderrTail = (stderrTail + text).slice(-2000);
      if (opts.onProgress && opts.durationMs > 0) {
        for (const line of text.split(/\r|\n/)) {
          const tMs = parseFfmpegTimeMs(line);
          if (tMs !== null) {
            const pct = Math.max(0, Math.min(100, (tMs / opts.durationMs) * 100));
            if (pct - lastReportedPct >= 2 || pct >= 100) {
              lastReportedPct = pct;
              opts.onProgress(pct);
            }
          }
        }
      }
    });
    proc.on('error', (err) => {
      if (activeProcessingProc === proc) activeProcessingProc = null;
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
    proc.on('close', async (code, signal) => {
      console.log('[ffmpeg] thumbnails exit code:', code);
      if (activeProcessingProc === proc) activeProcessingProc = null;
      if (signal === 'SIGKILL') { reject(new Error('CANCELLED')); return; }
      if (code !== 0) {
        const tail = stderrTail.split('\n').slice(-8).join('\n');
        reject(new Error(`thumbnail ffmpeg exited with code ${code}\n${tail}`));
        return;
      }
      opts.onProgress?.(100);
      try {
        const files = await readdir(opts.outputDir);
        resolve(files.filter((f) => /^thumb-\d+\.jpg$/.test(f)).sort());
      } catch (err) {
        reject(err as Error);
      }
    });
  });
}

// ───── Export (Phase 6) ─────

// The export ffmpeg child is tracked separately from project-processing so a
// user can cancel an export without touching anything else.
let activeExportProc: import('node:child_process').ChildProcess | null = null;

export function killActiveExportFfmpeg(): void {
  if (activeExportProc) {
    try { activeExportProc.kill('SIGKILL'); } catch { /* ignore */ }
    activeExportProc = null;
  }
}

export interface MuxExportOptions {
  videoMp4: string;       // video-only MP4 (WebCodecs + mp4-muxer)
  wavPath: string | null; // mixed audio WAV, or null for video-only
  output: string;
  audioBitrateKbps: number;
  durationMs: number;
  onProgress?: (percent: number) => void;
}

/**
 * Deterministic-export mux: copy the already-encoded H.264 video into the final
 * MP4 (no re-encode → fast + lossless) and add AAC audio from the WAV.
 */
export function muxExportToMp4(opts: MuxExportOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(FFMPEG_PATH)) { reject(new Error(`ffmpeg binary missing at ${FFMPEG_PATH}`)); return; }
    if (!existsSync(opts.videoMp4)) { reject(new Error(`export video missing at ${opts.videoMp4}`)); return; }
    const hasAudio = !!opts.wavPath && existsSync(opts.wavPath);
    const args = [
      '-y',
      '-i', opts.videoMp4,
      ...(hasAudio ? ['-i', opts.wavPath as string] : []),
      '-c:v', 'copy',
      ...(hasAudio ? ['-c:a', 'aac', '-b:a', `${opts.audioBitrateKbps}k`, '-shortest'] : ['-an']),
      '-movflags', '+faststart',
      '-f', 'mp4',
      opts.output,
    ];
    console.log('[ffmpeg] export mux:', args.join(' '));
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    activeExportProc = proc;
    let tail = '';
    let lastPct = 0;
    proc.stderr.on('data', (c: Buffer) => {
      const text = c.toString('utf8');
      tail = (tail + text).slice(-4000);
      if (opts.durationMs > 0) {
        for (const line of text.split(/\r|\n/)) {
          const tMs = parseFfmpegTimeMs(line);
          if (tMs !== null) {
            const pct = Math.max(0, Math.min(100, (tMs / opts.durationMs) * 100));
            if (pct - lastPct >= 1 || pct >= 100) { lastPct = pct; opts.onProgress?.(pct); }
          }
        }
      }
    });
    proc.on('error', (err) => {
      if (activeExportProc === proc) activeExportProc = null;
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
    proc.on('close', (code, signal) => {
      if (activeExportProc === proc) activeExportProc = null;
      if (code === 0 && existsSync(opts.output)) { opts.onProgress?.(100); resolve(); }
      else if (signal === 'SIGKILL') reject(new Error('CANCELLED'));
      else reject(new Error(`export mux ffmpeg exited ${code}\n${tail.split('\n').slice(-10).join('\n')}`));
    });
  });
}

export interface ExportTranscodeOptions {
  input: string;          // the captured .webm (canvas + web-audio mix)
  output: string;         // target .mp4 chosen by the user
  durationMs: number;
  fps: number;            // 30 | 60
  crf: number;            // x264 quality (lower = better); ~18 high … 26 low
  audioBitrateKbps: number;
  includeAudio: boolean;
  onProgress?: (percent: number) => void;
}

/**
 * Final export transcode: the renderer captured the composed timeline (all
 * channels) into a WebM at the target resolution/fps. Re-encode it to a widely
 * compatible MP4 (H.264 + AAC, +faststart).
 */
export function exportWebmToMp4(opts: ExportTranscodeOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!existsSync(FFMPEG_PATH)) { reject(new Error(`ffmpeg binary missing at ${FFMPEG_PATH}`)); return; }
    if (!existsSync(opts.input)) { reject(new Error(`export input missing at ${opts.input}`)); return; }
    const args = [
      '-y',
      '-i', opts.input,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(opts.crf),
      '-pix_fmt', 'yuv420p',
      '-r', String(opts.fps),
      ...(opts.includeAudio ? ['-c:a', 'aac', '-b:a', `${opts.audioBitrateKbps}k`] : ['-an']),
      '-movflags', '+faststart',
      '-f', 'mp4',
      opts.output,
    ];
    console.log('[ffmpeg] export start:', opts.input, '->', opts.output);
    const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    activeExportProc = proc;
    let tail = '';
    let lastPct = 0;
    proc.stderr.on('data', (c: Buffer) => {
      const text = c.toString('utf8');
      tail = (tail + text).slice(-4000);
      if (opts.durationMs > 0) {
        for (const line of text.split(/\r|\n/)) {
          const tMs = parseFfmpegTimeMs(line);
          if (tMs !== null) {
            const pct = Math.max(0, Math.min(100, (tMs / opts.durationMs) * 100));
            if (pct - lastPct >= 1 || pct >= 100) { lastPct = pct; opts.onProgress?.(pct); }
          }
        }
      }
    });
    proc.on('error', (err) => {
      if (activeExportProc === proc) activeExportProc = null;
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });
    proc.on('close', (code, signal) => {
      if (activeExportProc === proc) activeExportProc = null;
      if (code === 0 && existsSync(opts.output)) { opts.onProgress?.(100); resolve(); }
      else if (signal === 'SIGKILL') reject(new Error('CANCELLED'));
      else reject(new Error(`export ffmpeg exited ${code}\n${tail.split('\n').slice(-10).join('\n')}`));
    });
  });
}
