import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SOURCES, DEFAULT_SELECTED_KEYS, historyProgress, legacySettings,
  normalizeHistory, normalizeProgress, normalizeSearch, normalizeSettings,
  readLegacyData, withBuiltinSources,
} from './legacy-data';
import { legacyHistory, MemoryStorage } from './migration-test-helpers';

describe('actual legacy formats and source identity', () => {
  it('seeds all 13 real sources with the exact legacy IDs, names and URLs', () => {
    const sandbox: { window: { location: { origin: string }; API_SITES?: Record<string, { name: string; api: string; adult?: boolean }> } } = { window: { location: { origin: 'https://jayflix.invalid' } } };
    runInNewContext(readFileSync(new URL('../../tests/legacy/js/config.js', import.meta.url), 'utf8'), sandbox);
    const real = Object.entries(sandbox.window.API_SITES!).filter(([key]) => key !== 'testSource').map(([key, source]) => ({ key, name: source.name, url: source.api }));
    expect(BUILTIN_SOURCES).toEqual(real);
    expect(BUILTIN_SOURCES).toHaveLength(13);
    expect(withBuiltinSources({}).selectedKeys).toEqual(DEFAULT_SELECTED_KEYS);
  });

  it('retains legacy custom indices, URLs and an explicitly empty selection', () => {
    const state = legacySettings({ customAPIs: JSON.stringify([
      { name: '自定义', url: 'http://custom.invalid/api?token=non-secret-fixture', detail: 'https://custom.invalid', isAdult: true },
      { name: '保留 ID', key: 'my-source', url: 'https://custom2.invalid/api/' },
    ]), selectedAPIs: '[]', yellowFilterEnabled: 'false', adFilteringEnabled: 'false', doubanEnabled: 'false', autoplayEnabled: 'false' });
    expect(state).toMatchObject({ selectedKeys: [], yellowFilter: false, adFilter: false, doubanEnabled: false, autoplayNext: false });
    const sources = withBuiltinSources(state).customAPIs as typeof BUILTIN_SOURCES;
    expect(sources.slice(13).map((v) => v.key)).toEqual(['custom_0', 'my-source']);
    expect(sources[13].url).toBe('http://custom.invalid/api?token=non-secret-fixture');
    expect(withBuiltinSources(state).selectedKeys).toEqual([]);
  });

  it('accepts both history schemas and URL fallbacks, preserving all old fields', () => {
    const old = legacyHistory();
    const sources = [{ key: 'custom_0', name: 'A', url: 'https://a.invalid/api/' }];
    const rows = normalizeHistory([old, { sourceKey: 'lzi', vodId: 0, title: 'zero', timestamp: 1 }, { url: '/player.html?source_code=bfzy&id=2', title: 'URL' }], sources);
    expect(rows[0]).toMatchObject({ ...old, id: 'custom_0_1', sourceKey: 'custom_0', vodId: '1', sourceUrl: sources[0].url, totalEpisodes: 2 });
    expect(rows[1].vodId).toBe('0');
    expect(rows[2].id).toBe('bfzy_2');
    expect(normalizeHistory([{ title: 'unmapped' }], [], true)).toEqual([]);
    expect(() => normalizeHistory([{ title: 'unmapped' }], [])).toThrow('缺少');
  });

  it('maps exact encoded URL and title/index progress keys for every episode', () => {
    const old = legacyHistory();
    const [row] = normalizeHistory([old], []);
    const data = {
      [`videoProgress_${encodeURIComponent(old.episodes[0])}`]: JSON.stringify({ position: 33.25, duration: 210, timestamp: 30 }),
      [`videoProgress_${encodeURIComponent(old.title)}_1`]: JSON.stringify({ position: 8, duration: 220, timestamp: 40 }),
    };
    expect(historyProgress([row], data)).toEqual([
      { key: 'custom_0_1_0', position: 33.25, duration: 210, updatedAt: 30 },
      { key: 'custom_0_1_1', position: 8, duration: 220, updatedAt: 40 },
    ]);
  });
  it('prefers the saved URL source_code over a renamed or unavailable display name', () => {
    const [row] = normalizeHistory([{ sourceName: '旧显示名称', title: '旧影片', url: '/player.html?source=旧显示名称&source_code=bfzy&id=42' }], [...BUILTIN_SOURCES]);
    expect(row).toMatchObject({ id: 'bfzy_42', sourceKey: 'bfzy', sourceName: '旧显示名称' });
    expect(row.sourceUrl).toBe(BUILTIN_SOURCES.find((source) => source.key === 'bfzy')!.url);
  });

  it('preserves old string searches and long imported search text without TTL filtering', () => {
    const text = 'a'.repeat(200);
    expect(normalizeSearch(['old', { text, timestamp: 1, extra: true }])).toEqual([
      { text: 'old', timestamp: 0 }, { text, timestamp: 1, extra: true },
    ]);
  });

  it('does not read auth or unrelated localStorage values', () => {
    const storage = new MemoryStorage();
    storage.setItem('passwordVerified', 'hash');
    storage.setItem('adminPasswordVerified', 'hash');
    storage.setItem('videoProgress_url', '{"position":1}');
    const get = storage.getItem.bind(storage);
    storage.getItem = (key) => { if (key.includes('Password') || key === 'passwordVerified') throw new Error('auth read'); return get(key); };
    expect(readLegacyData(storage)).toEqual({ videoProgress_url: '{"position":1}' });
  });
});

