import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_SESSION_COOKIE, SESSION_COOKIE, signAdminSession, signSession } from './auth';
import { guardAdminRequest, guardAuthMutation, guardRequest } from './api-guard';
import { POST as publish } from '@/app/api/publish/route';

const publisher = vi.hoisted(() => vi.fn<(payload: string) => Promise<{ url: string; provider: string }>>(async () => ({ url: 'https://paste.example/test', provider: 'test' })));
vi.mock('@/lib/source-list-publish', () => ({ MAX_PUBLISH_BYTES: 256 * 1024, publishSourceList: publisher }));

beforeEach(() => { vi.stubEnv('PASSWORD', 'access-test'); vi.stubEnv('ADMINPASSWORD', 'admin-test'); publisher.mockClear(); });
afterEach(() => vi.unstubAllEnvs());

function request(cookie?: string, headers?: HeadersInit) {
  return new Request('https://app.example/api/settings', { headers: { ...(cookie ? { cookie } : {}), ...headers } });
}

describe('API access and admin guards', () => {
  it('retains access-only authorization for ordinary APIs', () => {
    const access = signSession().token;
    expect(guardRequest(request(`${SESSION_COOKIE}=${access}`))).toBeNull();
    expect(guardRequest(request())?.status).toBe(401);
    vi.stubEnv('PASSWORD', '');
    expect(guardRequest(request(`${SESSION_COOKIE}=${access}`))?.status).toBe(503);
  });

  it('requires BOTH sessions and configured credentials for administrative operations', () => {
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    expect(guardAdminRequest(request())?.status).toBe(401);
    expect(guardAdminRequest(request(`${ADMIN_SESSION_COOKIE}=${admin}`))?.status).toBe(401);
    expect(guardAdminRequest(request(`${SESSION_COOKIE}=${access}`))?.status).toBe(403);
    expect(guardAdminRequest(request(`${SESSION_COOKIE}=${access}; ${ADMIN_SESSION_COOKIE}=${access}`))?.status).toBe(403);
    expect(guardAdminRequest(request(`${SESSION_COOKIE}=${access}; ${ADMIN_SESSION_COOKIE}=${admin}`))).toBeNull();
    vi.stubEnv('ADMINPASSWORD', '');
    expect(guardAdminRequest(request(`${SESSION_COOKIE}=${access}; ${ADMIN_SESSION_COOKIE}=${admin}`))?.status).toBe(503);
  });

  it('malformed cookies fail closed with an uncacheable response', () => {
    const res = guardRequest(request(`${SESSION_COOKIE}=%E0%A4%A`));
    expect(res?.status).toBe(401);
    expect(res?.headers.get('cache-control')).toBe('no-store');
  });
});

describe('publish server authorization integration', () => {
  function publishRequest(cookie: string, headers: Record<string, string> = {}) {
    return new Request('https://app.example/api/publish', {
      method: 'POST', headers: { cookie, 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ sources: [{ name: 'A', url: 'https://vod.example/api' }] }),
    });
  }

  it('never invokes the publisher with only regular access authorization', async () => {
    const access = signSession().token;
    expect((await publish(publishRequest(`${SESSION_COOKIE}=${access}`))).status).toBe(403);
    expect(publisher).not.toHaveBeenCalled();
  });

  it('rejects cross-origin publishing even when BOTH cookies are valid', async () => {
    const access = signSession().token;
    const cookies = `${SESSION_COOKIE}=${access}; ${ADMIN_SESSION_COOKIE}=${signAdminSession(access).token}`;
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }] as Record<string, string>[]) {
      expect((await publish(publishRequest(cookies, headers))).status).toBe(403);
    }
    expect(publisher).not.toHaveBeenCalled();
  });

  it('allows same-origin admin publishing and keeps the LibreTV-SourceList wire protocol', async () => {
    const access = signSession().token;
    const cookies = `${SESSION_COOKIE}=${access}; ${ADMIN_SESSION_COOKIE}=${signAdminSession(access).token}`;
    expect((await publish(publishRequest(cookies, { origin: 'https://app.example' }))).status).toBe(200);
    expect(publisher).toHaveBeenCalledOnce();
    expect(JSON.parse(publisher.mock.calls[0][0])).toMatchObject({ name: 'LibreTV-SourceList', version: 2 });
  });
});

describe('authentication mutation origin checks', () => {
  it('allows same-origin browser requests and non-browser requests', () => {
    expect(guardAuthMutation(request())).toBeNull();
    expect(guardAuthMutation(request(undefined, { origin: 'https://app.example' }))).toBeNull();
    expect(guardAuthMutation(new Request('http://internal/api/admin', { headers: { host: 'app.example', 'x-forwarded-proto': 'https', origin: 'https://app.example' } }))).toBeNull();
  });

  it('rejects cross-site, different-port, same-site foreign-origin, and invalid origins', () => {
    const cases: Record<string, string>[] = [{ origin: 'https://evil.example' }, { origin: 'https://app.example:123' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }];
    for (const headers of cases) {
      expect(guardAuthMutation(request(undefined, headers))?.status).toBe(403);
    }
  });
});
