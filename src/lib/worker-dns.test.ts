import { afterEach, describe, expect, it, vi } from 'vitest';
import * as runtime from './cloudflare-env';
import { isBlockedByDNS } from './ssrf';
import { resolveWorkerAddresses } from './worker-dns';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function resolver(a: unknown, aaaa: unknown) {
  vi.spyOn(runtime, 'isWorkerRuntime').mockReturnValue(true);
  const fetch = vi.fn(async (input: URL) => Response.json(input.searchParams.get('type') === '1' ? a : aaaa));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('Workers typed DNS regression: real Douban CNAME and 60s NODATA shapes', () => {
  it('accepts CNAME chains ending in public A and CNAME-only AAAA answers', async () => {
    const cnames = [{ type: 5, data: 'forward.douban.com.' }, { type: 5, data: 'tc.forward.douban.com.' }];
    const fetch = resolver({ Status: 0, Answer: [...cnames, { type: 1, data: '120.53.130.158' }, { type: 1, data: '140.143.177.206' }] },
      { Status: 0, Answer: cnames });
    await expect(isBlockedByDNS('https://movie.douban.com/j/search_subjects')).resolves.toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetch.mock.calls as unknown as Array<[URL, RequestInit]>) {
      expect(url.origin + url.pathname).toBe('https://cloudflare-dns.com/dns-query');
      expect(url.searchParams.get('name')).toBe('movie.douban.com');
      expect(options.redirect).toBe('manual');
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('accepts public A plus successful absent AAAA (not NXDOMAIN)', async () => {
    resolver({ Status: 0, Answer: [{ type: 1, data: '154.219.110.174' }] }, { Status: 0 });
    await expect(isBlockedByDNS('https://60s.crystelf.top/v2/douban/weekly/movie')).resolves.toBe(false);
  });

  it.each([
    { Status: 3 }, { Status: 2 }, {}, { Status: 0, TC: true },
    { Status: 0, Answer: 'invalid' }, { Status: 0, Answer: [{ type: 28, data: 'fd00::1' }] },
    { Status: 0, Answer: [{ type: 28, data: '::ffff:127.0.0.1' }] },
    { Status: 0, Answer: [{ type: 28, data: 'not-an-ip' }] },
    { Status: 0, Answer: [{ type: 28, data: null }] },
    { Status: 0, Answer: [{ type: 1, data: '8.8.8.8' }] },
  ])('rejects unsuccessful, malformed, private or wrong-family AAAA replies: %j', async (aaaa) => {
    resolver({ Status: 0, Answer: [{ type: 1, data: '8.8.8.8' }] }, aaaa);
    await expect(isBlockedByDNS('https://fixture.example/')).resolves.toBe(true);
  });

  it('rejects all-empty records and any private address behind a CNAME', async () => {
    resolver({ Status: 0, Answer: [{ type: 5, data: 'alias.example.' }] }, { Status: 0 });
    await expect(isBlockedByDNS('https://fixture.example/')).resolves.toBe(true);
    resolver({ Status: 0, Answer: [{ type: 5, data: 'alias.example.' }, { type: 1, data: '8.8.8.8' }, { type: 1, data: '10.0.0.1' }] }, { Status: 0 });
    await expect(isBlockedByDNS('https://fixture.example/')).resolves.toBe(true);
  });

  it('fails closed on transport failure and HTTP errors', async () => {
    const fetch = resolver({}, {});
    fetch.mockRejectedValueOnce(new Error('timeout'));
    await expect(isBlockedByDNS('https://fixture.example/')).resolves.toBe(true);
    fetch.mockImplementation(async () => new Response(null, { status: 403 }));
    await expect(resolveWorkerAddresses('fixture.example', 1)).rejects.toThrow('request failed');
  });

  it('bounds actual DNS response bytes before JSON parsing', async () => {
    resolver({}, {}).mockImplementation(async () => new Response(' '.repeat(64 * 1024 + 1)));
    await expect(resolveWorkerAddresses('fixture.example', 1)).rejects.toThrow('字节限制');
  });

  it('rejects resolver redirects rather than following an unvalidated destination', async () => {
    resolver({}, {}).mockImplementation(async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }));
    await expect(resolveWorkerAddresses('fixture.example', 1)).rejects.toThrow('request failed');
  });
});
