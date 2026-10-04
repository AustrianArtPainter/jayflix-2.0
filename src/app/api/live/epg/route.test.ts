import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signSession } from '@/lib/auth';
import { getLiveCache } from '@/lib/live-cache';
import { GET } from './route';

const ORIGIN = 'https://93.184.216.34';
const xml = `<tv><programme channel="fixture" start="20240101000000 +0000" stop="20990101000000 +0000"><title>EPG fixture</title></programme></tv>`;

function request(name: string, force = true): Request {
  const url = `${ORIGIN}/${name}.xml.gz`;
  return new Request(`https://app.example.com/api/live/epg?url=${encodeURIComponent(url)}&channel=fixture${force ? '&force=1' : ''}`, {
    headers: { Cookie: `${SESSION_COOKIE}=${signSession().token}` },
  });
}

beforeEach(() => {
  vi.stubEnv('PASSWORD', 'epg-route-fixture');
  vi.stubEnv('PROXY_SECRET', 'epg-signing-fixture');
  vi.stubEnv('LIVE_ALLOW_PRIVATE', '');
  vi.stubEnv('EPG_MAX_INPUT_BYTES', '1024');
  vi.stubEnv('EPG_MAX_EXPANDED_BYTES', '2048');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('EPG network and decompression bounds', () => {
  it('accepts gzip, estimates parsed metadata, and reuses a valid cache entry', async () => {
    const fetch = vi.fn(async () => new Response(gzipSync(xml)));
    vi.stubGlobal('fetch', fetch);
    const res = await GET(request('valid'));
    expect(res.status).toBe(200);
    expect((await res.json()).current.title).toBe('EPG fixture');
    expect((await GET(request('valid', false))).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('rejects announced oversized input before reading and cancels its stream', async () => {
    const cancel = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': '1025' } })));
    const res = await GET(request('large-announced'));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('输入超过 1024');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([undefined, '1'])('counts chunks even with Content-Length=%s and stops at the limit', async (length) => {
    const cancel = vi.fn();
    let pulls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(600)); }, cancel,
    }), { headers: length ? { 'Content-Length': length } : undefined })));
    const res = await GET(request(`chunk-limit-${length}`));
    expect(res.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(pulls).toBeLessThanOrEqual(3);
    expect(getLiveCache(`live:epg:${ORIGIN}/chunk-limit-${length}.xml.gz`)).toBeUndefined();
  });

  it('rejects a small gzip bomb and never caches rejected metadata', async () => {
    const bomb = gzipSync('<tv>' + 'x'.repeat(8192) + '</tv>');
    expect(bomb.length).toBeLessThan(1024);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bomb)));
    const res = await GET(request('bomb'));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('解压后超过 2048');
    expect(getLiveCache(`live:epg:${ORIGIN}/bomb.xml.gz`)).toBeUndefined();
  });

  it('retains upstream error behavior and rejects retained metadata beyond budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
    expect((await GET(request('unavailable'))).status).toBe(502);
    vi.stubEnv('EPG_MAX_PARSED_BYTES', '1');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(gzipSync(xml))));
    const res = await GET(request('parsed-limit'));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain('解析结果超过');
  });
});
