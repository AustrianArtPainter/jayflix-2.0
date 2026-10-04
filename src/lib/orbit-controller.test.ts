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

function touch(target: Element, type = 'touchmove', cancelable = true) {
  const event = new Event(type, { bubbles: true, cancelable });
  target.dispatchEvent(event);
  return event;
}

function pointer(target: Element, type: string, x: number, y: number, id = 1) {
  // jsdom does not implement PointerEvent. Exercise the real DOM listeners,
  // including the touch + pointer streams delivered for the same movement.
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, button: 0 });
  target.dispatchEvent(event);
  return event;
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

describe('sphere-local native touch arbitration', () => {
  it.each(['scene', 'poster', 'link'])('cancels native scrolling from the first movement on %s', (origin) => {
    const { root, scene } = fixture(16, true);
    const target = origin === 'scene' ? scene : root.querySelector(origin === 'poster' ? '.orbit-card button' : '.orbit-link')!;
    const before = root.querySelector<HTMLElement>('.orbit-card')!.style.transform;
    expect(touch(target).defaultPrevented).toBe(true);
    // The compatibility guard must not rotate a second time or schedule work.
    expect(root.querySelector<HTMLElement>('.orbit-card')!.style.transform).toBe(before);
  });

  it('uses a non-passive capture listener even when a poster stops bubbling', () => {
    const add = vi.spyOn(window.EventTarget.prototype, 'addEventListener');
    const { root } = fixture();
    expect(add.mock.calls.some(([type, , options]) => type === 'touchmove' &&
      typeof options === 'object' && options?.capture === true && options?.passive === false)).toBe(true);
    add.mockRestore();
    const poster = root.querySelector('button')!;
    poster.addEventListener('touchmove', (event) => event.stopPropagation());
    expect(touch(poster).defaultPrevented).toBe(true);
  });

  it('does not cancel taps or touch movement outside the scene, including controls', () => {
    const { root } = fixture();
    const poster = root.querySelector('.orbit-card button')!;
    const activate = vi.fn(); poster.addEventListener('click', activate);
    expect(touch(poster, 'touchstart').defaultPrevented).toBe(false);
    expect(pointer(poster, 'pointerdown', 0, 0).defaultPrevented).toBe(false);
    pointer(poster, 'pointerup', 0, 0);
    expect(touch(poster, 'touchend').defaultPrevented).toBe(false);
    (poster as HTMLButtonElement).click();
    expect(activate).toHaveBeenCalledTimes(1);
    const outside = document.createElement('div'); document.body.append(outside);
    expect(touch(outside).defaultPrevented).toBe(false);
    expect(touch(root.querySelector('#orbitReset')!).defaultPrevented).toBe(false);
  });

  it('blocks scrolling below the drag threshold and keeps rotation owned by pointers', () => {
    localStorage.setItem('jayflix.orbit.preferences.v1', JSON.stringify({ version: 1, paused: true }));
    const { root, scene } = fixture(); frame();
    const card = root.querySelector<HTMLElement>('.orbit-card')!;
    const initial = card.style.transform;
    pointer(scene, 'pointerdown', 0, 0);
    pointer(scene, 'pointermove', 0, 2);
    expect(touch(scene).defaultPrevented).toBe(true);
    frame(); expect(card.style.transform).toBe(initial);
    pointer(scene, 'pointermove', 20, 40); frame();
    const dragged = card.style.transform;
    expect(dragged).not.toBe(initial);
    for (let i = 0; i < 10; i++) expect(touch(scene).defaultPrevented).toBe(true);
    expect(frames.size).toBe(0);
    expect(card.style.transform).toBe(dragged);
    pointer(scene, 'pointerup', 20, 40);
    const activate = vi.fn(); const poster = root.querySelector<HTMLButtonElement>('.orbit-card button')!;
    poster.addEventListener('click', activate); poster.click();
    expect(activate).not.toHaveBeenCalled();
  });

  it('preserves pinch zoom and a fresh single-finger drag after pinch or cancellation', () => {
    localStorage.setItem('jayflix.orbit.preferences.v1', JSON.stringify({ version: 1, paused: true }));
    const { root, scene } = fixture(); frame();
    pointer(scene, 'pointerdown', 0, 0);
    pointer(scene, 'pointerdown', 100, 0, 2);
    pointer(scene, 'pointermove', 200, 0, 2);
    expect(touch(scene).defaultPrevented).toBe(true);
    expect(scene.dataset.zoom).toBe('4');
    pointer(scene, 'pointerup', 200, 0, 2);
    const before = root.querySelector<HTMLElement>('.orbit-card')!.style.transform;
    pointer(scene, 'pointermove', 40, 30); frame();
    expect(root.querySelector<HTMLElement>('.orbit-card')!.style.transform).not.toBe(before);
    pointer(scene, 'pointercancel', 40, 30);
    expect(scene.classList.contains('is-dragging')).toBe(false);
    pointer(scene, 'pointerdown', 0, 0);
    pointer(scene, 'pointermove', 0, 30);
    expect(scene.classList.contains('is-dragging')).toBe(true);
  });

  it('ignores non-cancelable events and removes the touch guard on unmount/remount', () => {
    const { root, scene, controller } = fixture();
    const native = new Event('touchmove', { bubbles: true, cancelable: false });
    const cancel = vi.spyOn(native, 'preventDefault'); scene.dispatchEvent(native);
    expect(cancel).not.toHaveBeenCalled();
    controller.destroy();
    expect(touch(scene).defaultPrevented).toBe(false);
    const again = createOrbitController(root)!; dispose = () => again.destroy();
    const move = new Event('touchmove', { bubbles: true, cancelable: true });
    const prevent = vi.spyOn(move, 'preventDefault'); scene.dispatchEvent(move);
    expect(prevent).toHaveBeenCalledTimes(1);
  });
});
