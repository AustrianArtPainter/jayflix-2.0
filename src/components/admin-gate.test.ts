// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import * as jsxRuntime from 'react/jsx-runtime';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { summarizeSettingsBackup } from '@/lib/settings-backup';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.fn(() => { throw new Error('Protected settings hooks must not run before verification'); });

// The upstream test configuration preserves JSX for Next. Compile the real component sources
// locally for SSR tests without changing the shared test/build configuration or dependencies.
function loadComponent<T>(filename: string, bindings: Record<string, unknown>): T {
  const sourcePath = path.resolve(process.cwd(), 'src/components', filename);
  const code = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    fileName: sourcePath,
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, {
    exports, require: (id: string) => bindings[id] ?? {}, AbortController, Date, window, document, CustomEvent, Blob, URL,
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
    setTimeout: (...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args),
    clearTimeout: (...args: Parameters<typeof clearTimeout>) => globalThis.clearTimeout(...args),
    localStorage: {
      getItem: (key: string) => globalThis.localStorage.getItem(key),
      setItem: (key: string, value: string) => globalThis.localStorage.setItem(key, value),
    },
  }, { filename: sourcePath });
  return exports as T;
}

const bindings = {
  react: React,
  'react/jsx-runtime': jsxRuntime,
  './auth': { AUTH_CHANGED_EVENT: 'auth-test', AUTH_STORAGE_EVENT: 'auth-storage-test', useAuth: () => ({ openLogin: vi.fn(), loginOpen: false }) },
  './use-focus-trap': { useFocusTrap: vi.fn() },
  '@/lib/store': { useAppStore: store },
};
const { AdminGate } = loadComponent<{ AdminGate: React.ComponentType<{ open?: boolean; children?: React.ReactNode }> }>('admin-gate.tsx', bindings);
const guardedBindings = { ...bindings, './admin-gate': { AdminGate } };
const { SourceManagerDrawer } = loadComponent<{ SourceManagerDrawer: React.ComponentType<{ open: boolean; onClose: () => void }> }>('source-manager.tsx', guardedBindings);
const { LiveSourceManager } = loadComponent<{ LiveSourceManager: React.ComponentType }>('live-source-manager.tsx', guardedBindings);

let root: Root | undefined;
let container: HTMLDivElement;
const openLogin = vi.fn();
beforeEach(() => {
  store.mockClear();
  openLogin.mockClear();
  const entries = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => entries.set(key, String(value)),
    removeItem: (key: string) => entries.delete(key),
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() { return entries.size; },
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
});

