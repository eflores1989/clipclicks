import type { Project } from '@shared/types/project';

export interface AudioMixOptions {
  project: Project;
  projectPath: string;
  totalMs: number;
  resolveUrl: (absPath: string) => Promise<string>;
}

/** Encode an AudioBuffer (≤2ch) to 16-bit PCM WAV bytes. */
function audioBufferToWav(buf: AudioBuffer): Uint8Array {
  const numCh = Math.min(2, buf.numberOfChannels);
  const sr = buf.sampleRate;
  const len = buf.length;
  const blockAlign = numCh * 2;
  const dataLen = len * blockAlign;
  const out = new ArrayBuffer(44 + dataLen);
  const view = new DataView(out);
  const wstr = (o: number, s: string): void => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  wstr(0, 'RIFF'); view.setUint32(4, 36 + dataLen, true); wstr(8, 'WAVE');
  wstr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, numCh, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
  wstr(36, 'data'); view.setUint32(40, dataLen, true);
  const chans: Float32Array[] = [];
  for (let c = 0; c < numCh; c++) chans.push(buf.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = Math.max(-1, Math.min(1, chans[c][i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(out);
}

async function decode(ctx: BaseAudioContext, url: string): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url);
    const ab = await res.arrayBuffer();
    return await ctx.decodeAudioData(ab);
  } catch {
    return null;
  }
}

/**
 * Render the full audio mix OFFLINE (deterministic, faster-than-realtime) into
 * a WAV: each video clip's embedded audio (trim + speed + volume, placed at its
 * timeline position) and each timeline audio track (trim + volume + fades).
 * Returns null if there's nothing audible. Used by the deterministic export.
 */
export async function renderAudioMix(opts: AudioMixOptions): Promise<Uint8Array | null> {
  const { project, projectPath, totalMs, resolveUrl } = opts;
  const SR = 48000;
  const lengthFrames = Math.ceil((totalMs / 1000) * SR);
  if (lengthFrames <= 0) return null;
  const abs = (rel: string): string => `${projectPath}/${rel}`.replace(/\\/g, '/');

  const decodeCtx = new OfflineAudioContext(2, SR, SR);
  const clipBufs = new Map<string, AudioBuffer>();
  for (const c of project.clips) {
    if (c.kind === 'image' || !c.hasAudio || c.audioMuted) continue;
    const ab = await decode(decodeCtx, await resolveUrl(abs(c.filePath)));
    if (ab) clipBufs.set(c.id, ab);
  }
  const trackBufs = new Map<string, AudioBuffer>();
  for (const t of project.audioTracks) {
    if (t.muted) continue;
    const media = project.audioPool.find((m) => m.id === t.mediaId);
    if (!media) continue;
    const ab = await decode(decodeCtx, await resolveUrl(abs(media.filePath)));
    if (ab) trackBufs.set(t.id, ab);
  }
  if (clipBufs.size === 0 && trackBufs.size === 0) return null;

  const ctx = new OfflineAudioContext(2, lengthFrames, SR);

  for (const c of project.clips) {
    const ab = clipBufs.get(c.id);
    if (!ab) continue;
    const speed = c.speedSegments[0]?.speed ?? 1;
    const src = ctx.createBufferSource();
    src.buffer = ab;
    src.playbackRate.value = speed;
    const g = ctx.createGain();
    g.gain.value = Math.max(0, Math.min(1, c.audioVolume ?? 1));
    src.connect(g).connect(ctx.destination);
    const when = c.timelineStartMs / 1000;
    const offset = c.inMs / 1000;
    const effDur = Math.max(0, (c.outMs - c.inMs) / speed / 1000);
    try { src.start(when, offset); src.stop(when + effDur); } catch { /* ignore */ }
  }

  for (const t of project.audioTracks) {
    const ab = trackBufs.get(t.id);
    if (!ab) continue;
    const src = ctx.createBufferSource();
    src.buffer = ab;
    const g = ctx.createGain();
    const when = t.offsetMs / 1000;
    const offset = t.inMs / 1000;
    const playLen = Math.max(0, (t.outMs - t.inMs) / 1000);
    const vol = Math.max(0, Math.min(1, t.volume));
    const fi = Math.min(t.fadeInMs / 1000, playLen);
    const fo = Math.min(t.fadeOutMs / 1000, playLen);
    if (fi > 0) { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(vol, when + fi); }
    else g.gain.setValueAtTime(vol, when);
    if (fo > 0) { g.gain.setValueAtTime(vol, Math.max(when, when + playLen - fo)); g.gain.linearRampToValueAtTime(0, when + playLen); }
    src.connect(g).connect(ctx.destination);
    try { src.start(when, offset, playLen); } catch { /* ignore */ }
  }

  const rendered = await ctx.startRendering();
  return audioBufferToWav(rendered);
}
