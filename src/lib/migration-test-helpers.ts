import type { HistoryEntry } from './db';

/** Full Storage interface; tests can inject quota/access failures selectively. */
export class MemoryStorage implements Storage {
  private entries = new Map<string, string>();
  get length() { return this.entries.size; }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, value); }
  removeItem(key: string) { this.entries.delete(key); }
  key(index: number) { return Array.from(this.entries.keys())[index] ?? null; }
  clear() { this.entries.clear(); }
}

export function historyEntry(i = 1, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `lzi_${i}`, sourceKey: 'lzi', vodId: String(i), title: `标题 ${i}`,
    sourceUrl: 'https://cj.lziapi.com/api.php/provide/vod/from/lzm3u8/',
    pic: `https://images.invalid/${i}.jpg`, episodeIndex: 2, totalEpisodes: 10,
    playbackPosition: 6.25, duration: 300.5, timestamp: 1_700_000_000_000 + i,
    ...overrides,
  };
}

export function legacyHistory(i = 1) {
  return {
    title: `旧标题 ${i}`, sourceCode: 'custom_0', sourceName: 'custom_0', vod_id: String(i),
    url: `player.html?source_code=custom_0&id=${i}&index=1`,
    directVideoUrl: `https://stream.invalid/${i}/2.m3u8`,
    episodes: [`https://stream.invalid/${i}/1.m3u8`, `https://stream.invalid/${i}/2.m3u8`],
    episodeIndex: 1, playbackPosition: 5.5, duration: 200.25, timestamp: 1_650_000_000_000 + i,
    showIdentifier: `custom_0_${i}`, customLegacyField: 'keep me',
  };
}
