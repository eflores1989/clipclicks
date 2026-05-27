import { useCallback, useRef, useState } from 'react';
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
  { value: 'high', label: 'Alta (máxima)', crf: 16, wbFactor: 0.30, detFactor: 0.18 },
  { value: 'medium', label: 'Media', crf: 20, wbFactor: 0.18, detFactor: 0.11 },
  { value: 'low', label: 'Baja (liviano)', crf: 24, wbFactor: 0.10, detFactor: 0.06 },
];
const AQUALITY: { value: string; label: string; kbps: number }[] = [
  { value: 'high', label: 'Alta (256k)', kbps: 256 },
  { value: 'medium', label: 'Media (192k)', kbps: 192 },
  { value: 'low', label: 'Baja (128k)', kbps: 128 },
];

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

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
      <div className="export-dialog" role="dialog" aria-label="Exportar video">
        <header className="export-dialog__header">
          <h2>Exportar a MP4</h2>
          <button className="icon-btn" onClick={close} disabled={busy} aria-label="Cerrar"><X size={18} /></button>
        </header>

        {status === 'idle' && (
          <>
            <div className="export-dialog__body">
              <Field label="Método">
                <div className="export-seg">
                  <button className={`export-seg__btn ${method === 'realtime' ? 'export-seg__btn--on' : ''}`} onClick={() => setMethod('realtime')} title="Captura en tiempo real (rápido, ideal 1080p)">Rápido</button>
                  <button className={`export-seg__btn ${method === 'deterministic' ? 'export-seg__btn--on' : ''}`} onClick={() => setMethod('deterministic')} title="Cuadro por cuadro (calidad full a cualquier resolución, más lento)">Alta calidad</button>
                </div>
              </Field>
              <Field label="Resolución">
                <select className="panel__select" value={resolution} onChange={(e) => setResolution(e.target.value as ExportResolution)}>
                  {RESOLUTIONS.map((r) => {
                    // Realtime can't upscale above the source; deterministic can.
                    const tooBig = method === 'realtime' && r.value !== 'source' && presetHeight[r.value] > sourceHeight + 1;
                    return <option key={r.value} value={r.value} disabled={tooBig}>{r.label}{tooBig ? ' — mayor que la fuente' : ''}</option>;
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
              <Field label="Calidad de video">
                <select className="panel__select" value={vQuality} onChange={(e) => setVQuality(e.target.value)}>
                  {VQUALITY.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
                </select>
              </Field>
              <Field label="Calidad de audio">
                <select className="panel__select" value={aQuality} onChange={(e) => setAQuality(e.target.value)} disabled={!includeAudio}>
                  {AQUALITY.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
                </select>
              </Field>
              <label className="panel__checkbox">
                <input type="checkbox" checked={includeAudio} onChange={(e) => setIncludeAudio(e.target.checked)} />
                Incluir audio (clips + pistas de audio)
              </label>
              <p className="panel__hint">
                {method === 'realtime'
                  ? 'Rápido: captura en tiempo real (tarda ≈ el largo del video). Ideal 1080p. No cambies de pestaña mientras exporta.'
                  : 'Alta calidad: render cuadro por cuadro (determinista). Fluido y nítido a cualquier resolución incl. 4K, pero más lento.'}
              </p>
            </div>
            <footer className="export-dialog__footer">
              <button className="btn" onClick={close}>Cancelar</button>
              <button className="btn btn--accent" onClick={run}><Download size={15} /> Exportar</button>
            </footer>
          </>
        )}

        {busy && (
          <div className="export-dialog__progress">
            <Loader2 size={28} className="spin" />
            <p className="export-dialog__stage">
              {status === 'rendering'
                ? (method === 'deterministic' ? 'Codificando cuadro por cuadro…' : 'Componiendo el timeline…')
                : 'Finalizando MP4…'}
            </p>
            <div className="export-bar"><div className="export-bar__fill" style={{ width: `${Math.round(percent)}%` }} /></div>
            <span className="export-dialog__pct">{Math.round(percent)}%</span>
            <button className="btn btn--small" onClick={cancel}>Cancelar</button>
          </div>
        )}

        {status === 'done' && outputPath && (
          <div className="export-dialog__done">
            <CheckCircle2 size={32} className="export-dialog__ok" />
            <p>¡Listo! Se guardó en:</p>
            <code className="export-dialog__path">{outputPath}</code>
            <div className="export-dialog__done-actions">
              <button className="btn" onClick={() => window.videoZoom.export.revealFile(outputPath)}><FolderOpen size={15} /> Abrir carpeta</button>
              <button className="btn btn--accent" onClick={() => window.videoZoom.export.openFile(outputPath)}><Play size={15} /> Reproducir</button>
            </div>
            <button className="btn btn--small" onClick={() => exportStore.getState().reset()}>Exportar otro</button>
          </div>
        )}

        {status === 'cancelled' && (
          <div className="export-dialog__done">
            <p>Exportación cancelada.</p>
            <button className="btn" onClick={() => exportStore.getState().reset()}>Volver</button>
          </div>
        )}

        {status === 'error' && (
          <div className="export-dialog__done">
            <AlertTriangle size={28} className="export-dialog__err" />
            <p>No se pudo exportar.</p>
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