describe('settings import preview integration', () => {
  function previewPanel(toast: ReturnType<typeof vi.fn>, importConfig: ReturnType<typeof vi.fn>, exportConfig = vi.fn()) {
    const previewBindings = {
      ...bindings,
      react: { ...React, useState: (initial: unknown) => React.useState(initial === 'sources' ? 'data' : initial) },
      './admin-gate': { AdminGate: ({ children }: { children: React.ReactNode }) => children },
      './drawer': { Drawer: ({ children, subheader }: { children: React.ReactNode; subheader: React.ReactNode }) => React.createElement('section', null, subheader, children) },
      './auth': { useAuth: () => ({ verified: true, openLogin }) },
      './toast': { useToast: () => ({ toast }) },
      './settings-shared': { SectionTitle: () => null },
      './icon': { Icon: () => null },
      '@/lib/utils': { cn: (...items: unknown[]) => items.filter(Boolean).join(' ') },
      '@/lib/db': { importConfig, exportConfig },
      '@/lib/settings-backup': { summarizeSettingsBackup },
    };
    const confirm = loadComponent<{ ConfirmDialog: React.ComponentType }>('confirm-dialog.tsx', previewBindings);
    return loadComponent<{ SourceManagerDrawer: React.ComponentType<{ open: boolean; onClose: () => void }> }>('source-manager.tsx', {
      ...previewBindings, './confirm-dialog': confirm,
    }).SourceManagerDrawer;
  }

  async function pickFile(content: string) {
    const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [{ text: () => Promise.resolve(content) }] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  }

  it.each(['JAYFLIX-Settings', 'JAY-TV-Settings', 'LibreTV-Settings'])('accepts %s through the shared preview and preserves the confirmation step', async (name) => {
    const toast = vi.fn();
    const importConfig = vi.fn();
    const Panel = previewPanel(toast, importConfig);
    await render(React.createElement(Panel, { open: true, onClose: vi.fn() }));
    await pickFile(JSON.stringify({ name, cfgVer: '1.0.0', data: { customAPIs: '[{"name":"A","url":"https://a.example/api"}]', viewingHistory: '[{}]', videoSearchHistory: '["example"]' } }));
    expect(container.querySelector('[role="alertdialog"]')?.textContent).toContain('1 个点播源、1 条观看历史、1 条搜索历史');
    expect(toast).not.toHaveBeenCalled();
    expect(importConfig).not.toHaveBeenCalled();
    await click('取消');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(importConfig).not.toHaveBeenCalled();
  });

  it('rejects invalid backup previews before offering to overwrite any data', async () => {
    const toast = vi.fn();
    const importConfig = vi.fn();
    const Panel = previewPanel(toast, importConfig);
    await render(React.createElement(Panel, { open: true, onClose: vi.fn() }));
    await pickFile('{');
    expect(toast).toHaveBeenCalledWith(expect.any(String), 'error');
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(importConfig).not.toHaveBeenCalled();
  });

  it('exports settings with the JAYFLIX filename and preserves the shared backup payload', async () => {
    const payload = JSON.stringify({ name: 'LibreTV-Settings', cfgVer: '2.0.0', data: {} });
    const exportConfig = vi.fn().mockResolvedValue(payload);
    const createObjectURL = vi.fn((blob: Blob) => { expect(blob.type).toBe('application/json'); return 'blob:test-settings'; });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL }));
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    const Panel = previewPanel(vi.fn(), vi.fn(), exportConfig);
    await render(React.createElement(Panel, { open: true, onClose: vi.fn() }));
    await click('导出配置');
    expect(downloads[0]).toMatch(/^JAYFLIX-Settings_\d+\.json$/);
    expect(exportConfig).toHaveBeenCalledOnce();
    expect(await readBlob(createObjectURL.mock.calls[0][0] as Blob)).toBe(payload);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-settings');
  });
});

describe('JAYFLIX source sharing branding and protocol compatibility', () => {
  it('uses branded prompts and export filenames while keeping the LibreTV-SourceList export/publish payload', async () => {
    const state = {
      envSources: [{ key: 'env', name: 'VOD', url: 'https://vod.example/api' }], customAPIs: [],
      liveEnvSources: [{ name: 'Live', url: 'https://live.example/list.m3u' }], liveSubscriptions: [], subscriptions: [],
      selectedKeys: ['env'], liveSelectedUrls: ['https://live.example/list.m3u'],
    };
    const publishSourceList = vi.fn().mockResolvedValue({ url: 'https://paste.example/list', provider: 'test', sources: 1, liveSources: 1 });
    const createObjectURL = vi.fn((blob: Blob) => { expect(blob.type).toBe('application/json'); return 'blob:test-sources'; });
    vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL, revokeObjectURL: vi.fn() }));
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
    const panelBindings = {
      ...bindings,
      react: { ...React, useState: (initial: unknown) => React.useState(initial && typeof initial === 'object' && 'sources' in initial && 'prefs' in initial ? { ...initial, sources: 'subs' } : initial) },
      './admin-gate': { AdminGate: ({ children }: { children: React.ReactNode }) => children },
      './drawer': { Drawer: ({ children, subheader }: { children: React.ReactNode; subheader: React.ReactNode }) => React.createElement('section', null, subheader, children) },
      './toast': { useToast: () => ({ toast: vi.fn() }) },
      './settings-shared': { SectionTitle: ({ title, extra }: { title: string; extra: React.ReactNode }) => React.createElement('div', null, title, extra) },
      './icon': { Icon: () => null }, './confirm-dialog': { ConfirmDialog: () => null },
      '@/lib/utils': { cn: (...items: unknown[]) => items.filter(Boolean).join(' '), validateSourceUrl: (url: string) => /^https?:\/\//.test(url) },
      '@/lib/client-api': { api: { publishSourceList } },
      '@/lib/store': {
        useAppStore: () => state, resolveSource: () => state.envSources[0], isSourceDisabled: () => false,
        allLiveSources: () => state.liveEnvSources,
      },
    };
    const { SourceManagerDrawer: Panel } = loadComponent<{ SourceManagerDrawer: React.ComponentType<{ open: boolean; onClose: () => void }> }>('source-manager.tsx', panelBindings);
    await render(React.createElement(Panel, { open: true, onClose: vi.fn() }));
    expect(container.querySelector('input')?.placeholder).toContain('JAYFLIX');
    expect(container.textContent).toContain('JAYFLIX 源列表');
    expect(container.textContent).not.toMatch(/LibreTV|LibreSpark/i);
    await click('导出数据源');
    expect(downloads[0]).toMatch(/^JAYFLIX-SourceList_\d+\.json$/);
    expect(JSON.parse(await readBlob(createObjectURL.mock.calls[0][0]))).toMatchObject({ name: 'LibreTV-SourceList', version: 2 });
    await click('发布为链接');
    expect(publishSourceList).toHaveBeenCalledWith({ name: 'LibreTV-SourceList', sources: [{ name: 'VOD', url: 'https://vod.example/api' }], liveSources: [{ name: 'Live', url: 'https://live.example/list.m3u', epg: undefined }] });
  });
});

