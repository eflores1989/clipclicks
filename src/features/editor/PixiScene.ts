import {
  Application,
  Container,
  Graphics,
  Sprite,
  Text,
  TextStyle,
  Texture,
  type Renderer,
} from 'pixi.js';
import { DropShadowFilter, PixelateFilter } from 'pixi-filters';
import type { BackgroundConfig, CursorConfig, TextEvent, TimerEvent, TransitionKind, ZoomEvent } from '@shared/types/project';
import type { MouseEventRaw } from '@shared/types/recording';
import { computeZoomState, IDENTITY_ZOOM, type ZoomState } from '@shared/lib/computeZoomState';
import { timerText } from '@shared/lib/timerValue';
import { cursorAt, newCursorCursor, type CursorCursor } from '@shared/lib/cursorAt';
import { textRenderState } from '@shared/lib/textPresets';
import { extractCustomId, getCustomBackground, getPreset, isCustomPresetId, onCustomBackgroundsChange, paintBackgroundToCanvas } from './backgrounds';

/** Base radius (canvas px) for the cursor dot before applying size multiplier. */
const CURSOR_BASE_RADIUS_PX = 9;

/** Parse "#rrggbb" → 0xrrggbb. Returns fallback on malformed input. */
function hexColor(hex: string, fallback = 0xffffff): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  return m ? parseInt(m[1], 16) : fallback;
}

/**
 * Draw a Windows-style pointer arrow with its HOTSPOT at the local origin
 * (0, 0). The shape is in a 1× "unit" coordinate system — callers scale via
 * `g.scale.set(...)`. Caller chooses fill and outline colors.
 */
function drawArrow(
  g: Graphics,
  fillColor: number,
  fillAlpha: number,
  outlineColor: number,
): void {
  g.clear();
  // Path traces clockwise from the hotspot. Numbers are roughly the proportions
  // of the legacy Windows arrow: ~12 wide × 18 tall.
  const path = [
    0, 0,
    0, 17,
    4.2, 13.2,
    7.4, 19.4,
    9.4, 18.6,
    6.4, 12.6,
    10.6, 12.6,
  ];
  g.poly(path).fill({ color: fillColor, alpha: fillAlpha });
  g.poly(path).stroke({ color: outlineColor, alpha: Math.min(1, fillAlpha + 0.1), width: 1.2 });
}

interface SceneSize {
  w: number;
  h: number;
}

// Preview never needs to render at full source resolution. We cap the canvas
// internal size so a 4K source still previews at ~1280px wide. Final export
// (Phase 6) re-renders offscreen at native resolution.
const PREVIEW_MAX_WIDTH = 1280;

/**
 * Owns the PixiJS Application that renders the editor preview:
 *   - background sprite (drawn from a 2D canvas painter for any preset)
 *   - video sprite (texture from an HTMLVideoElement, auto-updated by Pixi)
 *   - mask + drop shadow for rounded corners + lift
 *
 * Layout is recomputed every time the background config changes. The Pixi
 * canvas renders at the source video resolution; CSS scales it to fit the
 * preview area while keeping aspect ratio.
 */
export class PixiScene {
  private app: Application;
  private size: SceneSize;
  private rootContainer: Container;
  private bgSprite: Sprite | null = null;
  private videoContainer: Container;
  private videoSprite: Sprite | null = null;
  private videoMask: Graphics | null = null;
  private dropShadow: DropShadowFilter | null = null;
  private currentPresetId: string | null = null;
  private lastBg: BackgroundConfig | null = null;
  private prevZoomState: ZoomState | null = null;
  private cursorCursor: CursorCursor = newCursorCursor();
  /** Normalized crop rect (0..1) or null for full frame. Composes under zoom. */
  private crop: { x: number; y: number; w: number; h: number } | null = null;
  /** While true, render the FULL uncropped, unzoomed frame so the crop-editor
   * overlay can align its handles to the whole source. */
  private cropEditMode = false;
  private trackEditMode = false;
  // Cursor rendering: a halo + dot follow the smoothed mouse position, and a
  // pulse Graphics is redrawn every frame with all click highlights whose
  // animation window contains currentMs (stateless — survives scrubbing).
  private cursorBody: Graphics;
  private cursorPulse: Graphics;
  private cursorRenderHint: CursorCursor = newCursorCursor();
  private smoothedCursorX: number | null = null;
  private smoothedCursorY: number | null = null;
  // Text overlays. The container sits on the STAGE (not rootContainer), so text
  // is unaffected by the click-zoom transform and stays visible even in the
  // audio-only "black" zone past the video. One Pixi Text per event, cached.
  private textContainer: Container;
  private texts = new Map<string, { node: Text; lastContent: string; lastStyleKey: string }>();
  // Timers share the top text layer. Cached like texts — one Pixi Text per timer,
  // its content refreshed every frame from the integrated clock value.
  private timers = new Map<string, { node: Text; lastContent: string; lastStyleKey: string }>();
  // Transition layer: a full-canvas color rect (darken/flash) sitting above the
  // video+background but below text. 'fade' uses the sprite alpha and 'pixelate'
  // a filter on the sprite, so they don't need the overlay.
  private transitionOverlay: Graphics;
  private pixelate: PixelateFilter | null = null;
  private pixOn = false;

