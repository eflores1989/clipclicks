import { useCallback } from 'react';
import { useRecordingStore } from '@/stores/recording';
import { useUiStore } from '@/stores/ui';
import { useProjectStore } from '@/stores/project';
import type { RecordingSource } from '@shared/types/recording';

const MIME_CANDIDATES = [
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

function pickMimeType(): string {
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return 'video/webm';
}

/** True if an error bubbling up from main is the "user cancelled" sentinel. */
function isCancellation(err: unknown): boolean {
  const msg = (err as Error)?.message ?? '';
  return msg === 'CANCELLED' || msg.includes('CANCELLED');
}

// Module-level singleton: there is only ever one active recording, and it must
// outlive component remounts (the recording starts in SourcePicker but Stop is
// pressed in RecordingBar, which is a different component tree).
interface Session {
  /** True iff main is running ffmpeg as the video recorder (cursor exclusion). */
  nativeMode: boolean;
  recorder: MediaRecorder | null;
  stream: MediaStream | null;
  chunks: Blob[];
  mime: string;
  videoMeta: { width: number; height: number; fps: number };
  displayBounds: { x: number; y: number; w: number; h: number } | null;
  /** True if the user kept the OS cursor in the capture stream. */
  systemCursorCaptured: boolean;
  /**
   * Promise resolving to the delta between `uiohook` start (`startedAtEpoch`)
   * and the first encoded video frame. Used to shift `mouseEvent.t` into the
   * video timeline. Two sources depending on mode:
   *   - MediaRecorder mode → resolved by `requestVideoFrameCallback` on a
   *     hidden `<video>` reading the live stream.
   *   - Native (ffmpeg) mode → resolved by parsing ffmpeg's stderr in main
   *     and returned via the stop() IPC; we forward the value here once
   *     stop returns.
   */
  videoStartOffsetMs: Promise<number>;
  /** Only set in MediaRecorder mode — exposed so stop() can hand the value over. */
  resolveVideoStartOffset?: (n: number) => void;
  /** Hidden video element kept alive so rVFC keeps firing. Stopped on dispose. */
  probeVideo: HTMLVideoElement | null;
  /** True if any audio source was captured into this recording. */
  hasAudio: boolean;
  /** Tear down audio capture streams/contexts. */
  audioCleanup: (() => void) | null;
  /** Native mode only: parallel audio-only recorder + its chunks (muxed at save). */
  audioRecorder: MediaRecorder | null;
  audioChunks: Blob[];
}
let session: Session | null = null;

function captureVideoMeta(stream: MediaStream): { width: number; height: number; fps: number } {
  const track = stream.getVideoTracks()[0];
  if (!track) return { width: 1920, height: 1080, fps: 30 };
  const settings = track.getSettings();
  return {
    width: typeof settings.width === 'number' ? settings.width : 1920,
    height: typeof settings.height === 'number' ? settings.height : 1080,
    fps: typeof settings.frameRate === 'number' ? Math.round(settings.frameRate) : 30,
  };
}

function clearSession(): void {
  if (!session) return;
  if (session.recorder) {
    try {
      if (session.recorder.state !== 'inactive') {
        session.recorder.onstop = null;
        session.recorder.stop();
      }
    } catch {
      /* ignore */
    }
  }
  if (session.stream) {
    session.stream.getTracks().forEach((t) => {
      try { t.stop(); } catch { /* ignore */ }
    });
  }
  if (session.probeVideo) {
    try { session.probeVideo.pause(); } catch { /* ignore */ }
    session.probeVideo.srcObject = null;
    session.probeVideo = null;
  }
  if (session.audioRecorder && session.audioRecorder.state !== 'inactive') {
    try { session.audioRecorder.stop(); } catch { /* ignore */ }
  }
  if (session.audioCleanup) { try { session.audioCleanup(); } catch { /* ignore */ } }
  session = null;
}

/**
 * Anchor the video timeline. Attach a hidden `<video>` element to the live
 * MediaStream, then wait for the first `requestVideoFrameCallback`. The
 * callback fires when Chromium actually delivers a frame from the capture
 * source — which is the correct moment to call "video time = 0", far more
 * accurate than `Date.now()` right after `mediaRecorder.start()`.
 *
 * Returns a promise that resolves with the offset (in ms) between
 * `startedAtEpoch` and the first frame, plus the hidden video element so the
 * caller can keep it alive until recording stops (otherwise the track may be
 * GC'd before rVFC fires).
 */
function startVideoFrameAnchor(
  stream: MediaStream,
  startedAtEpoch: number,
): { offsetPromise: Promise<number>; probeVideo: HTMLVideoElement } {
  const probe = document.createElement('video');
  probe.muted = true;
  probe.playsInline = true;
  probe.srcObject = stream;
  // Off-DOM playback is fine; we just need the track to deliver frames so
  // rVFC fires.
  probe.play().catch(() => { /* ignore — autoplay should work, muted */ });

  // Realistic capture/codec latency is well under a second. If our measurement
  // somehow comes back larger (rVFC never fired, clock-domain mismatch, slow
  // audio acquisition), we CLAMP it — shifting mouseEvents by a bogus multi-
  // second offset would drop nearly all of them and break auto-zoom. A small
  // sync error is far better than losing the events entirely.
  const MAX_OFFSET_MS = 1200;
  const FALLBACK_OFFSET_MS = 250;

  const offsetPromise = new Promise<number>((resolve) => {
    let resolved = false;
    const finish = (raw: number, reason: string): void => {
      if (resolved) return;
      resolved = true;
      const clamped = Math.max(0, Math.min(MAX_OFFSET_MS, raw));
      console.log(`[useRecorder] first-frame offset: ${clamped.toFixed(0)}ms (${reason}${clamped !== raw ? `, clamped from ${raw.toFixed(0)}` : ''})`);
      resolve(clamped);
    };
    const onFirstFrame = (): void => {
      // Use the delivery epoch (reliable, comparable to main's startedAtEpoch).
      finish(Date.now() - startedAtEpoch, 'rVFC');
    };
    if ('requestVideoFrameCallback' in probe) {
      probe.requestVideoFrameCallback(onFirstFrame);
    } else {
      finish(FALLBACK_OFFSET_MS, 'no-rVFC');
    }
    // Safety net: if no frame arrives in time, use the small fallback (NOT the
    // elapsed wall-clock — that would be huge and drop events).
    setTimeout(() => { if (!resolved) finish(FALLBACK_OFFSET_MS, 'timeout'); }, 2500);
  });

  return { offsetPromise, probeVideo: probe };
}

interface StartOptions {
  /** If false, request the capture stream without the OS cursor (cursor: 'never'). */
  captureSystemCursor: boolean;
  /** Capture the microphone into the clip's audio. */
  captureMic: boolean;
  /** Capture system audio (Windows loopback) into the clip's audio. */
  captureSystemAudio: boolean;
}

/** Acquire the microphone as a standalone stream. Null on failure/denied. */
async function getMicStream(): Promise<MediaStream | null> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    console.warn('[useRecorder] mic capture failed:', err);
    return null;
  }
}

