// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrbitController } from './orbit-controller.js';

let frames: Map<number, FrameRequestCallback>;
let sequence: number;
let dispose: (() => void) | undefined;
const disconnect = vi.fn();

function fixture(count = 16, links = false) {
  const root = document.createElement('div');
  root.innerHTML = `<section id="recommendationOrbit"><div class="orbit-camera"><div class="orbit-wireframe"></div><div id="douban-results"></div></div><b id="orbitCount"></b><div class="orbit-loading" hidden></div></section><div class="orbit-control-stack"><span id="orbitZoom"></span><span id="orbitCardScale"></span><span id="orbitSpeed"></span><button id="orbitPause" data-orbit-action="pause"><span class="orbit-pause-label"></span></button><button id="orbitReset" data-orbit-action="reset"></button>${['zoom-in', 'zoom-out', 'card-size-in', 'card-size-out', 'speed-in', 'speed-out'].map((action) => `<button data-orbit-action="${action}"></button>`).join('')}</div>`;
  const scene = root.querySelector<HTMLElement>('#recommendationOrbit')!;
  Object.defineProperties(scene, { clientWidth: { value: 1344 }, clientHeight: { value: 700 } });
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'orbit-card'; card.dataset.orbitCard = 'true';
    card.innerHTML = `<div class="orbit-card-front"><button>Cover ${i + 1}</button>${links ? '<a class="orbit-link" href="https://movie.douban.com/subject/1292052/">🔗</a>' : ''}</div>`;
    root.querySelector('#douban-results')!.appendChild(card);
  }
  document.body.appendChild(root);
  const controller = createOrbitController(root)!;
  dispose = () => controller.destroy();
  return { root, scene, controller };
}

function frame() {
  const callbacks = [...frames.values()]; frames.clear();
  callbacks.forEach((callback) => callback(performance.now()));
}

beforeEach(() => {
  frames = new Map(); sequence = 0; disconnect.mockClear();
  // Node 26's native localStorage accessor must not shadow jsdom's browser fixture.
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, String(value)), clear: () => values.clear() };
  vi.stubGlobal('localStorage', storage);
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++sequence, callback); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect = disconnect; });
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect = disconnect; });
  vi.stubGlobal('matchMedia', (query: string) => Object.assign(new EventTarget(), { matches: false, media: query }));
});
afterEach(() => { dispose?.(); dispose = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); });

describe('scoped orbit animation lifecycle', () => {
  it.each([0.5, 0.7, 1.5, 5])('animates linked cards at cover scale %s without rewriting descendant styles', (cardScale) => {
    localStorage.setItem('jayflix.orbit.preferences.v1', JSON.stringify({ version: 1, cardScale }));
    const { root, scene } = fixture(16, true);
    const links = [...root.querySelectorAll<HTMLAnchorElement>('.orbit-link')];
    const width = scene.style.getPropertyValue('--orbit-card-width');
    const initialTransform = root.querySelector<HTMLElement>('.orbit-card')!.style.transform;
    const observers = links.map((link) => {
      const callback = vi.fn();
      const observer = new MutationObserver(callback);
      observer.observe(link, { attributes: true, attributeFilter: ['style'] });
      return { observer, callback };
    });
    for (let i = 0; i < 120; i++) frame();
    expect(root.querySelector<HTMLElement>('.orbit-card')!.style.transform).not.toBe(initialTransform);
    expect(scene.style.getPropertyValue('--orbit-card-width')).toBe(width);
    for (const { observer, callback } of observers) {
      expect(observer.takeRecords()).toHaveLength(0);
      expect(callback).not.toHaveBeenCalled();
      observer.disconnect();
    }
    root.querySelector<HTMLButtonElement>('[data-orbit-action="card-size-in"]')!.click();
    for (const link of links) {
      expect(link.getAttribute('style')).toBeNull();
      expect(link.getAttribute('href')).toBe('https://movie.douban.com/subject/1292052/');
    }
    root.querySelector<HTMLButtonElement>('#orbitReset')!.click();
    for (const link of links) expect(link.getAttribute('style')).toBeNull();
  });

  it('preserves new detail links when reconciling React-owned cards', () => {
    const { root, controller } = fixture(1, true);
    const card = root.querySelector('.orbit-card')!.cloneNode(true) as HTMLElement;
    const link = card.querySelector<HTMLAnchorElement>('.orbit-link')!;
    root.querySelector('#douban-results')!.append(card);
    controller.refresh();
    expect(card.querySelector('.orbit-link')).toBe(link);
    expect(link.getAttribute('style')).toBeNull();
    expect(root.querySelectorAll('.orbit-link')).toHaveLength(2);
  });

  it('does not reparent React-owned markup and accepts image-free cards', () => {
    const { root } = fixture(212);
    expect(root.querySelector('#orbitCount')!.textContent).toBe('212');
    expect(root.querySelectorAll('.orbit-card-front')).toHaveLength(212);
    expect(root.querySelector('.orbit-card')!.getAttribute('style')).toContain('translate3d');
    expect(frames.size).toBe(1);
  });

  it('limits excess carriers in original order', () => {
    const { root } = fixture(1323);
    expect(root.querySelectorAll('.orbit-card')).toHaveLength(1322);
    expect(root.querySelector('#orbitCount')!.textContent).toBe('1322');
    expect(root.querySelector('.orbit-card button')!.textContent).toBe('Cover 1');
  });

  it('flushes preferences and removes frames, observers and listeners during unmount', () => {
    const { root, scene, controller } = fixture();
    root.querySelector<HTMLButtonElement>('[data-orbit-action="zoom-in"]')!.click();
    expect(scene.dataset.zoom).toBe('2.1');
    controller.destroy();
    expect(frames.size).toBe(0);
    expect(scene.dataset.orbitReady).toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(2);
    root.querySelector<HTMLButtonElement>('[data-orbit-action="zoom-in"]')!.click();
    expect(scene.dataset.zoom).toBe('2.1');
    expect(JSON.parse(localStorage.getItem('jayflix.orbit.preferences.v1')!).zoom).toBe(2.1);
    controller.destroy(); // idempotent StrictMode cleanup
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('StrictMode remount restores preferences without duplicate animation', () => {
    const { root, controller } = fixture(); controller.destroy();
    const again = createOrbitController(root)!; dispose = () => again.destroy();
    expect(frames.size).toBe(1); frame(); expect(frames.size).toBe(1);
    root.querySelector<HTMLButtonElement>('[data-orbit-action="zoom-in"]')!.click();
    expect(root.querySelector<HTMLElement>('#recommendationOrbit')!.dataset.zoom).toBe('2.1');
  });

  it('restores saved controls and reset returns all three to endpoint defaults', () => {
    localStorage.setItem('jayflix.orbit.preferences.v1', JSON.stringify({ version: 1, zoom: 3.1, cardScale: 2.6, speedPercent: 90, paused: true }));
    const { root, scene } = fixture();
    expect([scene.dataset.zoom, scene.dataset.cardScale, scene.dataset.speedPercent]).toEqual(['3.1', '2.6', '90']);
    root.querySelector<HTMLButtonElement>('#orbitReset')!.click();
    expect([scene.dataset.zoom, scene.dataset.cardScale, scene.dataset.speedPercent]).toEqual(['2', '0.7', '50']);
  });
});