  private constructor(app: Application, size: SceneSize) {
    this.app = app;
    this.size = size;
    this.rootContainer = new Container();
    this.videoContainer = new Container();
    this.cursorBody = new Graphics();
    this.cursorBody.visible = false;
    this.cursorPulse = new Graphics();
    this.app.stage.addChild(this.rootContainer);
    this.rootContainer.addChild(this.videoContainer);
    // Cursor graphics go INSIDE videoContainer so they share the dropShadow
    // filter and visually sit "on top of" the video. We rebuild the z-order
    // when setVideo / applyLayout runs so they're always above the sprite.
    this.videoContainer.addChild(this.cursorPulse);
    this.videoContainer.addChild(this.cursorBody);
    // Transition color overlay above the scene, below text.
    this.transitionOverlay = new Graphics();
    this.transitionOverlay.visible = false;
    this.app.stage.addChild(this.transitionOverlay);
    // Text layer on top of everything.
    this.textContainer = new Container();
    this.app.stage.addChild(this.textContainer);
  }

  static async create(
    target: HTMLElement,
    sourceSize: SceneSize,
    opts: { maxWidth?: number; maxFps?: number; preserveDrawingBuffer?: boolean } = {},
  ): Promise<PixiScene> {
    // Scale down for preview if the source is larger than our budget. The
    // export path passes a large maxWidth so it renders at full target res.
    const cap = opts.maxWidth ?? PREVIEW_MAX_WIDTH;
    let w = sourceSize.w;
    let h = sourceSize.h;
    if (w > cap) {
      const scale = cap / w;
      w = Math.round(w * scale);
      h = Math.round(h * scale);
    }
    const size: SceneSize = { w, h };

    const app = new Application();
    await app.init({
      width: size.w,
      height: size.h,
      backgroundAlpha: 0,
      // Heavy savings: skip MSAA. The video itself is the dominant cost,
      // not edge aliasing on the rounded mask.
      antialias: false,
      // We render at canvas size and let CSS upscale to display size. DPR
      // multiplication on top of source resolution was destroying perf.
      autoDensity: false,
      resolution: 1,
      // Export reads each frame back via `new VideoFrame(canvas)`; keep the
      // WebGL drawing buffer so the readback isn't a cleared frame.
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
    });
    // Cap ticker fps. Preview = 30 (recordings are <=30fps). Export overrides
    // with the chosen output fps so captureStream gets enough frames.
    app.ticker.maxFPS = opts.maxFps ?? 30;
    const canvas = app.canvas as HTMLCanvasElement;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    target.appendChild(canvas);
    return new PixiScene(app, size);
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas as HTMLCanvasElement;
  }

  /**
   * Push the video's current (decoded) frame to the GPU and render once. A
   * PAUSED video's VideoSource doesn't auto-update its texture, so after we
   * seek to the first frame for the still preview we must force the upload —
   * otherwise the canvas can stay black (worse when the clip has an audio
   * track, which delays the decode). Safe to call repeatedly.
   */
  forceVideoFrame(): void {
    const src = this.videoSprite?.texture?.source as { update?: () => void } | undefined;
    try { src?.update?.(); } catch { /* ignore */ }
    try { this.app.render(); } catch { /* ignore */ }
  }

  /**
   * Show/hide the whole scene (background + video + cursor). Used for the
   * "audio tail": once the video ends but audio keeps playing, the preview
   * goes black (canvas is transparent → the dark preview-wrap shows through)
   * instead of freezing on the last frame.
   */
  setContentVisible(visible: boolean): void {
    if (this.rootContainer.visible === visible) return;
    this.rootContainer.visible = visible;
    // No explicit render here — the ticker repaints next frame. A synchronous
    // GPU render at the video→audio handoff can stall the audio thread for a
    // beat (an audible "tick").
  }

  private buildTextStyle(t: TextEvent, fontSize: number): TextStyle {
    return new TextStyle({
      fontFamily: t.fontFamily,
      fontSize,
      fontWeight: t.bold ? '700' : '400',
      fontStyle: t.italic ? 'italic' : 'normal',
      fill: t.color,
      align: t.align,
      whiteSpace: 'pre',
      dropShadow: t.shadow
        ? { color: '#000000', alpha: 0.55, blur: Math.max(2, fontSize * 0.12), distance: Math.max(1, fontSize * 0.05), angle: Math.PI / 2 }
        : false,
    });
  }

