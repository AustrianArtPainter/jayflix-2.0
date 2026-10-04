import { db, type DownloadTaskEntry } from './db';
import {
  array, BACKUP_VERSION, BUILTIN_SOURCES, finite, historyProgress, LEGACY_KEYS,
  LEGACY_MIGRATION_KEY, LEGACY_MIGRATION_VERSION, legacySettings,
  normalizeHistory, normalizeProgress, normalizeSearch, normalizeSettings,
  ORBIT_KEY, PALETTE_KEY, parseJson, readLegacyData, record,
  SETTINGS_VERSION, string, strings, USER_TAG_KEYS, withBuiltinSources,
} from './legacy-data';
import { PERSIST_KEY, flushPendingPersist } from './persist-storage';
import type { SettingsBackup, SourceConfig } from './types';
import type { LiveProbeEntry } from './store';
import { loadTheme, THEME_STORAGE_KEY } from './ui-palette';
import { normalizeCacheSettings, VIDEO_CACHE_SETTINGS_KEY } from './video-cache-settings';

function isArchiveKey(key: string): boolean {
  return (LEGACY_KEYS as readonly string[]).includes(key) || key.startsWith('videoProgress_');
}

function stringMap(value: unknown, label: string): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value, label)).map(([key, value]) => [key, string(value, `${label}.${key}`)]));
}

function parseBackup(content: string): SettingsBackup {
  const input = record(parseJson(content, '配置文件'), '配置文件');
  if (!['JAYFLIX-Settings', 'JAY-TV-Settings', 'LibreTV-Settings'].includes(string(input.name, '配置名称'))) throw new Error('配置文件格式不正确');
  if (input.cfgVer !== undefined && !['1.0.0', '2.0.0', BACKUP_VERSION].includes(string(input.cfgVer, 'cfgVer'))) throw new Error('不支持的配置文件版本');
  if (input.hash !== undefined && !/^[a-f0-9]{64}$/i.test(string(input.hash, 'hash'))) throw new Error('配置文件哈希无效');
  return { name: input.name as SettingsBackup['name'], cfgVer: input.cfgVer as string | undefined, hash: input.hash as string | undefined, data: stringMap(input.data, '配置 data') };
}

/** Shared UI preview gate: the actual import performs full validation and hash verification. */
export function summarizeSettingsBackup(content: string): string {
  const { data } = parseBackup(content);
  const state = data[PERSIST_KEY] === undefined ? legacySettings(data) : normalizeSettings(data[PERSIST_KEY]).state;
  const parts: string[] = [];
  for (const [key, label] of [['customAPIs', '个点播源'], ['liveSubscriptions', '个直播源'], ['subscriptions', '个订阅']]) {
    if (state[key] !== undefined) parts.push(`${array(state[key], key).length} ${label}`);
  }
  if (data.viewingHistory !== undefined) parts.push(`${array(parseJson(data.viewingHistory, 'viewingHistory'), 'viewingHistory').length} 条观看历史`);
  if (data.videoSearchHistory !== undefined) parts.push(`${array(parseJson(data.videoSearchHistory, 'videoSearchHistory'), 'videoSearchHistory').length} 条搜索历史`);
  const archive = data.legacyData === undefined ? {} : stringMap(parseJson(data.legacyData, 'legacyData'), 'legacyData');
  for (const [key, label] of [['userMovieTags', '个电影标签'], ['userTvTags', '个剧集标签']]) {
    const value = data[key] ?? archive[key];
    if (value !== undefined) parts.push(`${validateUserTags(value, key).length} ${label}`);
  }
  if (data[VIDEO_CACHE_SETTINGS_KEY] !== undefined || archive[VIDEO_CACHE_SETTINGS_KEY] !== undefined) parts.push('视频缓存偏好');
  if (data[THEME_STORAGE_KEY] !== undefined || archive[THEME_STORAGE_KEY] !== undefined) parts.push('主题设置');
  return parts.length ? `该文件包含 ${parts.join('、')}` : '该文件未包含可导入的数据';
}

async function digest(data: Record<string, string>): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(data)));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeDownloads(value: unknown): DownloadTaskEntry[] {
  return array(value, 'downloads').map((v) => {
    const row = record(v, '下载任务');
    const id = string(row.id, '下载 id');
    const taskUrl = string(row.url, '下载 URL');
    if (!id || !['TS', 'MP4'].includes(string(row.format, '下载 format')) || !['waiting', 'downloading', 'paused', 'completed', 'error'].includes(string(row.status, '下载 status'))) throw new Error('下载任务格式无效');
    return {
      ...row, id, url: taskUrl, title: string(row.title, '下载 title'),
      format: row.format as DownloadTaskEntry['format'], status: row.status as DownloadTaskEntry['status'],
      finished: finite(row.finished, 'finished'), total: finite(row.total, 'total'), errorNum: finite(row.errorNum, 'errorNum'),
      createdAt: finite(row.createdAt, 'createdAt'), updatedAt: finite(row.updatedAt, 'updatedAt'),
    };
  });
}

