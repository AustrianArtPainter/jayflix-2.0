import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, POST } from './route';
import { ADMIN_SESSION_COOKIE, SESSION_COOKIE, clearRateLimit, signSession, verifySession } from '@/lib/auth';

let ip = 0;
beforeEach(() => {
  vi.stubEnv('PASSWORD', 'access-test');
  vi.stubEnv('ADMINPASSWORD', 'admin-test');
  vi.stubEnv('COOKIE_SECURE', '');
  vi.stubEnv('NODE_ENV', 'test');
  clearRateLimit(`auth-test-${++ip}`);
});
afterEach(() => vi.unstubAllEnvs());

function login(body: unknown = { password: 'access-test' }, headers?: Record<string, string>) {
  return new Request('https://app.example/api/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': `auth-test-${ip}`, ...headers }, body: JSON.stringify(body),
  });
}

describe('/api/auth', () => {
  it('issues only a server-side access cookie, expires any old admin cookie, and never returns credentials', async () => {
    const res = await POST(login());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    const access = res.cookies.get(SESSION_COOKIE);
    expect(verifySession(access?.value)).toBe(true);
    expect(access).toMatchObject({ httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
    expect(access?.maxAge).toBeGreaterThanOrEqual(90 * 24 * 60 * 60 - 1);
    expect(access?.maxAge).toBeLessThanOrEqual(90 * 24 * 60 * 60);
    expect(res.cookies.get(ADMIN_SESSION_COOKIE)).toMatchObject({ value: '', maxAge: 0 });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('fails closed without PASSWORD and does not substitute ADMINPASSWORD', async () => {
    const token = signSession().token;
    vi.stubEnv('PASSWORD', '');
    expect((await POST(login({ password: 'admin-test' }))).status).toBe(503);
    const state = await GET(new Request('https://app.example/api/auth', { headers: { cookie: `${SESSION_COOKIE}=${token}` } }));
    expect(await state.json()).toEqual({ success: true, verified: false });
  });

  it.each([null, [], {}, { password: 123 }, { password: ['access-test'] }, { password: 'x'.repeat(4097) }])('rejects malformed credential input %j', async (body) => {
    expect((await POST(login(body))).status).toBe(400);
  });

  it('rejects invalid JSON, wrong passwords, and query-string passwords', async () => {
    expect((await POST(new Request('https://app.example/api/auth', { method: 'POST', body: '{', headers: { 'x-real-ip': `auth-test-${ip}` } }))).status).toBe(400);
    expect((await POST(login({ password: 'admin-test' }))).status).toBe(401);
    expect((await POST(new Request('https://app.example/api/auth?password=access-test', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': `auth-test-${ip}` }, body: '{}' }))).status).toBe(400);
  });

  it('limits attempts and returns Retry-After even for a correct password after exhaustion', async () => {
    for (let i = 0; i < 10; i++) expect((await POST(login({ password: 'wrong' }))).status).toBe(401);
    const res = await POST(login());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('600');
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('forces secure production cookies even with COOKIE_SECURE=false and internal HTTP', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_SECURE', 'false');
    const res = await POST(new Request('http://internal/api/auth', { method: 'POST', body: JSON.stringify({ password: 'access-test' }), headers: { 'Content-Type': 'application/json', 'x-real-ip': `auth-test-${ip}` } }));
    expect(res.cookies.get(SESSION_COOKIE)?.secure).toBe(true);
  });

  it('GET validates actual cookies and treats malformed encodings as unauthenticated', async () => {
    const token = signSession().token;
    for (const [cookie, verified] of [[`${SESSION_COOKIE}=${token}`, true], [`${SESSION_COOKIE}=%E0%A4%A`, false], ['', false]] as const) {
      const res = await GET(new Request('https://app.example/api/auth', { headers: { cookie } }));
      expect(await res.json()).toEqual({ success: true, verified });
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('logout expires both cookies with the same strict transport attributes', async () => {
    const res = await DELETE(new Request('https://app.example/api/auth', { method: 'DELETE' }));
    for (const name of [SESSION_COOKIE, ADMIN_SESSION_COOKIE]) {
      expect(res.cookies.get(name)).toMatchObject({ value: '', httpOnly: true, sameSite: 'strict', secure: true, maxAge: 0, path: '/' });
    }
  });

  it('rejects cross-origin login and logout without modifying cookies', async () => {
    const res = await POST(login(undefined, { origin: 'https://evil.example' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect((await DELETE(new Request('https://app.example/api/auth', { method: 'DELETE', headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403);
  });
});