  /**
   * Render the timeline's text overlays for the current GLOBAL time. Each event
   * is a cached Pixi Text anchored at its normalized center; fade/typewriter
   * come from `textRenderState`. Events absent from `events` are destroyed;
   * out-of-range ones are just hidden. `selectedId` (if mid-edit) is forced
   * fully opaque so the drag overlay isn't fighting a fade.
   */
  updateTexts(globalMs: number, events: TextEvent[], selectedId?: string | null): void {
    const present = new Set(events.map((e) => e.id));
    for (const t of events) {
      const st = textRenderState(t, globalMs);
      const entry0 = this.texts.get(t.id);
      const showForEdit = selectedId === t.id && globalMs >= t.startMs && globalMs <= t.endMs;
      if (!st.visible && !showForEdit) {
        if (entry0) entry0.node.visible = false;
        continue;
      }
      const fontSize = Math.max(4, Math.round(t.fontScale * this.size.h));
      const content = showForEdit ? t.text : st.shownText;
      const styleKey = `${t.fontFamily}|${fontSize}|${t.bold}|${t.italic}|${t.color}|${t.align}|${t.shadow}`;
      let entry = entry0;
      if (!entry) {
        const node = new Text({ text: content, style: this.buildTextStyle(t, fontSize) });
        node.anchor.set(0.5, 0.5);
        this.textContainer.addChild(node);
        entry = { node, lastContent: content, lastStyleKey: styleKey };
        this.texts.set(t.id, entry);
      }
      if (entry.lastStyleKey !== styleKey) {
        entry.node.style = this.buildTextStyle(t, fontSize);
        entry.lastStyleKey = styleKey;
        entry.lastContent = ' '; // force a content refresh below
      }
      if (entry.lastContent !== content) {
        entry.node.text = content;
        entry.lastContent = content;
      }
      entry.node.alpha = showForEdit ? 1 : st.alpha;
      entry.node.x = t.nx * this.size.w;
      entry.node.y = t.ny * this.size.h;
      entry.node.visible = true;
    }
    for (const [id, entry] of this.texts) {
      if (!present.has(id)) {
        this.textContainer.removeChild(entry.node);
        entry.node.destroy();
        this.texts.delete(id);
      }
    }
  }

  private buildTimerStyle(t: TimerEvent, fontSize: number): TextStyle {
    return new TextStyle({
      fontFamily: t.fontFamily,
      fontSize,
      fontWeight: t.bold ? '700' : '400',
      fontStyle: t.italic ? 'italic' : 'normal',
      fill: t.color,
      align: 'center',
      whiteSpace: 'pre',
      dropShadow: t.shadow
        ? { color: '#000000', alpha: 0.55, blur: Math.max(2, fontSize * 0.12), distance: Math.max(1, fontSize * 0.05), angle: Math.PI / 2 }
        : false,
    });
  }

  /**
   * Render the timeline's chronometers for the current GLOBAL time. Mirrors
   * `updateTexts`, but each node's content is the integrated clock value
   * (see `timerText`), so it refreshes every frame while in range. A selected
   * timer is shown even at rest so its drag overlay has something to track.
   */
  updateTimers(globalMs: number, events: TimerEvent[], selectedId?: string | null): void {
    const present = new Set(events.map((e) => e.id));
    for (const t of events) {
      const inRange = globalMs >= t.startMs && globalMs <= t.endMs;
      const showForEdit = selectedId === t.id && inRange;
      const entry0 = this.timers.get(t.id);
      if (!inRange && !showForEdit) {
        if (entry0) entry0.node.visible = false;
        continue;
      }
      const fontSize = Math.max(4, Math.round(t.fontScale * this.size.h));
      const content = timerText(t, globalMs);
      const styleKey = `${t.fontFamily}|${fontSize}|${t.bold}|${t.italic}|${t.color}|${t.shadow}`;
      let entry = entry0;
      if (!entry) {
        const node = new Text({ text: content, style: this.buildTimerStyle(t, fontSize) });
        node.anchor.set(0.5, 0.5);
        this.textContainer.addChild(node);
        entry = { node, lastContent: content, lastStyleKey: styleKey };
        this.timers.set(t.id, entry);
      }
      if (entry.lastStyleKey !== styleKey) {
        entry.node.style = this.buildTimerStyle(t, fontSize);
        entry.lastStyleKey = styleKey;
        entry.lastContent = ' '; // force a content refresh below
      }
      if (entry.lastContent !== content) {
        entry.node.text = content;
        entry.lastContent = content;
      }
      entry.node.alpha = 1;
      entry.node.x = t.nx * this.size.w;
      entry.node.y = t.ny * this.size.h;
      entry.node.visible = true;
    }
    for (const [id, entry] of this.timers) {
      if (!present.has(id)) {
        this.textContainer.removeChild(entry.node);
        entry.node.destroy();
        this.timers.delete(id);
      }
    }
  }