describe('access authentication integration', () => {
  function fixture(initialVerified = false) {
    const anonymous = { passwordRequired: true, verified: false, version: 'test', defaultSources: [], defaultLiveSources: [], defaultSubscriptions: [] };
    const authenticated = { ...anonymous, verified: true, defaultSources: [{ key: 'env', name: 'A', url: 'https://a.example/api' }] };
    const api = {
      status: vi.fn().mockResolvedValueOnce(initialVerified ? authenticated : anonymous).mockResolvedValue(authenticated),
      login: vi.fn(() => Promise.resolve({ success: true })),
      logout: vi.fn(() => Promise.resolve({ success: true })),
    };
    const queryClient = {
      fetchQuery: vi.fn(({ queryFn }: { queryFn: () => unknown }) => Promise.resolve(queryFn())),
      invalidateQueries: vi.fn(), cancelQueries: vi.fn(() => Promise.resolve()), removeQueries: vi.fn(), getQueryData: vi.fn(() => anonymous),
    };
    const toast = vi.fn();
    const applyEnvPresets = vi.fn(() => Promise.resolve());
    const auth = loadComponent<{
      AuthProvider: React.ComponentType<{ children?: React.ReactNode }>;
      useAuth: () => { verified: boolean; loginOpen: boolean; openLogin: () => void; logout: () => Promise<void> };
      AUTH_CHANGED_EVENT: string; AUTH_STORAGE_EVENT: string;
    }>('auth.tsx', {
      ...bindings,
      '@tanstack/react-query': { useQueryClient: () => queryClient },
      '@/lib/client-api': { api, STATUS_QUERY_KEY: ['app-status'], onUnauthorized: () => () => {} },
      '@/lib/subscription-sync': { applyEnvPresets },
      './toast': { useToast: () => ({ toast }) },
    });
    function Controls() {
      const value = auth.useAuth();
      return React.createElement('div', null,
        React.createElement('output', null, value.verified ? 'verified' : 'locked'),
        React.createElement('button', { onClick: value.openLogin }, 'login fixture'),
        React.createElement('button', { onClick: () => void value.logout() }, 'logout fixture'));
    }
    return { ...auth, api, queryClient, toast, applyEnvPresets, anonymous, authenticated, Controls };
  }

  it('refreshes authenticated status and applies deployment presets after login instead of using anonymous cached values', async () => {
    const f = fixture();
    await render(React.createElement(f.AuthProvider, null, React.createElement(f.Controls)));
    expect(container.querySelector('output')).toBeNull();
    await submitPassword('access-test');
    expect(f.api.login).toHaveBeenCalledWith('access-test');
    expect(f.queryClient.fetchQuery).toHaveBeenLastCalledWith(expect.objectContaining({ staleTime: 0 }));
    expect(f.queryClient.getQueryData).not.toHaveBeenCalled();
    expect(f.queryClient.cancelQueries).toHaveBeenCalledWith({ queryKey: ['app-status'] });
    expect(f.applyEnvPresets).toHaveBeenCalledWith(f.authenticated);
    expect(container.querySelector('output')?.textContent).toBe('verified');
    expect(localStorage.getItem('libretv-auth-event')).toBeTruthy();
    expect(localStorage.getItem('libretv-auth-event')).not.toContain('access-test');
  });

  it('successful logout clears cached status and announces session invalidation to every open settings gate', async () => {
    const f = fixture(true);
    const changed = vi.fn();
    window.addEventListener(f.AUTH_CHANGED_EVENT, changed);
    try {
      await render(React.createElement(f.AuthProvider, null, React.createElement(f.Controls)));
      await click('logout fixture');
      expect(container.querySelector('output')).toBeNull();
      expect(container.querySelector('[aria-label="JAYFLIX 访问入口"]')).toBeTruthy();
      expect(container.querySelector('input[aria-label="访问密码"]')).toBeTruthy();
      expect(f.queryClient.removeQueries).toHaveBeenCalledWith({ queryKey: ['app-status'] });
      expect(changed.mock.calls[0][0].detail).toEqual({ verified: false });
      expect(f.toast).toHaveBeenCalledWith('已退出登录', 'info');
    } finally {
      window.removeEventListener(f.AUTH_CHANGED_EVENT, changed);
    }
  });

  it('a failed server logout does not falsely report success', async () => {
    const f = fixture(true);
    f.api.logout.mockRejectedValueOnce(new Error('offline'));
    await render(React.createElement(f.AuthProvider, null, React.createElement(f.Controls)));
    await click('logout fixture');
    expect(container.querySelector('output')?.textContent).toBe('verified');
    expect(f.toast).toHaveBeenCalledWith('退出失败，请重试', 'error');
    expect(f.queryClient.removeQueries).not.toHaveBeenCalled();
  });

  it('requires first access before even mounting an administrator gate or checking its cookies', async () => {
    const f = fixture();
    const fetch = vi.fn().mockResolvedValue(json(lockedState));
    vi.stubGlobal('fetch', fetch);
    const { AdminGate: Gate } = loadComponent<{ AdminGate: React.ComponentType<{ children?: React.ReactNode }> }>('admin-gate.tsx', { ...bindings, './auth': f });
    await render(React.createElement(f.AuthProvider, null, React.createElement(Gate, null, React.createElement('p', null, 'protected settings'))));
    expect(fetch).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="访问验证"]')).toBeTruthy();
    expect(container.querySelector('[aria-label="管理员验证"]')).toBeNull();
    await submitPassword('access-test');
    expect(container.querySelector('[aria-label="访问验证"]')).toBeNull();
    expect(container.querySelector('[aria-label="管理员验证"]')).toBeTruthy();
    expect(container.textContent).not.toContain('protected settings');
  });

  it('SSR never mounts history, download, source, or other application content before access verification', () => {
    const f = fixture();
    const mounts = vi.fn(() => React.createElement('div', null, 'history download source content'));
    const markup = renderToStaticMarkup(React.createElement(f.AuthProvider, null, React.createElement(mounts)));
    expect(mounts).not.toHaveBeenCalled();
    expect(markup).not.toContain('history download source content');
    expect(markup).toContain('JAYFLIX 访问入口');
    expect(markup).toContain('jayflix-brand');
    expect(markup).toContain('<svg');
  });

  it('Escape and backdrop dismissal keep the whole application unmounted and leave an accessible login entry', async () => {
    const f = fixture();
    const mounts = vi.fn(() => React.createElement('div', null, 'history download source content'));
    await render(React.createElement(f.AuthProvider, null, React.createElement(mounts)));
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(mounts).not.toHaveBeenCalled();
    await click('访问验证');
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog).toBeTruthy();
    await act(async () => (dialog.parentElement as HTMLElement).click());
    expect(mounts).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('history download source content');
    expect(button('访问验证')).toBeTruthy();
  });

  it('POST success alone cannot mount content while cookie verification is pending or rejected', async () => {
    const f = fixture();
    const pending = deferred<typeof f.anonymous>();
    f.api.status.mockReset().mockResolvedValueOnce(f.anonymous).mockReturnValueOnce(pending.promise);
    const mounts = vi.fn(() => React.createElement('div', null, 'history download source content'));
    await render(React.createElement(f.AuthProvider, null, React.createElement(mounts)));
    await submitPassword('access-test');
    expect(f.api.login).toHaveBeenCalledOnce();
    expect(mounts).not.toHaveBeenCalled();
    await act(async () => pending.resolve(f.anonymous));
    expect(mounts).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(f.applyEnvPresets).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="访问验证"]')).toBeTruthy();
  });

  it('failed first-access status remains fail closed but allows login and connection retry', async () => {
    const f = fixture();
    f.api.status.mockReset().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(f.anonymous);
    const mounts = vi.fn(() => React.createElement('div', null, 'history download source content'));
    await render(React.createElement(f.AuthProvider, null, React.createElement(mounts)));
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(mounts).not.toHaveBeenCalled();
    await click('访问验证');
    expect(container.querySelector('input[aria-label="访问密码"]')).toBeTruthy();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    await click('重试连接');
    expect(f.api.status).toHaveBeenCalledTimes(2);
    expect(mounts).not.toHaveBeenCalled();
  });

  it('allows login before the initial check finishes, keeps retry available after verification fails, and ignores a late initial result', async () => {
    const f = fixture();
    const initial = deferred<typeof f.authenticated>();
    f.api.status.mockReset().mockReturnValueOnce(initial.promise).mockRejectedValueOnce(new Error('offline'));
    const mounts = vi.fn(() => React.createElement('div', null, 'history download source content'));
    await render(React.createElement(f.AuthProvider, null, React.createElement(mounts)));
    expect(container.textContent).toContain('正在确认访问权限');
    await click('访问验证');
    await submitPassword('access-test');
    expect(mounts).not.toHaveBeenCalled();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(button('访问验证')).toBeTruthy();
    expect(button('重试连接')).toBeTruthy();
    await act(async () => initial.resolve(f.authenticated));
    expect(mounts).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('history download source content');
  });

  it('missing PASSWORD never mounts the app and only exposes the setup instructions', async () => {
    const f = fixture();
    f.api.status.mockReset().mockResolvedValue({ ...f.anonymous, passwordRequired: false });
    const mounts = vi.fn(() => React.createElement('div', null, 'history download source content'));
    await render(React.createElement(f.AuthProvider, null, React.createElement(mounts)));
    expect(container.textContent).toContain('PASSWORD');
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(mounts).not.toHaveBeenCalled();
  });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  document.body.style.overflow = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('settings mount boundary', () => {
  it('does not mount arbitrary future protected children during the initial server check', () => {
    const protectedContent = vi.fn(() => { throw new Error('must not mount'); });
    const markup = renderToStaticMarkup(React.createElement(AdminGate, null, React.createElement(protectedContent)));
    expect(protectedContent).not.toHaveBeenCalled();
    expect(markup).toContain('管理员验证');
    expect(markup).toContain('正在验证会话');
  });

  it('closed settings render no modal, drawer, tabs, or protected hooks', () => {
    expect(renderToStaticMarkup(React.createElement(SourceManagerDrawer, { open: false, onClose: vi.fn() }))).toBe('');
    expect(store).not.toHaveBeenCalled();
  });

  it('the WHOLE settings drawer, including playback/cache/image/home/data/sources, stays unmounted', () => {
    const markup = renderToStaticMarkup(React.createElement(SourceManagerDrawer, { open: true, onClose: vi.fn() }));
    expect(markup).toContain('管理员验证');
    for (const text of ['设置分类', '设置项', '点播源', '直播源', '播放与过滤', '封面图加载', '首页与内容', '配置导入导出']) expect(markup).not.toContain(text);
    expect(store).not.toHaveBeenCalled();
  });

  it('standalone live source management applies its own gate without any provider or caller changes', () => {
    const markup = renderToStaticMarkup(React.createElement(LiveSourceManager));
    expect(markup).toContain('管理员验证');
    expect(markup).not.toContain('添加直播源');
    expect(store).not.toHaveBeenCalled();
  });
});

