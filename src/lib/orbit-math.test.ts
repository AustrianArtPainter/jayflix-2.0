import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { OrbitMath as math } from './orbit-math.js';

const sandbox = vm.createContext({});
vm.runInContext(readFileSync(new URL('../../tests/legacy/js/home-orbit.js', import.meta.url), 'utf8'), sandbox);
const original = sandbox.JayflixOrbitMath;

describe('approved geometry migrated without changing mathematical results', () => {
  it('retains controls, limits and every exported mathematical function', () => {
    expect(Object.keys(math)).toEqual(Object.keys(original));
    expect(math.MAX_DISPLAY_CARDS).toBe(1322);
    expect([math.MIN_ZOOM, math.MAX_ZOOM, math.MIN_CARD_SCALE, math.MAX_CARD_SCALE]).toEqual([0.5, 5, 0.5, 5]);
    expect(math.autoSpeedFromPercent(50)).toBe(0.075);
  });

  it('links sphere surfaces, wires and controls to the four palette families', () => {
    const css = readFileSync(new URL('../components/orbit-gallery.css', import.meta.url), 'utf8');
    for (const token of ['--palette-glow', '--palette-wire', '--palette-card-border', '--palette-number-background', '--palette-number-text', '--home-accent', '--home-white', '--ui-panel']) {
      expect(css).toContain(`var(${token})`);
    }
    expect(css).not.toMatch(/#(?:4d9276|183428|edf2ee|0b110d|ecf3e4)|rgba\(128, 179, 147/);
  });

  it.each([1, 2, 3, 4, 8, 16, 50, 212, 512, 513, 1322])('preserves deterministic slots and complete-card dimensions at %i cards', (count) => {
    const slots = math.createSlots(count);
    expect(JSON.stringify(slots)).toBe(JSON.stringify(original.createSlots(count)));
    expect(slots).toHaveLength(count);
    expect(Object.isFrozen(slots)).toBe(true);
    for (const [width, height] of [[375, 420], [1440, 700]]) {
      expect(JSON.stringify(math.computeLayout(width, height, slots))).toBe(JSON.stringify(original.computeLayout(width, height, original.createSlots(count))));
      const layout = math.computeLayout(width, height, slots);
      expect(Math.hypot(layout.cardWidth, layout.cardHeight, 2 * layout.faceOffset)).toBeLessThanOrEqual(layout.minimumChord * math.CARD_CLEARANCE + 1e-9);
      for (const point of slots.map((slot: { latitude: number; longitude: number }) => math.positionOnSphere(slot, 1))) expect(Math.hypot(point.x, point.y, point.z)).toBeCloseTo(1, 12);
    }
  });

  it('preserves diagonal drag, free orientation, inertia and spatial opacity', () => {
    let q = [1, 0, 0, 0];
    for (let index = 0; index < 360; index++) {
      const vector = math.gestureVector(Math.cos(index) * 30, Math.sin(index) * 30);
      q = math.rotateOrientation(q, vector);
      expect(Math.hypot(...q)).toBeCloseTo(1, 12);
      expect(math.orientationMatrix(q)).toEqual(Array.from(original.orientationMatrix(q)));
    }
    expect(math.advanceOrientation(q, [1, 2, 0], [0, 0.075, 0], 0.016)).toEqual(original.advanceOrientation(q, [1, 2, 0], [0, 0.075, 0], 0.016));
    expect([-1, 0, 1].map((depth) => math.opacityFromDepth(depth, 1))).toEqual([0.24, 0.62, 1]);
  });
});