  get renderer(): Renderer {
    return this.app.renderer;
  }

  /**
   * Wait until a media element can be textured: a video needs HAVE_METADATA
   * (else VideoSource uploads a 0×0 frame and Chromium spams GL_INVALID_VALUE);
   * an image needs to be loaded + decoded (else the texture is blank).
   */
  private async waitMediaReady(el: HTMLVideoElement | HTMLImageElement): Promise<void> {
    if (el instanceof HTMLVideoElement) {
      if (el.readyState >= 1 /* HAVE_METADATA */) return;
      await new Promise<void>((resolve) => {
        const onReady = (): void => {
          el.removeEventListener('loadedmetadata', onReady);
          el.removeEventListener('error', onReady);
          resolve();
        };
        el.addEventListener('loadedmetadata', onReady, { once: true });
        el.addEventListener('error', onReady, { once: true });
      });
      return;
    }
    if (!el.complete || el.naturalWidth === 0) {
      await new Promise<void>((resolve) => {
        const onReady = (): void => {
          el.removeEventListener('load', onReady);
          el.removeEventListener('error', onReady);
          resolve();
        };
        el.addEventListener('load', onReady, { once: true });
        el.addEventListener('error', onReady, { once: true });
      });
    }
    try { await el.decode(); } catch { /* ignore */ }
  }

  /** Create the single video/image sprite from a media element. */
  async setVideo(mediaEl: HTMLVideoElement | HTMLImageElement): Promise<void> {
    if (this.videoSprite) {
      this.videoContainer.removeChild(this.videoSprite);
      this.videoSprite.destroy();
      this.videoSprite = null;
    }
    await this.waitMediaReady(mediaEl);
    const texture = Texture.from(mediaEl);
    const sprite = new Sprite(texture);
    sprite.anchor.set(0, 0);
    this.videoSprite = sprite;
    this.videoContainer.addChildAt(sprite, 0);
    // Keep cursor graphics on top of the new sprite.
    this.videoContainer.addChild(this.cursorPulse);
    this.videoContainer.addChild(this.cursorBody);
    this.prevZoomState = null; // new media → reset cursor smoothing carry-over
    this.smoothedCursorX = null;
    this.smoothedCursorY = null;
    this.pixOn = false; // fresh sprite has no filters
    if (this.lastBg) this.applyLayout(this.lastBg);
  }

  /**
   * Apply a transition effect to the current clip (or clear it with null).
   * `strength` is 0 at rest → 1 at the cut. Called every frame from the tick.
   */
  applyTransition(t: { kind: TransitionKind; strength: number } | null): void {
    if (!this.videoSprite) return;
    const s = t ? Math.max(0, Math.min(1, t.strength)) : 0;

    // Pixelate: a filter on the sprite (dropShadow is on the container, so they
    // don't clash). Toggle the filters array only on state change.
    const wantPix = !!t && t.kind === 'pixelate' && s > 0;
    if (wantPix) {
      if (!this.pixelate) this.pixelate = new PixelateFilter(1);
      if (!this.pixOn) { this.videoSprite.filters = [this.pixelate]; this.pixOn = true; }
      this.pixelate.size = 1 + s * 28;
    } else if (this.pixOn) {
      this.videoSprite.filters = [];
      this.pixOn = false;
    }

    // Fade: ramp the clip's own alpha (reveals the background behind it).
    this.videoSprite.alpha = t && t.kind === 'fade' ? 1 - s : 1;

    // Darken / flash: a black / white full-canvas overlay.
    if (t && (t.kind === 'darken' || t.kind === 'flash') && s > 0) {
      this.transitionOverlay.clear();
      this.transitionOverlay
        .rect(0, 0, this.size.w, this.size.h)
        .fill(t.kind === 'darken' ? 0x000000 : 0xffffff);
      this.transitionOverlay.alpha = s;
      this.transitionOverlay.visible = true;
    } else {
      this.transitionOverlay.visible = false;
    }
  }

  /**
   * Hot-swap the sprite's texture to a different media element (video or image).
   * Used when the global playhead crosses into another clip.
   */
  async setActiveVideo(mediaEl: HTMLVideoElement | HTMLImageElement): Promise<void> {
    if (!this.videoSprite) {
      await this.setVideo(mediaEl);
      return;
    }
    await this.waitMediaReady(mediaEl);
    const newTexture = Texture.from(mediaEl);
    this.videoSprite.texture = newTexture;
    // Reset smoothing so the focal doesn't drift from the previous clip's
    // cursor position into the new clip's space.
    this.prevZoomState = null;
    this.cursorCursor = newCursorCursor();
    this.cursorRenderHint = newCursorCursor();
    this.smoothedCursorX = null;
    this.smoothedCursorY = null;
    if (this.lastBg) this.applyLayout(this.lastBg);
  }

