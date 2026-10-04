import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_SESSION_COOKIE, SESSION_COOKIE, signAdminSession, signSession } from './auth';
import * as auth from '../app/api/auth/route';
import * as admin from '../app/api/admin/route';
import * as status from '../app/api/status/route';
import * as search from '../app/api/search/route';
import * as detail from '../app/api/detail/route';
import * as douban from '../app/api/douban/route';
import * as hotList from '../app/api/hot-list/route';
import * as bangumi from '../app/api/bangumi/calendar/route';
import * as sourceList from '../app/api/source-list/route';
import * as sourceTest from '../app/api/source/test/route';
import * as publish from '../app/api/publish/route';
import * as playlist from '../app/api/live/playlist/route';
import * as epg from '../app/api/live/epg/route';
import * as probe from '../app/api/live/probe/route';
import * as proxy from '../app/api/proxy/route';
import * as proxyPath from '../app/api/proxy/[url]/route';
import * as live from '../app/api/live/stream/route';
import * as livePath from '../app/api/live/stream/[url]/route';

// This exercises the real route handlers and real DNS/redirect helpers, while all
// DNS replies/upstream responses are deterministic fixtures (no external writes).
const PUBLIC = 'https://93.184.216.34';
const SOURCE = { key: 'cf-fixture', name: 'Fixture', url: `${PUBLIC}/cms` };
const ITEM = { vod_id: 421, vod_name: 'CF Fixture', type_name: '国产剧', vod_play_url: `第一集$${PUBLIC}/master.m3u8` };
const PASSWORD = 'cloudflare-route-test-fixture';
const TARGET = `${PUBLIC}/segment.ts`;
const dynamicContext = { params: Promise.resolve({ url: encodeURIComponent(TARGET) }) };

type Handler = (request: Request) => Promise<Response>;
const protectedRoutes: Array<[string, string, Handler]> = [
  ['admin', 'GET', admin.GET],
  ['search', 'POST', search.POST], ['detail', 'GET', detail.GET],
  ['douban', 'GET', douban.GET], ['hot-list', 'GET', hotList.GET],
  ['bangumi/calendar', 'GET', bangumi.GET], ['source-list', 'GET', sourceList.GET],
  ['source/test', 'POST', sourceTest.POST], ['publish', 'POST', publish.POST],
  ['live/playlist', 'GET', playlist.GET], ['live/epg', 'GET', epg.GET], ['live/probe', 'POST', probe.POST],
  ['proxy', 'GET', (req) => proxy.GET(req)],
  ['proxy/[url]', 'GET', (req) => proxyPath.GET(req, dynamicContext)],
  ['live/stream', 'GET', (req) => live.GET(req)],
  ['live/stream/[url]', 'GET', (req) => livePath.GET(req, dynamicContext)],
];