function validateUi(raw: string, key: string): void {
  const value = record(parseJson(raw, key), key);
  if (value.version !== 1) throw new Error(`${key} 版本无效`);
  // The owning palette/orbit modules normalize their values. Keep exact bytes.
}

function validateUserTags(raw: string, key: string): string[] {
  // Preserve order, duplicates, Unicode, whitespace and empty lists exactly.
  // The tag manager owns presentation rules; backup never truncates its data.
  return strings(parseJson(raw, key), key);
}

function normalizeCachePreference(raw: string): string {
  // Damaged JSON has the same defaults as runtime cache settings. The original
  // value remains in legacyData; never restore it as live NaN/string preferences.
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
  return JSON.stringify(normalizeCacheSettings(parsed));
}

function normalizeThemePreference(raw: string): string {
  return loadTheme({ getItem: () => raw });
}

export async function exportSettingsBackup(): Promise<string> {
  flushPendingPersist();
  const data = await db.transaction('r', [db.history, db.progress, db.searchHistory, db.liveProbe, db.downloads, db.legacyData], async () => ({
    viewingHistory: JSON.stringify(await db.history.toArray()),
    progress: JSON.stringify(await db.progress.toArray()),
    videoSearchHistory: JSON.stringify(await db.searchHistory.toArray()),
    liveProbeResults: JSON.stringify(Object.fromEntries((await db.liveProbe.toArray()).map(({ url, ...entry }) => [url, entry]))),
    downloads: JSON.stringify(await db.downloads.toArray()),
    legacyData: JSON.stringify(Object.fromEntries((await db.legacyData.toArray()).filter((e) => isArchiveKey(e.key)).map((e) => [e.key, e.value]))),
  })) as Record<string, string>;
  // Include old, not-yet-mapped progress and fields even if migration is pending.
  const latestLegacy = readLegacyData(localStorage);
  const legacyData = { ...stringMap(parseJson(data.legacyData, 'legacyData'), 'legacyData'), ...latestLegacy };
  // These remain live localStorage preferences in the new tag manager. Read
  // them on every export, rather than restoring a one-time migration snapshot.
  for (const key of USER_TAG_KEYS) {
    const value = latestLegacy[key];
    if (value !== undefined) { validateUserTags(value, key); data[key] = value; }
  }
  const cache = latestLegacy[VIDEO_CACHE_SETTINGS_KEY];
  if (cache !== undefined) legacyData[VIDEO_CACHE_SETTINGS_KEY] = data[VIDEO_CACHE_SETTINGS_KEY] = normalizeCachePreference(cache);
  const theme = latestLegacy[THEME_STORAGE_KEY];
  if (theme !== undefined) legacyData[THEME_STORAGE_KEY] = data[THEME_STORAGE_KEY] = normalizeThemePreference(theme);
  // IDB enumerates by key; canonical ordering and normalized live preferences
  // keep export → restore → export stable. Migration still archives raw bytes.
  data.legacyData = JSON.stringify(Object.fromEntries(Object.keys(legacyData).sort().map((key) => [key, legacyData[key]])));
  const settings = localStorage.getItem(PERSIST_KEY);
  if (settings !== null) data[PERSIST_KEY] = JSON.stringify(normalizeSettings(settings));
  for (const key of [PALETTE_KEY, ORBIT_KEY]) {
    const value = localStorage.getItem(key);
    if (value !== null) { validateUi(value, key); data[key] = value; }
  }
  return JSON.stringify({ name: 'LibreTV-Settings', time: String(Date.now()), cfgVer: BACKUP_VERSION, data, hash: await digest(data) });
}

