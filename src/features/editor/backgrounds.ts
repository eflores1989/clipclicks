export type BackgroundPresetType =
  | 'solid'
  | 'linear-gradient'
  | 'radial-gradient'
  | 'pattern';

export type BackgroundPatternId =
  | 'dotted-grid-light'
  | 'aurora'
  | 'synthwave'
  | 'neon-grid'
  | 'starfield'
  | 'liquid'
  | 'plasma'
  | 'carbon'
  | 'topo'
  | 'hex'
  | 'wave-mesh'
  | 'vapor'
  | 'matrix'
  | 'paper-grid'
  | 'terrazzo'
  | 'dot-storm'
  | 'blueprint'
  | 'circuit';

export interface BackgroundPreset {
  id: string;
  name: string;
  type: BackgroundPresetType;
  solid?: string;
  linear?: { from: string; to: string; angleDeg: number };
  radial?: { center: string; edge: string };
  multi?: Array<{ color: string; pos: number }>;
  pattern?: BackgroundPatternId;
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
    type: 'pattern',
    pattern: 'dotted-grid-light',
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

  // New presets (v0.1.2+)
  {
    id: 'aurora',
    name: 'Aurora',
    type: 'pattern',
    pattern: 'aurora',
    css: 'linear-gradient(160deg, #0b1d2a 0%, #1d4d4f 40%, #2f805d 70%, #5a3a8a 100%)',
  },
  {
    id: 'synthwave',
    name: 'Synthwave Horizon',
    type: 'pattern',
    pattern: 'synthwave',
    css: 'linear-gradient(180deg, #2a0a4a 0%, #5b1872 40%, #f25590 80%, #ffb86b 100%)',
  },
  {
    id: 'neon-grid',
    name: 'Neon Grid',
    type: 'pattern',
    pattern: 'neon-grid',
    css: 'radial-gradient(circle at 50% 60%, #1b1340 0%, #07051a 100%)',
  },
  {
    id: 'starfield',
    name: 'Starfield',
    type: 'pattern',
    pattern: 'starfield',
    css: 'radial-gradient(circle at 50% 50%, #1a1f3a 0%, #050610 100%)',
  },
  {
    id: 'liquid',
    name: 'Liquid Blobs',
    type: 'pattern',
    pattern: 'liquid',
    css: 'linear-gradient(135deg, #5a8bff 0%, #c060ff 60%, #ff7eb6 100%)',
  },
  {
    id: 'plasma',
    name: 'Plasma',
    type: 'pattern',
    pattern: 'plasma',
    css: 'linear-gradient(135deg, #ff3d80 0%, #7a3df3 50%, #2eb6ff 100%)',
  },
  {
    id: 'carbon',
    name: 'Carbon Fiber',
    type: 'pattern',
    pattern: 'carbon',
    css: '#0d0d0f',
  },
  {
    id: 'topo',
    name: 'Topographic',
    type: 'pattern',
    pattern: 'topo',
    css: 'linear-gradient(160deg, #f1ece1 0%, #d9cdb0 100%)',
  },
  {
    id: 'hex',
    name: 'Hexagons',
    type: 'pattern',
    pattern: 'hex',
    css: 'linear-gradient(135deg, #1e293b 0%, #334155 100%)',
  },
  {
    id: 'wave-mesh',
    name: 'Wave Mesh',
    type: 'pattern',
    pattern: 'wave-mesh',
    css: 'linear-gradient(180deg, #0e1738 0%, #1f3a7a 100%)',
  },
  {
    id: 'vapor',
    name: 'Vaporwave',
    type: 'pattern',
    pattern: 'vapor',
    css: 'linear-gradient(180deg, #ff7ad9 0%, #b76dff 50%, #6acdff 100%)',
  },
  {
    id: 'matrix',
    name: 'Matrix Rain',
    type: 'pattern',
    pattern: 'matrix',
    css: '#020807',
  },
  {
    id: 'paper-grid',
    name: 'Paper Grid',
    type: 'pattern',
    pattern: 'paper-grid',
    css: '#fbfbf6',
  },
  {
    id: 'terrazzo',
    name: 'Terrazzo',
    type: 'pattern',
    pattern: 'terrazzo',
    css: '#f6f3ec',
  },
  {
    id: 'dot-storm',
    name: 'Dot Storm',
    type: 'pattern',
    pattern: 'dot-storm',
    css: 'radial-gradient(circle, #1c1c2e 0%, #07071a 100%)',
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    type: 'pattern',
    pattern: 'blueprint',
    css: '#0d3b66',
  },
  {
    id: 'circuit',
    name: 'Circuit Board',
    type: 'pattern',
    pattern: 'circuit',
    css: '#04221b',
  },
  {
    id: 'solid-cream',
    name: 'Solid Cream',
    type: 'solid',
    solid: '#fef7e6',
    css: '#fef7e6',
  },
  {
    id: 'solid-slate',
    name: 'Solid Slate',
    type: 'solid',
    solid: '#475569',
    css: '#475569',
  },
  {
    id: 'cyber-sunset',
    name: 'Cyber Sunset',
    type: 'linear-gradient',
    multi: [
      { color: '#0b0524', pos: 0 },
      { color: '#7b1f8b', pos: 0.45 },
      { color: '#ff5d3a', pos: 0.85 },
      { color: '#ffd166', pos: 1 },
    ],
    linear: { from: '#0b0524', to: '#ffd166', angleDeg: 180 },
    css: 'linear-gradient(180deg, #0b0524 0%, #7b1f8b 45%, #ff5d3a 85%, #ffd166 100%)',
  },
  {
    id: 'midnight-aurora',
    name: 'Midnight Aurora',
    type: 'radial-gradient',
    radial: { center: '#1ed588', edge: '#050a1f' },
    css: 'radial-gradient(circle at 30% 40%, #1ed588 0%, #050a1f 90%)',
  },
];

