import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { useProjectStore } from '@/stores/project';
import { useUiStore } from '@/stores/ui';

type Rect = { x: number; y: number; w: number; h: number };
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move';

const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const MIN = 0.05; // smallest crop fraction per axis

/** Aspect presets — null means free-form. Ratio is OUTPUT pixels (W:H). */
const ASPECTS: { label: string; ratio: number | null }[] = [
  { label: 'Libre', ratio: null },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '1:1', ratio: 1 },
];

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Compute the largest centered crop of pixel-ratio R for a source of (sw, sh).
 * Returns normalized rect. `crop.w*sw / (crop.h*sh) === R`.
 */
function centeredCropForRatio(R: number, sw: number, sh: number): Rect {
  // normRatio = crop.w / crop.h needed so the pixel ratio is R.
  const normRatio = (R * sh) / sw;
  // Try full width first.
  let w = 1;
  let h = w / normRatio;
  if (h > 1) {
    h = 1;
    w = h * normRatio;
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

/**
 * Crop editor overlay. Sits over the `.preview-canvas` while
 * `ui.cropEditMode` is true. PixiScene renders the full uncropped frame in
 * that mode, so the video occupies the padded region of the canvas; we inset
 * the draggable rect by the same padding fraction. Handles update the active
 * clip's normalized `crop`. A small toolbar offers aspect presets, reset and
 * done.
 */
export function CropOverlay({ clipId, paddingPct }: { clipId: string; paddingPct: number }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const update = useProjectStore((s) => s.update);
  const setCropEditMode = useUiStore((s) => s.setCropEditMode);
  const clip = useProjectStore((s) => s.project?.clips.find((c) => c.id === clipId));
  const [lockRatio, setLockRatio] = useState<number | null>(null);
  // Snapshot for single-undo coalescing across a drag.
  const dragSnapshot = useRef<Rect | null>(null);

  const crop: Rect = clip?.crop ?? FULL;
  const sw = clip?.sourceWidth ?? 1920;
  const sh = clip?.sourceHeight ?? 1080;
  const padFrac = paddingPct / 100;

  // Escape closes the crop editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); setCropEditMode(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setCropEditMode]);

  /** Write a crop to the active clip (optionally without recording history). */
  const writeCrop = useCallback((rect: Rect, opts: { record: boolean }) => {
    update((d) => {
      const c = d.clips.find((cc) => cc.id === clipId);
      if (!c) return;
      // Normalize: full frame → clear the field entirely.
      if (rect.x <= 0.001 && rect.y <= 0.001 && rect.w >= 0.999 && rect.h >= 0.999) {
        delete c.crop;
      } else {
        c.crop = rect;
      }
    }, opts.record ? { label: 'Crop clip' } : { record: false });
  }, [update, clipId]);

  /** Convert a client point to normalized full-frame coords (0..1). */
  const toNorm = useCallback((clientX: number, clientY: number): { nx: number; ny: number } => {
    const el = rootRef.current;
    if (!el) return { nx: 0, ny: 0 };
    const r = el.getBoundingClientRect();
    const vx0 = r.left + r.width * padFrac;
    const vy0 = r.top + r.height * padFrac;
    const vw = r.width * (1 - 2 * padFrac);
    const vh = r.height * (1 - 2 * padFrac);
    return {
      nx: vw > 0 ? (clientX - vx0) / vw : 0,
      ny: vh > 0 ? (clientY - vy0) / vh : 0,
    };
  }, [padFrac]);

  const onHandleDown = useCallback((e: React.PointerEvent, handle: Handle) => {
    e.preventDefault();
    e.stopPropagation();
    const start = dragSnapshot.current = { ...crop };
    const startNorm = toNorm(e.clientX, e.clientY);

    const onMove = (ev: PointerEvent): void => {
      const cur = toNorm(ev.clientX, ev.clientY);
      const dx = cur.nx - startNorm.nx;
      const dy = cur.ny - startNorm.ny;
      let { x, y, w, h } = start;

      if (handle === 'move') {
        x = clamp01(start.x + dx);
        y = clamp01(start.y + dy);
        // Keep inside bounds without resizing.
        x = Math.min(x, 1 - w);
        y = Math.min(y, 1 - h);
        writeCrop({ x, y, w, h }, { record: false });
        return;
      }

      // Edge flags this handle controls.
      const left = handle === 'nw' || handle === 'w' || handle === 'sw';
      const right = handle === 'ne' || handle === 'e' || handle === 'se';
      const top = handle === 'nw' || handle === 'n' || handle === 'ne';
      const bottom = handle === 'sw' || handle === 's' || handle === 'se';

      let x0 = start.x;
      let y0 = start.y;
      let x1 = start.x + start.w;
      let y1 = start.y + start.h;

      if (left) x0 = clamp01(Math.min(start.x + dx, x1 - MIN));
      if (right) x1 = clamp01(Math.max(start.x + start.w + dx, x0 + MIN));
      if (top) y0 = clamp01(Math.min(start.y + dy, y1 - MIN));
      if (bottom) y1 = clamp01(Math.max(start.y + start.h + dy, y0 + MIN));

      w = x1 - x0;
      h = y1 - y0;
      x = x0;
      y = y0;

      // Aspect lock: only corner handles when a ratio is set. Anchor the
      // opposite corner and derive the perpendicular dimension from the ratio.
      if (lockRatio !== null && (handle === 'nw' || handle === 'ne' || handle === 'se' || handle === 'sw')) {
        const normRatio = (lockRatio * sh) / sw; // w/h in normalized space
        // Derive height from width (drive by the horizontal change).
        let nw = w;
        let nh = nw / normRatio;
        // If that overflows vertically, drive by height instead.
        if (nh > 1) { nh = 1; nw = nh * normRatio; }
        // Re-anchor to the fixed corner.
        if (left) x = x1 - nw; else x = x0;
        if (top) y = y1 - nh; else y = y0;
        // Clamp into frame.
        if (x < 0) { x = 0; }
        if (y < 0) { y = 0; }
        if (x + nw > 1) nw = 1 - x;
        if (y + nh > 1) nh = 1 - y;
        w = nw; h = nh;
      }

      writeCrop({ x, y, w, h }, { record: false });
    };

    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // Commit one history entry: replay snapshot → final.
      const snap = dragSnapshot.current;
      dragSnapshot.current = null;
      const c = useProjectStore.getState().project?.clips.find((cc) => cc.id === clipId);
      const final = c?.crop ?? FULL;
      if (snap) {
        writeCrop(snap, { record: false });
        writeCrop(final, { record: true });
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [crop, toNorm, writeCrop, lockRatio, sw, sh, clipId]);

  const applyAspect = useCallback((ratio: number | null) => {
    setLockRatio(ratio);
    if (ratio === null) return; // free — leave current crop
    writeCrop(centeredCropForRatio(ratio, sw, sh), { record: true });
  }, [writeCrop, sw, sh]);

  if (!clip) return null;

  // Geometry in % of the overlay box (which equals the .preview-canvas box).
  const padPctStr = padFrac * 100;
  const innerW = 100 - 2 * padPctStr;
  const innerH = 100 - 2 * padPctStr;
  const rectLeft = padPctStr + crop.x * innerW;
  const rectTop = padPctStr + crop.y * innerH;
  const rectW = crop.w * innerW;
  const rectH = crop.h * innerH;

  const cornerHandles: Handle[] = ['nw', 'ne', 'se', 'sw'];
  const edgeHandles: Handle[] = ['n', 'e', 's', 'w'];
  const handles: Handle[] = lockRatio === null ? [...cornerHandles, ...edgeHandles] : cornerHandles;

  return (
    <div className="crop-overlay" ref={rootRef}>
      {/* Dim the cropped-out area with 4 shade panels around the crop rect. */}
      <div className="crop-shade" style={{ left: 0, top: 0, width: '100%', height: `${rectTop}%` }} />
      <div className="crop-shade" style={{ left: 0, top: `${rectTop + rectH}%`, width: '100%', bottom: 0 }} />
      <div className="crop-shade" style={{ left: 0, top: `${rectTop}%`, width: `${rectLeft}%`, height: `${rectH}%` }} />
      <div className="crop-shade" style={{ left: `${rectLeft + rectW}%`, top: `${rectTop}%`, right: 0, height: `${rectH}%` }} />

      {/* Crop rectangle */}
      <div
        className="crop-rect"
        style={{ left: `${rectLeft}%`, top: `${rectTop}%`, width: `${rectW}%`, height: `${rectH}%` }}
        onPointerDown={(e) => onHandleDown(e, 'move')}
      >
        <div className="crop-rect__grid" />
        {handles.map((h) => (
          <div
            key={h}
            className={`crop-handle crop-handle--${h}`}
            onPointerDown={(e) => onHandleDown(e, h)}
          />
        ))}
      </div>

      {/* Toolbar */}
      <div className="crop-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        {ASPECTS.map((a) => (
          <button
            key={a.label}
            className={`crop-aspect ${lockRatio === a.ratio ? 'crop-aspect--active' : ''}`}
            onClick={() => applyAspect(a.ratio)}
          >
            {a.label}
          </button>
        ))}
        <span className="crop-toolbar__sep" />
        <button
          className="crop-aspect"
          title="Reset (full frame)"
          onClick={() => { setLockRatio(null); writeCrop(FULL, { record: true }); }}
        >
          <RotateCcw size={13} />
        </button>
        <button
          className="crop-aspect crop-aspect--done"
          onClick={() => setCropEditMode(false)}
        >
          <Check size={13} /> Listo
        </button>
      </div>
    </div>
  );
}
