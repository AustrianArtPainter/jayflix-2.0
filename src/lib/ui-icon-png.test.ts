import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { generateIcons, ICONS, renderIcons, SHARP_VERSION } from '../../scripts/generate-icons.mjs';
import { DEFAULTS } from './ui-palette';
import manifest from '../app/manifest';

const svg = readFileSync(new URL('../../public/icon.svg', import.meta.url));
const rgb = (color: string) => [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
const background = rgb(DEFAULTS.background), accent = rgb(DEFAULTS.accent);
const pixel = (data: Buffer, width: number, x: number, y: number) => Array.from(data.subarray((y * width + x) * 3, (y * width + x) * 3 + 3));

describe('derived JAYFLIX PNG installation assets', () => {
  it('uses the existing renderer and confines outputs to new brand filenames', () => {
    expect(sharp.versions.sharp).toBe(SHARP_VERSION);
    expect(SHARP_VERSION).toBe('0.35.4');
    expect(ICONS.map(({ file }) => file)).toEqual([
      'apple-touch-icon.png', 'icons/jayflix-192.png', 'icons/jayflix-512.png',
      'icons/jayflix-maskable-192.png', 'icons/jayflix-maskable-512.png',
    ]);
    expect(ICONS.some(({ file }) => /^icons\/(icon-|apple-touch-icon)/.test(file))).toBe(false);
  });

  it.each(ICONS)('$file has a valid PNG signature, exact dimensions and default family colors', async ({ file, size, purpose }) => {
    const png = readFileSync(new URL(`../../public/${file}`, import.meta.url));
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    const metadata = await sharp(png).metadata();
    expect(metadata).toMatchObject({ format: 'png', width: size, height: size, space: 'srgb', hasAlpha: false });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(pixel(data, size, 0, 0)).toEqual(background);
    expect(pixel(data, size, size - 1, size - 1)).toEqual(background);
    expect(pixel(data, size, Math.floor(size / 2), Math.floor(size / 2))).toEqual(background);
    // Center of the camera's top stroke in the original SVG's 64-unit canvas.
    expect(pixel(data, size, Math.floor(size * 26 / 64), Math.floor(size * 20 / 64))).toEqual(accent);
    if (purpose === 'maskable') {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (Math.hypot(x + .5 - size / 2, y + .5 - size / 2) <= size * .4) continue;
          const index = (y * size + x) * 3;
          if (data[index] !== background[0] || data[index + 1] !== background[1] || data[index + 2] !== background[2]) {
            throw new Error(`${file}: artwork exceeds the maskable safe circle at ${x},${y}`);
          }
        }
      }
    }
  });

  it('reproduces checked-in outputs byte-for-byte and has a read-only pre-build check', async () => {
    const first = await renderIcons(svg), second = await renderIcons(svg);
    for (let index = 0; index < first.length; index++) {
      expect(first[index].data.equals(second[index].data), first[index].file).toBe(true);
      expect(first[index].data.equals(readFileSync(new URL(`../../public/${first[index].file}`, import.meta.url))), first[index].file).toBe(true);
    }
    await expect(generateIcons({ check: true })).resolves.toEqual(ICONS.map(({ file }) => file));
  });

  it('resolves every PNG manifest reference to a generated file with matching size and purpose', () => {
    for (const icon of manifest().icons ?? []) {
      const generated = ICONS.find(({ file }) => `/${file}` === icon.src);
      expect(generated).toBeDefined();
      expect(icon.type).toBe('image/png');
      expect(icon.sizes).toBe(`${generated!.size}x${generated!.size}`);
      expect(icon.purpose).toBe(generated!.purpose);
    }
  });
});
