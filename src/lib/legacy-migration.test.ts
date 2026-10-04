import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, addSearchHistory, clearAllHistory, saveProgress, upsertHistory } from './db';
import { migrateLegacyBrowserData } from './legacy-migration';
import { BUILTIN_SOURCES, DEFAULT_SELECTED_KEYS, LEGACY_MIGRATION_KEY, LEGACY_MIGRATION_VERSION, ORBIT_KEY, PALETTE_KEY } from './legacy-data';
import { THEME_STORAGE_KEY } from './ui-palette';
import { VIDEO_CACHE_SETTINGS_KEY } from './video-cache-settings';
import { PERSIST_KEY, flushPendingPersist } from './persist-storage';
import { historyEntry, legacyHistory, MemoryStorage } from './migration-test-helpers';

let storage: MemoryStorage;
beforeEach(async () => {
  storage = new MemoryStorage();
  vi.stubGlobal('localStorage', storage);
  await db.delete();
  await db.open();
});
afterEach(() => { flushPendingPersist(); vi.restoreAllMocks(); vi.unstubAllGlobals(); db.close(); });

describe('transactional legacy browser migration', () => {
  it('archives external cache/theme keys verbatim while leaving live preferences unchanged', async () => {
    const cache = '{ "enabled":false, "horizonSeconds":"damaged", "maxTotalBytes":null }';
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, cache); storage.setItem(THEME_STORAGE_KEY, 'system');
    await migrateLegacyBrowserData();
    expect(await db.legacyData.get(VIDEO_CACHE_SETTINGS_KEY)).toEqual({ key: VIDEO_CACHE_SETTINGS_KEY, value: cache });
    expect(await db.legacyData.get(THEME_STORAGE_KEY)).toEqual({ key: THEME_STORAGE_KEY, value: 'system' });
    expect(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)).toBe(cache); expect(storage.getItem(THEME_STORAGE_KEY)).toBe('system');
  });

  it('upgrades a successful v1 migration by archiving only new preferences, never resurrecting old history or deleted sources', async () => {
    await db.migrations.put({ key: LEGACY_MIGRATION_KEY, version: 1, completedAt: 1 });
    const settings = '{"version":2,"state":{"customAPIs":[],"selectedKeys":[]}}';
    storage.setItem(PERSIST_KEY, settings);
    storage.setItem('viewingHistory', JSON.stringify([legacyHistory()]));
    storage.setItem('customAPIs', '{broken-but-already-migrated');
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, '{"enabled":false}'); storage.setItem(THEME_STORAGE_KEY, 'light');
    await expect(migrateLegacyBrowserData()).resolves.toEqual({ status: 'migrated', history: 0, archivedHistory: 0 });
    expect(await db.history.count()).toBe(0); expect(await db.progress.count()).toBe(0);
    expect(storage.getItem(PERSIST_KEY)).toBe(settings);
    expect(await db.legacyData.count()).toBe(2);
    expect(await db.migrations.get(LEGACY_MIGRATION_KEY)).toMatchObject({ version: LEGACY_MIGRATION_VERSION });
    expect((await migrateLegacyBrowserData()).status).toBe('already-migrated');
  });

  it('retries a failed v1 preference archive upgrade without changing its checkpoint or live data', async () => {
    await db.migrations.put({ key: LEGACY_MIGRATION_KEY, version: 1, completedAt: 1 });
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, '{"enabled":false}'); storage.setItem(THEME_STORAGE_KEY, 'dark');
    vi.spyOn(db.migrations, 'put').mockRejectedValueOnce(new Error('cannot checkpoint'));
    await expect(migrateLegacyBrowserData()).rejects.toThrow('cannot checkpoint');
    expect(await db.migrations.get(LEGACY_MIGRATION_KEY)).toMatchObject({ version: 1, completedAt: 1 });
    expect(await db.legacyData.count()).toBe(0);
    await expect(migrateLegacyBrowserData()).resolves.toMatchObject({ status: 'migrated' });
    expect(await db.legacyData.count()).toBe(2);
  });

  it('does not downgrade or replay a future migration checkpoint', async () => {
    await db.migrations.put({ key: LEGACY_MIGRATION_KEY, version: 99, completedAt: 1 });
    storage.setItem('viewingHistory', '{broken');
    expect((await migrateLegacyBrowserData()).status).toBe('already-migrated');
    expect(await db.migrations.get(LEGACY_MIGRATION_KEY)).toMatchObject({ version: 99 });
  });

  it('initializes an empty legacy browser with all 13 real sources and the actual old default selection before hydration', async () => {
    const { useAppStore } = await import('./store');
    expect(storage.length).toBe(0);
    expect(await db.history.count()).toBe(0);
    expect(await migrateLegacyBrowserData()).toEqual({ status: 'migrated', history: 0, archivedHistory: 0 });
    const saved = JSON.parse(storage.getItem(PERSIST_KEY)!);
    expect(saved.version).toBe(2);
    expect(saved.state.customAPIs).toEqual(BUILTIN_SOURCES);
    expect(saved.state.customAPIs).toHaveLength(13);
    expect(saved.state.selectedKeys).toEqual(DEFAULT_SELECTED_KEYS);
    expect(saved.state.selectedKeys).toEqual(['lzi', 'bfzy', 'dyttzy', 'ruyi']);
    await useAppStore.persist.rehydrate();
    expect(useAppStore.getState().customAPIs).toEqual(BUILTIN_SOURCES);
    expect(useAppStore.getState().selectedKeys).toEqual(DEFAULT_SELECTED_KEYS);
    expect(useAppStore.getState()).toMatchObject({ yellowFilter: true, adFilter: true, doubanEnabled: true, autoplayNext: true });
    expect(await db.legacyData.count()).toBe(0);
    expect(await db.history.count()).toBe(0);
    expect(await db.progress.count()).toBe(0);
    expect(await db.migrations.count()).toBe(1);
  });

  it('StrictMode concurrent startup shares one transaction without duplicate history, progress, sources or checkpoints', async () => {
    const old = Array.from({ length: 50 }, (_, i) => legacyHistory(i));
    storage.setItem('viewingHistory', JSON.stringify(old));
    storage.setItem('customAPIs', '[{"name":"custom","url":"https://custom.invalid/api"}]');
    const transaction = vi.spyOn(db, 'transaction');
    const a = migrateLegacyBrowserData();
    const b = migrateLegacyBrowserData();
    const c = migrateLegacyBrowserData();
    expect(a).toBe(b); expect(b).toBe(c);
    const results = await Promise.all([a, b, c]);
    expect(results.every((result) => result.status === 'migrated')).toBe(true);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await db.history.count()).toBe(50);
    expect(await db.progress.count()).toBe(50);
    expect(await db.migrations.count()).toBe(1);
    const sources = JSON.parse(storage.getItem(PERSIST_KEY)!).state.customAPIs;
    expect(sources).toHaveLength(14);
    expect(new Set(sources.map((source: { key: string }) => source.key)).size).toBe(14);
    expect((await migrateLegacyBrowserData()).status).toBe('already-migrated');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(await db.history.count()).toBe(50);
  });

  it('migrates the entire original 50 records, source IDs, flags, searches and episode progress exactly once', async () => {
    const old = Array.from({ length: 50 }, (_, i) => legacyHistory(i));
    storage.setItem('customAPIs', JSON.stringify([{ name: '旧自定义', url: 'http://custom.invalid/api/?x=1', detail: 'https://custom.invalid/details' }]));
    storage.setItem('selectedAPIs', '["lzi","custom_0"]');
    storage.setItem('viewingHistory', JSON.stringify(old));
    storage.setItem('videoSearchHistory', '["old",{"text":"older","timestamp":1}]');
    storage.setItem('adFilteringEnabled', 'false');
    storage.setItem('autoplayEnabled', 'false');
    storage.setItem(`videoProgress_${encodeURIComponent(old[0].episodes[0])}`, '{"position":45.75,"duration":360,"timestamp":80}');
    storage.setItem('videoProgress_orphan', '{"position":100,"duration":400,"timestamp":90}');
    storage.setItem(PALETTE_KEY, '{"version":1,"colors":{"accent":"#123456"}}');
    storage.setItem(ORBIT_KEY, '{"version":1,"zoom":2,"paused":true}');
    storage.setItem('userMovieTags', '["热门","自定义电影"]');
    storage.setItem('userTvTags', '["热门","自定义剧集"]');
    storage.setItem('passwordVerified', 'do not read/migrate');
    const previous = Array.from({ length: storage.length }, (_, i) => [storage.key(i)!, storage.getItem(storage.key(i)!)!] as const);
    const result = await migrateLegacyBrowserData();
    expect(result).toEqual({ status: 'migrated', history: 50, archivedHistory: 50 });
    expect(await db.history.count()).toBe(50);
    expect(await db.history.get('custom_0_0')).toMatchObject({ ...old[0], sourceUrl: 'http://custom.invalid/api/?x=1', totalEpisodes: 2, playbackPosition: 5.5 });
    expect(await db.progress.get('custom_0_0_0')).toEqual({ key: 'custom_0_0_0', position: 45.75, duration: 360, updatedAt: 80 });
    expect(await db.searchHistory.get('old')).toEqual({ text: 'old', timestamp: 0 });
    const state = JSON.parse(storage.getItem(PERSIST_KEY)!).state;
    expect(state.customAPIs).toHaveLength(14);
    expect(state).toMatchObject({ selectedKeys: ['lzi', 'custom_0'], adFilter: false, autoplayNext: false });
    for (const [key, value] of previous) expect(storage.getItem(key)).toBe(value);
    expect(await db.legacyData.get('videoProgress_orphan')).toMatchObject({ value: previous.find(([k]) => k === 'videoProgress_orphan')![1] });
    expect(await db.legacyData.get('passwordVerified')).toBeUndefined();
    expect(await db.legacyData.get('userMovieTags')).toEqual({ key: 'userMovieTags', value: '["热门","自定义电影"]' });
    expect(await db.legacyData.get('userTvTags')).toEqual({ key: 'userTvTags', value: '["热门","自定义剧集"]' });
    await clearAllHistory();
    expect((await migrateLegacyBrowserData()).status).toBe('already-migrated');
    expect(await db.history.count()).toBe(0);
  });

  it('archives history without stable identifiers and preserves new settings and newer DB records', async () => {
    storage.setItem('viewingHistory', JSON.stringify([legacyHistory(), { title: '无法定位', episodes: ['url'], extra: 'keep' }]));
    storage.setItem('selectedAPIs', '["custom_0"]');
    storage.setItem('yellowFilterEnabled', 'false');
    storage.setItem(PERSIST_KEY, JSON.stringify({ version: 2, state: { selectedKeys: [], yellowFilter: true, subscriptions: [{ url: 'https://s.invalid', enabled: false }] } }));
    await db.history.put(historyEntry(1, { id: 'custom_0_1', sourceKey: 'custom_0', title: 'newer', timestamp: Date.now() }));
    const result = await migrateLegacyBrowserData();
    expect(result.archivedHistory).toBe(2);
    expect(result.history).toBe(1);
    expect(await db.history.get('custom_0_1')).toMatchObject({ title: 'newer' });
    expect(JSON.parse(storage.getItem(PERSIST_KEY)!).state).toMatchObject({ selectedKeys: [], yellowFilter: true, subscriptions: [{ url: 'https://s.invalid', enabled: false }] });
    expect(JSON.parse((await db.legacyData.get('viewingHistory'))!.value)[1].extra).toBe('keep');
  });

  it('does not mark a malformed migration successful, and retries after repair', async () => {
    storage.setItem('viewingHistory', '{broken');
    await expect(migrateLegacyBrowserData()).rejects.toThrow('JSON');
    expect(await db.migrations.count()).toBe(0);
    expect(storage.getItem(PERSIST_KEY)).toBeNull();
    storage.setItem('viewingHistory', JSON.stringify([legacyHistory()]));
    await expect(migrateLegacyBrowserData()).resolves.toMatchObject({ status: 'migrated', history: 1 });
  });

  it('rolls back IndexedDB on a localStorage quota error and retries', async () => {
    storage.setItem('viewingHistory', JSON.stringify([legacyHistory()]));
    const write = vi.spyOn(storage, 'setItem').mockImplementationOnce(() => { throw new Error('quota'); });
    await expect(migrateLegacyBrowserData()).rejects.toThrow('quota');
    expect(await db.history.count()).toBe(0);
    expect(await db.progress.count()).toBe(0);
    expect(await db.legacyData.count()).toBe(0);
    expect(await db.migrations.count()).toBe(0);
    write.mockRestore();
    await expect(migrateLegacyBrowserData()).resolves.toMatchObject({ status: 'migrated' });
  });

  it('rolls back the settings write if writing the completion marker fails', async () => {
    storage.setItem(PERSIST_KEY, '{"version":2,"state":{"selectedKeys":[]}}');
    const previous = storage.getItem(PERSIST_KEY);
    vi.spyOn(db.migrations, 'put').mockRejectedValueOnce(new Error('IDB failure'));
    await expect(migrateLegacyBrowserData()).rejects.toThrow('IDB failure');
    expect(storage.getItem(PERSIST_KEY)).toBe(previous);
    expect(await db.legacyData.count()).toBe(0);
    expect(await db.migrations.count()).toBe(0);
  });

  it('coalesces concurrent startup calls and does not overwrite conflicting source URLs', async () => {
    const a = migrateLegacyBrowserData();
    const b = migrateLegacyBrowserData();
    expect(a).toBe(b);
    await a;
    expect(await db.migrations.get(LEGACY_MIGRATION_KEY)).toMatchObject({ version: LEGACY_MIGRATION_VERSION });
    await db.migrations.clear();
    storage.setItem('customAPIs', '[{"name":"old","url":"https://old.invalid"}]');
    storage.setItem(PERSIST_KEY, '{"version":2,"state":{"customAPIs":[{"key":"custom_0","name":"new","url":"https://new.invalid"}]}}');
    await expect(migrateLegacyBrowserData()).rejects.toThrow('冲突');
    expect(await db.migrations.count()).toBe(0);
  });
});

