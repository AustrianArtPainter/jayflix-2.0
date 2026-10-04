import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCloudflareContext } from '@opennextjs/cloudflare';

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: vi.fn() }));
const MIB = 1024 * 1024;

beforeEach(() => {
  vi.resetModules();
  vi.mocked(getCloudflareContext).mockImplementation(() => { throw new Error('Node context'); });
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('bounded live metadata cache', () => {
  it('skips an oversized item even when the cache is empty', async () => {
    const cache = await import('./live-cache');
    cache.setLiveCache('huge', { fixture: true }, 1000, 17 * MIB);
    expect(cache.getLiveCache('huge')).toBeUndefined();
    cache.setLiveCache('valid', 'ok', 1000, MIB);
    expect(cache.getLiveCache('valid')).toBe('ok');
  });

  it('evicts oldest entries to keep the default total within 16MiB', async () => {
    const cache = await import('./live-cache');
    for (let i = 0; i < 9; i++) cache.setLiveCache(`row${i}`, i, 1000, 2 * MIB);
    expect(cache.getLiveCache('row0')).toBeUndefined();
    expect(cache.getLiveCache('row1')).toBe(1);
    expect(cache.getLiveCache('row8')).toBe(8);
  });

  it('replacing an entry counts its new estimate only once', async () => {
    vi.stubEnv('LIVE_CACHE_MAX_BYTES', String(2 * MIB));
    const cache = await import('./live-cache');
    cache.setLiveCache('a', 1, 1000, MIB);
    cache.setLiveCache('b', 2, 1000, MIB);
    cache.setLiveCache('a', 3, 1000, MIB);
    expect(cache.getLiveCache('a')).toBe(3);
    expect(cache.getLiveCache('b')).toBe(2);
  });

  it('Node/Docker can explicitly increase the budget, with a 256MiB cap', async () => {
    vi.stubEnv('LIVE_CACHE_MAX_BYTES', String(256 * MIB));
    const cache = await import('./live-cache');
    cache.setLiveCache('large-node', 'ok', 1000, 32 * MIB);
    expect(cache.getLiveCache('large-node')).toBe('ok');
    cache.setLiveCache('too-big', 'bad', 1000, 257 * MIB);
    expect(cache.getLiveCache('too-big')).toBeUndefined();
  });

  it('Workers clamps even explicit larger bindings to 16MiB', async () => {
    vi.mocked(getCloudflareContext).mockReturnValue({ env: { LIVE_CACHE_MAX_BYTES: String(256 * MIB) } } as never);
    const cache = await import('./live-cache');
    cache.setLiveCache('too-big', 'bad', 1000, 17 * MIB);
    expect(cache.getLiveCache('too-big')).toBeUndefined();
  });

  it.each(['0', '-1', 'NaN', 'invalid', '1e9', '999999999999999999999999'])('invalid budget %s safely uses the default', async (value) => {
    vi.stubEnv('LIVE_CACHE_MAX_BYTES', value);
    const cache = await import('./live-cache');
    cache.setLiveCache('too-big', 'bad', 1000, 17 * MIB);
    expect(cache.getLiveCache('too-big')).toBeUndefined();
  });

  it('expires entries and rejects non-finite size estimates', async () => {
    vi.useFakeTimers();
    const cache = await import('./live-cache');
    cache.setLiveCache('a', 1, 1000, MIB);
    await vi.advanceTimersByTimeAsync(1001);
    expect(cache.getLiveCache('a')).toBeUndefined();
    cache.setLiveCache('nan', 1, 1000, NaN);
    cache.setLiveCache('infinite', 1, 1000, Infinity);
    expect(cache.getLiveCache('nan')).toBeUndefined();
    expect(cache.getLiveCache('infinite')).toBeUndefined();
  });
});
