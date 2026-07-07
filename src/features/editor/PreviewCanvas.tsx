import { useEffect, useRef, useState } from 'react';
import { PixiScene } from './PixiScene';
import {
  detachAllVideos,
  getActiveClipId,
  getActiveImage,
  getActiveVideo,
  setActiveClip,
  syncClipVideos,
} from './videoSession';
import { useProjectStore } from '@/stores/project';
import { usePlaybackStore } from '@/stores/playback';
import { useUiStore } from '@/stores/ui';
import { useSelectionStore } from '@/stores/selection';
import { applyEffectivePlaybackRate } from './playbackRate';
import {
  detachAllAudio,
  setAudioUrls,
  syncAudioElements,
  updateAudioPlayback,
} from './audioSession';
import { locateGlobal, clipEffectiveDurationMs } from '@shared/lib/clipTime';
import { CropOverlay } from './CropOverlay';
import { TextOverlay } from './TextOverlay';
import { TimerOverlay } from './TimerOverlay';
import { ZoomFocusOverlay } from './ZoomFocusOverlay';
import { isExporting } from '../export/exportBridge';
import type { Project } from '@shared/types/project';

interface PreviewCanvasProps {
  /** Path to the .vzproj root; used to resolve clip filePaths to vzasset URLs. */
  projectPath: string;
  sourceWidth: number;
  sourceHeight: number;
}

/**
 * Builds the URL map (clipId → vzasset URL) for every clip in the project.
 * The URLs are fetched once per clip from the main process.
 */
async function resolveClipUrls(
  project: Project,
  projectPath: string,
  existing: Map<string, string>,
): Promise<Map<string, string>> {
  const next = new Map<string, string>();
  for (const c of project.clips) {
    const cached = existing.get(c.id);
    if (cached) {
      next.set(c.id, cached);
      continue;
    }
    const absPath = `${projectPath}/${c.filePath}`.replace(/\\/g, '/');
    try {
      const url = await window.videoZoom.project.assetUrl(absPath);
      next.set(c.id, url);
    } catch (err) {
      console.error('[PreviewCanvas] could not resolve url for clip', c.id, err);
    }
  }
  return next;
}