describe('history/progress/search retention', () => {
  it('never truncates imported history or searches on subsequent normal writes', async () => {
    await db.history.bulkPut(Array.from({ length: 150 }, (_, i) => historyEntry(i)));
    await db.searchHistory.bulkPut(Array.from({ length: 25 }, (_, i) => ({ text: `search${i}`, timestamp: i })));
    await upsertHistory(historyEntry(200));
    await addSearchHistory('new');
    expect(await db.history.count()).toBe(151);
    expect(await db.searchHistory.count()).toBe(26);
    expect(await db.history.get('lzi_0')).toBeDefined();
    expect(await db.searchHistory.get('search0')).toBeDefined();
  });

  it('resumes the same episode but never carries another episode position/duration', async () => {
    await db.history.put(historyEntry(1, { playbackPosition: 90 }));
    await upsertHistory(historyEntry(1, { playbackPosition: 0 }));
    expect((await db.history.get('lzi_1'))!.playbackPosition).toBe(90);
    await upsertHistory(historyEntry(1, { episodeIndex: 3, playbackPosition: 0, duration: 0 }));
    expect(await db.history.get('lzi_1')).toMatchObject({ playbackPosition: 0, duration: 0 });
    await saveProgress('lzi', '1', 2, 90, 300);
    await saveProgress('lzi', '1', 3, 5.5, 300);
    expect(await db.progress.count()).toBe(2);
  });

  it('clears history and progress atomically', async () => {
    await db.history.put(historyEntry());
    await saveProgress('lzi', '1', 2, 90, 300);
    vi.spyOn(db.progress, 'clear').mockRejectedValueOnce(new Error('cannot clear progress'));
    await expect(clearAllHistory()).rejects.toThrow();
    expect(await db.history.count()).toBe(1);
    expect(await db.progress.count()).toBe(1);
  });
});
