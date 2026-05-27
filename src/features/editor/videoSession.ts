// Multi-clip media session. We hold one element per clip in the project (kept
// off-DOM) and track which clip is currently "active" — the one PixiJS samples.
// A clip is either a VIDEO (HTMLVideoElement, real playback) or an IMAGE
// (HTMLImageElement, a still shown for a fixed duration). The master clock in
// PreviewCanvas reconciles the active clip + scene texture every frame, so the
// video-specific helpers below simply return null for image clips and the
// callers' `if (v) …` guards make them no-op — images can't disturb playback.

type MediaKind = 'video' | 'image';

interface MediaEntry {
  el: HTMLVideoElement | HTMLImageElement;
  src: string;
  kind: MediaKind;
}

const entries = new Map<string, MediaEntry>();
let activeClipId: string | null = null;
const activeSubscribers = new Set<(clipId: string | null) => void>();

function notifyActive(): void {
  for (const cb of activeSubscribers) cb(activeClipId);
}

function createVideo(src: string): HTMLVideoElement {
  const v = document.createElement('video');
  v.src = src;
  v.muted = true;
  v.preload = 'auto';
  v.playsInline = true;
  v.crossOrigin = 'anonymous';
  return v;
}

function createImage(src: string): HTMLImageElement {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = src;
  return img;
}

function createMedia(src: string, kind: MediaKind): HTMLVideoElement | HTMLImageElement {
  return kind === 'image' ? createImage(src) : createVideo(src);
}

function teardown(entry: MediaEntry): void {
  if (entry.el instanceof HTMLVideoElement) {
    try { entry.el.pause(); } catch { /* ignore */ }
    entry.el.removeAttribute('src');
    try { entry.el.load(); } catch { /* ignore */ }
  } else {
    entry.el.removeAttribute('src');
  }
}

/**
 * Reconcile the live media pool with the project's current clip list. Creates
 * elements for new clips, swaps src if a clip's source changed, drops removed
 * entries. `kind` defaults to 'video' for legacy callers. Idempotent.
 */
export function syncClipVideos(clips: Array<{ id: string; src: string; kind?: MediaKind }>): void {
  const seen = new Set<string>();
  for (const c of clips) {
    const kind: MediaKind = c.kind ?? 'video';
    seen.add(c.id);
    const existing = entries.get(c.id);
    if (existing && existing.src === c.src && existing.kind === kind) continue;
    if (existing && existing.kind === kind) {
      // Same element type, different src → swap in place.
      if (existing.el instanceof HTMLVideoElement) { try { existing.el.pause(); } catch { /* ignore */ } }
      existing.el.src = c.src;
      existing.src = c.src;
    } else {
      if (existing) teardown(existing);
      entries.set(c.id, { el: createMedia(c.src, kind), src: c.src, kind });
    }
  }
  for (const [id, entry] of [...entries]) {
    if (seen.has(id)) continue;
    teardown(entry);
    entries.delete(id);
    if (activeClipId === id) {
      activeClipId = null;
      notifyActive();
    }
  }
}

/** Switch which clip is active. Pauses the previously-active video (if any). */
export function setActiveClip(clipId: string): HTMLVideoElement | HTMLImageElement | null {
  if (clipId === activeClipId) return entries.get(clipId)?.el ?? null;
  if (activeClipId) {
    const prev = entries.get(activeClipId);
    if (prev && prev.el instanceof HTMLVideoElement) {
      try { prev.el.pause(); } catch { /* ignore */ }
    }
  }
  activeClipId = clipId;
  const next = entries.get(clipId)?.el ?? null;
  notifyActive();
  return next;
}

/** The active clip's <video>, or null if there's no active clip OR it's an image. */
export function getActiveVideo(): HTMLVideoElement | null {
  if (!activeClipId) return null;
  const e = entries.get(activeClipId);
  return e && e.el instanceof HTMLVideoElement ? e.el : null;
}

/** The active clip's <img>, or null if there's no active clip OR it's a video. */
export function getActiveImage(): HTMLImageElement | null {
  if (!activeClipId) return null;
  const e = entries.get(activeClipId);
  return e && e.el instanceof HTMLImageElement ? e.el : null;
}

/** The active clip's element regardless of kind (what the scene should show). */
export function getActiveMediaEl(): HTMLVideoElement | HTMLImageElement | null {
  return activeClipId ? entries.get(activeClipId)?.el ?? null : null;
}

export function getActiveClipId(): string | null {
  return activeClipId;
}

/** The clip's <video>, or null if it's an image (or unknown). */
export function getVideoForClip(clipId: string): HTMLVideoElement | null {
  const e = entries.get(clipId);
  return e && e.el instanceof HTMLVideoElement ? e.el : null;
}

export function subscribeActiveClip(cb: (id: string | null) => void): () => void {
  activeSubscribers.add(cb);
  cb(activeClipId);
  return () => {
    activeSubscribers.delete(cb);
  };
}

/** Tear down ALL media elements. Called when leaving the editor. */
export function detachAllVideos(): void {
  for (const entry of entries.values()) teardown(entry);
  entries.clear();
  activeClipId = null;
  notifyActive();
}

// ───── Backwards-compat shims for code that hasn't migrated yet ─────

/** @deprecated Use getActiveVideo(). */
export function getVideoElement(): HTMLVideoElement | null {
  return getActiveVideo();
}

/** @deprecated Use syncClipVideos() — kept for code in useRecorder.ts. */
export function attachVideo(src: string): HTMLVideoElement {
  syncClipVideos([{ id: '__compat', src }]);
  setActiveClip('__compat');
  return getActiveVideo()!;
}

/** @deprecated Use detachAllVideos(). */
export function detachVideo(): void {
  detachAllVideos();
}