const lockedState = { configured: true, accessVerified: true, verified: false, expiresAt: null };
function grantedState(expiresAt = Date.now() + 60_000) {
  return { configured: true, accessVerified: true, verified: true, expiresAt };
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function gateForInteraction() {
  const focus = loadComponent<{ useFocusTrap: typeof bindings['./use-focus-trap']['useFocusTrap'] }>('use-focus-trap.ts', bindings);
  return loadComponent<{ AdminGate: React.ComponentType<{ open?: boolean; onCancel?: () => void; children?: React.ReactNode }> }>('admin-gate.tsx', {
    ...bindings, './auth': { ...bindings['./auth'], useAuth: () => ({ verified: false, checked: false, openLogin, loginOpen: false }) }, './use-focus-trap': focus,
  }).AdminGate;
}
async function render(element: React.ReactElement) {
  root ??= createRoot(container);
  await act(async () => { root!.render(element); });
}
function button(text: string) {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === text);
  expect(found, `button ${text}`).toBeTruthy();
  return found!;
}
async function click(text: string) {
  await act(async () => button(text).click());
}
async function submitPassword(value: string) {
  const input = container.querySelector<HTMLInputElement>('input[type="password"]');
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(blob);
  });
}

describe('administrator gate interactions', () => {
  it('keeps all children unmounted during a pending server check and after access-only validation', async () => {
    const pending = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const Gate = gateForInteraction();
    const protectedContent = vi.fn(() => React.createElement('p', null, 'protected settings'));
    await render(React.createElement(Gate, null, React.createElement(protectedContent)));
    expect(protectedContent).not.toHaveBeenCalled();
    expect(container.textContent).toContain('正在验证会话');
    await act(async () => pending.resolve(json(lockedState)));
    expect(container.querySelector('input[aria-label="管理员密码"]')).toBeTruthy();
    expect(protectedContent).not.toHaveBeenCalled();
  });

  it('accepts server-validated access plus admin even without client auth hooks, and shares the gate with nested panels', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(grantedState())));
    vi.stubGlobal('fetch', fetch);
    const Gate = gateForInteraction();
    await render(React.createElement(Gate, null, React.createElement(Gate, null, React.createElement('p', null, 'nested live settings'))));
    expect(container.textContent).toBe('nested live settings');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/admin', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' }));
  });

  it.each([
    { configured: true, verified: true, accessVerified: false, expiresAt: Date.now() + 60_000 },
    { configured: true, verified: true, accessVerified: true },
    { configured: true, verified: true, accessVerified: true, expiresAt: 0 },
    { configured: true, verified: 'true', accessVerified: true, expiresAt: Date.now() + 60_000 },
  ])('malformed or insufficient server state never mounts protected content: %j', async (state) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(state))));
    const Gate = gateForInteraction();
    await render(React.createElement(Gate, null, React.createElement('p', null, 'protected settings')));
    expect(container.textContent).not.toContain('protected settings');
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
  });

  it('missing ADMINPASSWORD stays locked and shows setup instructions', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json({ ...lockedState, configured: false }))));
    const Gate = gateForInteraction();
    await render(React.createElement(Gate, null, React.createElement('p', null, 'protected settings')));
    expect(container.textContent).toContain('ADMINPASSWORD');
    expect(container.querySelector('input')).toBeNull();
    expect(container.textContent).not.toContain('protected settings');
  });

  it('requires access validation first, while network failures remain fail closed', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ error: '未登录' }, 401)).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetch);
    const Gate = gateForInteraction();
    await render(React.createElement(Gate, null, React.createElement('p', null, 'protected settings')));
    await click('访问验证');
    expect(openLogin).toHaveBeenCalledOnce();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    expect(container.textContent).not.toContain('protected settings');
  });

  it('does not unlock from POST success until GET confirms the browser cookies', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(lockedState))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json(lockedState))
      .mockResolvedValueOnce(json({ success: true }))
      .mockResolvedValueOnce(json(grantedState()));
    vi.stubGlobal('fetch', fetch);
    const Gate = gateForInteraction();
    await render(React.createElement(Gate, null, React.createElement('p', null, 'protected settings')));
    await submitPassword('admin-test');
    expect(container.textContent).not.toContain('protected settings');
    expect(container.querySelector('input')?.value).toBe('');
    await submitPassword('admin-test');
    expect(container.textContent).toBe('protected settings');
    expect(fetch.mock.calls.map((call) => call[1].method || 'GET')).toEqual(['GET', 'POST', 'GET', 'POST', 'GET']);
  });

  it('a wrong admin password displays the server error, clears the input, and keeps children unmounted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json(lockedState)).mockResolvedValueOnce(json({ error: '管理员密码错误' }, 403)));
    const Gate = gateForInteraction();
    await render(React.createElement(Gate, null, React.createElement('p', null, 'protected settings')));
    await submitPassword('wrong');
    expect(container.textContent).toContain('管理员密码错误');
    expect(container.querySelector('input')?.value).toBe('');
    expect(container.textContent).not.toContain('protected settings');
  });

  it('Cancel closes the target and aborts pending verification, so a late success cannot mount content', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn().mockResolvedValueOnce(json(lockedState)).mockReturnValueOnce(pending.promise);
    vi.stubGlobal('fetch', fetch);
    const onCancel = vi.fn();
    const Gate = gateForInteraction();
    await render(React.createElement(Gate, { onCancel }, React.createElement('p', null, 'protected settings')));
    await submitPassword('admin-test');
    await click('取消');
    expect(onCancel).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
    await act(async () => pending.resolve(json({ success: true })));
    expect(container.textContent).toBe('');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('Escape closes the panel, restores body scrolling, and reopening requires a fresh server check', async () => {
    const fetch = vi.fn(() => Promise.resolve(json(lockedState)));
    vi.stubGlobal('fetch', fetch);
    const onCancel = vi.fn();
    const Gate = gateForInteraction();
    const children = React.createElement('p', null, 'protected settings');
    await render(React.createElement(Gate, { onCancel }, children));
    expect(document.body.style.overflow).toBe('hidden');
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe('');
    await render(React.createElement(Gate, { open: false, onCancel }, children));
    await render(React.createElement(Gate, { open: true, onCancel }, children));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(container.querySelector('input')).toBeTruthy();
  });

  it('logout immediately unmounts the entire protected child tree', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(grantedState()))));
    const Gate = gateForInteraction();
    await render(React.createElement(Gate, null, React.createElement('p', null, 'protected settings')));
    expect(container.textContent).toBe('protected settings');
    await act(async () => window.dispatchEvent(new CustomEvent('auth-test', { detail: { verified: false } })));
    expect(container.textContent).not.toContain('protected settings');
    expect(container.textContent).toContain('请先完成访问验证');
  });

  it('expiry and cross-tab/focus changes revalidate on the server and lock all settings when invalid', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const fetch = vi.fn().mockResolvedValueOnce(json(grantedState(Date.now() + 1000))).mockResolvedValue(json(lockedState));
    vi.stubGlobal('fetch', fetch);
    const Gate = gateForInteraction();
    await render(React.createElement(Gate, null, React.createElement('p', null, 'protected settings')));
    expect(container.textContent).toBe('protected settings');
    await act(async () => { vi.advanceTimersByTime(1001); });
    expect(container.textContent).not.toContain('protected settings');
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => window.dispatchEvent(new StorageEvent('storage', { key: 'auth-storage-test' })));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
