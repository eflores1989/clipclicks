// Generates the app icons from sources/icon.svg → build/icon.png (1024) +
// build/icon.ico (multi-size). The mark is a white "C" + cyan ">", so it's
// composited onto a dark rounded square to be visible on any background.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SIZE = 1024;
const BG = '#16181f';
const RADIUS = 176;
const GLYPH_W = 660; // the C+> mark width within the 1024 canvas

async function main() {
  mkdirSync(join(root, 'build'), { recursive: true });
  const svg = readFileSync(join(root, 'sources', 'icon.svg'));

  // Dark rounded-square background.
  const bgSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    `<rect width="${SIZE}" height="${SIZE}" rx="${RADIUS}" ry="${RADIUS}" fill="${BG}"/></svg>`,
  );
  const bg = await sharp(bgSvg).png().toBuffer();

  // Render the glyph at GLYPH_W (aspect preserved) on transparency.
  const glyph = await sharp(svg, { density: 1200 }).resize({ width: GLYPH_W }).png().toBuffer();

  // Composite centered.
  const icon = await sharp(bg).composite([{ input: glyph, gravity: 'center' }]).png().toBuffer();
  writeFileSync(join(root, 'build', 'icon.png'), icon);
  console.log('wrote build/icon.png', icon.length, 'bytes');

  // Multi-size .ico for Windows.
  const sizes = [256, 128, 64, 48, 32, 24, 16];
  const pngs = await Promise.all(sizes.map((s) => sharp(icon).resize(s, s).png().toBuffer()));
  const ico = await pngToIco(pngs);
  writeFileSync(join(root, 'build', 'icon.ico'), ico);
  console.log('wrote build/icon.ico', ico.length, 'bytes');
}

main().catch((e) => { console.error(e); process.exit(1); });
