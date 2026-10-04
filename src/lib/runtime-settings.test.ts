import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getEnvSources } from './env-sources';
import { getEnvLiveSources } from './env-live-sources';
import { getEnvSubscriptions } from './env-subscriptions';
import { getEnvRecommendSource } from './env-recommend-source';
import { getEnvImageMode } from './env-image-mode';
import { getSearchSettings } from './search-settings';
import { allowLivePrivate, checkLiveUrlAllowed } from './ssrf';
import { fetchDoubanRecommend } from './douban';
import { fetchHotList } from './douban-weekly';
import { fetchUpstream, fetchUpstreamWithMeta, getCache } from './fetch-utils';
import { SESSION_COOKIE, signSession } from './auth';
import { POST as search } from '../app/api/search/route';
import { POST as probe } from '../app/api/live/probe/route';

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: vi.fn() }));
vi.mock('./fetch-utils', () => ({
  fetchUpstream: vi.fn(), fetchUpstreamWithMeta: vi.fn(), getCache: vi.fn(), setCache: vi.fn(),
}));

function worker(env: Record<string, string> = {}) {
  vi.mocked(getCloudflareContext).mockReturnValue({ env } as never);
}
function request(path: string, body: unknown) {
  return new Request(`https://fixture.example/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${signSession().token}` },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.mocked(getCloudflareContext).mockImplementation(() => { throw new Error('Node context'); });
  vi.mocked(getCache).mockReturnValue(undefined);
});
afterEach(() => {
  vi.resetAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
});