describe('versioned settings validation', () => {
  it('normalizes all persisted upstream feature fields and v0 live ownership', () => {
    const state = {
      customAPIs: [], selectedKeys: [], envKeysSeen: ['env'], envSubsSeen: ['sub'],
      liveEnvKeysSeen: ['live'], liveSelectedUrls: ['https://a.invalid/list.m3u'], liveFavorites: ['https://a.invalid/1'],
      subscriptions: [{ url: 'https://a.invalid/list.json', enabled: false, lastStatus: 'ok', lastCounts: { vod: 2, live: 1 }, lastSync: 1 }],
      liveSubscriptions: [{ url: 'https://a.invalid/list.m3u', fromSubscription: 'https://a.invalid/list.json' }],
      liveRecent: [{ url: 'https://a.invalid/1', name: '频道', timestamp: 4 }],
      sourceHealth: { a: { ok: false, failStreak: 3, permanent: true, timestamp: 5 } },
      liveProbeResults: { 'https://a.invalid/1': { ok: true, timestamp: 6 } },
      yellowFilter: false, adFilter: true, doubanEnabled: true, recommendSource: 'bangumi', recommendSourceTouched: true,
      autoplayNext: false, imageProxyMode: 'custom', imageProxyModeTouched: true, customImageProxy: 'https://images.invalid/?url=',
    };
    const normalized = normalizeSettings(JSON.stringify({ state, version: 0 }));
    expect(normalized.version).toBe(2);
    expect(normalized.state).toEqual({ ...state, liveSubscriptions: [{ url: 'https://a.invalid/list.m3u', fromSubscriptions: ['https://a.invalid/list.json'] }] });
  });

  it('cannot hydrate store actions or auth hashes', () => {
    expect(normalizeSettings(JSON.stringify({ version: 2, state: { selectedKeys: [], updateSettings: 'bad', passwordVerified: 'hash', __proto__: null } })).state).toEqual({ selectedKeys: [] });
  });

  it.each([
    { version: 99, state: {} }, { state: null }, { state: { selectedKeys: 'x' } },
    { state: { yellowFilter: 'false' } }, { state: { recommendSource: 'unknown' } },
    { state: { customAPIs: [{ key: 'a', name: 'a', url: 'javascript:alert(1)' }] } },
    { state: { liveSubscriptions: [{ url: 'https://a.invalid', fromSubscriptions: [3] }] } },
    { state: { sourceHealth: { a: { ok: 'yes', timestamp: 1 } } } },
  ])('rejects malformed/future settings before hydration: %j', (value) => {
    expect(() => normalizeSettings(JSON.stringify(value))).toThrow();
  });

  it('rejects negative, infinite and fractional history/progress numbers', () => {
    expect(() => normalizeHistory([{ sourceKey: 'a', vodId: '1', timestamp: -1 }], [])).toThrow();
    expect(() => normalizeHistory([{ sourceKey: 'a', vodId: '1', episodeIndex: 0.5 }], [])).toThrow();
    expect(() => normalizeProgress([{ key: 'a', position: Infinity }])).toThrow();
  });
});