const PRESET_BY_ID = new Map(BACKGROUND_PRESETS.map((p) => [p.id, p]));

export function getPreset(id: string): BackgroundPreset {
  return PRESET_BY_ID.get(id) ?? BACKGROUND_PRESETS[0];
}

/**
 * Custom backgrounds (user-imported images/videos) live in the main process
 * config. The renderer keeps a parallel registry here so PixiScene can look
 * up an entry by id and so the BG library UI knows what to display.
 */
export interface CustomBackgroundEntry {
  id: string;
  name: string;
  kind: 'image' | 'video';
  filePath: string;
  /** Pre-resolved `vzasset://…` url that the renderer can load. */
  assetUrl: string;
  /** Optional CSS thumbnail used in the library grid (built from a snapshot). */
  thumbCss?: string;
}

export const CUSTOM_BG_PREFIX = 'custom:';

const customRegistry = new Map<string, CustomBackgroundEntry>();
const customListeners = new Set<() => void>();

export function getCustomBackground(id: string): CustomBackgroundEntry | undefined {
  return customRegistry.get(id);
}

export function listCustomBackgroundEntries(): CustomBackgroundEntry[] {
  return [...customRegistry.values()];
}

export function registerCustomBackground(entry: CustomBackgroundEntry): void {
  customRegistry.set(entry.id, entry);
  notifyCustomChange();
}

export function unregisterCustomBackground(id: string): void {
  customRegistry.delete(id);
  notifyCustomChange();
}

export function replaceCustomBackgrounds(entries: CustomBackgroundEntry[]): void {
  customRegistry.clear();
  for (const e of entries) customRegistry.set(e.id, e);
  notifyCustomChange();
}

export function onCustomBackgroundsChange(cb: () => void): () => void {
  customListeners.add(cb);
  return () => customListeners.delete(cb);
}

function notifyCustomChange(): void {
  for (const cb of customListeners) {
    try { cb(); } catch { /* ignore */ }
  }
}

export function isCustomPresetId(id: string): boolean {
  return id.startsWith(CUSTOM_BG_PREFIX);
}

export function extractCustomId(presetId: string): string | null {
  if (!presetId.startsWith(CUSTOM_BG_PREFIX)) return null;
  return presetId.slice(CUSTOM_BG_PREFIX.length);
}

