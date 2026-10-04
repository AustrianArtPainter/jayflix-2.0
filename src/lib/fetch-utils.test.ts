import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import { fetchUpstream, fetchWithSafeRedirects } from './fetch-utils';

/**
 * 安全跳转测试：mock 全局 fetch，验证 302 跳转到内网地址会被拒绝，
 * 跳转到公网地址则正常跟随。使用字面量公网 IP 避免 DNS 依赖。
 */

const PUBLIC_URL = 'https://93.184.216.34/a';

function mockFetch(handlers: Array<(url: string) => Response>) {
  const fn = vi.fn((url: string | URL) => {
    const handler = handlers.shift();
    if (!handler) throw new Error('意外的额外请求: ' + url);
    return Promise.resolve(handler(String(url)));
  });
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Workers safe redirect and streaming behavior', () => {
  it('cannot disable DNS checks or redirect validation via legacy options', async () => {
    const spy = mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'http://[::ffff:127.0.0.1]/secret' } }),
    ]);
    await expect(fetchUpstream(PUBLIC_URL, { safeRedirects: false, redirect: 'follow' })).rejects.toThrow(/跳转目标被拒绝/);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][1] as RequestInit).redirect).toBe('manual');
  });

  it('checks all DNS answers at a later redirect, never reaching a wildcard private destination', async () => {
    vi.spyOn(dns, 'resolve4').mockResolvedValue(['93.184.216.34', '10.0.0.1'] as never);
    vi.spyOn(dns, 'resolve6').mockResolvedValue([] as never);
    const spy = mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'https://wildcard.example.com/live' } }),
    ]);
    await expect(fetchWithSafeRedirects(PUBLIC_URL)).rejects.toThrow(/跳转目标被拒绝/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('DNS failure cannot trigger even the first network request', async () => {
    vi.spyOn(dns, 'resolve4').mockRejectedValue(new Error('Not implemented'));
    vi.spyOn(dns, 'resolve6').mockRejectedValue(new Error('DNS unavailable'));
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(fetchWithSafeRedirects('https://cdn.example.com/live')).rejects.toThrow(/无法安全解析/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('cancels redirect bodies, preserves Range and removes credentials across origins', async () => {
    const cancel = vi.fn();
    const redirect = new Response(new ReadableStream({ cancel }), {
      status: 307,
      headers: { location: 'https://1.1.1.1/final.ts' },
    });
    const spy = mockFetch([
      () => redirect,
      () => new Response('bytes', { status: 206, headers: { 'Content-Range': 'bytes 0-4/50' } }),
    ]);
    const { res, finalUrl } = await fetchWithSafeRedirects(PUBLIC_URL, {
      headers: { Range: 'bytes=0-4', Authorization: 'Bearer fixture', Cookie: 'fixture=1' },
    });
    expect(cancel).toHaveBeenCalledOnce();
    const headers = new Headers((spy.mock.calls[1][1] as RequestInit).headers);
    expect(headers.get('range')).toBe('bytes=0-4');
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-4/50');
    expect(finalUrl).toBe('https://1.1.1.1/final.ts');
  });

  it('resolves relative manifest redirects using the final URL', async () => {
    mockFetch([
      () => new Response(null, { status: 302, headers: { location: '/hls/master.m3u8' } }),
      () => new Response('#EXTM3U\nseg.ts'),
    ]);
    const result = await fetchWithSafeRedirects(PUBLIC_URL);
    expect(result.finalUrl).toBe('https://93.184.216.34/hls/master.m3u8');
  });

  it('returns the exact streaming response without waiting for media EOF', async () => {
    vi.useFakeTimers();
    let upstreamSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([70, 76, 86])); },
    });
    const response = new Response(body, { headers: { 'Content-Type': 'video/x-flv' } });
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      upstreamSignal = init.signal;
      return response;
    }));
    const result = await fetchWithSafeRedirects(PUBLIC_URL, {}, { headerTimeoutMs: 100 });
    expect(result.res).toBe(response);
    expect(body.locked).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(upstreamSignal?.aborted).toBe(false);
    const reader = result.res.body!.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([70, 76, 86]));
    await reader.cancel();
  });

  it('aborts only an outstanding response-header wait', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    })));
    const result = fetchWithSafeRedirects(PUBLIC_URL, {}, { headerTimeoutMs: 100 });
    const assertion = expect(result).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
  });

  it('propagates client cancellation to a returned long-lived stream', async () => {
    const client = new AbortController();
    let upstreamSignal: AbortSignal | null | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      upstreamSignal = init.signal;
      return new Response('flv');
    }));
    await fetchWithSafeRedirects(PUBLIC_URL, { signal: client.signal }, { headerTimeoutMs: 100 });
    client.abort();
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it('does not fetch an already aborted request', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(fetchWithSafeRedirects(PUBLIC_URL, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('allowPrivate callers still need the deployment opt-in', async () => {
    vi.stubEnv('LIVE_ALLOW_PRIVATE', '');
    const spy = vi.fn(async () => new Response('live'));
    vi.stubGlobal('fetch', spy);
    await expect(fetchWithSafeRedirects('http://10.0.0.1/live', {}, { allowPrivate: true })).rejects.toThrow(/跳转目标被拒绝/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchUpstream 安全跳转', () => {
  it('302 跳转到内网地址时拒绝，且不发起第二跳请求', async () => {
    const spy = mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/secret' } }),
    ]);
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/跳转目标被拒绝/);
    expect(spy.mock.calls.length).toBe(1); // 预检在请求前拦截，内网地址未实际请求
  });

  it('302 跳转到公网地址时正常跟随并返回最终响应', async () => {
    mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'https://93.184.216.34/b' } }),
      () => new Response('ok', { status: 200 }),
    ]);
    const res = await fetchUpstream(PUBLIC_URL);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('无跳转时直接返回响应', async () => {
    const spy = mockFetch([() => new Response('direct', { status: 200 })]);
    const res = await fetchUpstream(PUBLIC_URL);
    expect(await res.text()).toBe('direct');
    expect(spy.mock.calls.length).toBe(1);
  });

  it('重定向超过上限时抛错', async () => {
    mockFetch(Array.from({ length: 10 }, () => (url: string) =>
      new Response(null, { status: 302, headers: { location: url } })
    ));
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/重定向次数过多/);
  });
});