export function PreviewCanvas({ projectPath, sourceWidth, sourceHeight }: PreviewCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<PixiScene | null>(null);
  const urlMapRef = useRef<Map<string, string>>(new Map());
  const background = useProjectStore((s) => s.project?.background);
  const [error, setError] = useState<string | null>(null);
  // The clip currently shown in the preview (at the playhead). Drives which
  // clip the crop editor operates on. Updated from the rAF tick only when it
  // changes, so it never thrashes React state.
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const cropEditMode = useUiStore((s) => s.cropEditMode);
  const trackEditMode = useUiStore((s) => s.trackEditMode);
  const paddingPct = useProjectStore((s) => s.project?.background.paddingPct ?? 0);
  const selectedTextId = useSelectionStore((s) => s.selectedTextId);
  const selectedTimerId = useSelectionStore((s) => s.selectedTimerId);
  const selectedZoomId = useSelectionStore((s) => s.selectedZoomId);

  // Build / rebuild PixiScene + video pool when the source URL (first clip)
  // or dimensions change. Subsequent clip additions/removals are handled by
  // the syncClipVideos effect below — they don't tear down the scene.
  useEffect(() => {
    let cancelled = false;
    const host = containerRef.current;
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);

    const init = async (): Promise<void> => {
      try {
        const project = useProjectStore.getState().project;
        if (!project) return;
        // Resolve URLs for all clips up-front.
        const urls = await resolveClipUrls(project, projectPath, urlMapRef.current);
        if (cancelled) return;
        urlMapRef.current = urls;
        // Hand them to the video session.
        const clipsForSession = project.clips
          .map((c) => ({ id: c.id, src: urls.get(c.id), kind: c.kind === 'image' ? 'image' as const : 'video' as const }))
          .filter((x): x is { id: string; src: string; kind: 'video' | 'image' } => !!x.src);
        syncClipVideos(clipsForSession);

        const firstClip = project.clips[0];
        if (!firstClip) return;
        const initialEl = setActiveClip(firstClip.id);
        if (!initialEl) return;
        setActiveClipId(firstClip.id);

        // Self-heal the clip's stored dimensions from the DECODED video. The
        // browser auto-applies rotation metadata, so videoWidth/videoHeight are
        // always the TRUE display dims — this fixes imported portrait clips that
        // were saved with landscape/rotated dimensions, with no ffmpeg probe or
        // app restart. Updating the store changes the sourceWidth/sourceHeight
        // props, which re-runs this effect and rebuilds the scene at the right
        // aspect (autosave then persists the correction).
        if (initialEl instanceof HTMLVideoElement) {
          if (initialEl.readyState < 1 /* HAVE_METADATA */) {
            await new Promise<void>((resolve) => {
              const done = (): void => resolve();
              initialEl.addEventListener('loadedmetadata', done, { once: true });
              initialEl.addEventListener('error', done, { once: true });
              setTimeout(done, 2000);
            });
          }
          if (cancelled) return;
          const vw = initialEl.videoWidth;
          const vh = initialEl.videoHeight;
          if (vw > 0 && vh > 0 && (vw !== sourceWidth || vh !== sourceHeight)) {
            console.log(`[PreviewCanvas] reconciling clip dims ${sourceWidth}x${sourceHeight} -> ${vw}x${vh}`);
            useProjectStore.getState().update((d) => {
              const c = d.clips.find((x) => x.id === firstClip.id);
              if (c) { c.sourceWidth = vw; c.sourceHeight = vh; }
            }, { record: false });
            return; // props changed → effect re-runs and builds at the right size
          }
        }

        const scene = await PixiScene.create(host, { w: sourceWidth, h: sourceHeight });
        if (cancelled) {
          scene.destroy();
          return;
        }
        sceneRef.current = scene;
        await scene.setVideo(initialEl);
        if (cancelled) return;
        const bg = useProjectStore.getState().project?.background;
        if (bg) scene.applyBackground(bg);

        // For a VIDEO first clip: snap currentTime to its inMs and make sure the
        // decoded frame lands on the canvas (wait for `seeked` + rVFC, then the
        // warm-up window below forces the upload). An IMAGE first clip is static
        // — setVideo already decoded + textured it, nothing to seek.
        if (initialEl instanceof HTMLVideoElement) {
          const initialVideo = initialEl;
          initialVideo.currentTime = firstClip.inMs / 1000;
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = (): void => { if (!done) { done = true; resolve(); } };
            initialVideo.addEventListener('seeked', () => finish(), { once: true });
            initialVideo.requestVideoFrameCallback(() => finish());
            setTimeout(finish, 1500);
          });
          if (cancelled) return;
          try { initialVideo.pause(); } catch { /* ignore */ }
        }
        usePlaybackStore.getState().setCurrentTime(0);
        usePlaybackStore.getState().setPlaying(false);

        // Main rAF loop. The whole timeline runs on a single virtual MASTER
        // CLOCK (`masterMs`) that advances at wall-clock × rate while playing
        // and follows the store while paused/scrubbing. The active video AND
        // the timeline audio are both SLAVED to it: each plays freely and we
        // only seek-correct when it drifts past tolerance. This is what makes
        // the player robust to any number of clips/audios — a clip that stalls
        // while buffering can no longer freeze the playhead or make the audio
        // stutter. (The old design used the active video's currentTime as the
        // master, so a buffering/just-added clip stalled everything and the
        // free-running audio re-seeked backward to chase it → the stutter.)
        let lastStoreUpdate = 0;
        let lastWasScrubbing = false;
        let lastReactClipId: string | null = firstClip.id;
        let pendingActiveSwap = false;
        let masterMs = 0;
        let lastStorePush = 0;
        let lastNow = performance.now();
        // Which clip's video texture the PixiScene sprite is currently showing.
        // Tracked SEPARATELY from videoSession's active clip: an external seek
        // (jump-to-start) switches the active clip but not the scene texture, so
        // the tick must reconcile them or the canvas freezes on the old frame.
        let sceneVideoClipId: string | null = firstClip.id;
        // First-frame warm-up. A PAUSED VideoSource won't push its decoded frame
        // to the GPU on its own, and the first decode can land late on a cold
        // open (worse with an audio track). While paused and before this
        // deadline, the loop forces the upload every frame — robust regardless
        // of how long the decode takes. Re-armed after every texture swap.
        let forceFrameUntil = performance.now() + 2000;
        // How far the slaved video may drift from the master before we snap it
        // back (buffering stalls, clip-boundary entry). Generous, so normal
        // playback — where both advance at real-time — never triggers a seek.
        const VIDEO_DRIFT_SEEK_MS = 250;

        const tick = (now: number): void => {
          if (cancelled) return;
          // While an export is capturing, stand down so two WebGL apps aren't
          // both doing heavy work. The export uses its own (separate) scene, so
          // the preview scene is untouched and resumes cleanly afterwards.
          if (isExporting()) { rafId = requestAnimationFrame(tick); return; }
          const proj = useProjectStore.getState().project;
          const scene = sceneRef.current;
          if (!proj || !scene) { rafId = requestAnimationFrame(tick); return; }

          const ps = usePlaybackStore.getState();
          const scrubbing = ps.isScrubbing;
          const playing = ps.playing;
          const rate = ps.playbackRate || 1;

          const videoEnd = proj.timeline.durationMs;
          const audioEnd = proj.audioTracks.reduce((m, t) => Math.max(m, t.offsetMs + (t.outMs - t.inMs)), 0);
          const totalMs = Math.max(videoEnd, audioEnd);

          // ── Advance / sync the master clock ──
          const dt = now - lastNow;
          lastNow = now;
          if (playing && !scrubbing) {
            // Adopt external seeks (transport buttons, loop-to-0, scrub release):
            // if the store no longer holds the value we last wrote, jump to it.
            const storeNow = Math.round(ps.currentTimeMs);
            if (storeNow !== lastStorePush) { masterMs = storeNow; lastStorePush = storeNow; }
            masterMs += dt * rate;
            if (masterMs >= totalMs) { masterMs = totalMs; ps.setPlaying(false); }
          } else {
            // Paused / scrubbing: the store position is authoritative.
            masterMs = ps.currentTimeMs;
          }
          masterMs = Math.max(0, Math.min(totalMs, masterMs));

          // Reset cursor smoothing while scrubbing (and on release) so the halo
          // snaps to the scrubbed position instead of LERP-lagging behind it.
          if (scrubbing || (lastWasScrubbing && !scrubbing)) scene.resetSmoothingState();
          lastWasScrubbing = scrubbing;

          // ── Locate the clip under the master clock (null = audio-only zone) ──
          const located = masterMs <= videoEnd + 1 ? locateGlobal(proj, masterMs) : null;

          // Keep videoSession's active clip in sync with the located clip.
          if (located && getActiveClipId() !== located.clip.id) {
            setActiveClip(located.clip.id);
          }
          if (located && located.clip.id !== lastReactClipId) {
            lastReactClipId = located.clip.id;
            setActiveClipId(located.clip.id); // surface to React for the crop overlay
          }

          const activeVideo = getActiveVideo();          // null when the active clip is an image
          const mediaEl = activeVideo ?? getActiveImage(); // the element on the sprite
          // Reconcile the PixiScene texture with the active clip. Runs even when
          // the active clip changed externally (jump-to-start / scrub seek set
          // the active clip but not the scene texture) — otherwise the canvas
          // stays frozen on the previous clip's frame.
          if (located && mediaEl && sceneVideoClipId !== located.clip.id && !pendingActiveSwap) {
            pendingActiveSwap = true;
            const target = located.clip.id;
            scene.setActiveVideo(mediaEl).finally(() => {
              sceneVideoClipId = target;
              forceFrameUntil = performance.now() + 1200; // paint the new frame
              pendingActiveSwap = false;
            });
          }
          if (located && mediaEl) {
            const clip = located.clip;
            scene.setContentVisible(true);
            scene.setCrop(clip.crop ?? null);
            scene.setCropEditMode(useUiStore.getState().cropEditMode);
            scene.setTrackEditMode(useUiStore.getState().trackEditMode);

            if (activeVideo) {
              // ── VIDEO clip: drive embedded audio + slave to the master clock ──
              const wantMuted = !clip.hasAudio || !!clip.audioMuted;
              if (activeVideo.muted !== wantMuted) activeVideo.muted = wantMuted;
              const vol = Math.max(0, Math.min(1, clip.audioVolume ?? 1));
              if (activeVideo.volume !== vol) activeVideo.volume = vol;

              const expectedSec = located.localMs / 1000;
              // Don't replay an `ended` element (that would restart it from 0 and
              // flash the first frame); its last frame stays until the master
              // crosses into the next clip.
              if (playing && !scrubbing) {
                if (activeVideo.paused && !activeVideo.ended) activeVideo.play().catch(() => {});
                if (Math.abs(activeVideo.currentTime - expectedSec) * 1000 > VIDEO_DRIFT_SEEK_MS) {
                  try { activeVideo.currentTime = expectedSec; } catch { /* ignore */ }
                }
              } else {
                if (!activeVideo.paused) { try { activeVideo.pause(); } catch { /* ignore */ } }
                if (Math.abs(activeVideo.currentTime - expectedSec) * 1000 > 40) {
                  try { activeVideo.currentTime = expectedSec; } catch { /* ignore */ }
                  scene.forceVideoFrame();
                } else if (now < forceFrameUntil) {
                  // No drift, but within the warm-up window after a load/swap:
                  // keep pushing the decoded frame so a late cold-open decode
                  // lands on the canvas instead of leaving it black.
                  scene.forceVideoFrame();
                }
              }
            } else if (now < forceFrameUntil) {
              // ── IMAGE clip: static, nothing to slave. Just make sure the
              // freshly-swapped texture is painted during the warm-up window. ──
              scene.forceVideoFrame();
            }

            // Zoom + cursor from the clip-local time (cursor AFTER zoom so it
            // reads the videoSprite's current transform). Image clips have empty
            // events → identity transform (also resets any prior clip's zoom) and
            // no cursor. Their "local time" is 0 (no source playback).
            const bounds = clip.displayBounds;
            const coordSpace = bounds
              ? { width: bounds.w, height: bounds.h }
              : { width: clip.sourceWidth, height: clip.sourceHeight };
            const localForZoom = activeVideo ? located.localMs : 0;
            scene.updateZoom(localForZoom, clip.zoomEvents, clip.mouseEvents, coordSpace);
            scene.updateCursor(localForZoom, clip.mouseEvents, coordSpace, proj.cursor);

            // Transition overlay on this clip's edges. strength = 0 at rest → 1
            // at the cut. Out-edge wins near the cut if both would be active.
            const within = located.withinClipMs;
            const eff = clipEffectiveDurationMs(clip);
            let trans: { kind: 'fade' | 'darken' | 'flash' | 'pixelate'; strength: number } | null = null;
            const tin = clip.transitionIn;
            const tout = clip.transitionOut;
            if (tin && tin.durationMs > 0 && within < tin.durationMs) {
              trans = { kind: tin.kind, strength: 1 - within / tin.durationMs };
            }
            if (tout && tout.durationMs > 0 && within > eff - tout.durationMs) {
              const s = 1 - (eff - within) / tout.durationMs;
              if (!trans || s > trans.strength) trans = { kind: tout.kind, strength: s };
            }
            scene.applyTransition(trans);
          } else if (!located) {
            // Audio-only zone past the end of the video → show a black frame.
            scene.setContentVisible(false);
            scene.applyTransition(null);
            if (activeVideo && !activeVideo.paused) { try { activeVideo.pause(); } catch { /* ignore */ } }
          }

          // ── Text overlays (global timeline, on top of everything) ──
          scene.updateTexts(
            Math.round(masterMs),
            proj.timeline.textEvents ?? [],
            useSelectionStore.getState().selectedTextId,
          );
          // ── Timers (chronometers, same top layer) ──
          scene.updateTimers(
            Math.round(masterMs),
            proj.timeline.timerEvents ?? [],
            useSelectionStore.getState().selectedTimerId,
          );

          // ── Drive the timeline audio from the master clock, ALWAYS ──
          // Wrapped defensively: an audio glitch must never kill the rAF loop
          // (that would freeze the playhead + transport).
          if (proj.audioTracks.length > 0) {
            try {
              const mediaById = new Map(proj.audioPool.map((m) => [m.id, m]));
              updateAudioPlayback(Math.round(masterMs), playing && !scrubbing, proj.audioTracks, mediaById);
            } catch (err) {
              console.warn('[PreviewCanvas] audio playback tick error (ignored):', err);
            }
          }

          // ── Publish the master to the store (throttled while playing) ──
          if (playing && !scrubbing && now - lastStoreUpdate > 50) {
            const rounded = Math.round(masterMs);
            ps.setCurrentTime(rounded);
            lastStorePush = rounded;
            lastStoreUpdate = now;
          }

          rafId = requestAnimationFrame(tick);
        };
        let rafId = requestAnimationFrame(tick);

        // Cleanup binding moved into outer return so it captures rafId.
        (host as unknown as { __vz_rafId?: number }).__vz_rafId = rafId;
      } catch (err) {
        if (!cancelled) setError(`Could not initialise preview: ${(err as Error).message}`);
      }
    };
    init();

    return () => {
      cancelled = true;
      const ridStash = (host as unknown as { __vz_rafId?: number }).__vz_rafId;
      if (ridStash) cancelAnimationFrame(ridStash);
      detachAllVideos();
      detachAllAudio();
      if (sceneRef.current) {
        sceneRef.current.destroy();
        sceneRef.current = null;
      }
      while (host.firstChild) host.removeChild(host.firstChild);
    };
  }, [projectPath, sourceWidth, sourceHeight]);

  // Resolve audio-pool URLs + keep the audio element pool in sync with the
  // current tracks. Keyed on the audio media + track ids so it re-runs on
  // import / add / remove.
  const audioPoolKey = useProjectStore((s) => (s.project?.audioPool ?? []).map((m) => m.id).join('|'));
  const audioTrackKey = useProjectStore((s) => (s.project?.audioTracks ?? []).map((t) => t.id).join('|'));
  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      const project = useProjectStore.getState().project;
      if (!project) return;
      const map = new Map<string, string>();
      for (const m of project.audioPool) {
        const absPath = `${projectPath}/${m.filePath}`.replace(/\\/g, '/');
        try {
          map.set(m.id, await window.videoZoom.project.assetUrl(absPath));
        } catch (err) {
          console.warn('[PreviewCanvas] audio url resolve failed', m.id, err);
        }
      }
      if (cancelled) return;
      setAudioUrls(map);
      syncAudioElements(project.audioTracks);
    };
    run();
    return () => { cancelled = true; };
  }, [audioPoolKey, audioTrackKey, projectPath]);

  // Sync video pool when the clips array changes (add/split/delete).
  const clipIds = useProjectStore((s) => s.project?.clips.map((c) => c.id).join('|') ?? '');
  useEffect(() => {
    let cancelled = false;
    const run = async (): Promise<void> => {
      const project = useProjectStore.getState().project;
      if (!project) return;
      const urls = await resolveClipUrls(project, projectPath, urlMapRef.current);
      if (cancelled) return;
      urlMapRef.current = urls;
      const clipsForSession = project.clips
        .map((c) => ({ id: c.id, src: urls.get(c.id), kind: c.kind === 'image' ? 'image' as const : 'video' as const }))
        .filter((x): x is { id: string; src: string; kind: 'video' | 'image' } => !!x.src);
      syncClipVideos(clipsForSession);
    };
    run();
    return () => { cancelled = true; };
  }, [clipIds, projectPath]);

  // Pause playback while editing the crop so the active clip can't switch
  // out from under the overlay mid-edit.
  useEffect(() => {
    if (!cropEditMode) return;
    const v = getActiveVideo();
    if (v && !v.paused) v.pause();
    usePlaybackStore.getState().setPlaying(false);
  }, [cropEditMode]);

  // Same for track-edit: keep it paused so scrubbing to a moment and dropping
  // a focus point is deliberate (the clip won't advance under the dot).
  useEffect(() => {
    if (!trackEditMode) return;
    const v = getActiveVideo();
    if (v && !v.paused) v.pause();
    usePlaybackStore.getState().setPlaying(false);
  }, [trackEditMode]);

  // Apply background changes without rebuilding the scene.
  useEffect(() => {
    if (!sceneRef.current || !background) return;
    sceneRef.current.applyBackground(background);
  }, [background]);

  // Keep video.playbackRate = clip.speed × preview.rate.
  useEffect(() => {
    applyEffectivePlaybackRate();
    const unsubProject = useProjectStore.subscribe(applyEffectivePlaybackRate);
    return () => unsubProject();
  }, []);

  // Mirror project.timeline.durationMs into playback.durationMs so the Timeline
  // ruler + playhead positioning + scrub bounds-check all read a single value.
  // Pre-5C this was set from video.duration on loadedmetadata; under multi-clip
  // the project's timeline (sum of effective clip durations) is the source of
  // truth, not any individual video's natural duration.
  useEffect(() => {
    const apply = (): void => {
      const proj = useProjectStore.getState().project;
      if (!proj) return;
      // The playable timeline extends to the LONGER of the video and the audio
      // tracks, so playback (and the transport total) cover an audio tail that
      // outlasts the video.
      const audioEnd = proj.audioTracks.reduce((m, t) => Math.max(m, t.offsetMs + (t.outMs - t.inMs)), 0);
      usePlaybackStore.getState().setDuration(Math.max(proj.timeline.durationMs, audioEnd));
    };
    apply();
    const unsub = useProjectStore.subscribe(apply);
    return () => unsub();
  }, []);

  return (
    <div
      ref={containerRef}
      className="preview-canvas"
      style={{ aspectRatio: `${sourceWidth} / ${sourceHeight}`, ['--vz-ar']: sourceWidth / sourceHeight } as React.CSSProperties}
    >
      {error && <div className="preview-canvas__error">{error}</div>}
      {cropEditMode && activeClipId && (
        <CropOverlay clipId={activeClipId} paddingPct={paddingPct} />
      )}
      {!cropEditMode && !trackEditMode && selectedTextId && <TextOverlay />}
      {!cropEditMode && !trackEditMode && selectedTimerId && <TimerOverlay />}
      {trackEditMode && selectedZoomId && (
        <ZoomFocusOverlay paddingPct={paddingPct} />
      )}
    </div>
  );
}
