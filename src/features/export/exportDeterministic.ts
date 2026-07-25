import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { getExportScene } from './exportEngine';
import { setExporting } from './exportBridge';
import { locateGlobal, clipEffectiveDurationMs } from '@shared/lib/clipTime';
import type { Project } from '@shared/types/project';

export interface DeterministicExportOptions {
  project: Project;
  projectPath: string;
  width: number;
  height: number;
  fps: number;
  videoBitrate: number; // bits/s for the VideoEncoder
  totalMs: number;
  resolveUrl: (absPath: string) => Promise<string>;
  onProgress: (percent: number) => void; // 0..100 of the encode phase
  shouldCancel: () => boolean;
  /**
   * Ask for the GPU's H.264 encoder. OFF by default so the output is bit-for-bit
   * what the software encoder produces. Turning it on is dramatically faster —
   * the software encoder is the bottleneck of this path (~120ms/frame at 1080p60,
   * vs ~30ms for everything else combined) — at the cost of the encoder being a
   * different implementation (visually indistinguishable at these bitrates, but
   * not identical). Falls back to software if the GPU can't do the config.
   */
  preferHardware?: boolean;
}

const ENCODER_AVAILABLE = typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder !== 'undefined';

/** Seek a (non-playing) video to an exact time and wait for the frame. We wait
 *  ONLY on `seeked` — `requestVideoFrameCallback` is unreliable on a paused
 *  video and was the cause of the earlier export being pathologically slow.
 *
 *  `toleranceSec` skips the seek entirely when we're already inside the SAME
 *  source frame: a seek is a full decoder+IO round trip (the dominant cost of
 *  this export), and re-seeking within one frame decodes the very same picture.
 *  Pass half a source-frame duration. */
function seekExact(v: HTMLVideoElement, t: number, toleranceSec = 0.0005): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) <= toleranceSec) { resolve(); return; }
    let done = false;
    let timer = 0;
    const finish = (): void => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      v.removeEventListener('seeked', finish);
      resolve();
    };
    v.addEventListener('seeked', finish, { once: true });
    try { v.currentTime = t; } catch { finish(); }
    timer = window.setTimeout(finish, 1000);
  });
}

function whenVideoMeta(v: HTMLVideoElement): Promise<void> {
  return new Promise((res) => {
    if (v.readyState >= 2) { res(); return; }
    const done = (): void => { v.removeEventListener('loadeddata', done); v.removeEventListener('error', done); res(); };
    v.addEventListener('loadeddata', done, { once: true });
    v.addEventListener('error', done, { once: true });
    setTimeout(res, 8000);
  });
}

/**
 * DETERMINISTIC export: render + encode the timeline FRAME BY FRAME (not realtime),
 * so it stays smooth + full quality at any resolution (incl. 4K) regardless of
 * the machine. For each output frame we compose the scene at the exact time
 * (seeking video clips to the precise source frame — fast because clips are
 * all-keyframes), capture `VideoFrame(canvas)`, and encode with `VideoEncoder`
 * (`latencyMode:'quality'` → NO dropped frames). Chunks are muxed by `mp4-muxer`
 * using their timestamps (so frame order/timing is always correct). Returns a
 * VIDEO-ONLY MP4; the caller adds audio via ffmpeg.
 */