  applyBackground(bg: BackgroundConfig): void {
    this.lastBg = bg;
    // Re-paint texture only when preset id changes (expensive).
    if (this.currentPresetId !== bg.presetId || !this.bgSprite) {
      this.repaintBackgroundSprite(bg.presetId);
    }
    this.applyLayout(bg);
  }

  private bgVideoEl: HTMLVideoElement | null = null;

  private clearBgMedia(): void {
    if (this.bgVideoEl) {
      try { this.bgVideoEl.pause(); this.bgVideoEl.removeAttribute('src'); this.bgVideoEl.load(); } catch { /* ignore */ }
      this.bgVideoEl = null;
    }
  }

  private setBgSpriteFromTexture(texture: Texture, presetId: string): void {
    if (this.bgSprite) {
      this.rootContainer.removeChild(this.bgSprite);
      this.bgSprite.destroy();
      this.bgSprite = null;
    }
    const sprite = new Sprite(texture);
    sprite.width = this.size.w;
    sprite.height = this.size.h;
    this.bgSprite = sprite;
    this.rootContainer.addChildAt(sprite, 0);
    this.currentPresetId = presetId;
  }

  /**
   * Resize the renderer to a new output size (used by the persistent export
   * scene, which is reused across exports at different resolutions). Forces a
   * background repaint + relayout at the new size.
   */
  resize(w: number, h: number): void {
    if (this.size.w === w && this.size.h === h) return;
    this.size = { w, h };
    try { this.app.renderer.resize(w, h); } catch { /* ignore */ }
    this.currentPresetId = null; // force bg repaint at the new size
    if (this.lastBg) this.applyBackground(this.lastBg);
  }

  private pendingCustomBgUnsub: (() => void) | null = null;

  private repaintBackgroundSprite(presetId: string): void {
    this.clearBgMedia();
    // Clear any pending wait for a previous custom bg.
    if (this.pendingCustomBgUnsub) { this.pendingCustomBgUnsub(); this.pendingCustomBgUnsub = null; }
    if (isCustomPresetId(presetId)) {
      const customId = extractCustomId(presetId);
      const entry = customId ? getCustomBackground(customId) : undefined;
      if (!entry) {
        // Fall back to default while we wait for the registry to populate.
        const fallback = paintBackgroundToCanvas(getPreset('sunset-gradient'), this.size.w, this.size.h);
        this.setBgSpriteFromTexture(Texture.from(fallback), presetId);
        // Listen for the entry to arrive (e.g. registry hydration on project load).
        this.pendingCustomBgUnsub = onCustomBackgroundsChange(() => {
          if (this.currentPresetId !== presetId) return;
          const cid = extractCustomId(presetId);
          if (cid && getCustomBackground(cid)) {
            if (this.pendingCustomBgUnsub) { this.pendingCustomBgUnsub(); this.pendingCustomBgUnsub = null; }
            this.currentPresetId = null;
            this.repaintBackgroundSprite(presetId);
          }
        });
        return;
      }
      if (entry.kind === 'image') {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.src = entry.assetUrl;
        const finish = (): void => {
          if (this.currentPresetId !== presetId && this.currentPresetId !== null) {
            // user switched presets mid-load; abandon
            return;
          }
          this.setBgSpriteFromTexture(Texture.from(img), presetId);
        };
        if (img.complete && img.naturalWidth > 0) finish();
        else img.addEventListener('load', finish, { once: true });
      } else {
        const v = document.createElement('video');
        v.crossOrigin = 'anonymous';
        v.muted = true;
        v.loop = true;
        v.playsInline = true;
        v.autoplay = true;
        v.src = entry.assetUrl;
        this.bgVideoEl = v;
        const finish = (): void => {
          if (this.bgVideoEl !== v) return;
          this.setBgSpriteFromTexture(Texture.from(v), presetId);
          v.play().catch(() => { /* the user can scrub past autoplay errors */ });
        };
        if (v.readyState >= 2) finish();
        else v.addEventListener('loadeddata', finish, { once: true });
      }
      // Tentatively mark the target preset so concurrent calls don't repaint.
      this.currentPresetId = presetId;
      return;
    }
    const preset = getPreset(presetId);
    const canvas = paintBackgroundToCanvas(preset, this.size.w, this.size.h);
    this.setBgSpriteFromTexture(Texture.from(canvas), presetId);
  }

