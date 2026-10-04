import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, exportConfig, importConfig } from './db';
import { BACKUP_VERSION, LEGACY_MIGRATION_KEY, ORBIT_KEY, PALETTE_KEY } from './legacy-data';
import { createThrottledStorage, flushPendingPersist, PERSIST_KEY } from './persist-storage';
import { historyEntry, legacyHistory, MemoryStorage } from './migration-test-helpers';
import { summarizeSettingsBackup } from './settings-backup';
import { migrateLegacyBrowserData } from './legacy-migration';
import { THEME_STORAGE_KEY } from './ui-palette';
import { DEFAULT_CACHE_SETTINGS, normalizeCacheSettings, VIDEO_CACHE_SETTINGS_KEY } from './video-cache-settings';

let storage: MemoryStorage;
beforeEach(async () => {
  storage = new MemoryStorage(); vi.stubGlobal('localStorage', storage);
  await db.delete(); await db.open();
});
afterEach(() => { flushPendingPersist(); vi.restoreAllMocks(); vi.unstubAllGlobals(); db.close(); });

function backup(data: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return JSON.stringify({ name: 'LibreTV-Settings', cfgVer: '2.0.0', data, ...options });
}

async function snapshot() {
  return {
    history: await db.history.toArray(), progress: await db.progress.toArray(), searches: await db.searchHistory.toArray(),
    liveProbe: await db.liveProbe.toArray(), downloads: await db.downloads.toArray(),
  };
}

