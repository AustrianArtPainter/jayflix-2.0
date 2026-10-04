import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleLiveStreamRequest, handleProxyRequest } from './proxy-handlers';
import { SESSION_COOKIE, signSession } from './auth';
import { fetchWithSafeRedirects } from './fetch-utils';

vi.mock('node:dns/promises', () => ({ default: { resolve4: vi.fn(async () => ['8.8.8.8']), resolve6: vi.fn(async () => []) } }));
vi.mock('./fetch-utils', () => ({ fetchWithSafeRedirects: vi.fn() }));

function request(range?: string) {
  return new Request('https://local.test/api/proxy', { headers: { cookie: `${SESSION_COOKIE}=${signSession().token}`, ...(range ? { range } : {}) } });
}
beforeEach(() => { vi.stubEnv('PASSWORD', 'test-proxy-password'); vi.mocked(fetchWithSafeRedirects).mockReset(); });
afterEach(() => vi.unstubAllEnvs());

describe('media proxy contracts', () => {
  it('passes Range and 206 streaming bytes without buffering, and prevents shared authenticated caches', async () => {
    const upstream = new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { 'content-type': 'video/mp2t', 'content-range': 'bytes 0-2/900', 'accept-ranges': 'bytes' } });
    const buffered = vi.spyOn(upstream, 'arrayBuffer');
    vi.mocked(fetchWithSafeRedirects).mockResolvedValue({ res: upstream, finalUrl: 'https://cdn.example/part.ts' });
    const response = await handleProxyRequest(request('bytes=0-2'), 'https://cdn.example/part.ts');
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-2/900');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('vary')).toBe('Cookie');
    expect(fetchWithSafeRedirects).toHaveBeenCalledWith('https://cdn.example/part.ts', expect.objectContaining({ headers: expect.objectContaining({ Range: 'bytes=0-2' }) }));
    expect(buffered).not.toHaveBeenCalled();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('rewrites tokenized HLS variants, AES keys and initialization maps against the redirected URL', async () => {
    const manifest = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\npart.ts';
    vi.mocked(fetchWithSafeRedirects).mockResolvedValue({ res: new Response(manifest, { headers: { 'content-type': 'text/plain' } }), finalUrl: 'https://edge.example/final/index.m3u8?token=x' });
    const response = await handleProxyRequest(request(), 'https://cdn.example/index.m3u8?token=x');
    const text = await response.text();
    for (const name of ['key.bin', 'init.mp4', 'part.ts']) expect(text).toContain('/api/proxy?url=' + encodeURIComponent('https://edge.example/final/' + name));
  });
  it('blocks unauthenticated media, even when hosted at an anonymous image hostname', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(3)); }, cancel });
    vi.mocked(fetchWithSafeRedirects).mockResolvedValue({ res: new Response(stream, { headers: { 'content-type': 'video/mp2t' } }), finalUrl: 'https://bgm.tv/secret.ts' });
    const response = await handleProxyRequest(new Request('https://local.test/api/proxy'), 'https://bgm.tv/secret.ts');
    expect(response.status).toBe(401); expect(cancel).toHaveBeenCalledOnce();
    vi.mocked(fetchWithSafeRedirects).mockClear();
    expect((await handleProxyRequest(new Request('https://local.test/api/proxy'), 'https://evil-bgm.tv/pic.jpg')).status).toBe(401);
    expect(fetchWithSafeRedirects).not.toHaveBeenCalled();
  });
  it('rejects oversized HLS documents', async () => {
    vi.mocked(fetchWithSafeRedirects).mockResolvedValue({ res: new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/vnd.apple.mpegurl' } }), finalUrl: 'https://cdn.example/index.m3u8' });
    expect((await handleProxyRequest(request(), 'https://cdn.example/index.m3u8')).status).toBe(502);
  });
  it('live streaming has only a response-header deadline, no body buffering, and aborts on client disconnect', async () => {
    const client = new AbortController();
    const req = new Request('https://local.test/api/live/stream', { headers: { cookie: `${SESSION_COOKIE}=${signSession().token}` }, signal: client.signal });
    const upstream = new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/x-flv' } });
    const buffered = vi.spyOn(upstream, 'arrayBuffer');
    vi.mocked(fetchWithSafeRedirects).mockResolvedValue({ res: upstream, finalUrl: 'https://cdn.example/live.flv' });
    const response = await handleLiveStreamRequest(req, 'https://cdn.example/live.flv');
    expect(response.headers.get('cache-control')).toBe('no-store, no-transform');
    const [, init, options] = vi.mocked(fetchWithSafeRedirects).mock.calls[0];
    expect(options).toEqual({ allowPrivate: true, headerTimeoutMs: 15000 });
    expect(init!.signal!.aborted).toBe(false); client.abort(); expect(init!.signal!.aborted).toBe(true);
    expect(buffered).not.toHaveBeenCalled();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
