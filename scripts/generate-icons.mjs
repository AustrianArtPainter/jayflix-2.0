/** Code-native branding assets. Run from next-app:
 * node scripts/generate-icons.mjs [--check]
 * Asset paths resolve relative to this script, independently of the caller cwd.
 * Keep the checked-in PNGs synchronized before a Next/OpenNext build. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

export const SHARP_VERSION = '0.35.4';
export const ICONS = Object.freeze([
  Object.freeze({ file: 'apple-touch-icon.png', size: 180, purpose: 'apple' }),
  Object.freeze({ file: 'icons/jayflix-192.png', size: 192, purpose: 'any' }),
  Object.freeze({ file: 'icons/jayflix-512.png', size: 512, purpose: 'any' }),
  Object.freeze({ file: 'icons/jayflix-maskable-192.png', size: 192, purpose: 'maskable' }),
  Object.freeze({ file: 'icons/jayflix-maskable-512.png', size: 512, purpose: 'maskable' }),
]);
const PUBLIC_DIRECTORY = new URL('../public/', import.meta.url);

/** Rasterize directly at each output resolution, without intermediate bitmaps,
 * timestamps, embedded metadata, palettes or platform-dependent font rendering.
 * The SVG's solid canvas and padded camera are suitable for both icon purposes. */
export async function renderIcons(svg) {
  if (sharp.versions.sharp !== SHARP_VERSION) {
    throw new Error(`Icon generation requires sharp ${SHARP_VERSION}; found ${sharp.versions.sharp}`);
  }
  return Promise.all(ICONS.map(async (icon) => ({
    ...icon,
    data: await sharp(svg, { density: icon.size * 72 / 64 })
      .resize(icon.size, icon.size, { fit: 'fill' })
      .toColourspace('srgb')
      .removeAlpha()
      .png({ compressionLevel: 9, adaptiveFiltering: false, palette: false, progressive: false })
      .toBuffer(),
  })));
}

/** --check reads existing files only and fails if the SVG or renderer changed. */
export async function generateIcons({ check = false } = {}) {
  const rendered = await renderIcons(await readFile(new URL('icon.svg', PUBLIC_DIRECTORY)));
  for (const icon of rendered) {
    const target = new URL(icon.file, PUBLIC_DIRECTORY);
    if (check) {
      let current;
      try { current = await readFile(target); } catch {
        throw new Error(`Missing ${icon.file}; run node scripts/generate-icons.mjs before building`);
      }
      if (!current.equals(icon.data)) {
        throw new Error(`Stale ${icon.file}; run node scripts/generate-icons.mjs before building`);
      }
    } else {
      await mkdir(dirname(fileURLToPath(target)), { recursive: true });
      await writeFile(target, icon.data);
    }
  }
  return rendered.map(({ file }) => file);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check')) {
    console.error('Usage: node scripts/generate-icons.mjs [--check]');
    process.exitCode = 1;
  } else {
    generateIcons({ check: args.includes('--check') })
      .then((files) => console.log(`${args.includes('--check') ? 'Verified' : 'Generated'} ${files.length} JAYFLIX PNG icons from public/icon.svg (sharp ${SHARP_VERSION})`))
      .catch((error) => { console.error(error.message); process.exitCode = 1; });
  }
}
