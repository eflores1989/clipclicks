import { useCallback, useEffect, useRef, useState } from 'react';
import { Film, Plus, Trash2, MousePointerClick, Music, Upload, Loader2, Mic, Square, Type, Image as ImageIcon, Timer as TimerIcon } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { usePlaybackStore } from '@/stores/playback';
import { useSelectionStore } from '@/stores/selection';
import { useUiStore } from '@/stores/ui';
import { clipEffectiveDurationMs } from '@shared/lib/clipTime';
import { makeTextEvent } from '@shared/lib/textPresets';
import { makeTimerEvent } from '@shared/lib/timerValue';
import { loadImageDims, makeImageClip, paintGradientPng, paintSolidPng } from './imageMedia';
import { hideDropIndicator, showDropIndicator } from './dropIndicator';
import type { Clip, ImageMedia, TextPreset } from '@shared/types/project';

const DRAG_THRESHOLD_PX = 5;

function formatDur(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatRecordedAt(epoch: number): string {
  const d = new Date(epoch);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type MediaSubtab = 'video' | 'audio' | 'images' | 'text' | 'timer';

export function MediaPool({ subtab }: { subtab: MediaSubtab }) {
  const mediaPool = useProjectStore((s) => s.project?.mediaPool ?? []);
  const projectPath = useProjectStore((s) => s.projectPath);
  const update = useProjectStore((s) => s.update);
  const selectClip = useSelectionStore((s) => s.selectClip);

  /** Restore a clip from the pool to the end of the timeline. */
  const restoreClipToEnd = useCallback((clipId: string) => {
    update((d) => {
      const idx = d.mediaPool.findIndex((c) => c.id === clipId);
      if (idx === -1) return;
      const [clip] = d.mediaPool.splice(idx, 1);
      d.clips.push(clip);
    }, { label: 'Restore clip from pool' });
    selectClip(clipId);
  }, [update, selectClip]);

  /** Restore a clip to a specific timeline insertion index (used by drag). */
  const restoreClipAt = useCallback((clipId: string, insertIdx: number) => {
    update((d) => {
      const poolIdx = d.mediaPool.findIndex((c) => c.id === clipId);
      if (poolIdx === -1) return;
      const [clip] = d.mediaPool.splice(poolIdx, 1);
      const safeIdx = Math.max(0, Math.min(insertIdx, d.clips.length));
      d.clips.splice(safeIdx, 0, clip);
    }, { label: 'Restore clip from pool' });
    selectClip(clipId);
  }, [update, selectClip]);

  const deleteForever = useCallback(async (clipId: string) => {
    const project = useProjectStore.getState().project;
    if (!project || !projectPath) return;
    const clip = project.mediaPool.find((c) => c.id === clipId);
    if (!clip) return;
    const ok = window.confirm(
      `Delete this clip permanently?\n\nThe asset file "${clip.filePath}" will be removed from disk and cannot be recovered.`,
    );
    if (!ok) return;
    try {
      await window.videoZoom.project.deleteAsset(projectPath, clip.filePath);
    } catch (err) {
      console.warn('[MediaPool] deleteAsset failed:', err);
    }
    update((d) => {
      d.mediaPool = d.mediaPool.filter((c) => c.id !== clipId);
    }, { label: 'Delete clip forever' });
  }, [projectPath, update]);

  /** Pointer-down on a card: enter drag-to-timeline mode after threshold. */
  const onCardPointerDown = useCallback((e: React.PointerEvent<HTMLElement>, clipId: string) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    let isDragging = false;
    let targetIdx: number | null = null;

    const onMove = (ev: PointerEvent): void => {
      const dx = Math.abs(ev.clientX - startX);
      const dy = Math.abs(ev.clientY - startY);
      if (!isDragging && Math.max(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!isDragging) {
        isDragging = true;
        document.body.classList.add('cursor-grabbing');
      }
      // Locate the timeline track and compute insertion index from cursor X.
      const trackEl = document.querySelector<HTMLElement>('.timeline__track-area');
      if (!trackEl) return;
      const rect = trackEl.getBoundingClientRect();
      const inside =
        ev.clientX >= rect.left && ev.clientX <= rect.right &&
        ev.clientY >= rect.top && ev.clientY <= rect.bottom;
      if (!inside) {
        hideDropIndicator();
        targetIdx = null;
        return;
      }
      const project = useProjectStore.getState().project;
      if (!project) return;
      const total = project.timeline.durationMs;
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const cursorMs = ratio * total;
      let bestIdx = 0;
      let bestDist = Math.abs(cursorMs);
      let acc = 0;
      for (let i = 0; i < project.clips.length; i++) {
        acc += clipEffectiveDurationMs(project.clips[i]);
        const dist = Math.abs(cursorMs - acc);
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i + 1;
        }
      }
      targetIdx = bestIdx;
      // Percent of total timeline for the indicator.
      let posMs = 0;
      for (let i = 0; i < bestIdx && i < project.clips.length; i++) {
        posMs += clipEffectiveDurationMs(project.clips[i]);
      }
      const pct = total > 0 ? (posMs / total) * 100 : 0;
      showDropIndicator(pct);
    };

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('cursor-grabbing');
      hideDropIndicator();
      if (isDragging && targetIdx !== null) {
        restoreClipAt(clipId, targetIdx);
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [restoreClipAt]);

  if (subtab === 'audio') {
    return <AudioPoolView />;
  }
  if (subtab === 'text') {
    return <TextPoolView />;
  }
  if (subtab === 'timer') {
    return <TimerPoolView />;
  }
  if (subtab === 'images') {
    return <ImagePoolView />;
  }

  return <VideoPoolView mediaPool={mediaPool} onCardPointerDown={onCardPointerDown} restoreClipToEnd={restoreClipToEnd} deleteForever={deleteForever} />;
}

/**
 * The "Video" media-pool subtab: an Import button (bring in an external
 * recording as a new clip) plus the recycle bin of clips removed from the
 * timeline (restore / delete forever). Importing routes through the shared
 * "Preparing your project" view so the transcode shows a progress bar.
 */
function VideoPoolView({
  mediaPool, onCardPointerDown, restoreClipToEnd, deleteForever,
}: {
  mediaPool: Clip[];
  onCardPointerDown: (e: React.PointerEvent<HTMLElement>, clipId: string) => void;
  restoreClipToEnd: (clipId: string) => void;
  deleteForever: (clipId: string) => Promise<void>;
}) {
  const projectPath = useProjectStore((s) => s.projectPath);
  const update = useProjectStore((s) => s.update);
  const selectClip = useSelectionStore((s) => s.selectClip);

  const importVideo = useCallback(async () => {
    if (!projectPath) return;
    const ui = useUiStore.getState();
    ui.setView('processing');
    try {
      const result = await window.videoZoom.project.importVideoAppend(projectPath);
      if (!result) { ui.setView('editor'); return; }
      update((d) => { d.clips.push(result.clip); }, { label: 'Import video' });
      selectClip(result.clip.id);
      ui.setView('editor');
    } catch (err) {
      const msg = (err as Error).message ?? '';
      ui.setView('editor');
      if (!msg.includes('CANCELLED')) window.alert(`Could not import the video: ${msg}`);
    }
  }, [projectPath, update, selectClip]);

  return (
    <div className="media-pool">
      <div className="media-pool__audio-actions">
        <button className="btn btn--small btn--accent media-pool__import" onClick={importVideo} disabled={!projectPath}>
          <Upload size={14} /> Import
        </button>
      </div>

      {mediaPool.length === 0 ? (
        <p className="panel__hint" style={{ marginTop: 12 }}>
          Import an external recording to add it as a clip, or drag it onto the timeline. Clips removed from the timeline also land here so you can restore them.
        </p>
      ) : (
      <ul className="media-pool__list" style={{ marginTop: 12 }}>
        {mediaPool.map((clip: Clip) => {
          const clickCount = clip.mouseEvents.filter((e) => e.type === 'down').length;
          return (
            <li
              key={clip.id}
              className="media-pool__card"
              onPointerDown={(e) => onCardPointerDown(e, clip.id)}
              title="Click + Add to append to the timeline, or drag to drop at a specific position."
            >
              <div className="media-pool__card-icon">
                <Film size={20} />
              </div>
              <div className="media-pool__card-body">
                <span className="media-pool__card-title">
                  {formatRecordedAt(clip.recordedAt)}
                </span>
                <span className="media-pool__card-meta">
                  {formatDur(clipEffectiveDurationMs(clip))}
                  <span className="media-pool__card-sep">·</span>
                  <MousePointerClick size={10} /> {clickCount}
                </span>
              </div>
              <div className="media-pool__card-actions">
                <button
                  className="icon-btn"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => restoreClipToEnd(clip.id)}
                  title="Add to end of timeline"
                  aria-label="Add to timeline"
                >
                  <Plus size={14} />
                </button>
                <button
                  className="icon-btn icon-btn--danger"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => deleteForever(clip.id)}
                  title="Delete forever (removes the asset file)"
                  aria-label="Delete forever"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      )}
    </div>
  );
}

/**
 * The "Audio" media-pool subtab: import audio files, then drop them onto the
 * timeline. Each import is copied into the project + waveform-peaked in main,
 * then lives in `project.audioPool`. Clicking + places an AudioTrack at the
 * playhead.
 */
function AudioPoolView() {
  const audioPool = useProjectStore((s) => s.project?.audioPool ?? []);
  const projectPath = useProjectStore((s) => s.projectPath);
  const update = useProjectStore((s) => s.update);
  const [importing, setImporting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const micRef = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; timer: number } | null>(null);

  const handleImport = useCallback(async () => {
    if (!projectPath || importing) return;
    setImporting(true);
    try {
      const media = await window.videoZoom.project.importAudio(projectPath);
      if (media) {
        update((d) => { d.audioPool.push(media); }, { label: 'Import audio' });
      }
    } catch (err) {
      console.error('[AudioPool] import failed:', err);
      window.alert(`Could not import audio: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  }, [projectPath, importing, update]);

  const startMic = useCallback(async () => {
    if (!projectPath || recording) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (err) {
      window.alert(`Could not access the microphone: ${(err as Error).message}`);
      return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    const recorder = new MediaRecorder(stream, { mimeType: mime });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    const timer = window.setInterval(() => setElapsed((v) => v + 1), 1000);
    micRef.current = { recorder, stream, chunks, timer };
    recorder.start();
    setElapsed(0);
    setRecording(true);
  }, [projectPath, recording]);

  const stopMic = useCallback(async () => {
    const m = micRef.current;
    if (!m || !projectPath) return;
    window.clearInterval(m.timer);
    const done = new Promise<void>((resolve) => { m.recorder.onstop = () => resolve(); });
    try { m.recorder.stop(); } catch { /* ignore */ }
    await done;
    m.stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignore */ } });
    micRef.current = null;
    setRecording(false);
    const blob = new Blob(m.chunks, { type: m.recorder.mimeType });
    if (blob.size === 0) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = `Mic ${new Date().toLocaleTimeString()}`;
    try {
      const media = await window.videoZoom.project.saveRecordedAudio(projectPath, bytes, 'mic', name);
      update((d) => { d.audioPool.push(media); }, { label: 'Record mic audio' });
    } catch (err) {
      console.error('[AudioPool] save mic failed:', err);
      window.alert(`Could not save the recording: ${(err as Error).message}`);
    }
  }, [projectPath, update]);

  /** Place an audio media on the timeline at the current playhead. */
  const addToTimeline = useCallback((mediaId: string) => {
    const proj = useProjectStore.getState().project;
    const media = proj?.audioPool.find((m) => m.id === mediaId);
    if (!media) return;
    const playhead = usePlaybackStore.getState().currentTimeMs;
    update((d) => {
      d.audioTracks.push({
        id: crypto.randomUUID(),
        mediaId,
        offsetMs: Math.max(0, Math.round(playhead)),
        inMs: 0,
        outMs: media.durationMs,
        volume: 1,
        muted: false,
        fadeInMs: 0,
        fadeOutMs: 0,
      });
    }, { label: 'Add audio to timeline' });
  }, [update]);

  const deleteForever = useCallback(async (mediaId: string) => {
    const proj = useProjectStore.getState().project;
    const media = proj?.audioPool.find((m) => m.id === mediaId);
    if (!media || !projectPath) return;
    const inUse = proj?.audioTracks.some((t) => t.mediaId === mediaId);
    const msg = inUse
      ? `This audio is used on the timeline. Delete it permanently?\n\nThe file "${media.filePath}" will be removed and its timeline clips dropped.`
      : `Delete "${media.name}" permanently?\n\nThe file "${media.filePath}" will be removed from disk.`;
    if (!window.confirm(msg)) return;
    try {
      await window.videoZoom.project.deleteAsset(projectPath, media.filePath);
    } catch (err) {
      console.warn('[AudioPool] deleteAsset failed:', err);
    }
    update((d) => {
      d.audioPool = d.audioPool.filter((m) => m.id !== mediaId);
      d.audioTracks = d.audioTracks.filter((t) => t.mediaId !== mediaId);
    }, { label: 'Delete audio forever' });
  }, [projectPath, update]);

  return (
    <div className="media-pool">
      <div className="media-pool__audio-actions">
        <button
          className="btn btn--small btn--accent media-pool__import"
          onClick={handleImport}
          disabled={importing || recording || !projectPath}
        >
          {importing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          {importing ? 'Importing…' : 'Import'}
        </button>
        {recording ? (
          <button className="btn btn--small btn--record media-pool__import" onClick={stopMic}>
            <Square size={13} /> Stop ({elapsed}s)
          </button>
        ) : (
          <button className="btn btn--small media-pool__import" onClick={startMic} disabled={importing || !projectPath}>
            <Mic size={14} /> Record mic
          </button>
        )}
      </div>

      {audioPool.length === 0 ? (
        <p className="panel__hint" style={{ marginTop: 12 }}>
          Import music or voice (mp3, wav, m4a…). Then click + to add it to the timeline's audio track.
        </p>
      ) : (
        <ul className="media-pool__list" style={{ marginTop: 12 }}>
          {audioPool.map((m) => (
            <li key={m.id} className="media-pool__card" style={{ cursor: 'default' }}>
              <div className="media-pool__card-icon"><Music size={18} /></div>
              <div className="media-pool__card-body">
                <span className="media-pool__card-title">{m.name}</span>
                <span className="media-pool__card-meta">{formatDur(m.durationMs)}</span>
              </div>
              <div className="media-pool__card-actions">
                <button
                  className="icon-btn"
                  onClick={() => addToTimeline(m.id)}
                  title="Add to the audio track (at the playhead)"
                  aria-label="Add audio to timeline"
                >
                  <Plus size={14} />
                </button>
                <button
                  className="icon-btn icon-btn--danger"
                  onClick={() => deleteForever(m.id)}
                  title="Delete permanently (removes the file)"
                  aria-label="Delete audio forever"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The "Texto" media-pool subtab: three blocks (Título / Subtítulo / Párrafo).
 * Clicking one drops a TextEvent on the global timeline at the playhead with
 * that preset's look + animation. Defaults live in `textPresets.ts`.
 */
const TEXT_BLOCKS: { preset: TextPreset; label: string; hint: string }[] = [
  { preset: 'title', label: 'Title', hint: 'Large, centered, fade-in' },
  { preset: 'subtitle', label: 'Subtitle', hint: 'Bottom, fade-in' },
  { preset: 'paragraph', label: 'Paragraph', hint: 'Typewriter animation' },
];

const DEFAULT_TEXT_DURATION_MS = 3000;

function TextPoolView() {
  const update = useProjectStore((s) => s.update);
  const selectText = useSelectionStore((s) => s.selectText);

  const addText = useCallback((preset: TextPreset) => {
    const playhead = Math.max(0, Math.round(usePlaybackStore.getState().currentTimeMs));
    const ev = makeTextEvent(preset, playhead, playhead + DEFAULT_TEXT_DURATION_MS);
    update((d) => { d.timeline.textEvents.push(ev); }, { label: 'Add text' });
    selectText(ev.id);
  }, [update, selectText]);

  return (
    <div className="media-pool">
      <p className="panel__hint" style={{ marginBottom: 10 }}>
        Click a block to drop it at the playhead. Then edit the content, font and animation in the panel, and drag it over the video to position it.
      </p>
      <ul className="media-pool__list">
        {TEXT_BLOCKS.map((b) => (
          <li key={b.preset} className="media-pool__card" style={{ cursor: 'pointer' }} onClick={() => addText(b.preset)}>
            <div className="media-pool__card-icon"><Type size={18} /></div>
            <div className="media-pool__card-body">
              <span className={`media-pool__card-title media-pool__text-${b.preset}`}>{b.label}</span>
              <span className="media-pool__card-meta">{b.hint}</span>
            </div>
            <div className="media-pool__card-actions">
              <button className="icon-btn" onClick={(e) => { e.stopPropagation(); addText(b.preset); }} title="Add to timeline" aria-label="Add text">
                <Plus size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The "Timer" media-pool subtab: drop an on-screen chronometer at the playhead.
 * It starts counting from the point you place it and can be sped up / slowed
 * down via rate keyframes in its properties panel. Reposition + style it like a
 * text overlay.
 */
function TimerPoolView() {
  const update = useProjectStore((s) => s.update);
  const selectTimer = useSelectionStore((s) => s.selectTimer);

  const addTimer = useCallback(() => {
    const playhead = Math.max(0, Math.round(usePlaybackStore.getState().currentTimeMs));
    const ev = makeTimerEvent(playhead);
    update((d) => {
      if (!d.timeline.timerEvents) d.timeline.timerEvents = [];
      d.timeline.timerEvents.push(ev);
    }, { label: 'Add timer' });
    selectTimer(ev.id);
  }, [update, selectTimer]);

  return (
    <div className="media-pool">
      <p className="panel__hint" style={{ marginBottom: 10 }}>
        Drop a chronometer at the playhead. It starts counting where you place it. In the panel choose count up/down, the format, and add speed keyframes to accelerate or slow it down. Drag it over the video to position it.
      </p>
      <ul className="media-pool__list">
        <li className="media-pool__card" style={{ cursor: 'pointer' }} onClick={addTimer}>
          <div className="media-pool__card-icon"><TimerIcon size={18} /></div>
          <div className="media-pool__card-body">
            <span className="media-pool__card-title">Timer</span>
            <span className="media-pool__card-meta">Chronometer · count up / down</span>
          </div>
          <div className="media-pool__card-actions">
            <button className="icon-btn" onClick={(e) => { e.stopPropagation(); addTimer(); }} title="Add to timeline" aria-label="Add timer">
              <Plus size={14} />
            </button>
          </div>
        </li>
      </ul>
    </div>
  );
}

/**
 * The "Images" media-pool subtab. Import image files OR generate solid / gradient
 * swatches, then add them to the VIDEO track — each becomes a `kind: 'image'`
 * clip with a 3s default duration (trimmable like any clip).
 */
const GRADIENT_PRESETS: { name: string; from: string; to: string; angle: number }[] = [
  { name: 'Sunset', from: '#ff7e5f', to: '#feb47b', angle: 90 },
  { name: 'Ocean', from: '#2193b0', to: '#6dd5ed', angle: 90 },
  { name: 'Purple', from: '#7b2ff7', to: '#f107a3', angle: 120 },
  { name: 'Mint', from: '#00b09b', to: '#96c93d', angle: 90 },
  { name: 'Charcoal', from: '#232526', to: '#414345', angle: 90 },
  { name: 'Night', from: '#0f2027', to: '#2c5364', angle: 135 },
];

function ImagePoolView() {
  const imagePool = useProjectStore((s) => s.project?.imagePool ?? []);
  const projectPath = useProjectStore((s) => s.projectPath);
  const update = useProjectStore((s) => s.update);
  const selectClip = useSelectionStore((s) => s.selectClip);
  const [importing, setImporting] = useState(false);
  const [solidColor, setSolidColor] = useState('#1c1c1e');
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // Canvas size for generated images = the project's first clip dims (fallback 1080p).
  const canvasW = useProjectStore((s) => s.project?.clips[0]?.sourceWidth ?? 1920);
  const canvasH = useProjectStore((s) => s.project?.clips[0]?.sourceHeight ?? 1080);

  // Resolve thumbnail URLs for the pool cards.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!projectPath) return;
      const next: Record<string, string> = {};
      for (const m of imagePool) {
        if (thumbs[m.id]) { next[m.id] = thumbs[m.id]; continue; }
        try {
          const abs = `${projectPath}/${m.filePath}`.replace(/\\/g, '/');
          next[m.id] = await window.videoZoom.project.assetUrl(abs);
        } catch { /* ignore */ }
      }
      if (!cancelled) setThumbs(next);
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imagePool.map((m) => m.id).join('|'), projectPath]);

  const handleImport = useCallback(async () => {
    if (!projectPath || importing) return;
    setImporting(true);
    try {
      const media = await window.videoZoom.project.importImage(projectPath);
      if (media) {
        // Fill in real dimensions by loading the copied asset. Animated (GIF→MP4)
        // entries already carry probed dims and aren't loadable as an <img>.
        if (!media.animated) {
          try {
            const abs = `${projectPath}/${media.filePath}`.replace(/\\/g, '/');
            const url = await window.videoZoom.project.assetUrl(abs);
            const { w, h } = await loadImageDims(url);
            media.width = w; media.height = h;
          } catch { /* leave 0 → clip falls back to 1920×1080 */ }
        }
        update((d) => { d.imagePool.push(media); }, { label: 'Import image' });
      }
    } catch (err) {
      window.alert(`Could not import the image: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  }, [projectPath, importing, update]);

  const addGenerated = useCallback(async (bytes: Uint8Array, kind: 'solid' | 'gradient', name: string) => {
    if (!projectPath) return;
    try {
      const media = await window.videoZoom.project.saveImageAsset(projectPath, bytes, kind, name, canvasW, canvasH);
      update((d) => { d.imagePool.push(media); }, { label: 'Add image' });
    } catch (err) {
      window.alert(`Could not create the image: ${(err as Error).message}`);
    }
  }, [projectPath, update, canvasW, canvasH]);

  const addSolid = useCallback(async () => {
    addGenerated(await paintSolidPng(solidColor, canvasW, canvasH), 'solid', `Solid ${solidColor}`);
  }, [addGenerated, solidColor, canvasW, canvasH]);

  const addGradient = useCallback(async (g: typeof GRADIENT_PRESETS[number]) => {
    addGenerated(await paintGradientPng(g.from, g.to, g.angle, canvasW, canvasH), 'gradient', g.name);
  }, [addGenerated, canvasW, canvasH]);

  /** Append the image to the end of the video track as a 3s clip. */
  const addToTimeline = useCallback((mediaId: string) => {
    const proj = useProjectStore.getState().project;
    const media = proj?.imagePool.find((m) => m.id === mediaId);
    if (!media) return;
    const clip = makeImageClip(media);
    update((d) => { d.clips.push(clip); }, { label: 'Add image to timeline' });
    selectClip(clip.id);
  }, [update, selectClip]);

  const deleteForever = useCallback(async (mediaId: string) => {
    const proj = useProjectStore.getState().project;
    const media = proj?.imagePool.find((m) => m.id === mediaId);
    if (!media || !projectPath) return;
    if (!window.confirm(`Remove "${media.name}" from the pool?`)) return;
    // Only delete the file if no clip references it (a placed image shares the file).
    const referenced = proj?.clips.some((c) => c.filePath === media.filePath);
    if (!referenced) {
      try { await window.videoZoom.project.deleteAsset(projectPath, media.filePath); } catch { /* ignore */ }
    }
    update((d) => { d.imagePool = d.imagePool.filter((m) => m.id !== mediaId); }, { label: 'Delete image' });
  }, [projectPath, update]);

  return (
    <div className="media-pool">
      <div className="media-pool__audio-actions">
        <button className="btn btn--small btn--accent media-pool__import" onClick={handleImport} disabled={importing || !projectPath}>
          {importing ? <Loader2 size={14} className="spin" /> : <Upload size={14} />}
          {importing ? 'Importing…' : 'Import'}
        </button>
      </div>

      <div className="image-gen">
        <div className="image-gen__row">
          <input type="color" className="panel__color" value={solidColor} onChange={(e) => setSolidColor(e.target.value)} title="Solid color" />
          <button className="btn btn--small" onClick={addSolid} disabled={!projectPath}>Add solid</button>
        </div>
        <div className="image-gen__grad">
          {GRADIENT_PRESETS.map((g) => (
            <button
              key={g.name}
              className="image-gen__swatch"
              style={{ background: `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})` }}
              title={`Add ${g.name} gradient`}
              onClick={() => addGradient(g)}
              disabled={!projectPath}
            />
          ))}
        </div>
      </div>

      {imagePool.length === 0 ? (
        <p className="panel__hint" style={{ marginTop: 12 }}>
          Import images or generate solid/gradient backgrounds. Click + to add them to the video track (3s by default; resize them by their edges).
        </p>
      ) : (
        <ul className="media-pool__list" style={{ marginTop: 12 }}>
          {imagePool.map((m: ImageMedia) => (
            <li key={m.id} className="media-pool__card" style={{ cursor: 'default' }}>
              <div className="media-pool__card-icon media-pool__card-thumb">
                {!thumbs[m.id] ? <ImageIcon size={18} />
                  : m.animated
                    ? <video src={thumbs[m.id]} muted loop autoPlay playsInline />
                    : <img src={thumbs[m.id]} alt="" />}
              </div>
              <div className="media-pool__card-body">
                <span className="media-pool__card-title">{m.name}</span>
                <span className="media-pool__card-meta">
                  {m.width || '?'}×{m.height || '?'}
                  {m.animated && <> <span className="media-pool__card-sep">·</span> GIF {((m.durationMs ?? 0) / 1000).toFixed(1)}s</>}
                </span>
              </div>
              <div className="media-pool__card-actions">
                <button className="icon-btn" onClick={() => addToTimeline(m.id)} title="Add to video track" aria-label="Add image to timeline">
                  <Plus size={14} />
                </button>
                <button className="icon-btn icon-btn--danger" onClick={() => deleteForever(m.id)} title="Remove from pool" aria-label="Delete image">
                  <Trash2 size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