  private applyLayout(bg: BackgroundConfig): void {
    if (!this.videoSprite) return;
    const padPx = (this.size.w * bg.paddingPct) / 100;
    const padPxY = (this.size.h * bg.paddingPct) / 100;
    const w = this.size.w - 2 * padPx;
    const h = this.size.h - 2 * padPxY;

    // Mask for rounded corners — STAYS at the visible window. The sprite
    // itself scales/translates beyond the mask when a zoom is active; the
    // mask clips the overflow.
    if (this.videoMask) {
      this.videoContainer.removeChild(this.videoMask);
      this.videoMask.destroy();
      this.videoMask = null;
    }
    if (bg.cornerRadiusPx > 0) {
      const mask = new Graphics();
      mask.roundRect(padPx, padPxY, w, h, bg.cornerRadiusPx).fill(0xffffff);
      this.videoMask = mask;
      this.videoContainer.addChild(mask);
      this.videoSprite.mask = mask;
    } else {
      this.videoSprite.mask = null;
    }

    // Reset sprite to identity zoom baseline. updateZoom() (called every
    // frame) will override this with the actual transform.
    this.applyZoomToSprite(IDENTITY_ZOOM);

    // Drop shadow on the video CONTAINER so it follows the mask shape.
    if (bg.shadow.enabled) {
      if (!this.dropShadow) {
        this.dropShadow = new DropShadowFilter({
          offset: { x: 0, y: bg.shadow.y },
          alpha: bg.shadow.opacity,
          blur: Math.max(0.1, bg.shadow.blur / 8),
          quality: 2,
          color: 0x000000,
        });
        this.videoContainer.filters = [this.dropShadow];
      } else {
        this.dropShadow.offset = { x: 0, y: bg.shadow.y };
        this.dropShadow.alpha = bg.shadow.opacity;
        this.dropShadow.blur = Math.max(0.1, bg.shadow.blur / 8);
      }
    } else {
      this.videoContainer.filters = [];
      this.dropShadow = null;
    }
  }

  private applyZoomToSprite(state: ZoomState): void {
    if (!this.videoSprite || !this.lastBg) return;
    const bg = this.lastBg;
    const padX = (this.size.w * bg.paddingPct) / 100;
    const padY = (this.size.h * bg.paddingPct) / 100;
    const W = this.size.w - 2 * padX;
    const H = this.size.h - 2 * padY;

    // Crop-edit / track-edit modes: show the FULL frame fit to the padded area,
    // no crop, no zoom. The crop handles / focus dots map directly onto this rect.
    if (this.cropEditMode || this.trackEditMode) {
      this.videoSprite.x = padX;
      this.videoSprite.y = padY;
      this.videoSprite.width = W;
      this.videoSprite.height = H;
      return;
    }

    // Base crop transform: the crop sub-rect [cx,cy,cw,ch] (normalized source)
    // maps onto the padded area [padX,padY,W,H]. The full frame is therefore
    // sized to (W/cw)x(H/ch) and offset so the crop's top-left sits at the pad
    // origin. Click-zoom (scale Z about focal point) composes on top of that.
    const cx = this.crop?.x ?? 0;
    const cy = this.crop?.y ?? 0;
    const cw = this.crop?.w ?? 1;
    const ch = this.crop?.h ?? 1;
    const spriteW0 = W / cw;
    const spriteH0 = H / ch;
    const spriteX0 = padX - cx * spriteW0;
    const spriteY0 = padY - cy * spriteH0;
    // Focal point in canvas at Z=1 (with crop applied).
    const focalCanvasX = spriteX0 + state.focalNx * spriteW0;
    const focalCanvasY = spriteY0 + state.focalNy * spriteH0;
    const Z = state.scale;
    const spriteWpx = spriteW0 * Z;
    const spriteHpx = spriteH0 * Z;
    this.videoSprite.width = spriteWpx;
    this.videoSprite.height = spriteHpx;

    // ANCHOR position: keep the focal point where it sits in the frame (classic
    // click-zoom — zoom into the point in place).
    const anchorX = focalCanvasX - state.focalNx * spriteWpx;
    const anchorY = focalCanvasY - state.focalNy * spriteHpx;

    // CENTER position: put the focal at the padded-area centre (camera "looks
    // at" the point), clamped so the sprite still covers the window (no gaps).
    const tightness = state.focalTightness ?? 0;
    if (tightness > 0) {
      const rawCenterX = padX + W / 2 - state.focalNx * spriteWpx;
      const rawCenterY = padY + H / 2 - state.focalNy * spriteHpx;
      const centerX = Math.max(padX + W - spriteWpx, Math.min(padX, rawCenterX));
      const centerY = Math.max(padY + H - spriteHpx, Math.min(padY, rawCenterY));
      this.videoSprite.x = anchorX + tightness * (centerX - anchorX);
      this.videoSprite.y = anchorY + tightness * (centerY - anchorY);
    } else {
      this.videoSprite.x = anchorX;
      this.videoSprite.y = anchorY;
    }
  }

  /**
   * Set the crop rect (normalized) or null for full frame. Cheap to call every
   * frame — it early-returns when the value is unchanged. The next updateZoom
   * tick applies it (no mask rebuild needed; the crop only affects the sprite
   * transform, not the fixed mask window).
   */
  setCrop(crop: { x: number; y: number; w: number; h: number } | null): void {
    const norm = crop && crop.w > 0 && crop.h > 0 ? crop : null;
    const a = this.crop;
    const same = (!a && !norm) ||
      (!!a && !!norm && a.x === norm.x && a.y === norm.y && a.w === norm.w && a.h === norm.h);
    if (same) return;
    this.crop = norm;
  }