/** Deterministic pseudo-random — same canvas size produces same pattern. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function paintPattern(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  id: BackgroundPatternId,
): void {
  switch (id) {
    case 'dotted-grid-light': {
      ctx.fillStyle = '#fafafa';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#d4d4d8';
      const step = Math.max(16, Math.round(width / 60));
      for (let y = step / 2; y < height; y += step) {
        for (let x = step / 2; x < width; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      return;
    }
    case 'aurora': {
      const base = ctx.createLinearGradient(0, 0, 0, height);
      base.addColorStop(0, '#06121e');
      base.addColorStop(1, '#0c2540');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, width, height);
      const bands: Array<{ color: string; y: number; amp: number; freq: number }> = [
        { color: 'rgba(46, 192, 138, 0.55)', y: height * 0.35, amp: height * 0.12, freq: 1.4 },
        { color: 'rgba(124, 92, 240, 0.45)', y: height * 0.50, amp: height * 0.15, freq: 1.1 },
        { color: 'rgba(38, 220, 200, 0.35)', y: height * 0.62, amp: height * 0.10, freq: 1.8 },
      ];
      for (const b of bands) {
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.moveTo(0, height);
        for (let x = 0; x <= width; x += 8) {
          const yy = b.y + Math.sin((x / width) * Math.PI * b.freq * 2) * b.amp
            + Math.sin((x / width) * Math.PI * b.freq * 5) * b.amp * 0.3;
          ctx.lineTo(x, yy);
        }
        ctx.lineTo(width, height);
        ctx.closePath();
        ctx.fill();
      }
      // Stars
      const rng = mulberry32(7);
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (let i = 0; i < 90; i++) {
        const x = rng() * width;
        const y = rng() * height * 0.5;
        const r = rng() * 0.9 + 0.3;
        ctx.fillRect(x, y, r, r);
      }
      return;
    }
    case 'synthwave': {
      const sky = ctx.createLinearGradient(0, 0, 0, height);
      sky.addColorStop(0, '#2a0a4a');
      sky.addColorStop(0.45, '#5b1872');
      sky.addColorStop(0.7, '#f25590');
      sky.addColorStop(1, '#ffb86b');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, width, height);
      // Sun
      const cx = width / 2;
      const sunY = height * 0.55;
      const sunR = Math.min(width, height) * 0.18;
      const sunGrad = ctx.createLinearGradient(cx, sunY - sunR, cx, sunY + sunR);
      sunGrad.addColorStop(0, '#fff15a');
      sunGrad.addColorStop(0.6, '#ff7a3d');
      sunGrad.addColorStop(1, '#d61f6a');
      ctx.fillStyle = sunGrad;
      ctx.beginPath();
      ctx.arc(cx, sunY, sunR, 0, Math.PI * 2);
      ctx.fill();
      // Sun stripes (cutouts)
      ctx.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 6; i++) {
        const y = sunY + sunR * 0.55 + i * sunR * 0.12;
        ctx.fillRect(cx - sunR, y, sunR * 2, sunR * 0.05);
      }
      ctx.globalCompositeOperation = 'source-over';
      // Grid floor
      const horizon = height * 0.68;
      ctx.strokeStyle = 'rgba(255, 90, 200, 0.85)';
      ctx.lineWidth = 1.2;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20;
        const y = horizon + (height - horizon) * (t * t);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      for (let i = -10; i <= 10; i++) {
        const x = cx + (i * width) * 0.06;
        ctx.beginPath();
        ctx.moveTo(x, horizon);
        ctx.lineTo(cx + (i * width) * 0.5, height);
        ctx.stroke();
      }
      return;
    }
    case 'neon-grid': {
      const bg = ctx.createRadialGradient(width / 2, height * 0.6, 0, width / 2, height * 0.6, Math.max(width, height));
      bg.addColorStop(0, '#1b1340');
      bg.addColorStop(1, '#07051a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.55)';
      ctx.lineWidth = 1;
      const step = Math.max(40, Math.round(width / 32));
      for (let x = 0; x <= width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y <= height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      // glow accent
      ctx.fillStyle = 'rgba(255, 60, 220, 0.18)';
      ctx.beginPath();
      ctx.arc(width / 2, height * 0.6, Math.min(width, height) * 0.4, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    case 'starfield': {
      const bg = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height));
      bg.addColorStop(0, '#1a1f3a');
      bg.addColorStop(1, '#050610');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      const rng = mulberry32(13);
      for (let i = 0; i < 600; i++) {
        const x = rng() * width;
        const y = rng() * height;
        const r = rng() * rng() * 1.6 + 0.2;
        const a = rng() * 0.7 + 0.3;
        ctx.fillStyle = `rgba(255, 255, 255, ${a})`;
        ctx.fillRect(x, y, r, r);
      }
      // a few warm stars
      for (let i = 0; i < 30; i++) {
        const x = rng() * width;
        const y = rng() * height;
        ctx.fillStyle = `rgba(255, 200, 130, ${rng() * 0.5 + 0.4})`;
        ctx.beginPath();
        ctx.arc(x, y, rng() * 1.4 + 0.6, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    case 'liquid': {
      const base = ctx.createLinearGradient(0, 0, width, height);
      base.addColorStop(0, '#5a8bff');
      base.addColorStop(0.55, '#c060ff');
      base.addColorStop(1, '#ff7eb6');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, width, height);
      const blobs: Array<[number, number, number, string]> = [
        [width * 0.2, height * 0.3, Math.min(width, height) * 0.4, 'rgba(255, 230, 160, 0.55)'],
        [width * 0.75, height * 0.25, Math.min(width, height) * 0.35, 'rgba(60, 220, 255, 0.5)'],
        [width * 0.5, height * 0.78, Math.min(width, height) * 0.45, 'rgba(255, 110, 180, 0.55)'],
        [width * 0.85, height * 0.7, Math.min(width, height) * 0.3, 'rgba(140, 90, 255, 0.55)'],
      ];
      for (const [cx, cy, r, color] of blobs) {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, color);
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, width, height);
      }
      return;
    }
    case 'plasma': {
      const cellSize = Math.max(2, Math.floor(Math.min(width, height) / 220));
      const cols = Math.ceil(width / cellSize);
      const rows = Math.ceil(height / cellSize);
      const t = 0;
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const x = (i / cols) * 6;
          const y = (j / rows) * 6;
          const v = Math.sin(x + t) + Math.sin((y + t) * 1.3) + Math.sin((x + y + t) * 0.8) + Math.sin(Math.sqrt(x * x + y * y) * 1.6);
          const n = (v + 4) / 8; // 0..1
          const r = Math.floor(120 + 130 * Math.sin(Math.PI * n + 0));
          const g = Math.floor(80 + 130 * Math.sin(Math.PI * n + 2));
          const b = Math.floor(160 + 90 * Math.sin(Math.PI * n + 4));
          ctx.fillStyle = `rgb(${r},${g},${b})`;
          ctx.fillRect(i * cellSize, j * cellSize, cellSize + 1, cellSize + 1);
        }
      }
      return;
    }
    case 'carbon': {
      ctx.fillStyle = '#0d0d0f';
      ctx.fillRect(0, 0, width, height);
      const tile = Math.max(14, Math.round(width / 80));
      for (let y = 0; y < height; y += tile) {
        for (let x = 0; x < width; x += tile) {
          const offY = ((x / tile) & 1) ? tile / 2 : 0;
          const yy = y + offY;
          // light wedge
          const grad = ctx.createLinearGradient(x, yy, x + tile, yy + tile);
          grad.addColorStop(0, '#222226');
          grad.addColorStop(0.5, '#16161a');
          grad.addColorStop(1, '#0a0a0d');
          ctx.fillStyle = grad;
          ctx.fillRect(x, yy, tile, tile);
        }
      }
      return;
    }
    case 'topo': {
      const base = ctx.createLinearGradient(0, 0, 0, height);
      base.addColorStop(0, '#f4eddb');
      base.addColorStop(1, '#d9cdb0');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(110, 88, 50, 0.42)';
      ctx.lineWidth = 1;
      const centers: Array<[number, number, number]> = [
        [width * 0.3, height * 0.4, Math.min(width, height) * 0.5],
        [width * 0.78, height * 0.7, Math.min(width, height) * 0.45],
        [width * 0.15, height * 0.85, Math.min(width, height) * 0.35],
      ];
      const ring = Math.max(14, Math.round(Math.min(width, height) / 40));
      for (const [cx, cy, rmax] of centers) {
        for (let r = ring; r < rmax; r += ring) {
          ctx.beginPath();
          ctx.ellipse(cx, cy, r, r * 0.65, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      return;
    }
    case 'hex': {
      const bg = ctx.createLinearGradient(0, 0, width, height);
      bg.addColorStop(0, '#1e293b');
      bg.addColorStop(1, '#334155');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(160, 190, 230, 0.22)';
      ctx.lineWidth = 1;
      const size = Math.max(24, Math.round(width / 36));
      const w = size * Math.sqrt(3);
      const h = size * 1.5;
      for (let row = -1; row < height / h + 1; row++) {
        for (let col = -1; col < width / w + 1; col++) {
          const cx = col * w + (row & 1 ? w / 2 : 0);
          const cy = row * h;
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 3) * k - Math.PI / 2;
            const x = cx + Math.cos(a) * size;
            const y = cy + Math.sin(a) * size;
            if (k === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          }
          ctx.closePath();
          ctx.stroke();
        }
      }
      return;
    }
    case 'wave-mesh': {
      const bg = ctx.createLinearGradient(0, 0, 0, height);
      bg.addColorStop(0, '#0e1738');
      bg.addColorStop(1, '#1f3a7a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.35)';
      ctx.lineWidth = 1;
      for (let yLine = 0; yLine < 22; yLine++) {
        const baseY = (yLine / 22) * height;
        ctx.beginPath();
        for (let x = 0; x <= width; x += 6) {
          const phase = (x / width) * Math.PI * 4 + yLine * 0.4;
          const y = baseY + Math.sin(phase) * 14 + Math.sin(phase * 2.1) * 6;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      return;
    }
    case 'vapor': {
      const bg = ctx.createLinearGradient(0, 0, 0, height);
      bg.addColorStop(0, '#ff7ad9');
      bg.addColorStop(0.5, '#b76dff');
      bg.addColorStop(1, '#6acdff');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      // horizontal scanlines
      ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
      for (let y = 0; y < height; y += 4) {
        ctx.fillRect(0, y, width, 1);
      }
      // grid floor
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.lineWidth = 1;
      const horizon = height * 0.58;
      for (let i = 0; i <= 16; i++) {
        const t = i / 16;
        const y = horizon + (height - horizon) * (t * t);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      for (let i = -8; i <= 8; i++) {
        const cx = width / 2;
        const x1 = cx + (i / 8) * width * 0.5;
        const x2 = cx + (i / 8) * width * 2;
        ctx.beginPath();
        ctx.moveTo(x1, horizon);
        ctx.lineTo(x2, height);
        ctx.stroke();
      }
      return;
    }
    case 'matrix': {
      ctx.fillStyle = '#020807';
      ctx.fillRect(0, 0, width, height);
      const rng = mulberry32(91);
      const colW = Math.max(10, Math.round(width / 100));
      const chars = 'アァカサタナハマヤラワABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      for (let c = 0; c < width; c += colW) {
        const len = 6 + Math.floor(rng() * 22);
        const startY = -Math.floor(rng() * height);
        for (let k = 0; k < len; k++) {
          const y = startY + k * colW * 1.2;
          if (y < 0 || y > height) continue;
          const ch = chars[Math.floor(rng() * chars.length)];
          const a = k === len - 1 ? 0.95 : Math.max(0.05, 0.5 - k * 0.04);
          ctx.fillStyle = k === len - 1 ? `rgba(220,255,220,${a})` : `rgba(35,200,90,${a})`;
          ctx.font = `${colW}px monospace`;
          ctx.textBaseline = 'top';
          ctx.fillText(ch, c, y);
        }
      }
      return;
    }
    case 'paper-grid': {
      ctx.fillStyle = '#fbfbf6';
      ctx.fillRect(0, 0, width, height);
      const step = Math.max(20, Math.round(width / 60));
      ctx.strokeStyle = 'rgba(110, 140, 180, 0.18)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y <= height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      // major lines
      ctx.strokeStyle = 'rgba(110, 140, 180, 0.32)';
      const major = step * 5;
      for (let x = 0; x <= width; x += major) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y <= height; y += major) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      return;
    }
    case 'terrazzo': {
      ctx.fillStyle = '#f6f3ec';
      ctx.fillRect(0, 0, width, height);
      const rng = mulberry32(42);
      const palette = ['#e63946', '#f4a261', '#2a9d8f', '#264653', '#f1c40f', '#a78bfa', '#1f2937'];
      const count = Math.round((width * height) / 16000);
      for (let i = 0; i < count; i++) {
        const x = rng() * width;
        const y = rng() * height;
        const r = rng() * 16 + 4;
        const verts = 4 + Math.floor(rng() * 4);
        const rot = rng() * Math.PI * 2;
        ctx.fillStyle = palette[Math.floor(rng() * palette.length)];
        ctx.beginPath();
        for (let k = 0; k < verts; k++) {
          const ang = rot + (Math.PI * 2 * k) / verts;
          const rr = r * (0.7 + rng() * 0.6);
          const px = x + Math.cos(ang) * rr;
          const py = y + Math.sin(ang) * rr;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
      }
      return;
    }
    case 'dot-storm': {
      const bg = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height));
      bg.addColorStop(0, '#1c1c2e');
      bg.addColorStop(1, '#07071a');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, width, height);
      const rng = mulberry32(5);
      const palette = ['#7dd3fc', '#a78bfa', '#fb7185', '#fcd34d'];
      for (let i = 0; i < 1400; i++) {
        const x = rng() * width;
        const y = rng() * height;
        const r = rng() * rng() * 3 + 0.5;
        const a = rng() * 0.6 + 0.3;
        const c = palette[Math.floor(rng() * palette.length)];
        ctx.fillStyle = c;
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      return;
    }
    case 'blueprint': {
      ctx.fillStyle = '#0d3b66';
      ctx.fillRect(0, 0, width, height);
      const step = Math.max(20, Math.round(width / 60));
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y <= height; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      const major = step * 5;
      for (let x = 0; x <= width; x += major) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 0; y <= height; y += major) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }
      // diagonal accents (faux schematic)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      const rng = mulberry32(3);
      for (let i = 0; i < 8; i++) {
        const x = rng() * width;
        const y = rng() * height;
        const r = rng() * 60 + 30;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }
    case 'circuit': {
      ctx.fillStyle = '#04221b';
      ctx.fillRect(0, 0, width, height);
      const step = Math.max(20, Math.round(width / 60));
      ctx.strokeStyle = 'rgba(50, 220, 150, 0.45)';
      ctx.fillStyle = 'rgba(80, 240, 170, 0.85)';
      ctx.lineWidth = 1.2;
      const rng = mulberry32(11);
      for (let i = 0; i < 100; i++) {
        const x = Math.floor(rng() * (width / step)) * step;
        const y = Math.floor(rng() * (height / step)) * step;
        const len = (1 + Math.floor(rng() * 4)) * step;
        const horiz = rng() < 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        if (horiz) ctx.lineTo(x + len, y);
        else ctx.lineTo(x, y + len);
        // bend
        const bend = (rng() < 0.5 ? 1 : -1) * step * (1 + Math.floor(rng() * 3));
        if (horiz) ctx.lineTo(x + len, y + bend);
        else ctx.lineTo(x + bend, y + len);
        ctx.stroke();
        // pad
        ctx.beginPath();
        ctx.arc(x, y, 2, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
  }
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

  if (preset.type === 'pattern' && preset.pattern) {
    paintPattern(ctx, width, height, preset.pattern);
    return canvas;
  }

  return canvas;
}