export async function encodeTimelineToMp4(opts: DeterministicExportOptions): Promise<Uint8Array> {
  const { project, projectPath, width, height, fps, videoBitrate, totalMs, resolveUrl, onProgress, shouldCancel } = opts;
  if (!ENCODER_AVAILABLE) throw new Error('WebCodecs (VideoEncoder) is not available in this environment.');

  // AVCC output (default) so mp4-muxer gets the avcC description in the chunk meta.
  const candidates = ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4D4028', 'avc1.42E01E'];
  // With `preferHardware` we probe the GPU encoder first and fall back to the
  // default (software-or-whatever-Chromium-picks) if nothing matches.
  const accelModes: Array<'prefer-hardware' | 'no-preference'> =
    opts.preferHardware ? ['prefer-hardware', 'no-preference'] : ['no-preference'];
  let codec: string | null = null;
  let accel: 'prefer-hardware' | 'no-preference' = 'no-preference';
  outer: for (const mode of accelModes) {
    for (const c of candidates) {
      try {
        const support = await VideoEncoder.isConfigSupported({
          codec: c, width, height, bitrate: videoBitrate, framerate: fps, hardwareAcceleration: mode,
        });
        if (support.supported) { codec = c; accel = mode; break outer; }
      } catch { /* try next */ }
    }
  }
  if (!codec) throw new Error('This system does not support encoding H.264 via WebCodecs.');
  console.log(`[export] encoder: ${codec} (${accel})`);

  const abs = (rel: string): string => `${projectPath}/${rel}`.replace(/\\/g, '/');
  const videoEls = new Map<string, HTMLVideoElement>();
  const imageEls = new Map<string, HTMLImageElement>();
  let encoder: VideoEncoder | null = null;

  const cleanup = (): void => {
    try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch { /* ignore */ }
    for (const v of videoEls.values()) { try { v.pause(); v.removeAttribute('src'); } catch { /* ignore */ } }
    setExporting(false);
  };

  setExporting(true);
  try {
    const scene = await getExportScene(width, height);
    scene.applyBackground(project.background);
    scene.updateTexts(-1, [], null);
    scene.updateTimers(-1, [], null);

    const ready: Promise<unknown>[] = [];
    for (const c of project.clips) {
      const url = await resolveUrl(abs(c.filePath));
      if (c.kind === 'image') {
        const img = new Image(); img.crossOrigin = 'anonymous'; img.src = url;
        imageEls.set(c.id, img);
        ready.push(img.decode().catch(() => {}));
      } else {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.muted = true; v.src = url;
        videoEls.set(c.id, v);
        ready.push(whenVideoMeta(v));
      }
    }
    await Promise.all(ready);
    if (shouldCancel()) throw new Error('CANCELLED');

    const muxer = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width, height, frameRate: fps },
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
    });
    let encodeError: Error | null = null;
    encoder = new VideoEncoder({
      output: (chunk, meta) => { try { muxer.addVideoChunk(chunk, meta); } catch (e) { encodeError = e as Error; } },
      error: (e) => { encodeError = e as unknown as Error; },
    });
    encoder.configure({ codec, width, height, bitrate: videoBitrate, framerate: fps, latencyMode: 'quality', hardwareAcceleration: accel });

    const videoEnd = project.timeline.durationMs;
    const frameDurUs = 1_000_000 / fps;
    const totalFrames = Math.max(1, Math.round((totalMs / 1000) * fps));
    const gop = Math.max(1, fps * 2);
    let sceneClipId: string | null = null;
    // Per-phase timing so a slow export can be diagnosed instead of guessed at.
    // (Logged every 25% + a final summary. Zero effect on output quality.)
    const prof = { seek: 0, compose: 0, render: 0, encode: 0, wait: 0, seeks: 0 };
    let nextProfLog = 0.25;

    for (let i = 0; i < totalFrames; i++) {
      if (shouldCancel()) throw new Error('CANCELLED');
      if (encodeError) throw encodeError;
      const masterMs = (i / fps) * 1000;
      const located = masterMs <= videoEnd + 1 ? locateGlobal(project, masterMs) : null;

      const tFrame0 = performance.now();
      let seekMs = 0;
      if (located) {
        const clip = located.clip;
        const isImage = clip.kind === 'image';
        const el = isImage ? imageEls.get(clip.id) : videoEls.get(clip.id);
        if (el && sceneClipId !== clip.id) { await scene.setActiveVideo(el); sceneClipId = clip.id; }
        scene.setContentVisible(true);
        scene.setCrop(clip.crop ?? null);
        if (!isImage) {
          const v = videoEls.get(clip.id);
          if (v) {
            // Tolerance = half a SOURCE frame: if the output fps is higher than
            // the source's (or the clip is slowed down), consecutive output
            // frames map to the same source picture — seeking again would cost a
            // full decode round trip for an identical frame.
            const halfSrcFrame = 1 / (2 * Math.max(1, clip.fps || 30));
            const target = located.localMs / 1000; // localMs already accounts for clip speed
            const needed = Math.abs(v.currentTime - target) > halfSrcFrame;
            const t0 = performance.now();
            await seekExact(v, target, halfSrcFrame);
            seekMs = performance.now() - t0;
            prof.seek += seekMs;
            if (needed) prof.seeks++;
          }
        }
        const b = clip.displayBounds;
        const coord = b ? { width: b.w, height: b.h } : { width: clip.sourceWidth, height: clip.sourceHeight };
        const localForZoom = isImage ? 0 : located.localMs;
        scene.updateZoom(localForZoom, clip.zoomEvents, clip.mouseEvents, coord);
        scene.updateCursor(localForZoom, clip.mouseEvents, coord, project.cursor);

        const within = located.withinClipMs;
        const eff = clipEffectiveDurationMs(clip);
        let trans: { kind: 'fade' | 'darken' | 'flash' | 'pixelate'; strength: number } | null = null;
        const tin = clip.transitionIn;
        const tout = clip.transitionOut;
        if (tin && tin.durationMs > 0 && within < tin.durationMs) trans = { kind: tin.kind, strength: 1 - within / tin.durationMs };
        if (tout && tout.durationMs > 0 && within > eff - tout.durationMs) {
          const s = 1 - (eff - within) / tout.durationMs;
          if (!trans || s > trans.strength) trans = { kind: tout.kind, strength: s };
        }
        scene.applyTransition(trans);
      } else {
        scene.setContentVisible(false);
        scene.applyTransition(null);
      }

      scene.updateTexts(Math.round(masterMs), project.timeline.textEvents ?? [], null);
      scene.updateTimers(Math.round(masterMs), project.timeline.timerEvents ?? [], null);
      const tCompose = performance.now();
      prof.compose += tCompose - tFrame0 - seekMs;
      scene.forceVideoFrame();
      const tRender = performance.now();
      prof.render += tRender - tCompose;

      const frame = new VideoFrame(scene.canvas, { timestamp: Math.round(i * frameDurUs), duration: Math.round(frameDurUs) });
      encoder.encode(frame, { keyFrame: i % gop === 0 });
      frame.close();
      prof.encode += performance.now() - tRender;

      // Backpressure: wait while the encoder queue is deep; bail on error/cancel,
      // and fail (rather than hang) if a frame stalls > 15s. A DEEP queue matters:
      // it lets the encoder chew on already-composed frames while we seek/render
      // the next one, instead of the loop stalling on every single frame.
      const tWait0 = performance.now();
      let waited = 0;
      while (encoder.encodeQueueSize > 24) {
        if (encodeError) throw encodeError;
        if (shouldCancel()) throw new Error('CANCELLED');
        await new Promise((r) => setTimeout(r, 2));
        waited += 2;
        if (waited > 15000) throw new Error('The encoder stalled (frame ' + i + ').');
      }
      prof.wait += performance.now() - tWait0;
      const done = (i + 1) / totalFrames;
      if (done >= nextProfLog) {
        nextProfLog += 0.25;
        const n = i + 1;
        console.log(`[export] ${Math.round(done * 100)}% — per frame avg (ms): seek=${(prof.seek / n).toFixed(1)} compose=${(prof.compose / n).toFixed(1)} render=${(prof.render / n).toFixed(1)} encode=${(prof.encode / n).toFixed(1)} queueWait=${(prof.wait / n).toFixed(1)} | real seeks ${prof.seeks}/${n}`);
      }
      onProgress((done) * 100);
    }
    console.log(`[export] done. ${totalFrames} frames; totals (s): seek=${(prof.seek / 1000).toFixed(1)} compose=${(prof.compose / 1000).toFixed(1)} render=${(prof.render / 1000).toFixed(1)} encode=${(prof.encode / 1000).toFixed(1)} queueWait=${(prof.wait / 1000).toFixed(1)}`);

    if (encodeError) throw encodeError;
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    const buf = (muxer.target as ArrayBufferTarget).buffer;
    cleanup();
    return new Uint8Array(buf);
  } catch (err) {
    cleanup();
    throw err;
  }
}