  /** Toggle the full-frame crop-editing render. */
  setCropEditMode(enabled: boolean): void {
    if (this.cropEditMode === enabled) return;
    this.cropEditMode = enabled;
  }

  /** Toggle the full-frame track-editing render (authoring a zoom's pan path). */
  setTrackEditMode(enabled: boolean): void {
    if (this.trackEditMode === enabled) return;
    this.trackEditMode = enabled;
  }

  updateZoom(
    currentMs: number,
    zoomEvents: ZoomEvent[],
    mouseEvents?: MouseEventRaw[],
    coordSpace?: { width: number; height: number },
  ): void {
    if (!this.videoSprite || !this.lastBg) return;
    const state = computeZoomState(currentMs, zoomEvents, {
      mouseEvents,
      coordSpace,
      previousState: this.prevZoomState,
      cursorCursor: this.cursorCursor,
    });
    this.applyZoomToSprite(state);
    this.prevZoomState = state;
  }

  /**
   * Render the enhanced cursor layer over the video. Behaviour depends on
   * `cfg.style`:
   *   - 'hidden'     : nothing drawn (the video's own cursor, if any, shows).
   *   - 'pulse'      : no follower; rings grow + fade at each `down` event.
   *   - 'dot'        : filled circle follows the cursor + scales on click.
   *   - 'arrow'      : Windows-style pointer + scales on click ("Screen Studio").
   *
   * Positions for the follower and the pulse rings are derived from
   * `mouseEvents` (LERPed at `currentMs`) and mapped through the videoSprite's
   * current transform so they track correctly under zoom. Click animations are
   * stateless (a pure function of `currentMs - eventTime`) so scrubbing
   * replays them naturally.
   */
  updateCursor(
    currentMs: number,
    mouseEvents: MouseEventRaw[],
    coordSpace: { width: number; height: number },
    cfg: CursorConfig,
  ): void {
    // Always reset graphics before deciding — keeps the previous frame's
    // drawing from "smearing" into the new style when the user changes it.
    this.cursorBody.clear();
    this.cursorBody.visible = false;
    this.cursorPulse.clear();

    if (!this.videoSprite || !this.lastBg) return;
    // Crop editor shows the raw frame only. Track editor KEEPS the cursor — you
    // need to see it to follow it. (In track mode the sprite is the full frame,
    // so the cursor still maps correctly.)
    if (this.cropEditMode) return;
    if (cfg.style === 'hidden' || mouseEvents.length === 0) return;

    const bg = this.lastBg;
    const padX = (this.size.w * bg.paddingPct) / 100;
    const padY = (this.size.h * bg.paddingPct) / 100;
    const W = this.size.w - 2 * padX;
    const H = this.size.h - 2 * padY;
    const fillColor = hexColor(cfg.color, 0xffffff);

    // ───── 'pulse' style: no follower, only click rings ─────
    if (cfg.style === 'pulse') {
      if (!cfg.click.enabled) return;
      const dur = Math.max(80, cfg.click.durationMs);
      const ringColor = hexColor(cfg.click.pulseColor, 0x6c8cff);
      const maxR = cfg.click.pulseMaxSizePx;
      for (let i = 0; i < mouseEvents.length; i++) {
        const ev = mouseEvents[i];
        if (ev.type !== 'down') continue;
        if (ev.t > currentMs) break;
        const elapsed = currentMs - ev.t;
        if (elapsed < 0 || elapsed > dur) continue;
        const t = elapsed / dur;
        const eased = 1 - (1 - t) * (1 - t);   // radius: ease-out
        const r = maxR * eased;
        const a = (1 - t) * 0.85;              // alpha: linear fade
        const enx = ev.x / coordSpace.width;
        const eny = ev.y / coordSpace.height;
        const px = this.videoSprite.x + enx * this.videoSprite.width;
        const py = this.videoSprite.y + eny * this.videoSprite.height;
        if (px < padX || px > padX + W || py < padY || py > padY + H) continue;
        this.cursorPulse.circle(px, py, r).stroke({ color: ringColor, alpha: a, width: 2 });
      }
      return;
    }

    // ───── 'dot' / 'arrow' styles: follower with optional click scale ─────
    const raw = cursorAt(currentMs, mouseEvents, this.cursorRenderHint);
    if (!raw) return;
    const nx = raw.x / coordSpace.width;
    const ny = raw.y / coordSpace.height;
    const targetX = this.videoSprite.x + nx * this.videoSprite.width;
    const targetY = this.videoSprite.y + ny * this.videoSprite.height;

    // Frame-to-frame LERP. smoothing=0 → snap; ~0.5 → cinematic glide.
    const alpha = Math.max(0.05, Math.min(1, 1 - cfg.smoothing));
    if (this.smoothedCursorX === null || this.smoothedCursorY === null) {
      this.smoothedCursorX = targetX;
      this.smoothedCursorY = targetY;
    } else {
      this.smoothedCursorX += alpha * (targetX - this.smoothedCursorX);
      this.smoothedCursorY += alpha * (targetY - this.smoothedCursorY);
    }
    const cx = this.smoothedCursorX;
    const cy = this.smoothedCursorY;

    // Hide outside the visible video window (e.g. zoomed in past the cursor).
    if (cx < padX || cx > padX + W || cy < padY || cy > padY + H) return;

    // Find the most-recent click whose scale animation is still in progress
    // and compute a bell-curve scale multiplier (1 → peak → 1).
    let clickScale = 1;
    if (cfg.click.enabled) {
      const dur = Math.max(80, cfg.click.durationMs);
      for (let i = mouseEvents.length - 1; i >= 0; i--) {
        const ev = mouseEvents[i];
        if (ev.t > currentMs) continue;
        if (ev.type !== 'down') continue;
        const elapsed = currentMs - ev.t;
        if (elapsed > dur) break;       // older events can't matter
        const t = elapsed / dur;
        const bell = Math.sin(t * Math.PI); // peaks at t=0.5
        clickScale = 1 + (cfg.click.peakScale - 1) * bell;
        break;
      }
    }

    const baseScale = Math.max(0.3, cfg.size) * clickScale;

    if (cfg.style === 'dot') {
      const radius = CURSOR_BASE_RADIUS_PX * baseScale;
      // Outer glow, mid ring, solid centre — drawn at local (0,0) and then
      // positioned via this.cursorBody.position.set(cx, cy). Pivoting the
      // circle stack at the centre means click-scale grows around the centre.
      this.cursorBody
        .circle(0, 0, radius * 1.7).fill({ color: fillColor, alpha: cfg.opacity * 0.18 })
        .circle(0, 0, radius * 1.15).fill({ color: fillColor, alpha: cfg.opacity * 0.35 })
        .circle(0, 0, radius * 0.55).fill({ color: fillColor, alpha: cfg.opacity });
      this.cursorBody.scale.set(1, 1);
      this.cursorBody.position.set(cx, cy);
      this.cursorBody.visible = true;
    } else if (cfg.style === 'arrow') {
      // Draw the unit arrow once into cursorBody; scale via the Graphics
      // transform so the click animation can lerp it around the hotspot (0,0).
      const outlineColor = hexColor(cfg.outlineColor, 0x111111);
      drawArrow(this.cursorBody, fillColor, cfg.opacity, outlineColor);
      this.cursorBody.scale.set(baseScale);
      this.cursorBody.position.set(cx, cy);
      this.cursorBody.visible = true;
    }
  }

