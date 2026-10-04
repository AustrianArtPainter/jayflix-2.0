import type { HistoryEntry, ProgressEntry, SearchHistoryEntry } from './db';
import type { SourceConfig } from './types';
import { PERSIST_KEY } from './persist-storage';
import { THEME_STORAGE_KEY } from './ui-palette';
import { VIDEO_CACHE_SETTINGS_KEY } from './video-cache-settings';

export const SETTINGS_VERSION = 2;
export const BACKUP_VERSION = '3.0.0';
export const LEGACY_MIGRATION_VERSION = 2;
export const LEGACY_MIGRATION_KEY = 'jayflix-browser-legacy';
export const PALETTE_KEY = 'jayflix.ui.palette.v1';
export const ORBIT_KEY = 'jayflix.orbit.preferences.v1';
export const USER_TAG_KEYS = ['userMovieTags', 'userTvTags'] as const;
export const EXTERNAL_PREFERENCE_KEYS = [VIDEO_CACHE_SETTINGS_KEY, THEME_STORAGE_KEY] as const;
export const LEGACY_KEYS = [
  'selectedAPIs', 'customAPIs', 'yellowFilterEnabled', 'adFilteringEnabled',
  'doubanEnabled', 'autoplayEnabled', 'episodesReversed', 'hasInitializedDefaults',
  'viewingHistory', 'videoSearchHistory', ...USER_TAG_KEYS, ...EXTERNAL_PREFERENCE_KEYS,
] as const;

/** Copied exactly from js/config.js; deliberately excludes testSource. */
export const BUILTIN_SOURCES: readonly SourceConfig[] = [
  { key: 'dyttzy', name: '电影天堂资源', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod/from/dyttm3u8' },
  { key: 'ruyi', name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod' },
  { key: 'bfzy', name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod' },
  { key: 'ffzy', name: '非凡影视', url: 'http://ffzy5.tv/api.php/provide/vod/from/ffm3u8' },
  { key: 'zy360', name: '360资源', url: 'https://360zy.com/api.php/provide/vod' },
  { key: 'iqiyi', name: 'iqiyi资源', url: 'https://www.iqiyizyapi.com/api.php/provide/vod' },
  { key: 'jisu', name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod/from/jsm3u8' },
  { key: 'mdzy', name: '魔都资源', url: 'https://www.mdzyapi.com/api.php/provide/vod' },
  { key: 'zuid', name: '最大资源', url: 'https://api.zuidapi.com/api.php/provide/vod' },
  { key: 'baidu', name: '百度云资源', url: 'https://api.apibdzy.com/api.php/provide/vod' },
  { key: 'wujin', name: '无尽资源', url: 'https://api.wujinapi.com/api.php/provide/vod' },
  { key: 'ikun', name: 'iKun资源', url: 'https://ikunzyapi.com/api.php/provide/vod' },
  { key: 'lzi', name: '量子资源站', url: 'https://cj.lziapi.com/api.php/provide/vod/from/lzm3u8/' },
];
export const DEFAULT_SELECTED_KEYS = ['lzi', 'bfzy', 'dyttzy', 'ruyi'];

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

export function parseJson(value: string, label: string): unknown {
  try { return JSON.parse(value); } catch { throw new Error(`${label} 不是有效 JSON`); }
}

export function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
  return value;
}

export function finite(value: unknown, label: string, fallback = 0): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`${label} 必须是非负有限数值`);
  return value;
}

function index(value: unknown, label: string): number {
  const number = finite(value, label);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} 必须是整数`);
  return number;
}

export function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} 必须是字符串`);
  return value;
}

export function strings(value: unknown, label: string): string[] {
  return array(value, label).map((v) => string(v, label));
}

function url(value: unknown, label: string): string {
  const text = string(value, label);
  try {
    if (!['http:', 'https:'].includes(new URL(text).protocol)) throw new Error();
  } catch { throw new Error(`${label} 必须是 http(s) URL`); }
  return text;
}

