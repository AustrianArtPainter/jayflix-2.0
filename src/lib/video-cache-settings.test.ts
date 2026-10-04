import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CACHE_SETTINGS, normalizeCacheSettings, VIDEO_CACHE_SETTINGS_KEY } from './video-cache-settings';
import { loadCacheSettings, saveCacheSettings } from './video-cache';
import { MemoryStorage } from './migration-test-helpers';

afterEach(() => { vi.unstubAllGlobals(); });

describe('cache preference normalization', () => {
  it.each([undefined, null, true, false, 42, 'false', [], [0], { enabled: 'false', horizonSeconds: '0', maxBytesPerEpisode: '100000000', maxTotalBytes: '200000000' }])('rejects string coercion and invalid container shapes: %j', (value) => {
    expect(normalizeCacheSettings(value)).toEqual(DEFAULT_CACHE_SETTINGS);
  });

  it.each([NaN, Infinity, -Infinity, 'NaN', 'Infinity', '123', null, undefined, {}, [], true])('never propagates invalid numeric values: %j', (value) => {
    const settings = normalizeCacheSettings({ horizonSeconds: value, maxBytesPerEpisode: value, maxTotalBytes: value });
    expect(settings).toEqual(DEFAULT_CACHE_SETTINGS);
    for (const field of ['horizonSeconds', 'maxBytesPerEpisode', 'maxTotalBytes'] as const) {
      expect(typeof settings[field]).toBe('number');
      expect(Number.isFinite(settings[field])).toBe(true);
    }
  });

  it('preserves valid settings, including disabled caching and unlimited horizon', () => {
    const valid = { enabled: false, horizonSeconds: 0, maxBytesPerEpisode: 200 * 1024 * 1024, maxTotalBytes: 600 * 1024 * 1024 };
    expect(normalizeCacheSettings(valid)).toEqual(valid);
    expect(normalizeCacheSettings({ ...valid, horizonSeconds: 120.5 }).horizonSeconds).toBe(120.5);
  });

  it('clamps finite out-of-range numbers while keeping runtime limits unchanged', () => {
    expect(normalizeCacheSettings({ horizonSeconds: -1, maxBytesPerEpisode: -1, maxTotalBytes: -1 })).toMatchObject({ horizonSeconds: 60, maxBytesPerEpisode: 50 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 });
    expect(normalizeCacheSettings({ horizonSeconds: 1e100, maxBytesPerEpisode: 1e100, maxTotalBytes: 1e100 })).toMatchObject({ horizonSeconds: 7200, maxBytesPerEpisode: 8 * 1024 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 * 1024 });
  });

  it('runtime loads and saves use the same safe normalization as backups', () => {
    const storage = new MemoryStorage(); vi.stubGlobal('localStorage', storage);
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, '{"enabled":"false","horizonSeconds":"invalid","maxTotalBytes":1e9999}');
    expect(loadCacheSettings()).toEqual(DEFAULT_CACHE_SETTINGS);
    expect(saveCacheSettings({ enabled: false, horizonSeconds: NaN, maxBytesPerEpisode: Infinity })).toEqual({ ...DEFAULT_CACHE_SETTINGS, enabled: false });
    expect(JSON.parse(storage.getItem(VIDEO_CACHE_SETTINGS_KEY)!)).toEqual({ ...DEFAULT_CACHE_SETTINGS, enabled: false });
    storage.setItem(VIDEO_CACHE_SETTINGS_KEY, '{broken');
    expect(loadCacheSettings()).toEqual(DEFAULT_CACHE_SETTINGS);
  });
});