  /** Called when the user scrubs / seeks — drop the smoothing state so the
   * next frame samples the cursor fresh instead of LERPing from the old
   * position (which would cause a noticeable drift on jump). */
  resetSmoothingState(): void {
    this.prevZoomState = null;
    this.cursorCursor = newCursorCursor();
    this.cursorRenderHint = newCursorCursor();
    this.smoothedCursorX = null;
    this.smoothedCursorY = null;
  }

  destroy(): void {
    // CRITICAL: the export path runs a SECOND PixiJS Application at the same
    // time as this preview one. PixiJS v8's text texture pool (and filter
    // batchers) are GLOBAL singletons shared across Applications. Destroying a
    // `Text` returns its render-texture to that shared pool; doing so while the
    // other app is alive corrupts it and crashes the other app's next render
    // (`returnTexture … undefined.push`, batcher `… null.clear`). So we tear
    // down gently: detach text nodes WITHOUT destroying them, drop filters, and
    // destroy the renderer WITHOUT freeing textures (`texture: false`). The
    // small leak is fine — these are one-shot / project-lifetime scenes.
    try {
      for (const { node } of this.texts.values()) {
        try { node.visible = false; this.textContainer.removeChild(node); } catch { /* ignore */ }
      }
      this.texts.clear();
      for (const { node } of this.timers.values()) {
        try { node.visible = false; this.textContainer.removeChild(node); } catch { /* ignore */ }
      }
      this.timers.clear();
      try { this.videoContainer.filters = []; } catch { /* ignore */ }
      try { if (this.videoSprite) this.videoSprite.filters = []; } catch { /* ignore */ }
      this.dropShadow = null;
      this.pixelate = null;
      this.pixOn = false;
      this.clearBgMedia();
      if (this.pendingCustomBgUnsub) { this.pendingCustomBgUnsub(); this.pendingCustomBgUnsub = null; }
    } catch { /* ignore */ }
    this.app.destroy(true, { children: true, texture: false, textureSource: false });
  }
}
