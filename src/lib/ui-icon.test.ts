import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from './ui-palette';
import manifest from '../app/manifest';

vi.mock('@/components/providers', () => ({ Providers: ({ children }: { children: unknown }) => children }));
import { metadata } from '../app/layout';

const svg = readFileSync(new URL('../../public/icon.svg', import.meta.url), 'utf8');
const cameraPath = 'M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z';

describe('code-native JAYFLIX application icon', () => {
  it('reuses the thin camera geometry and exact default palette without external assets', () => {
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain('<title id="jayflix-icon-title">JAYFLIX</title>');
    expect(svg).toContain(`<rect width="64" height="64" fill="${DEFAULTS.background}"`);
    expect(svg).toContain(`stroke="${DEFAULTS.accent}"`);
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke-width="2"');
    expect(svg).toContain(`d="${cameraPath}"`);
    expect(svg).not.toMatch(/<image|<script|<foreignObject|\bhref=|linearGradient|data:|\.png|LibreTV/i);
  });

  it('keeps the complete camera stroke inside the centered maskable safe circle', () => {
    expect(svg).toContain('transform="translate(8 8) scale(2)"');
    // Header geometry bounds x=3..21, y=6..18. Account for the full
    // 2-unit stroke after scaling, even at the bounding rectangle corners.
    const radius = 64 * .4;
    for (const x of [3, 21]) {
      for (const y of [6, 18]) {
        expect(Math.hypot(8 + x * 2 - 32, 8 + y * 2 - 32) + 2).toBeLessThan(radius);
      }
    }
  });

  it('retains the SVG favicon and supplies the derived 180px PNG for Apple Web Clips', () => {
    expect(metadata.icons).toEqual({
      icon: [{ url: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }],
      shortcut: '/icon.svg',
      apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
    });
    expect(JSON.stringify(metadata.icons)).not.toMatch(/favicon\.ico|\/icons\/icon-|\/icons\/apple-touch-icon/);
  });

  it('declares generated PNGs at both regular and maskable install sizes', () => {
    expect(manifest().icons).toEqual([
      { src: '/icons/jayflix-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/jayflix-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/jayflix-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/jayflix-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });
});
