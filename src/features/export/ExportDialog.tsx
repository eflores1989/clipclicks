import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Download, FolderOpen, Play, Loader2, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useExportStore } from '@/stores/export';
import { renderTimelineToWebm } from './exportEngine';
import { encodeTimelineToMp4 } from './exportDeterministic';
import { renderAudioMix } from './exportAudio';
import type { ExportFps, ExportResolution } from '@shared/types/project';

type ExportMethod = 'realtime' | 'deterministic';

const RESOLUTIONS: { value: ExportResolution; label: string }[] = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p (HD)' },
  { value: '1440p', label: '1440p (2K)' },
  { value: '4k', label: '2160p (4K)' },
  { value: 'source', label: 'Original' },
];
// Per quality: `crf` = final x264 quality (offline, doesn't affect capture
// smoothness); `wbFactor` = intermediate WebM bitrate (× w·h·fps) — the
// capture-quality ceiling, but higher = heavier realtime encode.
// `crf`/`wbFactor` drive the realtime path; `detFactor` is the H.264 bitrate
// factor (× w·h·fps) for the deterministic encoder (its final quality).
const VQUALITY: { value: string; label: string; crf: number; wbFactor: number; detFactor: number }[] = [
  { value: 'high', label: 'High (best)', crf: 16, wbFactor: 0.30, detFactor: 0.18 },
  { value: 'medium', label: 'Medium', crf: 20, wbFactor: 0.18, detFactor: 0.11 },
  { value: 'low', label: 'Low (lighter file)', crf: 24, wbFactor: 0.10, detFactor: 0.06 },
];
const AQUALITY: { value: string; label: string; kbps: number }[] = [
  { value: 'high', label: 'High (256k)', kbps: 256 },
  { value: 'medium', label: 'Medium (192k)', kbps: 192 },
  { value: 'low', label: 'Low (128k)', kbps: 128 },
];

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

function formatEta(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `~${s}s restantes`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `~${m}m ${String(r).padStart(2, '0')}s restantes`;
}

/**
 * Estimated time remaining for the current export stage. Measures the observed
 * progress rate (percent per ms) since the stage started and extrapolates to
 * 100%, smoothed with an EMA so it doesn't jitter, and ticked down every second
 * so it keeps moving between progress events. The baseline resets on every stage
 * change (rendering → transcoding), since those stages run at different rates.
 */
function useEtaSeconds(active: boolean, stageKey: string, percent: number): number | null {
  const baseRef = useRef<{ t: number; p: number } | null>(null);
  const [eta, setEta] = useState<number | null>(null);

  // New stage (or finished) → forget the previous rate.
  useEffect(() => {
    baseRef.current = null;
    setEta(null);
  }, [stageKey, active]);

  useEffect(() => {
    if (!active) return;
    const now = Date.now();
    if (percent <= 0) return;
    if (!baseRef.current) { baseRef.current = { t: now, p: percent }; return; }
    const dp = percent - baseRef.current.p;
    const dt = now - baseRef.current.t;
    // Need a meaningful sample before showing a number (avoids a wild first guess).
    if (dp <= 0.3 || dt < 1500) return;
    const remainingSec = ((100 - percent) / (dp / dt)) / 1000;
    if (!Number.isFinite(remainingSec) || remainingSec < 0) return;
    setEta((prev) => (prev === null ? remainingSec : prev * 0.7 + remainingSec * 0.3));
  }, [percent, active, stageKey]);

  // Count down between progress events; the next event corrects the value.
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      setEta((prev) => (prev === null ? prev : Math.max(0, prev - 1)));
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return eta;
}

function targetDims(resolution: ExportResolution, sw: number, sh: number, allowUpscale: boolean): { w: number; h: number } {
  const aspect = sw / sh;
  const presetH = resolution === 'source' ? sh
    : resolution === '720p' ? 720
    : resolution === '1080p' ? 1080
    : resolution === '1440p' ? 1440
    : 2160;
  // Realtime can't reliably upscale (breaks the live encoder); deterministic can.
  const h = allowUpscale ? presetH : Math.min(presetH, sh);
  return { w: even(h * aspect), h: even(h) };
}

