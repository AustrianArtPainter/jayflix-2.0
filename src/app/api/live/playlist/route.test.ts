import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { fetchUpstream } from '@/lib/fetch-utils';
import { getLiveCache, setLiveCache } from '@/lib/live-cache';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

vi.mock('@/lib/fetch-utils', () => ({ fetchUpstream: vi.fn() }));
vi.mock('@/lib/live-cache', () => ({ getLiveCache: vi.fn(), setLiveCache: vi.fn() }));
vi.mock('node:dns/promises', () => ({ default: { resolve4: vi.fn(async () => ['8.8.8.8']), resolve6: vi.fn(async () => []) } }));

function request(extra = '') {
  return new Request(`https://local.example/api/live/playlist?url=https%3A%2F%2Fiptv.example%2Flist.m3u${extra}`, { headers: { cookie: `${SESSION_COOKIE}=${signSession().token}` } });
}
beforeEach(() => { vi.stubEnv('PASSWORD', 'fixture-access'); vi.mocked(getLiveCache).mockReturnValue(undefined); });
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe('live playlists preserve functionality within bounded memory', () => {
  it('resolves relative streams after redirects and conservatively accounts the cache', async () => {
    const upstream = new Response('#EXTM3U\n#PLAYLIST:影院\n#EXTINF:-1 group-title="电影",电影频道\nstream.m3u8');
    Object.defineProperty(upstream, 'url', { value: 'https://final.example/folder/list.m3u' });
    vi.mocked(fetchUpstream).mockResolvedValue(upstream);
    const response = await GET(request());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ name: '影院', groups: ['电影'], channels: [{ name: '电影频道', url: 'https://final.example/folder/stream.m3u8' }] });
    expect(vi.mocked(setLiveCache).mock.calls[0][3]).toBeGreaterThan(256);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([undefined, '1'])('cancels oversized input with absent or dishonest length %s', async (length) => {
    vi.stubEnv('M3U_MAX_INPUT_BYTES', '10');
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(11)); }, cancel });
    vi.mocked(fetchUpstream).mockResolvedValue(new Response(stream, { headers: length ? { 'content-length': length } : {} }));
    expect((await GET(request())).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(setLiveCache).not.toHaveBeenCalled();
  });
  it('rejects oversized announcements before reading', async () => {
    const cancel = vi.fn();
    vi.stubEnv('M3U_MAX_INPUT_BYTES', '10');
    vi.mocked(fetchUpstream).mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '11' } }));
    expect((await GET(request())).status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects too many channels and oversized parsed metadata without caching partial results', async () => {
    vi.stubEnv('M3U_MAX_CHANNELS', '1');
    vi.mocked(fetchUpstream).mockResolvedValue(new Response('https://media.example/1\nhttps://media.example/2'));
    expect((await GET(request())).status).toBe(413);
    vi.stubEnv('M3U_MAX_CHANNELS', '2'); vi.stubEnv('M3U_MAX_PARSED_BYTES', '10');
    vi.mocked(fetchUpstream).mockResolvedValue(new Response('https://media.example/1'));
    expect((await GET(request())).status).toBe(413);
    expect(setLiveCache).not.toHaveBeenCalled();
  });
  it('retains cached standard M3U export without an upstream request', async () => {
    vi.mocked(getLiveCache).mockReturnValue({ name: '频道', groups: [], channels: [{ id: '1', name: '电影', url: 'https://media.example/live' }] });
    const response = await GET(request('&format=m3u'));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('https://media.example/live');
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
  it('keeps first-layer access protection before fetching any playlist', async () => {
    expect((await GET(new Request('https://local.example/api/live/playlist'))).status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });
});
