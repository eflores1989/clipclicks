import { PixiScene } from '../editor/PixiScene';
import { locateGlobal, clipEffectiveDurationMs, clipSpeed } from '@shared/lib/clipTime';
import { setExporting } from './exportBridge';
import type { AudioTrack, Project } from '@shared/types/project';

export interface ExportRenderOptions {
  project: Project;
  projectPath: string;
  width: number;   // target output width (even)
  height: number;  // target output height (even)
  fps: number;     // 30 | 60
  includeAudio: boolean;
  /** Bits/s for the intermediate WebM (the capture-quality ceiling). Higher =
   *  sharper but heavier realtime encode (risk of dropped frames). */
  videoBitsPerSecond: number;
  resolveUrl: (absPath: string) => Promise<string>;
  onProgress: (percent: number) => void; // 0..100 of the render (capture) phase
  shouldCancel: () => boolean;
}

// ── Persistent export scene ──────────────────────────────────────────────
// A SECOND PixiJS Application is destructive to the live preview one: PixiJS v8
// shares a global texture pool + GC across Applications, so destroying the
// export app corrupts the preview (blank video / crash). The fix is to NEVER
// destroy it — create it once, reuse + resize it on every export.
let exportScene: PixiScene | null = null;
let exportHost: HTMLDivElement | null = null;

export async function getExportScene(w: number, h: number): Promise<PixiScene> {
  if (!exportScene) {
    exportHost = document.createElement('div');
    exportHost.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;';
    document.body.appendChild(exportHost);
    exportScene = await PixiScene.create(exportHost, { w, h }, { maxWidth: Infinity, preserveDrawingBuffer: true, highQuality: true });
  } else {
    await exportScene.resize(w, h);
  }
  return exportScene;
}

/** Smooth gain ramp for an audio track's fades (mirrors audioSession.gainAt). */
function gainAt(t: AudioTrack, localMs: number, playLenMs: number): number {
  let g = t.volume;
  if (t.fadeInMs > 0 && localMs < t.fadeInMs) g *= localMs / t.fadeInMs;
  const foStart = playLenMs - t.fadeOutMs;
  if (t.fadeOutMs > 0 && localMs > foStart) g *= Math.max(0, (playLenMs - localMs) / t.fadeOutMs);
  return Math.max(0, Math.min(2, g));
}

function whenReady(el: HTMLVideoElement | HTMLAudioElement, timeoutMs = 8000): Promise<void> {
  return new Promise((res) => {
    if (el.readyState >= 1) { res(); return; }
    const done = (): void => { el.removeEventListener('loadedmetadata', done); el.removeEventListener('error', done); res(); };
    el.addEventListener('loadedmetadata', done, { once: true });
    el.addEventListener('error', done, { once: true });
    setTimeout(res, timeoutMs);
  });
}

/**
 * Render the whole timeline to a WebM (video + audio mix) by playing it through
 * in REAL TIME and capturing the composed canvas + a Web Audio mix. Reuses the
 * exact PixiScene compositing the preview uses, so every channel is included.
 * Returns the WebM bytes; the caller hands them to ffmpeg for the MP4.
 */