describe('backup compatibility and roundtrip', () => {
  it.each(['dark', 'light', 'system'])('restores the latest %s theme and normalized cache preferences after migration and keeps v3 roundtrips stable', async (theme) => {
    const oldCache = '{"enabled":true,"horizonSeconds":120}';
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, oldCache); storage.setItem(THEME_STORAGE_KEY, 'dark');
    await migrateLegacyBrowserData();
    const latestCache = { enabled: false, horizonSeconds: 0, maxBytesPerEpisode: 400 * 1024 * 1024, maxTotalBytes: 4 * 1024 * 1024 * 1024 };
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, JSON.stringify(latestCache)); storage.setItem(THEME_STORAGE_KEY, theme);
    expect((await db.legacyData.get(VIDEO_CACHE_SETTINGS_KEY))!.value).toBe(oldCache);
    const content = await exportConfig();
    const data = JSON.parse(content).data;
    expect(data[THEME_STORAGE_KEY]).toBe(theme);
    expect(JSON.parse(data[VIDEO_CACHE_SETTINGS_KEY])).toEqual(latestCache);
    expect(JSON.parse(data.legacyData)[VIDEO_CACHE_SETTINGS_KEY]).toBe(data[VIDEO_CACHE_SETTINGS_KEY]);
    storage.clear(); await db.delete(); await db.open();
    await importConfig(content);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe(theme);
    expect(JSON.parse(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)!)).toEqual(latestCache);
    expect(JSON.parse(await exportConfig()).data).toEqual(data);
    storage.setItem(THEME_STORAGE_KEY, theme === 'light' ? 'system' : 'light');
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, '{"enabled":true,"horizonSeconds":600}');
    const edited = JSON.parse(await exportConfig()).data;
    expect(edited[THEME_STORAGE_KEY]).toBe(theme === 'light' ? 'system' : 'light');
    expect(JSON.parse(edited[VIDEO_CACHE_SETTINGS_KEY])).toEqual({ ...DEFAULT_CACHE_SETTINGS, enabled: true, horizonSeconds: 600 });
  });

  it.each(['{broken', 'null', '[]', '"not settings"', '{"enabled":"false","horizonSeconds":"0","maxBytesPerEpisode":"NaN","maxTotalBytes":1e9999}'])('normalizes damaged cache preferences at both export and import: %s', async (raw) => {
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, raw);
    const exported = JSON.parse(await exportConfig()).data;
    expect(JSON.parse(exported[VIDEO_CACHE_SETTINGS_KEY])).toEqual(DEFAULT_CACHE_SETTINGS);
    const content = backup({ [VIDEO_CACHE_SETTINGS_KEY]: raw }, { cfgVer: BACKUP_VERSION });
    await importConfig(content);
    const restored = JSON.parse(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)!);
    expect(restored).toEqual(DEFAULT_CACHE_SETTINGS);
    for (const key of ['horizonSeconds', 'maxBytesPerEpisode', 'maxTotalBytes']) expect(Number.isFinite(restored[key])).toBe(true);
  });

  it('clamps finite numeric cache preferences and normalizes invalid theme without rewriting live values during export', async () => {
    const raw = '{"enabled":false,"horizonSeconds":1e100,"maxBytesPerEpisode":-5,"maxTotalBytes":1e100}';
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, raw); storage.setItem(THEME_STORAGE_KEY, 'invalid');
    const data = JSON.parse(await exportConfig()).data;
    expect(data[THEME_STORAGE_KEY]).toBe('dark');
    expect(JSON.parse(data[VIDEO_CACHE_SETTINGS_KEY])).toEqual(normalizeCacheSettings(JSON.parse(raw)));
    expect(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)).toBe(raw);
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('invalid');
    await importConfig(backup({ [VIDEO_CACHE_SETTINGS_KEY]: raw, [THEME_STORAGE_KEY]: 'invalid' }, { cfgVer: BACKUP_VERSION }));
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(JSON.parse(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)!)).toEqual({ enabled: false, horizonSeconds: 7200, maxBytesPerEpisode: 50 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 * 1024 });
  });

  it('restores archive-only external preferences, prioritizes explicit fields, and preserves omitted keys on a partial import', async () => {
    const archive = { [VIDEO_CACHE_SETTINGS_KEY]: '{"enabled":false,"horizonSeconds":0}', [THEME_STORAGE_KEY]: 'light' };
    await importConfig(backup({ legacyData: JSON.stringify(archive) }, { cfgVer: BACKUP_VERSION }));
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(JSON.parse(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)!)).toEqual({ ...DEFAULT_CACHE_SETTINGS, enabled: false, horizonSeconds: 0 });
    await importConfig(backup({ [THEME_STORAGE_KEY]: 'system', [VIDEO_CACHE_SETTINGS_KEY]: '{"horizonSeconds":900}', legacyData: JSON.stringify(archive) }, { cfgVer: BACKUP_VERSION }));
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(JSON.parse(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)!)).toEqual({ ...DEFAULT_CACHE_SETTINGS, horizonSeconds: 900 });
    const before = storage.getItem(VIDEO_CACHE_SETTINGS_KEY);
    await importConfig(backup({ viewingHistory: '[]' }, { cfgVer: BACKUP_VERSION }));
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)).toBe(before);
  });

  it('previews preference-only backups rather than reporting them empty', () => {
    expect(summarizeSettingsBackup(backup({ [VIDEO_CACHE_SETTINGS_KEY]: '{}', [THEME_STORAGE_KEY]: 'system' }, { cfgVer: BACKUP_VERSION }))).toBe('该文件包含 视频缓存偏好、主题设置');
  });

  it.each(['JAYFLIX-Settings', 'LibreTV-Settings'])('the shared UI preview accepts %s and counts the actual legacy fields', (name) => {
    expect(summarizeSettingsBackup(backup({ customAPIs: '[{"name":"A","url":"https://a.invalid"}]', viewingHistory: JSON.stringify([legacyHistory()]), videoSearchHistory: '["x"]' }, { name, cfgVer: '1.0.0' }))).toBe('该文件包含 1 个点播源、1 条观看历史、1 条搜索历史');
  });

  it('previews tag-only current and older archive-only backups accurately', () => {
    expect(summarizeSettingsBackup(backup({ userMovieTags: '["A","B"]', userTvTags: '[]' }))).toBe('该文件包含 2 个电影标签、0 个剧集标签');
    expect(summarizeSettingsBackup(backup({ legacyData: '{"userTvTags":"[\\\"archived\\\"]"}' }, { cfgVer: BACKUP_VERSION }))).toBe('该文件包含 1 个剧集标签');
  });

  it('fixes the upstream regression: newly exported sourceKey/vodId history imports without losing timestamps or short progress', async () => {
    const entry = historyEntry();
    await db.history.put(entry);
    const content = await exportConfig();
    await db.history.clear();
    await importConfig(content);
    expect(await db.history.toArray()).toEqual([entry]);
    expect(await db.progress.toArray()).toEqual([]);
    expect(JSON.parse(content).cfgVer).toBe(BACKUP_VERSION);
  });

  it.each(['JAYFLIX-Settings', 'JAY-TV-Settings', 'LibreTV-Settings'])('accepts %s legacy backups, including all 50 histories and unmappable original fields', async (name) => {
    const old = Array.from({ length: 50 }, (_, i) => legacyHistory(i));
    const missingId = { title: 'missing ID', episodes: ['url'], extra: 'keep' };
    const data = {
      customAPIs: '[{"name":"custom","url":"http://custom.invalid/api/","detail":"https://custom.invalid/details","isAdult":true}]',
      selectedAPIs: '["bfzy","custom_0"]', viewingHistory: JSON.stringify([...old, missingId]),
      videoSearchHistory: '["old",{"text":"new","timestamp":10}]',
      yellowFilterEnabled: 'false', adFilteringEnabled: 'false', doubanEnabled: 'false',
      userMovieTags: '["热门","旧电影标签"]', userTvTags: '["热门","旧剧集标签"]',
      passwordVerified: 'excluded', adminPasswordVerified: 'excluded',
    };
    await importConfig(backup(data, { name, cfgVer: '1.0.0' }));
    expect(await db.history.count()).toBe(50);
    expect(await db.history.get('custom_0_0')).toMatchObject({ ...old[0], sourceUrl: 'http://custom.invalid/api/' });
    expect(await db.progress.get('custom_0_0_1')).toMatchObject({ position: 5.5, updatedAt: old[0].timestamp });
    expect(JSON.parse(storage.getItem(PERSIST_KEY)!).state).toMatchObject({ selectedKeys: ['bfzy', 'custom_0'], yellowFilter: false, adFilter: false, doubanEnabled: false });
    const exported = JSON.parse(await exportConfig());
    expect(JSON.parse(JSON.parse(exported.data.legacyData).viewingHistory)).toEqual([...old, missingId]);
    expect(JSON.stringify(exported)).not.toContain('passwordVerified');
    expect(storage.getItem('userMovieTags')).toBe(data.userMovieTags);
    expect(storage.getItem('userTvTags')).toBe(data.userTvTags);
    expect(exported.data.userMovieTags).toBe(data.userMovieTags);
    expect(exported.data.userTvTags).toBe(data.userTvTags);
  });

  it('roundtrips every durable upstream table, advanced settings, raw orphan progress and exact palette/orbit bytes', async () => {
    const state = {
      customAPIs: [{ key: 'manual', name: 'A', url: 'https://a.invalid/api/', isAdult: false }], selectedKeys: ['manual'],
      envKeysSeen: ['env'], envSubsSeen: ['sub'], liveEnvKeysSeen: ['live'],
      subscriptions: [{ url: 'https://s.invalid/list.json', name: 'S', enabled: false, lastSync: 123, lastStatus: 'error', lastError: 'timeout', lastCounts: { vod: 2, live: 3 } }],
      liveSubscriptions: [{ url: 'https://s.invalid/list.m3u', name: 'M3U', epg: 'https://s.invalid/epg.xml', lastSync: 124, fromSubscriptions: ['https://s.invalid/list.json'] }],
      liveSelectedUrls: ['https://s.invalid/list.m3u'], liveFavorites: ['https://s.invalid/live/1'],
      liveRecent: [{ url: 'https://s.invalid/live/1', name: 'channel', timestamp: 125, sourceUrl: 'https://s.invalid/list.m3u' }],
      sourceHealth: { manual: { ok: false, failStreak: 5, disableCount: 3, permanent: true, timestamp: 126 } },
      yellowFilter: false, adFilter: false, doubanEnabled: false, recommendSource: 'bangumi', recommendSourceTouched: true,
      autoplayNext: false, imageProxyMode: 'custom', imageProxyModeTouched: true, customImageProxy: 'https://images.invalid/?url=',
    };
    storage.setItem(PERSIST_KEY, JSON.stringify({ version: 2, state }));
    const palette = '{ "version":1, "colors":{"accent":"#123456","text":"#abcdef"} }';
    const orbit = '{ "version":1,"zoom":1.4,"cardScale":0.8,"speedPercent":75,"paused":true }';
    storage.setItem(PALETTE_KEY, palette); storage.setItem(ORBIT_KEY, orbit);
    storage.setItem('userMovieTags', '[ "热门", "电影 🎬", "保留顺序" ]');
    storage.setItem('userTvTags', '["剧集","纪录片"]');
    await db.history.put(historyEntry());
    await db.progress.bulkPut([{ key: 'lzi_1_2', position: 1.25, duration: 300.5, updatedAt: 12 }, { key: 'lzi_1_0', position: 10, duration: 20, updatedAt: 11 }]);
    await db.searchHistory.bulkPut([{ text: 'long'.repeat(100), timestamp: 1 }, { text: 'old', timestamp: 0 }]);
    await db.liveProbe.put({ url: 'https://s.invalid/live/1', ok: true, timestamp: 127, level: 'segment', codec: 'avc1', kbps: 500, ms: 100 });
    await db.downloads.put({ id: 'download', url: 'https://s.invalid/1.m3u8', title: 'D', format: 'TS', status: 'paused', finished: 5, total: 10, errorNum: 0, createdAt: 8, updatedAt: 9 });
    await db.legacyData.put({ key: 'videoProgress_orphan', value: '{"position":9,"duration":10,"timestamp":11}' });
    const before = await snapshot();
    const content = await exportConfig();
    await db.delete(); await db.open(); storage.clear();
    await importConfig(content);
    expect(await snapshot()).toEqual(before);
    expect(storage.getItem(PALETTE_KEY)).toBe(palette);
    expect(storage.getItem(ORBIT_KEY)).toBe(orbit);
    expect(storage.getItem('userMovieTags')).toBe('[ "热门", "电影 🎬", "保留顺序" ]');
    expect(storage.getItem('userTvTags')).toBe('["剧集","纪录片"]');
    expect(JSON.parse(storage.getItem(PERSIST_KEY)!).state).toMatchObject(state);
    expect((await db.legacyData.get('videoProgress_orphan'))!.value).toBe('{"position":9,"duration":10,"timestamp":11}');
    const again = JSON.parse(await exportConfig()).data;
    const original = JSON.parse(content).data;
    expect(again).toEqual(original);
  });

  it('exports the newest live tags and orbit/palette after one-time migration, then roundtrips subsequent edits', async () => {
    storage.setItem('userMovieTags', '["old movie"]');
    storage.setItem('userTvTags', '["old TV"]');
    await migrateLegacyBrowserData();
    const latest = {
      userMovieTags: '[ "自定义电影", "经典", "自定义电影", "🎬" ]',
      userTvTags: '[]',
      [PALETTE_KEY]: '{ "version":1, "colors":{"accent":"#abcdef"} }',
      [ORBIT_KEY]: '{ "version":1, "zoom":1.8, "paused":true }',
    };
    for (const [key, value] of Object.entries(latest)) storage.setItem(key, value);
    expect((await db.legacyData.get('userMovieTags'))!.value).toBe('["old movie"]');
    expect((await db.legacyData.get('userTvTags'))!.value).toBe('["old TV"]');
    const first = await exportConfig();
    const firstData = JSON.parse(first).data;
    for (const [key, value] of Object.entries(latest)) expect(firstData[key]).toBe(value);
    expect(JSON.parse(firstData.legacyData)).toMatchObject({ userMovieTags: latest.userMovieTags, userTvTags: latest.userTvTags });
    storage.clear(); await db.delete(); await db.open();
    await importConfig(first);
    for (const [key, value] of Object.entries(latest)) expect(storage.getItem(key)).toBe(value);
    expect(JSON.parse(await exportConfig()).data).toEqual(firstData);
    storage.setItem('userMovieTags', '["edited again"]');
    storage.setItem('userTvTags', '["new TV"]');
    const secondData = JSON.parse(await exportConfig()).data;
    expect(secondData.userMovieTags).toBe('["edited again"]');
    expect(secondData.userTvTags).toBe('["new TV"]');
  });

  it('restores tags from earlier v3 archive-only backups and lets explicit new tags win', async () => {
    await importConfig(backup({ legacyData: JSON.stringify({ userMovieTags: '["archived movie"]', userTvTags: '["archived TV"]' }) }, { cfgVer: BACKUP_VERSION }));
    expect(storage.getItem('userMovieTags')).toBe('["archived movie"]');
    expect(storage.getItem('userTvTags')).toBe('["archived TV"]');
    await importConfig(backup({ userMovieTags: '[]', userTvTags: '["new TV"]', legacyData: JSON.stringify({ userMovieTags: '["stale movie"]', userTvTags: '["stale TV"]' }) }, { cfgVer: BACKUP_VERSION }));
    expect(storage.getItem('userMovieTags')).toBe('[]');
    expect(storage.getItem('userTvTags')).toBe('["new TV"]');
  });

  it('preserves omitted tag keys on a partial restore and never truncates a large imported tag list', async () => {
    const tags = JSON.stringify(Array.from({ length: 150 }, (_, i) => `标签 ${i}`));
    storage.setItem('userTvTags', '["unchanged"]');
    await importConfig(backup({ userMovieTags: tags }));
    expect(storage.getItem('userMovieTags')).toBe(tags);
    expect(storage.getItem('userTvTags')).toBe('["unchanged"]');
    expect(JSON.parse(await exportConfig()).data.userMovieTags).toBe(tags);
  });

  it('imports 150 histories/25 searches without slicing and keeps newer existing progress and records', async () => {
    await db.history.put(historyEntry(0, { title: 'newer', timestamp: Date.now() }));
    await db.progress.put({ key: 'lzi_0_2', position: 300, duration: 400, updatedAt: Date.now() });
    const records = Array.from({ length: 150 }, (_, i) => historyEntry(i));
    await importConfig(backup({ viewingHistory: JSON.stringify(records), videoSearchHistory: JSON.stringify(Array.from({ length: 25 }, (_, i) => ({ text: `text${i}`, timestamp: i }))) }));
    expect(await db.history.count()).toBe(150); expect(await db.searchHistory.count()).toBe(25);
    expect(await db.history.get('lzi_0')).toMatchObject({ title: 'newer' });
    expect(await db.progress.get('lzi_0_2')).toMatchObject({ position: 300 });
  });

  it('flushes the throttled settings before export, and cannot overwrite a completed import with the stale buffer', async () => {
    const throttled = createThrottledStorage();
    throttled.setItem(PERSIST_KEY, '{"version":2,"state":{"selectedKeys":["lzi"]}}');
    expect(JSON.parse(JSON.parse(await exportConfig()).data[PERSIST_KEY]).state.selectedKeys).toEqual(['lzi']);
    throttled.setItem(PERSIST_KEY, '{"version":2,"state":{"selectedKeys":["bfzy"]}}');
    await importConfig(backup({ [PERSIST_KEY]: '{"version":2,"state":{"selectedKeys":[]}}' }));
    flushPendingPersist();
    expect(JSON.parse(storage.getItem(PERSIST_KEY)!).state.selectedKeys).toEqual([]);
  });

  it('upgrades v3 IndexedDB without touching any upstream tables', async () => {
    await db.delete();
    const oldDb = new Dexie('libretv');
    oldDb.version(3).stores({ history: 'id, timestamp', progress: 'key, updatedAt', searchHistory: 'text, timestamp', liveProbe: 'url', segmentMeta: 'key, episodeKey, lastAccess', downloads: 'id, createdAt' });
    await oldDb.open();
    await oldDb.table('history').put(historyEntry());
    await oldDb.table('segmentMeta').put({ key: 'segment', episodeKey: 'lzi:1:2', index: 1, bytes: 10, costMs: 5, lastAccess: 100 });
    oldDb.close(); await db.open();
    expect(await db.history.get('lzi_1')).toEqual(historyEntry());
    expect(await db.segmentMeta.count()).toBe(1);
    expect(await db.migrations.count()).toBe(0); expect(await db.legacyData.count()).toBe(0);
  });
});

