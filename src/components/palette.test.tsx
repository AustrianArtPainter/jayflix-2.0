// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, STORAGE_KEY, THEME_STORAGE_KEY } from '@/lib/ui-palette';
import { PaletteControl } from './palette';
import { ThemeProvider, ThemeToggle } from './theme';

let root: Root;
let container: HTMLDivElement;
let media: EventTarget & { matches: boolean };
const storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');

async function renderPalette(key = 'initial') {
  await act(async () => {
    root.render(<ThemeProvider key={key}><PaletteControl headingAction={<ThemeToggle />} /></ThemeProvider>);
  });
}

async function click(selector: string) {
  const button = container.querySelector<HTMLButtonElement>(selector);
  expect(button).not.toBeNull();
  await act(async () => { button!.focus(); button!.click(); });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  media = Object.assign(new window.EventTarget(), { matches: true });
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  const entries = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, String(value)); },
    removeItem: (key) => { entries.delete(key); },
    clear: () => entries.clear(),
    key: (index) => [...entries.keys()][index] ?? null,
    get length() { return entries.size; },
  };
  // Isolate browser storage from Node's optional process-wide localStorage.
  vi.stubGlobal('localStorage', storage);
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  window.localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('data-ui-mode');
  document.documentElement.removeAttribute('data-ui-palette');
  vi.unstubAllGlobals();
  if (storageDescriptor) Object.defineProperty(window, 'localStorage', storageDescriptor);
});

describe('theme entry in the palette heading', () => {
  it('only shows theme inside the open palette, immediately after its title', async () => {
    await renderPalette();
    expect(container.querySelector('.ui-palette-theme')).toBeNull();
    await click('.palette-control > button');
    const heading = container.querySelector('.ui-palette-heading-main')!;
    expect([...heading.children].map((child) => child.textContent)).toEqual(['色调', '主题']);
    expect(heading.querySelector('.home-tool-button')).toBeNull();
    expect(heading.querySelector('.home-tool-label')).toBeNull();
    expect(container.querySelectorAll('input[type="color"]')).toHaveLength(4);
    expect(container.querySelector('.ui-palette-theme')?.getAttribute('aria-label')).toBe('切换主题，当前 深色');
    await click('.ui-palette-close');
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('.palette-control > button'));
  });

  it('cycles dark → system → light → dark without closing the palette or changing saved colors', async () => {
    const colors = { ...DEFAULTS, accent: '#345678' };
    const saved = JSON.stringify({ version: 1, colors });
    window.localStorage.setItem(STORAGE_KEY, saved);
    await renderPalette();
    await click('.palette-control > button');
    for (const [theme, mode, label] of [
      ['system', 'dark', '跟随系统（当前深色）'],
      ['light', 'light', '浅色'],
      ['dark', 'dark', '深色'],
    ]) {
      await click('.ui-palette-theme');
      expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe(theme);
      expect(document.documentElement.dataset.uiMode).toBe(mode);
      expect(container.querySelector('.ui-palette-theme')?.getAttribute('aria-label')).toBe(`切换主题，当前 ${label}`);
      expect(container.querySelector('[role="dialog"]')).not.toBeNull();
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe(saved);
      expect(container.querySelector<HTMLInputElement>('input[aria-label="强调颜色，包含进度条"]')?.value).toBe(colors.accent);
    }
  });

  it('continues responding to system theme changes from inside the palette', async () => {
    await renderPalette();
    await click('.palette-control > button');
    await click('.ui-palette-theme');
    await act(async () => { media.matches = false; media.dispatchEvent(new window.Event('change')); });
    expect(document.documentElement.dataset.uiMode).toBe('light');
    expect(container.querySelector('.ui-palette-theme')?.getAttribute('aria-label')).toBe('切换主题，当前 跟随系统（当前浅色）');
    await act(async () => { media.matches = true; media.dispatchEvent(new window.Event('change')); });
    expect(document.documentElement.dataset.uiMode).toBe('dark');
  });

  it('restores the saved theme after remount and Escape returns focus to the palette entry', async () => {
    await renderPalette();
    await click('.palette-control > button');
    await click('.ui-palette-theme');
    await click('.ui-palette-theme');
    await renderPalette('reload');
    expect(document.documentElement.dataset.uiMode).toBe('light');
    expect(container.querySelector('.ui-palette-theme')).toBeNull();
    await click('.palette-control > button');
    expect(container.querySelector('.ui-palette-theme')?.getAttribute('aria-label')).toBe('切换主题，当前 浅色');
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('.palette-control > button')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(container.querySelector('.palette-control > button'));
  });

  it('keeps restoring default colors separate from the selected theme', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, colors: { ...DEFAULTS, background: '#123456' } }));
    window.localStorage.setItem(THEME_STORAGE_KEY, 'light');
    await renderPalette();
    await click('.palette-control > button');
    await click('.ui-palette-reset');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({ version: 1, colors: DEFAULTS });
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.uiMode).toBe('light');
    expect(container.querySelector('.ui-palette-theme')?.getAttribute('aria-label')).toBe('切换主题，当前 浅色');
  });
});
