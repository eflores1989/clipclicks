import type { Ms, TextEvent, TextPreset } from '../types/project';

/** Default look + animation for each pool block. fontScale = fraction of canvas height. */
export const TEXT_PRESET_DEFAULTS: Record<TextPreset, Omit<TextEvent, 'id' | 'startMs' | 'endMs' | 'preset'>> = {
  title: {
    text: 'Título',
    nx: 0.5, ny: 0.22,
    fontScale: 0.10,
    fontFamily: 'Inter, Segoe UI, sans-serif',
    bold: true, italic: false,
    color: '#ffffff',
    align: 'center',
    shadow: true,
    enterAnim: 'fade', exitAnim: 'fade',
    enterDurationMs: 450, exitDurationMs: 400,
  },
  subtitle: {
    text: 'Subtítulo',
    nx: 0.5, ny: 0.85,
    fontScale: 0.05,
    fontFamily: 'Inter, Segoe UI, sans-serif',
    bold: false, italic: false,
    color: '#ffffff',
    align: 'center',
    shadow: true,
    enterAnim: 'fade', exitAnim: 'fade',
    enterDurationMs: 350, exitDurationMs: 350,
  },
  paragraph: {
    // Typewriter feel — good for software walkthroughs.
    text: 'Escribí tu texto…',
    nx: 0.5, ny: 0.5,
    fontScale: 0.045,
    fontFamily: 'Inter, Segoe UI, sans-serif',
    bold: false, italic: false,
    color: '#ffffff',
    align: 'left',
    shadow: true,
    enterAnim: 'type', exitAnim: 'fade',
    enterDurationMs: 900, exitDurationMs: 350,
  },
};

/** Build a fresh TextEvent for a preset, placed at [startMs, endMs]. */
export function makeTextEvent(preset: TextPreset, startMs: Ms, endMs: Ms): TextEvent {
  return {
    id: crypto.randomUUID(),
    startMs,
    endMs,
    preset,
    ...TEXT_PRESET_DEFAULTS[preset],
  };
}

export interface TextRenderState {
  /** Whether the text should be drawn at all for this time. */
  visible: boolean;
  /** Opacity 0..1 (drives fade in/out). */
  alpha: number;
  /** The substring to show (full text unless mid-typewriter). */
  shownText: string;
}

/**
 * Compute how a text should appear at a given global time: visibility, fade
 * alpha, and (for the typewriter animation) how much of the string is typed.
 * Shared by the live preview (PixiScene) and the export renderer.
 */
export function textRenderState(t: TextEvent, globalMs: number): TextRenderState {
  if (globalMs < t.startMs || globalMs > t.endMs) {
    return { visible: false, alpha: 0, shownText: '' };
  }
  const sinceStart = globalMs - t.startMs;
  const untilEnd = t.endMs - globalMs;

  let alpha = 1;
  if (t.enterAnim === 'fade' && t.enterDurationMs > 0) {
    alpha = Math.min(alpha, sinceStart / t.enterDurationMs);
  }
  if (t.exitAnim === 'fade' && t.exitDurationMs > 0) {
    alpha = Math.min(alpha, untilEnd / t.exitDurationMs);
  }
  alpha = Math.max(0, Math.min(1, alpha));

  let shownText = t.text;
  if (t.enterAnim === 'type' && t.enterDurationMs > 0 && t.text.length > 0) {
    const progress = Math.max(0, Math.min(1, sinceStart / t.enterDurationMs));
    const chars = Math.ceil(progress * t.text.length);
    shownText = t.text.slice(0, chars);
  }

  return { visible: true, alpha, shownText };
}