describe('validation and atomic failure', () => {
  it('rolls back external preferences together with IDB and other settings when a later storage write fails', async () => {
    const oldCache = '{"enabled":false}';
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, oldCache); storage.setItem(THEME_STORAGE_KEY, 'system');
    const write = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => { if (key === PALETTE_KEY) throw new Error('quota'); write(key, value); });
    await expect(importConfig(backup({ [VIDEO_CACHE_SETTINGS_KEY]: '{"horizonSeconds":0}', [THEME_STORAGE_KEY]: 'light', viewingHistory: JSON.stringify([historyEntry()]), [PALETTE_KEY]: '{"version":1,"colors":{}}' }, { cfgVer: BACKUP_VERSION }))).rejects.toThrow('quota');
    expect(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)).toBe(oldCache); expect(storage.getItem(THEME_STORAGE_KEY)).toBe('system');
    expect(await db.history.count()).toBe(0); expect(await db.legacyData.count()).toBe(0); expect(await db.migrations.count()).toBe(0);
  });

  it.each(['userMovieTags', 'userTvTags'])('rejects malformed %s before writing any settings or IndexedDB tables', async (key) => {
    const original = '["keep"]'; storage.setItem(key, original);
    for (const value of ['{broken', '{}', '[null]', '[123]']) {
      await expect(importConfig(backup({ viewingHistory: JSON.stringify([historyEntry()]), [key]: value }))).rejects.toThrow();
      expect(storage.getItem(key)).toBe(original);
      expect(await db.history.count()).toBe(0);
      expect(await db.migrations.count()).toBe(0);
    }
    await expect(importConfig(backup({ legacyData: JSON.stringify({ [key]: '[false]' }) }, { cfgVer: BACKUP_VERSION }))).rejects.toThrow();
    expect(storage.getItem(key)).toBe(original);
  });

  it('rolls back restored tags, settings and IndexedDB when a later palette write fails', async () => {
    const original = { userMovieTags: '["keep movie"]', userTvTags: '["keep TV"]', [PERSIST_KEY]: '{"version":2,"state":{"selectedKeys":["lzi"]}}' };
    for (const [key, value] of Object.entries(original)) storage.setItem(key, value);
    const write = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => { if (key === PALETTE_KEY) throw new Error('quota'); write(key, value); });
    await expect(importConfig(backup({ userMovieTags: '["imported movie"]', userTvTags: '["imported TV"]', [PERSIST_KEY]: '{"version":2,"state":{"selectedKeys":[]}}', viewingHistory: JSON.stringify([historyEntry()]), [PALETTE_KEY]: '{"version":1,"colors":{}}' }))).rejects.toThrow('quota');
    for (const [key, value] of Object.entries(original)) expect(storage.getItem(key)).toBe(value);
    expect(await db.history.count()).toBe(0); expect(await db.progress.count()).toBe(0);
    expect(await db.legacyData.count()).toBe(0); expect(await db.migrations.count()).toBe(0);
  });

  it.each([
    backup({}, { name: 'unknown' }), backup({}, { cfgVer: '9.0.0' }),
    backup({ [PERSIST_KEY]: '{"version":99,"state":{}}' }),
    backup({ viewingHistory: '{}' }), backup({ videoSearchHistory: '[null]' }),
    backup({ viewingHistory: '[{"sourceKey":"a","vodId":"1","timestamp":-1}]' }),
    backup({ progress: '[{"key":"a","position":-1}]' }),
    backup({ legacyData: '{"passwordVerified":"hash"}' }),
    backup({ liveProbeResults: '{"url":{"ok":"yes","timestamp":1}}' }),
    backup({ downloads: '[{"id":"a","url":"x","format":"invalid"}]' }),
    backup({ [PALETTE_KEY]: '{"version":2}' }), backup({ [PERSIST_KEY]: 123 }),
    backup({ viewingHistory: '[{"title":"missing id"}]' }, { cfgVer: BACKUP_VERSION }),
  ])('rejects invalid input before changing settings or IDB: %s', async (content) => {
    await db.history.put(historyEntry()); storage.setItem(PERSIST_KEY, '{"version":2,"state":{"selectedKeys":["lzi"]}}');
    const previous = storage.getItem(PERSIST_KEY);
    await expect(importConfig(content)).rejects.toThrow();
    expect(storage.getItem(PERSIST_KEY)).toBe(previous);
    expect(await db.history.toArray()).toEqual([historyEntry()]);
    expect(await db.migrations.count()).toBe(0);
  });

  it('checks optional legacy SHA-256 and refuses tampered versioned exports', async () => {
    await db.history.put(historyEntry());
    const config = JSON.parse(await exportConfig());
    config.data.viewingHistory = '[]';
    await expect(importConfig(JSON.stringify(config))).rejects.toThrow('哈希');
    expect(await db.history.count()).toBe(1);
    await expect(importConfig(backup({}, { hash: '0'.repeat(64) }))).rejects.toThrow('哈希');
  });

  it('rolls back both settings and IDB when the second localStorage write fails', async () => {
    const previous = '{"version":2,"state":{"selectedKeys":["lzi"]}}'; storage.setItem(PERSIST_KEY, previous);
    const write = storage.setItem.bind(storage);
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => { if (key === PALETTE_KEY) throw new Error('quota'); write(key, value); });
    await expect(importConfig(backup({ [PERSIST_KEY]: '{"version":2,"state":{"selectedKeys":[]}}', viewingHistory: JSON.stringify([historyEntry()]), [PALETTE_KEY]: '{"version":1,"colors":{}}' }))).rejects.toThrow('quota');
    expect(storage.getItem(PERSIST_KEY)).toBe(previous);
    expect(await db.history.count()).toBe(0); expect(await db.legacyData.count()).toBe(0);
    expect(await db.migrations.get(LEGACY_MIGRATION_KEY)).toBeUndefined();
  });

  it('aborts all tables when an IDB section write fails', async () => {
    vi.spyOn(db.searchHistory, 'put').mockRejectedValueOnce(new Error('search write failed'));
    await expect(importConfig(backup({ viewingHistory: JSON.stringify([historyEntry()]), videoSearchHistory: '["search"]' }))).rejects.toThrow('search write failed');
    expect(await db.history.count()).toBe(0); expect(await db.progress.count()).toBe(0);
    expect(await db.migrations.count()).toBe(0);
  });
});