function request(route: string, body?: unknown, query: Record<string, string> = {}, verified = true): Request {
  const url = new URL(`/api/${route}`, 'https://app.example.com');
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  const headers = new Headers({ 'Content-Type': 'application/json', Origin: url.origin });
  if (verified) {
    const access = signSession().token;
    headers.set('cookie', `${SESSION_COOKIE}=${access}; ${ADMIN_SESSION_COOKIE}=${signAdminSession(access).token}`);
  }
  return new Request(url, { headers, method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(() => {
  vi.stubEnv('PASSWORD', PASSWORD);
  vi.stubEnv('ADMINPASSWORD', 'admin-route-test-fixture');
  vi.stubEnv('PROXY_SECRET', 'signature-route-test-fixture');
  vi.stubEnv('LIVE_ALLOW_PRIVATE', '');
  vi.spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34'] as never);
  vi.spyOn(dns, 'resolve6').mockResolvedValue([] as never);
  vi.spyOn(dns, 'lookup').mockRejectedValue(new Error('Workers lookup is not implemented'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('all imported API capabilities in the Workers-compatible runtime', () => {
  it('covers every upstream route including both encoded-path aliases', () => {
    const expected = ['auth', 'status', ...protectedRoutes.map(([route]) => route)];
    for (const route of expected) {
      expect(fs.existsSync(path.resolve(__dirname, `../app/api/${route}/route.ts`))).toBe(true);
    }
    const actual = fs.readdirSync(path.resolve(__dirname, '../app/api'), { recursive: true })
      .filter((file) => String(file).endsWith('/route.ts'))
      .map((file) => String(file).slice(0, -'/route.ts'.length));
    expect(new Set(expected)).toEqual(new Set(actual));
    expect(expected).toHaveLength(18);
  });

  it.each(protectedRoutes)('%s blocks missing configuration before any upstream request', async (route, method, handler) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('PASSWORD', '');
    const res = await handler(request(route, method === 'POST' ? {} : undefined, { url: TARGET }, false));
    expect(res.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(protectedRoutes)('%s requires a valid access session', async (route, method, handler) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const res = await handler(request(route, method === 'POST' ? {} : undefined, { url: TARGET }, false));
    expect(res.status).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('supports status, login, verification and logout without leaking configured secrets', async () => {
    const before = await status.GET(request('status', undefined, {}, false));
    const state = await before.json();
    expect(state.verified).toBe(false);
    expect(JSON.stringify(state)).not.toContain(PASSWORD);
    const login = await auth.POST(request('auth', { password: PASSWORD }, {}, false));
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('HttpOnly');
    expect((await (await auth.GET(request('auth'))).json()).verified).toBe(true);
    expect((await auth.DELETE(request('auth', {}))).headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('supports the independent administrator gate and admin-only logout', async () => {
    const state = await (await admin.GET(request('admin'))).json();
    expect(state).toMatchObject({ configured: true, accessVerified: true, verified: true });
    const login = await admin.POST(request('admin', { password: 'admin-route-test-fixture' }));
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain(`${ADMIN_SESSION_COOKIE}=`);
    const logout = await admin.DELETE(request('admin', {}));
    expect(logout.headers.get('set-cookie')).toContain(`${ADMIN_SESSION_COOKIE}=`);
    expect(logout.headers.get('set-cookie')).not.toContain(`${SESSION_COOKIE}=`);
  });

  it('aggregates CMS search in JSON and NDJSON and preserves playable detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 1, pagecount: 1, list: [ITEM] })));
    const json = await search.POST(request('search', { wd: 'CF Fixture', sources: [SOURCE] }));
    expect((await json.json()).list[0].vodId).toBe('421');
    const streamed = await search.POST(request('search', { wd: 'Fixture', sources: [SOURCE] }, { stream: '1' }));
    expect(streamed.headers.get('content-type')).toContain('ndjson');
    const events = (await streamed.text()).trim().split('\n').map((line) => JSON.parse(line));
    expect(events.at(-1).type).toBe('done');
    const result = await detail.GET(request('detail', undefined, { id: '421', source: JSON.stringify(SOURCE) }));
    expect((await result.json()).episodes).toEqual([`${PUBLIC}/master.m3u8`]);
    const checked = await sourceTest.POST(request('source/test', { url: SOURCE.url }));
    expect((await checked.json()).ok).toBe(true);
    expect(dns.lookup).not.toHaveBeenCalled();
  });

  it('preserves all three recommendation providers using public DNS fixtures', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('search_subjects')) return Response.json({ subjects: [{ id: '1', title: 'Fixture', cover: `${PUBLIC}/cover.jpg`, rate: '8' }] });
      if (url.includes('/weekly/')) return Response.json({ data: [{ id: 2, title: 'Fixture', cover: `${PUBLIC}/cover.jpg` }] });
      if (url.includes('/calendar')) return Response.json([{ weekday: { id: 1 }, items: [{ id: 3, name: 'Fixture', images: { large: `${PUBLIC}/cover.jpg` } }] }]);
      throw new Error(`Unexpected fixture URL: ${url}`);
    }));
    expect((await (await douban.GET(request('douban', undefined, { tag: 'cf-fixture' }))).json()).items).toHaveLength(1);
    expect((await (await hotList.GET(request('hot-list', undefined, { id: 'douban_movie_weekly' }))).json()).items).toHaveLength(1);
    expect((await (await bangumi.GET(request('bangumi/calendar'))).json()).days[0].items).toHaveLength(1);
  });

  it('imports source subscriptions and publishes through a mocked fixed destination', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).startsWith('https://paste.rs/')) return new Response('https://paste.rs/fixture', { status: 201 });
      return Response.json({ name: 'Fixture', sources: [{ name: SOURCE.name, url: SOURCE.url }], liveSources: [] });
    });
    vi.stubGlobal('fetch', fetch);
    const imported = await sourceList.GET(request('source-list', undefined, { url: `${PUBLIC}/sources.json` }));
    expect((await imported.json()).sources).toHaveLength(1);
    const published = await publish.POST(request('publish', { sources: [{ name: SOURCE.name, url: SOURCE.url }] }));
    expect(published.status).toBe(200);
    expect((await published.json()).url).toBe('https://paste.rs/fixture');
    expect(fetch).toHaveBeenCalledWith('https://paste.rs/', expect.objectContaining({ method: 'POST' }));
  });

  it('parses and exports live M3U, reads gzip XMLTV and probes a playable endpoint', async () => {
    const now = new Date();
    const xmlDate = (date: Date) => date.toISOString().replace(/[-:T]/g, '').slice(0, 14) + ' +0000';
    const xml = `<tv><programme channel="fixture" start="${xmlDate(new Date(now.getTime() - 60000))}" stop="${xmlDate(new Date(now.getTime() + 60000))}"><title>Fixture programme</title></programme></tv>`;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith('/channels.m3u')) return new Response(`#EXTM3U\n#EXTINF:-1 tvg-id="fixture" group-title="Fixture",Fixture TV\n${TARGET}`);
      if (String(input).endsWith('/epg.xml.gz')) return new Response(gzipSync(xml));
      return new Response(new Uint8Array([1, 2]), { status: 206, headers: { 'Content-Type': 'video/mp4' } });
    }));
    const parsed = await playlist.GET(request('live/playlist', undefined, { url: `${PUBLIC}/channels.m3u`, force: '1' }));
    expect((await parsed.json()).channels[0].tvgId).toBe('fixture');
    const exported = await playlist.GET(request('live/playlist', undefined, { url: `${PUBLIC}/channels.m3u`, format: 'm3u' }));
    expect(await exported.text()).toContain('#EXTINF:');
    const programs = await epg.GET(request('live/epg', undefined, { url: `${PUBLIC}/epg.xml.gz`, channel: 'fixture', force: '1' }));
    expect((await programs.json()).current.title).toBe('Fixture programme');
    const probed = await probe.POST(request('live/probe', { urls: [`${PUBLIC}/capability.mp4`] }));
    expect((await probed.json()).results[0].ok).toBe(true);
  });

  it.each([
    ['proxy', proxy.GET],
    ['proxy/[url]', (req: Request) => proxyPath.GET(req, dynamicContext)],
    ['live/stream', live.GET],
    ['live/stream/[url]', (req: Request) => livePath.GET(req, dynamicContext)],
  ] as Array<[string, Handler]>)('%s returns a live response before EOF and preserves bytes', async (route, handler) => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); } });
    const upstream = new Response(body, { status: 206, headers: { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-2/100', 'Accept-Ranges': 'bytes' } });
    const fetch = vi.fn(async () => upstream);
    vi.stubGlobal('fetch', fetch);
    const req = request(route, undefined, { url: TARGET });
    req.headers.set('range', 'bytes=0-2');
    const response = await handler(req);
    expect(response.status).toBe(206);
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1, 2, 3]));
    await reader.cancel();
    if (route.startsWith('proxy')) {
      expect(response.headers.get('content-range')).toBe('bytes 0-2/100');
      expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Range: 'bytes=0-2' });
    }
  });

  it.each(['proxy', 'live/stream'])('%s rewrites HLS variants, segments, key and map', async (route) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg.ts', { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } })));
    const handler = route === 'proxy' ? proxy.GET : live.GET;
    const res = await handler(request(route, undefined, { url: `${PUBLIC}/hls/master.m3u8` }));
    const text = await res.text();
    for (const asset of ['key.bin', 'init.mp4', 'seg.ts']) {
      expect(text).toContain(encodeURIComponent(`${PUBLIC}/hls/${asset}`));
    }
    expect(text).toContain(`/api/${route}?url=`);
  });
});