export async function renderTimelineToWebm(opts: ExportRenderOptions): Promise<Uint8Array> {
  const { project, projectPath, width, height, fps, includeAudio, videoBitsPerSecond, resolveUrl, onProgress, shouldCancel } = opts;

  let ctx: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;
  let rafId = 0;
  const videoEls = new Map<string, HTMLVideoElement>();
  const imageEls = new Map<string, HTMLImageElement>();
  const audioEls = new Map<string, HTMLAudioElement>();
  const gains = new Map<string, GainNode>();

  // Tear down per-export resources but KEEP the persistent scene alive.
  const cleanup = (): void => {
    cancelAnimationFrame(rafId);
    try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch { /* ignore */ }
    for (const v of videoEls.values()) { try { v.pause(); v.removeAttribute('src'); } catch { /* ignore */ } }
    for (const a of audioEls.values()) { try { a.pause(); a.removeAttribute('src'); } catch { /* ignore */ } }
    try { ctx?.close(); } catch { /* ignore */ }
    setExporting(false);
  };

  setExporting(true);
  try {
    const scene = await getExportScene(width, height);
    scene.applyBackground(project.background);
    scene.updateTexts(-1, [], null); // clear any leftover text nodes from a prior export
    scene.updateTimers(-1, [], null);

    // Create + preload one element per clip/track.
    const ready: Promise<unknown>[] = [];
    for (const c of project.clips) {
      const url = await resolveUrl(`${projectPath}/${c.filePath}`.replace(/\\/g, '/'));
      if (c.kind === 'image') {
        const img = new Image(); img.crossOrigin = 'anonymous'; img.src = url;
        imageEls.set(c.id, img);
        ready.push(img.decode().catch(() => {}));
      } else {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous'; v.preload = 'auto'; v.src = url; v.muted = !includeAudio;
        videoEls.set(c.id, v);
        ready.push(whenReady(v));
      }
    }
    for (const t of project.audioTracks) {
      const media = project.audioPool.find((m) => m.id === t.mediaId);
      if (!media) continue;
      const url = await resolveUrl(`${projectPath}/${media.filePath}`.replace(/\\/g, '/'));
      const a = new Audio(); a.crossOrigin = 'anonymous'; a.preload = 'auto'; a.src = url;
      audioEls.set(t.id, a);
      ready.push(whenReady(a));
    }
    await Promise.all(ready);
    if (shouldCancel()) throw new Error('CANCELLED');

    // Web Audio mix → a MediaStream we can attach to the recorder.
    let audioStream: MediaStream | null = null;
    if (includeAudio && (videoEls.size > 0 || audioEls.size > 0)) {
      ctx = new AudioContext();
      await ctx.resume().catch(() => {});
      const dest = ctx.createMediaStreamDestination();
      for (const [id, v] of videoEls) {
        try {
          const g = ctx.createGain(); g.gain.value = 0;
          ctx.createMediaElementSource(v).connect(g).connect(dest);
          gains.set(`clip:${id}`, g);
        } catch { /* not tappable; skip */ }
      }
      for (const [id, a] of audioEls) {
        try {
          const g = ctx.createGain(); g.gain.value = 0;
          ctx.createMediaElementSource(a).connect(g).connect(dest);
          gains.set(`aud:${id}`, g);
        } catch { /* skip */ }
      }
      audioStream = dest.stream;
    }

    const canvasStream = (scene.canvas as HTMLCanvasElement).captureStream(fps);
    const tracks = [...canvasStream.getVideoTracks(), ...(audioStream ? audioStream.getAudioTracks() : [])];
    const combined = new MediaStream(tracks);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
        ? 'video/webm;codecs=vp8,opus'
        : 'video/webm';
    recorder = new MediaRecorder(combined, { mimeType: mime, videoBitsPerSecond });
    const chunks: Blob[] = [];
    let recorderError: string | null = null;
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onerror = (e) => { recorderError = (e as unknown as { error?: { message?: string } }).error?.message ?? 'MediaRecorder error'; };
    const recorded = new Promise<Uint8Array>((resolve) => {
      recorder!.onstop = async () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        resolve(new Uint8Array(await blob.arrayBuffer()));
      };
    });

    const videoEnd = project.timeline.durationMs;
    const audioEnd = project.audioTracks.reduce((m, t) => Math.max(m, t.offsetMs + (t.outMs - t.inMs)), 0);
    const totalMs = Math.max(videoEnd, audioEnd, 1);

    // Pre-roll the first clip so frame 0 is decoded before recording starts.
    let sceneClipId: string | null = null;
    const first = project.clips[0];
    if (first) {
      if (first.kind === 'image') {
        const img = imageEls.get(first.id);
        if (img) { await scene.setVideo(img); sceneClipId = first.id; }
      } else {
        const v = videoEls.get(first.id);
        if (v) {
          await scene.setVideo(v);
          sceneClipId = first.id;
          v.currentTime = first.inMs / 1000;
          await new Promise<void>((res) => { v.addEventListener('seeked', () => res(), { once: true }); setTimeout(res, 800); });
        }
      }
      scene.forceVideoFrame();
    }
    if (shouldCancel()) throw new Error('CANCELLED');

    let pendingSwap = false;
    const startWall = performance.now();
    recorder.start();
    if (first && first.kind !== 'image') {
      const v = videoEls.get(first.id);
      if (v) { v.playbackRate = clipSpeed(first); v.play().catch(() => {}); }
    }

    await new Promise<void>((resolveLoop, rejectLoop) => {
      const loop = (): void => {
        if (shouldCancel()) { rejectLoop(new Error('CANCELLED')); return; }
        const masterMs = Math.min(totalMs, performance.now() - startWall);
        const located = masterMs <= videoEnd + 1 ? locateGlobal(project, masterMs) : null;

        if (located) {
          const clip = located.clip;
          const isImage = clip.kind === 'image';
          const el = isImage ? imageEls.get(clip.id) : videoEls.get(clip.id);
          if (el && sceneClipId !== clip.id && !pendingSwap) {
            pendingSwap = true;
            const target = clip.id;
            scene.setActiveVideo(el).finally(() => { sceneClipId = target; pendingSwap = false; });
            if (!isImage) {
              const v = el as HTMLVideoElement;
              v.playbackRate = clipSpeed(clip);
              try { v.currentTime = located.localMs / 1000; } catch { /* ignore */ }
              v.play().catch(() => {});
            }
          }
          scene.setContentVisible(true);
          scene.setCrop(clip.crop ?? null);
          if (!isImage) {
            const v = videoEls.get(clip.id);
            const expected = located.localMs / 1000;
            if (v) {
              if (v.paused && !v.ended) v.play().catch(() => {});
              if (Math.abs(v.currentTime - expected) * 1000 > 300) { try { v.currentTime = expected; } catch { /* ignore */ } }
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

          for (const [id, v] of videoEls) { if (id !== clip.id && !v.paused) { try { v.pause(); } catch { /* ignore */ } } }
        } else {
          scene.setContentVisible(false);
          scene.applyTransition(null);
          for (const v of videoEls.values()) { if (!v.paused) { try { v.pause(); } catch { /* ignore */ } } }
        }

        scene.updateTexts(Math.round(masterMs), project.timeline.textEvents ?? [], null);
        scene.updateTimers(Math.round(masterMs), project.timeline.timerEvents ?? [], null);

        if (ctx) {
          for (const c of project.clips) {
            if (c.kind === 'image') continue;
            const g = gains.get(`clip:${c.id}`);
            if (!g) continue;
            const active = located?.clip.id === c.id;
            g.gain.value = active && c.hasAudio && !c.audioMuted ? Math.max(0, Math.min(1, c.audioVolume ?? 1)) : 0;
          }
          for (const t of project.audioTracks) {
            const g = gains.get(`aud:${t.id}`);
            const a = audioEls.get(t.id);
            if (!g || !a) continue;
            const playLen = Math.max(0, t.outMs - t.inMs);
            const start = t.offsetMs;
            const inRange = masterMs >= start && masterMs < start + playLen && !t.muted;
            if (inRange) {
              const localMs = (masterMs - start) + t.inMs;
              const expected = localMs / 1000;
              if (a.paused) { try { a.currentTime = expected; } catch { /* ignore */ } a.play().catch(() => {}); }
              else if (Math.abs(a.currentTime - expected) * 1000 > 400) { try { a.currentTime = expected; } catch { /* ignore */ } }
              g.gain.value = Math.max(0, Math.min(1, gainAt(t, masterMs - start, playLen)));
            } else {
              if (!a.paused) { try { a.pause(); } catch { /* ignore */ } }
              g.gain.value = 0;
            }
          }
        }

        onProgress(Math.min(100, (masterMs / totalMs) * 100));
        if (masterMs >= totalMs) { resolveLoop(); return; }
        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    });

    await new Promise((r) => setTimeout(r, 200)); // flush the last frame
    try { recorder.stop(); } catch { /* ignore */ }
    const bytes = await recorded;
    if (recorderError) throw new Error(`Could not encode the video (${recorderError}). Try a lower resolution or quality.`);
    if (bytes.length < 1024) {
      throw new Error('Capture produced no video. This usually means the resolution is too high to encode live on this machine — try a lower resolution or quality.');
    }
    cleanup();
    return bytes;
  } catch (err) {
    cleanup();
    throw err;
  }
}