export async function importSettingsBackup(content: string): Promise<void> {
  const config = parseBackup(content);
  if (config.hash !== undefined && (await digest(config.data)) !== config.hash.toLowerCase()) throw new Error('配置文件哈希值不匹配');
  const data = config.data;
  // Validate every section before flushing settings or touching either storage.
  const importedLegacy = legacySettings(data);
  const settings = data[PERSIST_KEY] === undefined ? importedLegacy : { ...importedLegacy, ...normalizeSettings(data[PERSIST_KEY]).state };
  const hasSettings = Object.keys(settings).length > 0 || data[PERSIST_KEY] !== undefined;
  const currentRaw = localStorage.getItem(PERSIST_KEY);
  const current = currentRaw === null ? {} : normalizeSettings(currentRaw).state;
  // Modern snapshots are restored exactly, including intentional source deletion.
  const state = data[PERSIST_KEY] === undefined && hasSettings ? withBuiltinSources(settings) : hasSettings ? settings : current;
  const sources = (state.customAPIs ?? BUILTIN_SOURCES) as SourceConfig[];
  const history = data.viewingHistory === undefined ? [] : normalizeHistory(parseJson(data.viewingHistory, 'viewingHistory'), config.cfgVer === BACKUP_VERSION ? [] : sources, config.cfgVer !== BACKUP_VERSION);
  const progress = [
    ...(config.cfgVer === BACKUP_VERSION ? [] : historyProgress(history, data)),
    ...(data.progress === undefined ? [] : normalizeProgress(parseJson(data.progress, 'progress'))),
  ];
  const search = data.videoSearchHistory === undefined ? [] : normalizeSearch(parseJson(data.videoSearchHistory, 'videoSearchHistory'));
  const downloads = data.downloads === undefined ? [] : normalizeDownloads(parseJson(data.downloads, 'downloads'));
  const liveProbeResults = data.liveProbeResults === undefined
    ? (settings.liveProbeResults ?? {})
    : normalizeSettings(JSON.stringify({ state: { liveProbeResults: parseJson(data.liveProbeResults, 'liveProbeResults') }, version: SETTINGS_VERSION })).state.liveProbeResults;
  const probeRows = Object.entries(record(liveProbeResults, 'liveProbeResults')).map(([url, value]) => ({ ...record(value, '测活结果') as unknown as LiveProbeEntry, url }));
  const archive = data.legacyData === undefined ? {} : stringMap(parseJson(data.legacyData, 'legacyData'), 'legacyData');
  for (const key of Object.keys(archive)) if (!isArchiveKey(key)) throw new Error(`legacyData 不支持键 ${key}`);
  for (const [key, value] of Object.entries(data)) {
    if (isArchiveKey(key) && !(config.cfgVer === BACKUP_VERSION && ['viewingHistory', 'videoSearchHistory'].includes(key))) archive[key] = value;
  }
  const storageWrites = new Map<string, string>();
  if (hasSettings) storageWrites.set(PERSIST_KEY, JSON.stringify({ state, version: SETTINGS_VERSION }));
  for (const key of USER_TAG_KEYS) {
    // v1/v2 and new v3 put tags at the top level. Earlier v3 backups kept them
    // only in legacyData, so restore those too, with explicit current values
    // (including []) taking precedence over the archived snapshot.
    const value = data[key] ?? archive[key];
    if (value !== undefined) { validateUserTags(value, key); storageWrites.set(key, value); }
  }
  const cache = data[VIDEO_CACHE_SETTINGS_KEY] ?? archive[VIDEO_CACHE_SETTINGS_KEY];
  if (cache !== undefined) storageWrites.set(VIDEO_CACHE_SETTINGS_KEY, normalizeCachePreference(cache));
  const theme = data[THEME_STORAGE_KEY] ?? archive[THEME_STORAGE_KEY];
  if (theme !== undefined) storageWrites.set(THEME_STORAGE_KEY, normalizeThemePreference(theme));
  for (const key of [PALETTE_KEY, ORBIT_KEY]) {
    if (data[key] !== undefined) { validateUi(data[key], key); storageWrites.set(key, data[key]); }
  }
  flushPendingPersist();
  const previous = new Map(Array.from(storageWrites.keys(), (key) => [key, localStorage.getItem(key)]));
  const written: string[] = [];
  try {
    await db.transaction('rw', [db.history, db.progress, db.searchHistory, db.liveProbe, db.downloads, db.legacyData, db.migrations], async () => {
      // Import merges by stable identities and timestamps; never slice to UI limits.
      for (const row of history) {
        const existing = await db.history.get(row.id);
        if (!existing || existing.timestamp <= row.timestamp) await db.history.put({ ...existing, ...row });
      }
      for (const row of progress) {
        const existing = await db.progress.get(row.key);
        if (!existing || existing.updatedAt <= row.updatedAt) await db.progress.put(row);
      }
      for (const row of search) {
        const existing = await db.searchHistory.get(row.text);
        if (!existing || existing.timestamp <= row.timestamp) await db.searchHistory.put(row);
      }
      if (probeRows.length) await db.liveProbe.bulkPut(probeRows);
      if (downloads.length) await db.downloads.bulkPut(downloads);
      if (Object.keys(archive).length) await db.legacyData.bulkPut(Object.entries(archive).map(([key, value]) => ({ key, value })));
      for (const [key, value] of storageWrites) { localStorage.setItem(key, value); written.push(key); }
      // A restore is already explicit migration. Prevent stale legacy browser
      // records being reintroduced on the following page reload.
      await db.migrations.put({ key: LEGACY_MIGRATION_KEY, version: LEGACY_MIGRATION_VERSION, completedAt: Date.now() });
    });
  } catch (error) {
    for (const key of written.reverse()) {
      const value = previous.get(key);
      if (value === null || value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
    throw error;
  }
}
