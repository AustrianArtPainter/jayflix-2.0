import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { estimatePlaylistBytes, getPlaylistLimits } from './playlist-limits';
import { M3uLimitError, parseM3u } from './m3u-parser';

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe('bounded playlist metadata', () => {
  it('allows explicit Node limits and refuses unsafe numeric input', () => {
    vi.mocked(getCloudflareContext).mockImplementation(() => { throw new Error('Node'); });
    vi.stubEnv('M3U_MAX_CHANNELS', '100000');
    vi.stubEnv('M3U_MAX_INPUT_BYTES', 'Infinity');
    expect(getPlaylistLimits()).toEqual({ maxChannels: 100000, maxInputBytes: 4 * 1024 ** 2, maxParsedBytes: 8 * 1024 ** 2 });
  });
  it('caps Worker settings and respects lower request-time bounds', () => {
    vi.mocked(getCloudflareContext).mockReturnValue({ env: { M3U_MAX_CHANNELS: '100000', M3U_MAX_INPUT_BYTES: '1048576', M3U_MAX_PARSED_BYTES: '100000000' } } as never);
    expect(getPlaylistLimits()).toEqual({ maxChannels: 20000, maxInputBytes: 1024 ** 2, maxParsedBytes: 8 * 1024 ** 2 });
  });
  it('rejects excess unique channels, never silently truncates', () => {
    expect(() => parseM3u('https://media.example/1\nhttps://media.example/2', undefined, 1)).toThrow(M3uLimitError);
    expect(parseM3u('https://media.example/1\nhttps://media.example/1', undefined, 1)).toHaveLength(1);
  });
  it('accounts for channel objects, groups and complete UTF-16 metadata', () => {
    const playlist = { name: '频道', groups: ['电影'], channels: [{ id: '1', name: '影院', group: '电影', url: 'https://media.example/live.m3u8', logo: 'https://media.example/logo.png' }] };
    const expected = 256 + 4 + 32 + 4 + 256 + Object.values(playlist.channels[0]).reduce((sum, value) => sum + value.length * 2, 0);
    expect(estimatePlaylistBytes(playlist)).toBe(expected);
  });
});
