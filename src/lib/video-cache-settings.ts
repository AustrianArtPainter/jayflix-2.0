/** Shared by the runtime cache and backups; no IndexedDB/browser side effects. */
export const VIDEO_CACHE_SETTINGS_KEY = 'libretv-video-cache-settings';

export interface CacheSettings {
  enabled: boolean;
  /** 0 prefetches to the end; otherwise the forward window is 60–7200 seconds. */
  horizonSeconds: number;
  maxBytesPerEpisode: number;
  maxTotalBytes: number;
}

export const DEFAULT_CACHE_SETTINGS: CacheSettings = {
  enabled: true,
  horizonSeconds: 300,
  maxBytesPerEpisode: 800 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
};

function finiteNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, min), max) : fallback;
}

export function normalizeCacheSettings(input: unknown): CacheSettings {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_CACHE_SETTINGS.enabled,
    horizonSeconds: raw.horizonSeconds === 0 ? 0 : finiteNumber(raw.horizonSeconds, DEFAULT_CACHE_SETTINGS.horizonSeconds, 60, 7200),
    maxBytesPerEpisode: finiteNumber(raw.maxBytesPerEpisode, DEFAULT_CACHE_SETTINGS.maxBytesPerEpisode, 50 * 1024 * 1024, 8 * 1024 * 1024 * 1024),
    maxTotalBytes: finiteNumber(raw.maxTotalBytes, DEFAULT_CACHE_SETTINGS.maxTotalBytes, 100 * 1024 * 1024, 20 * 1024 * 1024 * 1024),
  };
}