export function ExportDialog() {
  const open = useExportStore((s) => s.open);
  const status = useExportStore((s) => s.status);
  const percent = useExportStore((s) => s.percent);
  const outputPath = useExportStore((s) => s.outputPath);
  const error = useExportStore((s) => s.error);
  const setOpen = useExportStore((s) => s.setOpen);
  const exportStore = useExportStore;

  // Source height of the first clip — we don't offer UPSCALING above it (no
  // real detail gained, and high-res realtime VP9 encode breaks on CPU-bound
  // machines → empty webm). Presets taller than the source are disabled.
  const sourceHeight = useProjectStore((s) => s.project?.clips[0]?.sourceHeight ?? 1080);
  const presetHeight: Record<ExportResolution, number> = { '720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160, source: sourceHeight };

  const [method, setMethod] = useState<ExportMethod>('realtime');
  const [resolution, setResolution] = useState<ExportResolution>('1080p');
  const [fps, setFps] = useState<ExportFps>(30);
  const [vQuality, setVQuality] = useState('medium');
  const [aQuality, setAQuality] = useState('medium');
  const [includeAudio, setIncludeAudio] = useState(true);
  const cancelRef = useRef(false);

  const busy = status === 'rendering' || status === 'transcoding';
  const etaSec = useEtaSeconds(busy, status, percent);

  const close = useCallback(() => {
    if (busy) return; // can't close mid-export; use Cancel
    setOpen(false);
    exportStore.getState().reset();
  }, [busy, setOpen, exportStore]);

  const cancel = useCallback(() => {
    cancelRef.current = true;
    window.videoZoom.export.cancel().catch(() => {});
  }, []);

  const run = useCallback(async () => {
    const project = useProjectStore.getState().project;
    const projectPath = useProjectStore.getState().projectPath;
    if (!project || !projectPath || project.clips.length === 0) return;

    const outPath = await window.videoZoom.export.saveDialog(project.name || 'export');
    if (!outPath) return; // user cancelled the save dialog

    cancelRef.current = false;
    const st = exportStore.getState();
    st.start();

    const src = project.clips[0];
    const { w, h } = targetDims(resolution, src?.sourceWidth ?? 1920, src?.sourceHeight ?? 1080, method === 'deterministic');
    const audioEnd = project.audioTracks.reduce((m, t) => Math.max(m, t.offsetMs + (t.outMs - t.inMs)), 0);
    const durationMs = Math.max(project.timeline.durationMs, audioEnd, 1);
    const vq = VQUALITY.find((q) => q.value === vQuality);
    const audioBitrateKbps = AQUALITY.find((q) => q.value === aQuality)?.kbps ?? 192;
    const resolveUrl = (p: string): Promise<string> => window.videoZoom.project.assetUrl(p);

    // Persist the chosen res/fps/audio on the project for next time.
    useProjectStore.getState().update((d) => {
      if (!d.exportSettings) return;
      d.exportSettings.resolution = resolution;
      d.exportSettings.fps = fps;
      d.exportSettings.includeAudio = includeAudio;
    }, { record: false });

    const onErr = (err: unknown): void => exportStore.getState().finishErr((err as Error).message);

    if (method === 'deterministic') {
      // Frame-by-frame: smooth + full quality at any resolution.
      const videoBitrate = Math.min(120_000_000, Math.round(w * h * fps * (vq?.detFactor ?? 0.11)));
      try {
        const mp4Bytes = await encodeTimelineToMp4({
          project, projectPath, width: w, height: h, fps, videoBitrate, totalMs: durationMs,
          resolveUrl,
          onProgress: (pct) => exportStore.getState().setStage('rendering', pct),
          shouldCancel: () => cancelRef.current,
        });
        if (cancelRef.current) { exportStore.getState().finishErr('CANCELLED'); return; }
        const wavBytes = includeAudio ? await renderAudioMix({ project, projectPath, totalMs: durationMs, resolveUrl }) : null;
        exportStore.getState().setStage('transcoding', 0);
        const unsub = window.videoZoom.export.onProgress((p) => exportStore.getState().setPercent(p.percent));
        try {
          await window.videoZoom.export.mux({ mp4Bytes, wavBytes, outputPath: outPath, audioBitrateKbps });
        } finally { unsub(); }
        exportStore.getState().finishOk(outPath);
      } catch (err) { onErr(err); }
      return;
    }

    // Realtime (default, unchanged): capture the timeline live → WebM → ffmpeg.
    const crf = vq?.crf ?? 20;
    const videoBitsPerSecond = Math.min(80_000_000, Math.round(w * h * fps * (vq?.wbFactor ?? 0.18)));
    try {
      const bytes = await renderTimelineToWebm({
        project, projectPath, width: w, height: h, fps, includeAudio, videoBitsPerSecond,
        resolveUrl,
        onProgress: (pct) => exportStore.getState().setStage('rendering', pct),
        shouldCancel: () => cancelRef.current,
      });
      if (cancelRef.current) { exportStore.getState().finishErr('CANCELLED'); return; }
      exportStore.getState().setStage('transcoding', 0);
      const unsub = window.videoZoom.export.onProgress((p) => exportStore.getState().setPercent(p.percent));
      try {
        await window.videoZoom.export.run({ bytes, outputPath: outPath, durationMs, fps, crf, audioBitrateKbps, includeAudio });
      } finally { unsub(); }
      exportStore.getState().finishOk(outPath);
    } catch (err) { onErr(err); }
  }, [method, resolution, fps, vQuality, aQuality, includeAudio, exportStore]);

  if (!open) return null;

  return (
    <div className="export-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="export-dialog" role="dialog" aria-label="Export video">
        <header className="export-dialog__header">
          <h2>Export to MP4</h2>
          <button className="icon-btn" onClick={close} disabled={busy} aria-label="Close"><X size={18} /></button>
        </header>

        {status === 'idle' && (
          <>
            <div className="export-dialog__body">
              <Field label="Method">
                <div className="export-seg">
                  <button className={`export-seg__btn ${method === 'realtime' ? 'export-seg__btn--on' : ''}`} onClick={() => setMethod('realtime')} title="Realtime capture (fast, ideal for 1080p)">Fast</button>
                  <button className={`export-seg__btn ${method === 'deterministic' ? 'export-seg__btn--on' : ''}`} onClick={() => setMethod('deterministic')} title="Frame-by-frame (full quality at any resolution, slower)">High quality</button>
                </div>
              </Field>
              <Field label="Resolution">
                <select className="panel__select" value={resolution} onChange={(e) => setResolution(e.target.value as ExportResolution)}>
                  {RESOLUTIONS.map((r) => {
                    // Realtime can't upscale above the source; deterministic can.
                    const tooBig = method === 'realtime' && r.value !== 'source' && presetHeight[r.value] > sourceHeight + 1;
                    return <option key={r.value} value={r.value} disabled={tooBig}>{r.label}{tooBig ? ' — larger than source' : ''}</option>;
                  })}
                </select>
              </Field>
              <Field label="FPS">
                <div className="export-seg">
                  {([30, 60] as ExportFps[]).map((f) => (
                    <button key={f} className={`export-seg__btn ${fps === f ? 'export-seg__btn--on' : ''}`} onClick={() => setFps(f)}>{f}</button>
                  ))}
                </div>
              </Field>
              <Field label="Video quality">
                <select className="panel__select" value={vQuality} onChange={(e) => setVQuality(e.target.value)}>
                  {VQUALITY.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
                </select>
              </Field>
              <Field label="Audio quality">
                <select className="panel__select" value={aQuality} onChange={(e) => setAQuality(e.target.value)} disabled={!includeAudio}>
                  {AQUALITY.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
                </select>
              </Field>
              <label className="panel__checkbox">
                <input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} />
                Include audio (clips + audio tracks)
              </label>
              <p className="panel__hint">
                {method === 'realtime'
                  ? 'Fast: realtime capture (takes about as long as the video). Ideal for 1080p. Keep this window in focus while exporting.'
                  : 'High quality: deterministic frame-by-frame render. Smooth and crisp at any resolution including 4K, but slower.'}
              </p>
            </div>
            <footer className="export-dialog__footer">
              <button className="btn" onClick={close}>Cancel</button>
              <button className="btn btn--accent" onClick={run}><Download size={15} /> Export</button>
            </footer>
          </>
        )}

        {busy && (
          <div className="export-dialog__progress">
            <Loader2 size={28} className="spin" />
            <p className="export-dialog__stage">
              {status === 'rendering'
                ? (method === 'deterministic' ? 'Encoding frame by frame…' : 'Composing the timeline…')
                : 'Finishing MP4…'}
            </p>
            <div className="export-bar"><div className="export-bar__fill" style={{ width: `${Math.round(percent)}%` }} /></div>
            <span className="export-dialog__pct">
              {Math.round(percent)}%
              {etaSec !== null && <span className="export-dialog__eta">{formatEta(etaSec)}</span>}
            </span>
            <button className="btn btn--small" onClick={cancel}>Cancel</button>
          </div>
        )}

        {status === 'done' && outputPath && (
          <div className="export-dialog__done">
            <CheckCircle2 size={32} className="export-dialog__ok" />
            <p>Done! Saved to:</p>
            <code className="export-dialog__path">{outputPath}</code>
            <div className="export-dialog__done-actions">
              <button className="btn" onClick={() => window.videoZoom.export.revealFile(outputPath)}><FolderOpen size={15} /> Open folder</button>
              <button className="btn btn--accent" onClick={() => window.videoZoom.export.openFile(outputPath)}><Play size={15} /> Play</button>
            </div>
            <button className="btn btn--small" onClick={() => exportStore.getState().reset()}>Export another</button>
          </div>
        )}

        {status === 'cancelled' && (
          <div className="export-dialog__done">
            <p>Export cancelled.</p>
            <button className="btn" onClick={() => exportStore.getState().reset()}>Back</button>
          </div>
        )}

        {status === 'error' && (
          <div className="export-dialog__done">
            <AlertTriangle size={28} className="export-dialog__err" />
            <p>Export failed.</p>
            <code className="export-dialog__path">{error}</code>
            <button className="btn" onClick={() => exportStore.getState().reset()}>Volver</button>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="export-field">
      <label className="export-field__label">{label}</label>
      {children}
    </div>
  );
}
