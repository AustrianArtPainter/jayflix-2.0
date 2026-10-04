import { db } from './db';
import {
  EXTERNAL_PREFERENCE_KEYS, historyProgress, LEGACY_MIGRATION_KEY, LEGACY_MIGRATION_VERSION,
  legacySettings, normalizeHistory, normalizeSearch, normalizeSettings,
  parseJson, readLegacyData, SETTINGS_VERSION, withBuiltinSources,
} from './legacy-data';
import { PERSIST_KEY, flushPendingPersist } from './persist-storage';
import type { SourceConfig } from './types';

export interface MigrationResult {
  status: 'migrated' | 'already-migrated' | 'unavailable';
  history: number;
  archivedHistory: number;
}

// StrictMode invokes effects twice; share in-flight work but retry failures.
let pending: Promise<MigrationResult> | undefined;

export function migrateLegacyBrowserData(): Promise<MigrationResult> {
  if (pending) return pending;
  pending = migrate().finally(() => { pending = undefined; });
  return pending;
}

async function migrate(): Promise<MigrationResult> {
  if (typeof localStorage === 'undefined') return { status: 'unavailable', history: 0, archivedHistory: 0 };
  const checkpoint = await db.migrations.get(LEGACY_MIGRATION_KEY);
  if (checkpoint && checkpoint.version >= LEGACY_MIGRATION_VERSION) {
    return { status: 'already-migrated', history: 0, archivedHistory: 0 };
  }
  if (checkpoint && checkpoint.version >= 1) {
    // v1 already migrated history/settings. Archive only the newly recognized
    // external preferences: replaying old history would resurrect deleted rows.
    const rows = EXTERNAL_PREFERENCE_KEYS.flatMap((key) => {
      const value = localStorage.getItem(key);
      return value === null ? [] : [{ key, value }];
    });
    await db.transaction('rw', [db.legacyData, db.migrations], async () => {
      if (((await db.migrations.get(LEGACY_MIGRATION_KEY))?.version ?? 0) >= LEGACY_MIGRATION_VERSION) return;
      for (const row of rows) if (!await db.legacyData.get(row.key)) await db.legacyData.put(row);
      await db.migrations.put({ key: LEGACY_MIGRATION_KEY, version: LEGACY_MIGRATION_VERSION, completedAt: Date.now() });
    });
    return { status: 'migrated', history: 0, archivedHistory: 0 };
  }
  // Must run before rehydrate. Flush only after the input has been validated.
  const data = readLegacyData(localStorage);
  const previous = localStorage.getItem(PERSIST_KEY);
  const oldSettings = legacySettings(data);
  const current = previous === null ? {} : normalizeSettings(previous).state;
  const oldSources = (oldSettings.customAPIs ?? []) as SourceConfig[];
  const currentSources = (current.customAPIs ?? []) as SourceConfig[];
  for (const source of oldSources) {
    const conflict = currentSources.find((v) => v.key === source.key && v.url !== source.url);
    if (conflict) throw new Error(`旧数据源 ${source.key} 与当前 URL 冲突，迁移未完成`);
  }
  const state = withBuiltinSources({
    ...oldSettings, ...current,
    customAPIs: [...oldSources.filter((v) => !currentSources.some((s) => s.key === v.key)), ...currentSources],
  });
  const sources = state.customAPIs as SourceConfig[];
  const rawHistory = data.viewingHistory === undefined ? [] : parseJson(data.viewingHistory, 'viewingHistory');
  const history = normalizeHistory(rawHistory, sources, true);
  const progress = historyProgress(history, data);
  const search = data.videoSearchHistory === undefined ? [] : normalizeSearch(parseJson(data.videoSearchHistory, 'videoSearchHistory'));
  flushPendingPersist();
  let wroteSettings = false;
  try {
    await db.transaction('rw', [db.history, db.progress, db.searchHistory, db.legacyData, db.migrations], async () => {
      // Check again under a write transaction, covering simultaneous tabs.
      if (((await db.migrations.get(LEGACY_MIGRATION_KEY))?.version ?? 0) >= LEGACY_MIGRATION_VERSION) return;
      for (const row of history) {
        const existing = await db.history.get(row.id);
        if (!existing || existing.timestamp < row.timestamp) await db.history.put({ ...existing, ...row });
      }
      for (const row of progress) {
        const existing = await db.progress.get(row.key);
        if (!existing || existing.updatedAt < row.updatedAt) await db.progress.put(row);
      }
      for (const row of search) {
        const existing = await db.searchHistory.get(row.text);
        if (!existing || existing.timestamp < row.timestamp) await db.searchHistory.put(row);
      }
      await db.legacyData.bulkPut(Object.entries(data).map(([key, value]) => ({ key, value })));
      // Synchronous storage writes inside the IDB transaction: quota errors abort
      // all database writes, including the success checkpoint.
      localStorage.setItem(PERSIST_KEY, JSON.stringify({ state, version: SETTINGS_VERSION }));
      wroteSettings = true;
      await db.migrations.put({ key: LEGACY_MIGRATION_KEY, version: LEGACY_MIGRATION_VERSION, completedAt: Date.now() });
    });
  } catch (error) {
    if (wroteSettings) {
      if (previous === null) localStorage.removeItem(PERSIST_KEY);
      else localStorage.setItem(PERSIST_KEY, previous);
    }
    throw error;
  }
  return { status: 'migrated', history: history.length, archivedHistory: Array.isArray(rawHistory) ? rawHistory.length : 0 };
}