export function normalizeSources(value: unknown, legacy = false): SourceConfig[] {
  const result = array(value, 'customAPIs').map((v, i) => {
    const item = record(v, '数据源');
    const key = item.key === undefined && legacy ? `custom_${i}` : string(item.key, '数据源 key');
    if (!key || ['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('数据源 key 无效');
    const source: SourceConfig = { key, name: string(item.name, '数据源 name'), url: url(item.url ?? item.api, '数据源 URL') };
    if (item.detail) source.detail = url(item.detail, '数据源 detail');
    const adult = item.isAdult ?? item.adult;
    if (adult !== undefined) {
      if (typeof adult !== 'boolean') throw new Error('数据源 isAdult 必须是布尔值');
      source.isAdult = adult;
    }
    return source;
  });
  if (new Set(result.map((s) => s.key)).size !== result.length) throw new Error('存在重复的数据源 key');
  return result;
}

const booleanSettings = ['yellowFilter', 'adFilter', 'doubanEnabled', 'recommendSourceTouched', 'autoplayNext', 'imageProxyModeTouched'];
const listSettings = ['selectedKeys', 'envKeysSeen', 'liveEnvKeysSeen', 'liveSelectedUrls', 'liveFavorites', 'envSubsSeen'];
const objectLists = ['subscriptions', 'liveSubscriptions', 'liveRecent'];
const mapSettings = ['sourceHealth', 'liveProbeResults'];

/** Only data fields can enter Zustand: never hydrate action names or auth tokens. */
export function normalizeSettings(raw: string): { state: Record<string, unknown>; version: number } {
  const envelope = record(parseJson(raw, PERSIST_KEY), PERSIST_KEY);
  const version = envelope.version === undefined ? 0 : index(envelope.version, '设置版本');
  if (version > SETTINGS_VERSION) throw new Error('设置版本比当前应用更新');
  const input = record(envelope.state, '设置 state');
  const state: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    const value = input[key];
    if (booleanSettings.includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} 必须是布尔值`);
      state[key] = value;
    } else if (listSettings.includes(key)) state[key] = strings(value, key);
    else if (key === 'customAPIs') state[key] = normalizeSources(value);
    else if (key === 'recommendSource') {
      if (!['douban', 'bangumi', 'hot-list'].includes(string(value, key))) throw new Error('推荐源无效');
      state[key] = value;
    } else if (key === 'imageProxyMode') {
      if (!['direct', 'proxy', 'custom'].includes(string(value, key))) throw new Error('图片模式无效');
      state[key] = value;
    } else if (key === 'customImageProxy') state[key] = string(value, key);
    else if (objectLists.includes(key)) {
      state[key] = array(value, key).map((v) => {
        const row = { ...record(v, key) };
        row.url = url(row.url, key);
        for (const text of ['name', 'epg', 'logo', 'group', 'tvgId', 'sourceUrl', 'lastError']) {
          if (row[text] !== undefined) string(row[text], `${key}.${text}`);
        }
        for (const time of ['timestamp', 'lastSync']) if (row[time] !== undefined) finite(row[time], `${key}.${time}`);
        if (key === 'liveRecent') {
          string(row.name, '频道 name');
          row.timestamp = finite(row.timestamp, '频道 timestamp');
        }
        if (key === 'liveSubscriptions') {
          row.fromSubscriptions = row.fromSubscriptions === undefined
            ? (typeof row.fromSubscription === 'string' && row.fromSubscription ? [row.fromSubscription] : [])
            : strings(row.fromSubscriptions, 'fromSubscriptions');
          delete row.fromSubscription;
        }
        if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw new Error('订阅 enabled 无效');
        if (row.lastStatus !== undefined && !['ok', 'error'].includes(string(row.lastStatus, 'lastStatus'))) throw new Error('订阅 lastStatus 无效');
        if (row.lastCounts !== undefined) {
          const counts = record(row.lastCounts, 'lastCounts');
          index(counts.vod, 'vod'); index(counts.live, 'live');
        }
        return row;
      });
    } else if (mapSettings.includes(key)) {
      state[key] = Object.fromEntries(Object.entries(record(value, key)).map(([id, v]) => {
        if (['__proto__', 'prototype', 'constructor'].includes(id)) throw new Error('缓存 key 无效');
        const row = record(v, key);
        if (typeof row.ok !== 'boolean') throw new Error(`${key}.ok 无效`);
        finite(row.timestamp, `${key}.timestamp`);
        for (const n of ['ms', 'kbps', 'failStreak', 'disableCount', 'disabledUntil']) if (row[n] !== undefined) finite(row[n], `${key}.${n}`);
        for (const b of ['timedOut', 'permanent']) if (row[b] !== undefined && typeof row[b] !== 'boolean') throw new Error(`${key}.${b} 无效`);
        if (key === 'sourceHealth') index(row.failStreak, 'failStreak');
        return [id, row];
      }));
    }
  }
  return { state, version: SETTINGS_VERSION };
}

export function legacySettings(data: Record<string, string>): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (data.customAPIs !== undefined) state.customAPIs = normalizeSources(parseJson(data.customAPIs, 'customAPIs'), true);
  if (data.selectedAPIs !== undefined) state.selectedKeys = strings(parseJson(data.selectedAPIs, 'selectedAPIs'), 'selectedAPIs');
  for (const [old, current] of [['yellowFilterEnabled', 'yellowFilter'], ['adFilteringEnabled', 'adFilter'], ['doubanEnabled', 'doubanEnabled'], ['autoplayEnabled', 'autoplayNext']]) {
    if (data[old] !== undefined) {
      if (!['true', 'false'].includes(data[old])) throw new Error(`${old} 必须是布尔值`);
      state[current] = data[old] === 'true';
    }
  }
  return state;
}

export function withBuiltinSources(state: Record<string, unknown>): Record<string, unknown> {
  const sources = (state.customAPIs ?? []) as SourceConfig[];
  return {
    ...state,
    customAPIs: [...BUILTIN_SOURCES.filter((s) => !sources.some((v) => v.key === s.key)), ...sources],
    selectedKeys: state.selectedKeys ?? [...DEFAULT_SELECTED_KEYS],
  };
}

function identifier(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** Keep the legacy fields on migrated rows for a lossless export, including episodes. */
export function normalizeHistory(value: unknown, sources: SourceConfig[], allowUnmapped = false): HistoryEntry[] {
  return array(value, 'viewingHistory').flatMap((v) => {
    const item = record(v, '历史记录');
    let params = new URLSearchParams();
    if (typeof item.url === 'string') {
      try { params = new URL(item.url, 'https://jayflix.invalid').searchParams; } catch { /* retained in raw archive */ }
    }
    const source = identifier(item.sourceKey || item.sourceCode || params.get('source_code') || item.sourceName || params.get('source'));
    const sourceKey = sources.find((s) => s.name === source)?.key ?? source;
    const vodId = identifier(item.vodId ?? item.vod_id ?? params.get('id'));
    if (!sourceKey || !vodId) {
      if (allowUnmapped) return [];
      throw new Error('历史记录缺少 sourceKey/sourceCode 或 vodId/vod_id');
    }
    const episodeIndex = index(item.episodeIndex, 'episodeIndex');
    const totalEpisodes = item.totalEpisodes === undefined && Array.isArray(item.episodes)
      ? item.episodes.length : index(item.totalEpisodes, 'totalEpisodes');
    const sourceUrl = item.sourceUrl ?? item.apiUrl ?? item.api_url ?? sources.find((s) => s.key === sourceKey)?.url;
    return [{
      ...item,
      id: `${sourceKey}_${vodId}`, sourceKey, vodId,
      title: item.title === undefined ? '未知视频' : string(item.title, 'title'),
      ...(sourceUrl ? { sourceUrl: url(sourceUrl, '历史来源 URL') } : {}),
      ...(item.pic !== undefined ? { pic: string(item.pic, 'pic') } : {}),
      episodeIndex, totalEpisodes,
      playbackPosition: finite(item.playbackPosition, 'playbackPosition'),
      duration: finite(item.duration, 'duration'), timestamp: finite(item.timestamp, 'timestamp'),
    }];
  });
}

export function normalizeSearch(value: unknown): SearchHistoryEntry[] {
  return array(value, 'videoSearchHistory').map((v) => {
    const item = typeof v === 'string' ? { text: v, timestamp: 0 } : record(v, '搜索记录');
    const text = string(item.text, '搜索 text');
    if (!text) throw new Error('搜索 text 不能为空');
    return { ...item, text, timestamp: finite(item.timestamp, '搜索 timestamp') };
  });
}

export function normalizeProgress(value: unknown): ProgressEntry[] {
  return array(value, 'progress').map((v) => {
    const item = record(v, '播放进度');
    const key = string(item.key, '进度 key');
    if (!key) throw new Error('进度 key 不能为空');
    return { ...item, key, position: finite(item.position, 'position'), duration: finite(item.duration, 'duration'), updatedAt: finite(item.updatedAt, 'updatedAt') };
  });
}

export function historyProgress(history: HistoryEntry[], data: Record<string, string>): ProgressEntry[] {
  const rows: ProgressEntry[] = [];
  for (const entry of history) {
    const legacy = entry as HistoryEntry & { episodes?: unknown; directVideoUrl?: unknown };
    const episodes = Array.isArray(legacy.episodes) ? legacy.episodes : [];
    const targets = episodes.map((episode, i) => ({ episode, i }));
    if (!targets.length) targets.push({ episode: legacy.directVideoUrl, i: entry.episodeIndex });
    for (const { episode, i } of targets) {
      const candidates = [
        ...(typeof episode === 'string' ? [`videoProgress_${encodeURIComponent(episode)}`] : []),
        `videoProgress_${encodeURIComponent(entry.title)}_${i}`,
      ];
      const raw = candidates.map((key) => data[key]).find((v) => v !== undefined);
      const progress = raw === undefined ? undefined : record(parseJson(raw, '旧播放进度'), '旧播放进度');
      if (!progress && i !== entry.episodeIndex) continue;
      const row = {
        key: `${entry.sourceKey}_${entry.vodId}_${i}`,
        position: progress ? finite(progress.position, 'position') : entry.playbackPosition,
        duration: progress ? finite(progress.duration, 'duration') : entry.duration,
        updatedAt: progress ? finite(progress.timestamp, 'timestamp') : entry.timestamp,
      };
      if (progress || row.position > 0 || row.duration > 0) rows.push(row);
    }
    if (!targets.some((v) => v.i === entry.episodeIndex) && (entry.playbackPosition || entry.duration)) {
      rows.push({ key: `${entry.sourceKey}_${entry.vodId}_${entry.episodeIndex}`, position: entry.playbackPosition, duration: entry.duration, updatedAt: entry.timestamp });
    }
  }
  return rows;
}

/** Explicit allowlist: do not even read passwordVerified/adminPasswordVerified. */
export function readLegacyData(storage: Pick<Storage, 'getItem' | 'key' | 'length'>): Record<string, string> {
  const data: Record<string, string> = {};
  for (const key of LEGACY_KEYS) {
    const value = storage.getItem(key);
    if (value !== null) data[key] = value;
  }
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key?.startsWith('videoProgress_')) continue;
    const value = storage.getItem(key);
    if (value !== null) data[key] = value;
  }
  return data;
}