describe('request-time runtime configuration', () => {
  it('Worker absence does not revive any stale Node defaults or private-network opt-in', async () => {
    vi.stubEnv('DEFAULT_SOURCES', '[{"name":"stale","url":"https://stale.example/cms"}]');
    vi.stubEnv('DEFAULT_LIVE_SOURCES', '[{"name":"stale","url":"https://stale.example/live"}]');
    vi.stubEnv('DEFAULT_SUBSCRIPTIONS', '["https://stale.example/sources"]');
    vi.stubEnv('DEFAULT_RECOMMEND_SOURCE', 'douban');
    vi.stubEnv('DEFAULT_IMAGE_MODE', 'proxy');
    vi.stubEnv('SEARCH_MAX_PAGES', '50');
    vi.stubEnv('SEARCH_SOURCE_TIMEOUT_MS', '60000');
    vi.stubEnv('LIVE_ALLOW_PRIVATE', '1');
    worker();
    expect(getEnvSources()).toEqual([]);
    expect(getEnvLiveSources()).toEqual([]);
    expect(getEnvSubscriptions()).toEqual([]);
    expect(getEnvRecommendSource()).toBeUndefined();
    expect(getEnvImageMode()).toBeUndefined();
    expect(getSearchSettings()).toEqual({ maxPages: 5, sourceTimeoutMs: 10000 });
    expect(allowLivePrivate()).toBe(false);
    await expect(checkLiveUrlAllowed('http://10.0.0.1/private')).resolves.toMatchObject({ ok: false });
  });

  it('reads current source/subscription/recommendation/image bindings on each call', () => {
    worker({
      DEFAULT_SOURCES: '[{"name":"bound","url":"https://bound.example/cms/"}]',
      DEFAULT_LIVE_SOURCES: '[{"name":"bound live","url":"https://bound.example/live","epg":"https://bound.example/epg"}]',
      DEFAULT_SUBSCRIPTIONS: '[{"name":"bound subscription","url":"https://bound.example/sources/"}]',
      DEFAULT_RECOMMEND_SOURCE: 'BANGUMI', DEFAULT_IMAGE_MODE: 'PROXY',
    });
    expect(getEnvSources()[0]).toMatchObject({ name: 'bound', url: 'https://bound.example/cms' });
    expect(getEnvLiveSources()[0]).toMatchObject({ name: 'bound live', epg: 'https://bound.example/epg' });
    expect(getEnvSubscriptions()).toEqual([{ name: 'bound subscription', url: 'https://bound.example/sources' }]);
    expect(getEnvRecommendSource()).toBe('bangumi');
    expect(getEnvImageMode()).toBe('proxy');
    worker({ DEFAULT_RECOMMEND_SOURCE: 'hot-list', DEFAULT_IMAGE_MODE: 'direct' });
    expect(getEnvSources()).toEqual([]);
    expect(getEnvRecommendSource()).toBe('hot-list');
    expect(getEnvImageMode()).toBe('direct');
  });

  it('Node keeps explicitly configured defaults and private IPTV capability', async () => {
    vi.stubEnv('DEFAULT_SOURCES', '[{"name":"node","url":"https://node.example/cms"}]');
    vi.stubEnv('DEFAULT_LIVE_SOURCES', '[{"name":"node","url":"http://10.0.0.1/list"}]');
    vi.stubEnv('DEFAULT_SUBSCRIPTIONS', '["https://node.example/sources"]');
    vi.stubEnv('DEFAULT_RECOMMEND_SOURCE', 'douban');
    vi.stubEnv('DEFAULT_IMAGE_MODE', 'proxy');
    vi.stubEnv('LIVE_ALLOW_PRIVATE', '1');
    expect(getEnvSources()[0].name).toBe('node');
    expect(getEnvLiveSources()[0].url).toBe('http://10.0.0.1/list');
    expect(getEnvSubscriptions()[0].url).toBe('https://node.example/sources');
    expect(getEnvRecommendSource()).toBe('douban');
    expect(getEnvImageMode()).toBe('proxy');
    expect(allowLivePrivate()).toBe(true);
    await expect(checkLiveUrlAllowed('http://10.0.0.1/live')).resolves.toEqual({ ok: true });
  });

  it('Workers cannot enable private IPTV even with a current binding of 1', async () => {
    worker({ LIVE_ALLOW_PRIVATE: '1' });
    expect(allowLivePrivate()).toBe(false);
    await expect(checkLiveUrlAllowed('http://[::ffff:10.0.0.1]/live')).resolves.toMatchObject({ ok: false });
  });

  it.each([
    ['2', '4000', 2, 4000], ['99', '999999', 50, 60000], ['0', '1', 1, 3000], ['NaN', 'bad', 5, 10000],
  ])('search %s pages / %s ms preserves the bounded parsing contract', (pages, timeout, expectedPages, expectedTimeout) => {
    worker({ SEARCH_MAX_PAGES: pages, SEARCH_SOURCE_TIMEOUT_MS: timeout });
    expect(getSearchSettings()).toEqual({ maxPages: expectedPages, sourceTimeoutMs: expectedTimeout });
  });

  it('search pagination consumes current bindings rather than import-time settings', async () => {
    vi.stubEnv('SEARCH_MAX_PAGES', '50');
    const source = { key: 'runtime', name: 'Runtime', url: 'https://93.184.216.34/cms' };
    vi.mocked(fetchUpstream).mockImplementation(async (url) => Response.json({
      pagecount: 20,
      list: [{ vod_id: new URL(url).searchParams.get('pg'), vod_name: 'Runtime fixture', vod_play_url: '第1集$https://93.184.216.34/master.m3u8' }],
    }));
    worker({ PASSWORD: 'bound-access', SEARCH_MAX_PAGES: '2' });
    expect((await (await search(request('search', { wd: 'Runtime fixture', sources: [source] }))).json()).list).toHaveLength(2);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
    vi.mocked(fetchUpstream).mockClear();
    worker({ PASSWORD: 'bound-access', SEARCH_MAX_PAGES: '1' });
    expect((await (await search(request('search', { wd: 'Runtime fixture', sources: [source] }))).json()).list).toHaveLength(1);
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });

  it('60s provider absence ignores stale process.env and a current binding selects its own cache namespace', async () => {
    vi.stubEnv('60S_API_BASE', 'https://stale.example');
    vi.mocked(fetchUpstream).mockResolvedValue(Response.json({ data: [{ id: 1, title: 'Runtime', cover: 'https://93.184.216.34/cover.png' }] }));
    worker();
    await fetchHotList('douban_movie_weekly');
    expect(fetchUpstream).toHaveBeenLastCalledWith('https://60s.crystelf.top/v2/douban/weekly/movie', expect.anything());
    expect(getCache).toHaveBeenLastCalledWith('hot-list:https://60s.crystelf.top:douban_movie_weekly');
    vi.mocked(fetchUpstream).mockResolvedValue(Response.json({ data: [{ id: 1, title: 'Runtime', cover: 'https://93.184.216.34/cover.png' }] }));
    worker({ '60S_API_BASE': 'https://bound.example/' });
    await fetchHotList('douban_movie_weekly');
    expect(fetchUpstream).toHaveBeenLastCalledWith('https://bound.example/v2/douban/weekly/movie', expect.anything());
    expect(getCache).toHaveBeenLastCalledWith('hot-list:https://bound.example:douban_movie_weekly');
  });

  it('missing fallback proxy binding cannot revive a stale public proxy', async () => {
    vi.stubEnv('FALLBACK_CORS_PROXY', 'https://stale.example/?url=');
    worker();
    vi.mocked(fetchUpstream).mockResolvedValue(new Response(null, { status: 403 }));
    await expect(fetchDoubanRecommend('movie', 'runtime-missing', 0, 20)).rejects.toThrow('豆瓣推荐获取失败');
    expect(fetchUpstream).toHaveBeenCalledTimes(1);
  });

  it('configured fallback proxy is read for the current request', async () => {
    worker({ FALLBACK_CORS_PROXY: 'https://bound.example/?url=' });
    vi.mocked(fetchUpstream).mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ subjects: [{ id: '1', title: 'Fixture', cover: 'https://93.184.216.34/cover.png', rate: '8' }] }));
    expect(await fetchDoubanRecommend('movie', 'runtime-bound', 0, 20)).toHaveLength(1);
    expect(String(vi.mocked(fetchUpstream).mock.calls[1][0])).toMatch(/^https:\/\/bound\.example\/\?url=/);
  });

  it('live probe reads current UA and restores the default when the binding is absent', async () => {
    vi.stubEnv('USER_AGENT', 'stale-user-agent');
    vi.mocked(fetchUpstreamWithMeta).mockImplementation(async (url) => ({
      finalUrl: url, res: new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'video/mp4' } }),
    }));
    worker({ PASSWORD: 'bound-access', USER_AGENT: 'bound-user-agent' });
    await probe(request('live/probe', { urls: ['https://93.184.216.34/runtime-bound.mp4'] }));
    expect(vi.mocked(fetchUpstreamWithMeta).mock.calls[0][1]?.headers).toMatchObject({ 'User-Agent': 'bound-user-agent' });
    worker({ PASSWORD: 'bound-access' });
    await probe(request('live/probe', { urls: ['https://93.184.216.34/runtime-default.mp4'] }));
    expect(vi.mocked(fetchUpstreamWithMeta).mock.calls[1][1]?.headers).toMatchObject({ 'User-Agent': expect.stringContaining('Mozilla/5.0') });
  });
});
