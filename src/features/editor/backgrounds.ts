export type BackgroundPresetType = 'solid' | 'linear-gradient' | 'radial-gradient';

export interface BackgroundPreset {
  id: string;
  name: string;
  type: BackgroundPresetType;
  solid?: string;
  linear?: { from: string; to: string; angleDeg: number };
  radial?: { center: string; edge: string };
  multi?: Array<{ color: string; pos: number }>;
  /** Optional CSS background string for HTML previews (palette swatches, panel) */
  css: string;
}

export const BACKGROUND_PRESETS: BackgroundPreset[] = [
  {
    id: 'sunset-gradient',
    name: 'Sunset Gradient',
    type: 'linear-gradient',
    linear: { from: '#ff9a6c', to: '#ff6f91', angleDeg: 135 },
    css: 'linear-gradient(135deg, #ff9a6c 0%, #ff6f91 100%)',
  },
  {
    id: 'ocean-mesh',
    name: 'Ocean Mesh',
    type: 'linear-gradient',
    linear: { from: '#6bb6ff', to: '#b078ff', angleDeg: 135 },
    css: 'linear-gradient(135deg, #6bb6ff 0%, #b078ff 100%)',
  },
  {
    id: 'macos-sonoma',
    name: 'macOS Sonoma',
    type: 'linear-gradient',
    multi: [
      { color: '#f4c5b0', pos: 0 },
      { color: '#b6a0f0', pos: 0.5 },
      { color: '#6ab4d8', pos: 1 },
    ],
    linear: { from: '#f4c5b0', to: '#6ab4d8', angleDeg: 160 },
    css: 'linear-gradient(160deg, #f4c5b0 0%, #b6a0f0 50%, #6ab4d8 100%)',
  },
  {
    id: 'macos-sequoia-dark',
    name: 'macOS Sequoia Dark',
    type: 'linear-gradient',
    linear: { from: '#1a1f2e', to: '#2d3245', angleDeg: 160 },
    css: 'linear-gradient(160deg, #1a1f2e 0%, #2d3245 100%)',
  },
  {
    id: 'solid-charcoal',
    name: 'Solid Charcoal',
    type: 'solid',
    solid: '#1C1C1E',
    css: '#1C1C1E',
  },
  {
    id: 'solid-offwhite',
    name: 'Solid Off-White',
    type: 'solid',
    solid: '#F5F5F0',
    css: '#F5F5F0',
  },
  {
    id: 'purple-haze',
    name: 'Purple Haze',
    type: 'radial-gradient',
    radial: { center: '#8b5cf6', edge: '#1f1235' },
    css: 'radial-gradient(circle, #8b5cf6 0%, #1f1235 100%)',
  },
  {
    id: 'forest-mint',
    name: 'Forest Mint',
    type: 'linear-gradient',
    linear: { from: '#a8e6cf', to: '#2d6a4f', angleDeg: 135 },
    css: 'linear-gradient(135deg, #a8e6cf 0%, #2d6a4f 100%)',
  },
  {
    id: 'dotted-grid-light',
    name: 'Dotted Grid Light',
    type: 'solid',
    solid: '#fafafa',
    css: '#fafafa',
  },
  {
    id: 'linear-glow',
    name: 'Linear Glow',
    type: 'linear-gradient',
    linear: { from: '#1e3a8a', to: '#c026d3', angleDeg: 135 },
    css: 'linear-gradient(135deg, #1e3a8a 0%, #c026d3 100%)',
  },
];

const PRESET_BY_ID = new Map(BACKGROUND_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): BackgroundPreset {
  return PRESET_BY_ID.get(id) ?? BACKGROUND_PRESETS[0];
}

/**
 * Paint the background preset into a 2D canvas. Used as a source texture for
 * the PixiJS background sprite — works for any gradient/pattern we want.
 */
export function paintBackgroundToCanvas(
  preset: BackgroundPreset,
  width: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  if (preset.type === 'solid' && preset.solid) {
    ctx.fillStyle = preset.solid;
    ctx.fillRect(0, 0, width, height);
    if (preset.id === 'dotted-grid-light') {
      ctx.fillStyle = '#d4d4d8';
      const step = Math.max(16, Math.round(width / 60));
      for (let y = step / 2; y < height; y += step) {
        for (let x = step / 2; x < width; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    return canvas;
  }

  if (preset.type === 'linear-gradient') {
    const angle = (preset.linear?.angleDeg ?? 135) * (Math.PI / 180);
    const cx = width / 2;
    const cy = height / 2;
    const half = Math.max(width, height);
    const dx = (Math.cos(angle) * half) / 2;
    const dy = (Math.sin(angle) * half) / 2;
    const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
    if (preset.multi) {
      for (const s of preset.multi) grad.addColorStop(s.pos, s.color);
    } else if (preset.linear) {
      grad.addColorStop(0, preset.linear.from);
      grad.addColorStop(1, preset.linear.to);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    return canvas;
  }

  if (preset.type === 'radial-gradient' && preset.radial) {
    const cx = width / 2;
    const cy = height / 2;
    const r = Math.max(width, height) * 0.7;
    const grad = ctx.createRadialGradient(cx, cy, r * 0.05, cx, cy, r);
    grad.addColorStop(0, preset.radial.center);
    grad.addColorStop(1, preset.radial.edge);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    return canvas;
  }

  return canvas;
}