/**
 * Combine N audio tracks into ONE output track. With a single track we wrap it
 * directly; with several we sum them through a Web Audio graph. Returns the
 * mixed track(s) as a MediaStream plus a cleanup that closes the context.
 *
 * NOTE: system (desktop loopback) audio is NOT captured here — Chromium
 * crashes ("bad IPC message") on a standalone desktop-audio getUserMedia. It
 * must be requested together with the desktop VIDEO in one call, which the
 * MediaRecorder path does; that track is then passed in here for mixing.
 */
function mixAudioTracks(tracks: MediaStreamTrack[]): { stream: MediaStream; cleanup: () => void } | null {
  if (tracks.length === 0) return null;
  if (tracks.length === 1) {
    return { stream: new MediaStream(tracks), cleanup: () => { /* tracks owned by their source streams */ } };
  }
  const ctx = new AudioContext();
  const dest = ctx.createMediaStreamDestination();
  for (const tr of tracks) {
    ctx.createMediaStreamSource(new MediaStream([tr])).connect(dest);
  }
  return { stream: dest.stream, cleanup: () => { ctx.close().catch(() => { /* ignore */ }); } };
}

export function useRecorder() {
  const start = useCallback(async (source: RecordingSource, options: StartOptions) => {
    const ui = useUiStore.getState();
    const rec = useRecordingStore.getState();

    if (session) {
      console.warn('[useRecorder] start() called while a session was already active — clearing');
      clearSession();
    }

    rec.setStatus('starting');
    rec.setError(null);

    // Window capture + a second media stream (mic) or desktop-audio-with-window
    // blacks out the video on Windows/Chromium. So audio is only supported for
    // full-screen captures. Force it off for window sources.
    const captureMic = source.kind === 'screen' && options.captureMic;
    const captureSystemAudio = source.kind === 'screen' && options.captureSystemAudio;

    // Native mode (ffmpeg + gdigrab -draw_mouse 0) is the only way to actually
    // exclude the OS cursor from the recorded video on Windows. We ask main
    // to spawn ffmpeg when the user opted out AND the source is a full screen
    // (gdigrab can only address displays by offset/size). For window captures
    // we fall back to the MediaRecorder path with the cursor still visible.
    const wantNative = !options.captureSystemCursor && source.kind === 'screen';

    let startResult: {
      recordingId: string;
      startedAtEpoch: number;
      mouseHookActive: boolean;
      displayBounds: { x: number; y: number; w: number; h: number } | null;
      nativeCaptureActive: boolean;
    };
    try {
      startResult = await window.videoZoom.recorder.start({
        source,
        useNativeCapture: wantNative,
      });
    } catch (err) {
      rec.setError(`Could not start mouse hook: ${(err as Error).message}`);
      return;
    }

    if (startResult.nativeCaptureActive) {
      // ffmpeg owns the video. The renderer just orchestrates start/stop.
      // The offset will arrive via the stop IPC response; until then we hold
      // a deferred promise so stop() can `await` it uniformly.
      let resolveOffset!: (n: number) => void;
      const offsetPromise = new Promise<number>((resolve) => { resolveOffset = resolve; });

      // Native (no-cursor) mode: only MIC audio is supported. System loopback
      // would require a desktop-video getUserMedia (which ffmpeg replaces), and
      // a standalone desktop-audio request crashes Chromium — so skip it.
      if (captureSystemAudio) {
        console.warn('[useRecorder] system audio is not available in no-cursor (native) mode — capturing mic only');
      }
      let micStream: MediaStream | null = null;
      let audioMix: { stream: MediaStream; cleanup: () => void } | null = null;
      if (captureMic) {
        micStream = await getMicStream();
        if (micStream) audioMix = mixAudioTracks(micStream.getAudioTracks());
      }
      const audioCleanup = (): void => {
        micStream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
        audioMix?.cleanup();
      };

      let audioRecorder: MediaRecorder | null = null;
      const audioChunks: Blob[] = [];
      if (audioMix) {
        try {
          const am = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
          audioRecorder = new MediaRecorder(audioMix.stream, { mimeType: am });
          audioRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
          audioRecorder.start(1000);
        } catch (err) {
          console.warn('[useRecorder] could not start parallel audio recorder:', err);
          audioRecorder = null;
        }
      }

      const bounds = startResult.displayBounds;
      session = {
        nativeMode: true,
        recorder: null,
        stream: null,
        chunks: [],
        mime: 'video/mp4',
        videoMeta: { width: bounds?.w ?? 1920, height: bounds?.h ?? 1080, fps: 30 },
        displayBounds: bounds,
        systemCursorCaptured: false,
        videoStartOffsetMs: offsetPromise,
        resolveVideoStartOffset: resolveOffset,
        probeVideo: null,
        hasAudio: !!audioRecorder,
        audioCleanup,
        audioRecorder,
        audioChunks,
      };
    } else {
      // MediaRecorder path: getUserMedia + chromeMediaSource: 'desktop'. System
      // audio (if requested) MUST be requested in the SAME call as the desktop
      // video — a standalone desktop-audio request crashes Chromium. Mic is a
      // separate getUserMedia and gets mixed in afterwards.
      let avStream: MediaStream;
      try {
        const videoConstraints = {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: source.id,
            maxWidth: 3840,
            maxHeight: 2160,
            maxFrameRate: 60,
          },
        };
        const audioConstraint = captureSystemAudio
          ? ({ mandatory: { chromeMediaSource: 'desktop' } } as unknown as MediaTrackConstraints)
          : false;
        avStream = await navigator.mediaDevices.getUserMedia({
          audio: audioConstraint,
          video: videoConstraints as unknown as MediaTrackConstraints,
        });
      } catch (err) {
        await window.videoZoom.recorder.cancel();
        rec.setError(`Could not capture screen: ${(err as Error).message}`);
        return;
      }

      // Mic in a separate stream, then mix mic + any system-audio track.
      let micStream: MediaStream | null = null;
      if (captureMic) micStream = await getMicStream();
      const audioTracks = [...avStream.getAudioTracks(), ...(micStream?.getAudioTracks() ?? [])];
      const audioMix = mixAudioTracks(audioTracks);
      const audioCleanup = (): void => {
        micStream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
        audioMix?.cleanup();
      };

      // The recorded stream is the desktop VIDEO track + the mixed audio (if any).
      const videoOnly = new MediaStream(avStream.getVideoTracks());
      const recordStream = audioMix
        ? new MediaStream([...avStream.getVideoTracks(), ...audioMix.stream.getAudioTracks()])
        : avStream;

      const mime = pickMimeType();
      const mediaRecorder = new MediaRecorder(recordStream, {
        mimeType: mime,
        videoBitsPerSecond: 8_000_000,
      });

      // rVFC anchor reads the video track only.
      const anchor = startVideoFrameAnchor(videoOnly, startResult.startedAtEpoch);
      mediaRecorder.start(1000);

      session = {
        nativeMode: false,
        recorder: mediaRecorder,
        stream: avStream,
        chunks: [],
        mime,
        videoMeta: captureVideoMeta(avStream),
        displayBounds: startResult.displayBounds,
        systemCursorCaptured: options.captureSystemCursor,
        videoStartOffsetMs: anchor.offsetPromise,
        probeVideo: anchor.probeVideo,
        hasAudio: audioTracks.length > 0,
        audioCleanup,
        audioRecorder: null,
        audioChunks: [],
      };

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0 && session) session.chunks.push(e.data);
      };

      mediaRecorder.onerror = (e) => {
        console.error('[MediaRecorder] error', e);
        useRecordingStore.getState().setError('MediaRecorder error');
      };
    }

    rec.setSelectedSource(source);
    rec.setStart(startResult.startedAtEpoch, startResult.mouseHookActive);
    rec.setStatus('recording');

    await window.videoZoom.window.enterRecording();
    ui.setView('recording');
  }, []);

  const pause = useCallback(async () => {
    if (!session) {
      console.warn('[useRecorder] pause() called with no active session');
      return;
    }
    if (session.nativeMode) {
      // Pause is not yet supported in native mode (ffmpeg gdigrab keeps
      // running). For MVP we silently no-op; UI should hide the pause button
      // when nativeMode is true.
      console.warn('[useRecorder] pause not supported in native mode');
      return;
    }
    if (!session.recorder || session.recorder.state !== 'recording') return;
    session.recorder.pause();
    await window.videoZoom.recorder.pause();
    useRecordingStore.getState().pause();
  }, []);

  const resume = useCallback(async () => {
    if (!session) return;
    if (session.nativeMode) return;
    if (!session.recorder || session.recorder.state !== 'paused') return;
    session.recorder.resume();
    await window.videoZoom.recorder.resume();
    useRecordingStore.getState().resume();
  }, []);

  const stop = useCallback(async () => {
    if (!session) {
      console.warn('[useRecorder] stop() called with no active session');
      return;
    }
    const localSession = session;
    const rec = useRecordingStore.getState();
    const ui = useUiStore.getState();

    rec.setStatus('stopping');
    ui.setView('saving');

    // MediaRecorder cleanup happens BEFORE the IPC stop so we have the blob
    // ready. In native mode there's no MediaRecorder — main owns the file.
    if (!localSession.nativeMode && localSession.recorder) {
      if (localSession.recorder.state === 'paused') {
        localSession.recorder.resume();
      }
      const stopped = new Promise<void>((resolve) => {
        localSession.recorder!.onstop = () => resolve();
      });
      try {
        localSession.recorder.stop();
      } catch (err) {
        console.error('[useRecorder] recorder.stop() threw', err);
      }
      await stopped;
      localSession.stream?.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
    }

    // Native mode: stop the parallel audio recorder and collect its blob so we
    // can mux it into the gdigrab MP4 at save time.
    let nativeAudioBytes: Uint8Array | null = null;
    if (localSession.nativeMode && localSession.audioRecorder) {
      const ar = localSession.audioRecorder;
      const adone = new Promise<void>((resolve) => { ar.onstop = () => resolve(); });
      try { ar.stop(); } catch { /* ignore */ }
      await adone;
      const ablob = new Blob(localSession.audioChunks, { type: ar.mimeType });
      if (ablob.size > 0) nativeAudioBytes = new Uint8Array(await ablob.arrayBuffer());
    }
    // Release mic/system streams + audio context.
    if (localSession.audioCleanup) { try { localSession.audioCleanup(); } catch { /* ignore */ } }

    let stopResult;
    try {
      stopResult = await window.videoZoom.recorder.stop();
    } catch (err) {
      rec.setError(`Stop failed: ${(err as Error).message}`);
      session = null;
      await window.videoZoom.window.exitRecording();
      ui.setView('launcher');
      return;
    }

    // In native mode, the offset comes from main's ffmpeg-stderr parsing —
    // surface it through the session's deferred promise so the downstream
    // code can `await` it the same way as the MediaRecorder path.
    if (localSession.nativeMode && stopResult.nativeCapture) {
      localSession.resolveVideoStartOffset?.(stopResult.nativeCapture.firstFrameOffsetMs);
    } else if (localSession.nativeMode) {
      // Native flag was set at start but main didn't return native meta —
      // fall back to a zero offset so save can still proceed.
      console.warn('[useRecorder] native mode active but no nativeCapture meta from main');
      localSession.resolveVideoStartOffset?.(0);
    }

    rec.setMouseEventCount(stopResult.mouseEvents.length);
    rec.setStatus('saving');

    // Shift every mouseEvent so its `t` is in the VIDEO timeline rather than
    // the uiohook timeline. The offset comes from a `requestVideoFrameCallback`
    // promise that fires when Chromium actually delivers the first captured
    // frame — accurate to ~1 frame. Events whose original `t` lands before
    // the offset happened before the video began, so we drop them.
    const offset = await localSession.videoStartOffsetMs;
    console.log(`[useRecorder] aligning ${stopResult.mouseEvents.length} events by ${offset.toFixed(0)}ms`);
    // Release the probe video before async save work to free its decoder slot.
    if (localSession.probeVideo) {
      try { localSession.probeVideo.pause(); } catch { /* ignore */ }
      localSession.probeVideo.srcObject = null;
      localSession.probeVideo = null;
    }
    const alignedMouseEvents = stopResult.mouseEvents
      .map((ev) => ({ ...ev, t: ev.t - offset }))
      .filter((ev) => ev.t >= 0);

    const source = rec.selectedSource;
    if (!source) {
      rec.setError('Lost source reference while saving');
      session = null;
      await window.videoZoom.window.exitRecording();
      ui.setView('launcher');
      return;
    }

    let saveResult;
    try {
      if (localSession.nativeMode) {
        // ffmpeg already wrote the MP4 to staging. Persist events + meta; pass
        // the parallel audio blob (if any) so main muxes it into the MP4.
        saveResult = await window.videoZoom.recorder.save({
          recordingId: stopResult.recordingId,
          // videoBytes intentionally omitted — main detects native mode by
          // its absence and the existing .mp4 in staging.
          audioBytes: nativeAudioBytes ?? undefined,
          mouseEvents: alignedMouseEvents,
          durationMs: stopResult.durationMs,
          source,
        });
      } else {
        const blob = new Blob(localSession.chunks, { type: localSession.mime });
        const arrayBuffer = await blob.arrayBuffer();
        saveResult = await window.videoZoom.recorder.save({
          recordingId: stopResult.recordingId,
          videoBytes: new Uint8Array(arrayBuffer),
          mouseEvents: alignedMouseEvents,
          durationMs: stopResult.durationMs,
          source,
        });
      }
      rec.setLastSave(saveResult);
    } catch (err) {
      rec.setError(`Save failed: ${(err as Error).message}`);
      session = null;
      await window.videoZoom.window.exitRecording();
      ui.setView('launcher');
      return;
    }

    const videoMeta = {
      ...localSession.videoMeta,
      durationMs: stopResult.durationMs,
    };
    session = null;

    await window.videoZoom.window.exitRecording();
    ui.setView('processing');

    // Branch: append to an existing project (Add Recording flow) vs. create a
    // brand-new project (default recording from launcher).
    const appendTarget = ui.pendingAppendToProjectPath;
    if (appendTarget) {
      try {
        const result = await window.videoZoom.project.appendClipFromStaging({
          targetProjectPath: appendTarget,
          stagingPath: saveResult.stagingPath,
          videoMeta,
          mouseEvents: alignedMouseEvents,
          source,
          displayBounds: localSession.displayBounds,
          systemCursorCaptured: localSession.systemCursorCaptured,
          hasAudio: localSession.hasAudio,
        });
        // Push the new clip onto the loaded project; autosave handles disk.
        useProjectStore.getState().update((d) => {
          d.clips.push(result.clip);
        }, { label: 'Add recording' });
        // Select the new clip so the user lands on its panel.
        const { useSelectionStore } = await import('@/stores/selection');
        useSelectionStore.getState().selectClip(result.clip.id);
        rec.setStatus('idle');
        ui.setPendingAppendTarget(null);
        ui.setView('editor');
      } catch (err) {
        if (isCancellation(err)) {
          // User cancelled while appending — main already cleaned up staging.
          rec.setStatus('idle');
          ui.setPendingAppendTarget(null);
          ui.setView('editor');
          return;
        }
        rec.setError(`Append recording failed: ${(err as Error).message}`);
        ui.setPendingAppendTarget(null);
        ui.setView('editor');
        return;
      }
      return;
    }

    try {
      const result = await window.videoZoom.project.createFromStaging({
        stagingPath: saveResult.stagingPath,
        videoMeta,
        mouseEvents: alignedMouseEvents,
        source,
        displayBounds: localSession.displayBounds,
        systemCursorCaptured: localSession.systemCursorCaptured,
        hasAudio: localSession.hasAudio,
      });
      const assetUrl = await window.videoZoom.project.assetUrl(result.videoAssetPath);
      useProjectStore.getState().setLoaded({
        project: result.project,
        projectPath: result.projectPath,
        videoAssetUrl: assetUrl,
        thumbnailUrls: [],
      });
      rec.setStatus('idle');
      ui.setView('editor');
    } catch (err) {
      if (isCancellation(err)) {
        // User cancelled the "Preparing your project" step. Main removed the
        // half-built project + staging; just return to the launcher quietly.
        rec.setStatus('idle');
        rec.reset();
        ui.setView('launcher');
        return;
      }
      rec.setError(`Project creation failed: ${(err as Error).message}`);
      ui.setView('launcher');
      return;
    }
  }, []);

  const cancel = useCallback(async () => {
    clearSession();
    try {
      await window.videoZoom.recorder.cancel();
    } catch { /* ignore */ }
    await window.videoZoom.window.exitRecording();
    useRecordingStore.getState().reset();
    useUiStore.getState().setView('launcher');
  }, []);

  return { start, pause, resume, stop, cancel };
}
