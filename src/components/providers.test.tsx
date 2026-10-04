// @vitest-environment jsdom
import React, { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  checked: false,
  verified: false,
  migrate: vi.fn(async () => ({ status: 'migrated' })),
  rehydrate: vi.fn(async () => {}),
  liveProbe: vi.fn(async () => {}),
  presets: vi.fn(async () => {}),
  status: vi.fn(async () => ({ verified: false })),
  toast: vi.fn(),
  pickTarget: vi.fn(async () => ({ kind: 'memory', write: vi.fn(), close: vi.fn(), abort: vi.fn() })),
  putDownload: vi.fn(async () => {}),
  // An empty queue exercises registration without starting real network jobs.
  readDownloads: vi.fn(async () => []),
}));

vi.mock('./auth', () => ({
  // Auth belongs to the parallel auth agent. Exercise the requested checked /
  // verified contract without changing that agent's implementation or tests.
  AuthProvider: ({ children }: { children: ReactNode }) => fixture.checked && fixture.verified
    ? children : <p data-testid="access-gate">访问验证</p>,
}));
vi.mock('./theme', () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./toast', () => ({ ToastProvider: ({ children }: { children: ReactNode }) => children, useToast: () => ({ toast: fixture.toast }) }));
vi.mock('./drawer', () => ({ Drawer: () => null }));
vi.mock('./icon', () => ({ Icon: () => null }));
vi.mock('@/lib/legacy-migration', () => ({ migrateLegacyBrowserData: fixture.migrate }));
vi.mock('@/lib/store', () => ({ useAppStore: { persist: { rehydrate: fixture.rehydrate } }, hydrateLiveProbeResults: fixture.liveProbe }));
vi.mock('@/lib/client-api', () => ({ api: { status: fixture.status }, STATUS_QUERY_KEY: ['status-fixture'] }));
vi.mock('@/lib/subscription-sync', () => ({ applyEnvPresets: fixture.presets }));
vi.mock('@/lib/db', () => ({
  db: { downloads: { put: fixture.putDownload, orderBy: () => ({ toArray: fixture.readDownloads, reverse: () => ({ toArray: fixture.readDownloads }) }) } },
}));
vi.mock('@/lib/download-saver', () => ({ detectSavingCapability: () => 'memory', pickSaveTarget: fixture.pickTarget }));

import { Providers } from './providers';
// Use the real global manager to exercise its event subscriptions and cleanup.
import { enqueueDownload, requestShowDownloadManager } from './download-manager';

let root: Root;
let container: HTMLDivElement;

async function renderPage(name = 'home') {
  await act(async () => { root.render(<Providers><p data-testid="page">{name}</p></Providers>); });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.checked = false; fixture.verified = false;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (globalThis as { __dlSaveTarget?: unknown }).__dlSaveTarget;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

function callbacks(spy: { mock: { calls: readonly unknown[][] } }, event: string): unknown[] {
  return spy.mock.calls.filter((call) => call[0] === event).map((call) => call[1]);
}

describe('authenticated global download placement', () => {
  it('mounts no download listeners and handles no enqueue events until both checked and verified', async () => {
    const added = vi.spyOn(window, 'addEventListener');
    for (const [checked, verified] of [[false, false], [false, true], [true, false]]) {
      fixture.checked = checked; fixture.verified = verified;
      await renderPage();
      expect(container.querySelector('[data-testid="page"]')).toBeNull();
      await act(async () => enqueueDownload({ url: 'https://download.invalid/1.m3u8', title: 'before verification' }));
      expect(callbacks(added, 'libretv:add-download')).toHaveLength(0);
      expect(callbacks(added, 'libretv:show-download-manager')).toHaveLength(0);
      expect(fixture.pickTarget).not.toHaveBeenCalled();
      expect(fixture.putDownload).not.toHaveBeenCalled();
    }
    fixture.checked = true; fixture.verified = true;
    await renderPage();
    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe('home');
    expect(callbacks(added, 'libretv:add-download')).toHaveLength(1);
    expect(callbacks(added, 'libretv:show-download-manager')).toHaveLength(1);
    await act(async () => enqueueDownload({ url: 'https://download.invalid/1.m3u8', title: 'after verification' }));
    expect(fixture.pickTarget).toHaveBeenCalledTimes(1);
    expect(fixture.putDownload).toHaveBeenCalledTimes(1);
  });

  it('keeps one mounted global manager across authenticated page changes, including the watch page', async () => {
    fixture.checked = true; fixture.verified = true;
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    await renderPage('home');
    await renderPage('watch');
    await act(async () => requestShowDownloadManager());
    expect(container.querySelector('[data-testid="page"]')?.textContent).toBe('watch');
    expect(callbacks(added, 'libretv:add-download')).toHaveLength(1);
    expect(callbacks(added, 'libretv:show-download-manager')).toHaveLength(1);
    expect(callbacks(removed, 'libretv:add-download')).toHaveLength(0);
    expect(callbacks(removed, 'libretv:show-download-manager')).toHaveLength(0);
    await act(async () => enqueueDownload({ url: 'https://download.invalid/1.m3u8', title: 'watch download' }));
    expect(fixture.putDownload).toHaveBeenCalledTimes(1);
  });

  it('unmounts the real manager listeners on logout, ignores further download events, and registers once on relogin', async () => {
    fixture.checked = true; fixture.verified = true;
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');
    await renderPage();
    const addHandler = callbacks(added, 'libretv:add-download')[0];
    const showHandler = callbacks(added, 'libretv:show-download-manager')[0];
    fixture.verified = false;
    await renderPage();
    expect(callbacks(removed, 'libretv:add-download')).toEqual([addHandler]);
    expect(callbacks(removed, 'libretv:show-download-manager')).toEqual([showHandler]);
    await act(async () => {
      enqueueDownload({ url: 'https://download.invalid/1.m3u8', title: 'after logout' });
      requestShowDownloadManager();
    });
    expect(fixture.pickTarget).not.toHaveBeenCalled();
    expect(fixture.putDownload).not.toHaveBeenCalled();
    fixture.verified = true;
    await renderPage('watch');
    expect(callbacks(added, 'libretv:add-download')).toHaveLength(2);
    expect(callbacks(added, 'libretv:show-download-manager')).toHaveLength(2);
    await act(async () => enqueueDownload({ url: 'https://download.invalid/1.m3u8', title: 'after relogin' }));
    expect(fixture.putDownload).toHaveBeenCalledTimes(1);
  });
});
