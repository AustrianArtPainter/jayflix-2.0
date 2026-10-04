import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, POST } from './route';
import { POST as accessLogin } from '../auth/route';
import {
  ADMIN_SESSION_COOKIE, SESSION_COOKIE, clearRateLimit, signAdminSession, signSession, verifyAdminSession, verifySession,
} from '@/lib/auth';

let ip = 0;
let access: string;
beforeEach(() => {
  vi.stubEnv('PASSWORD', 'access-test');
  vi.stubEnv('ADMINPASSWORD', 'admin-test');
  vi.stubEnv('COOKIE_SECURE', '');
  vi.stubEnv('NODE_ENV', 'test');
  clearRateLimit(`admin-test-${++ip}`, 'admin');
  clearRateLimit(`admin-test-${ip}`);
  access = signSession().token;
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

function request(method = 'GET', cookie = `${SESSION_COOKIE}=${access}`, body: unknown = { password: 'admin-test' }, extra?: Record<string, string>) {
  return new Request('https://app.example/api/admin', {
    method, headers: { cookie, 'Content-Type': 'application/json', 'x-real-ip': `admin-test-${ip}`, ...extra },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
}

describe('/api/admin', () => {
  it('requires a valid access session before checking or verifying an admin password', async () => {
    expect((await GET(request('GET', ''))).status).toBe(401);
    expect((await POST(request('POST', ''))).status).toBe(401);
    expect((await POST(request('POST', `${SESSION_COOKIE}=%E0%A4%A`))).status).toBe(401);
    vi.stubEnv('PASSWORD', '');
    expect((await POST(request('POST'))).status).toBe(503);
    expect((await GET(request())).status).toBe(503);
  });

  it('reports configuration as booleans and never treats access cookies as admin sessions', async () => {
    const res = await GET(request('GET', `${SESSION_COOKIE}=${access}; ${ADMIN_SESSION_COOKIE}=${access}`));
    expect(await res.json()).toEqual({ configured: true, accessVerified: true, verified: false, expiresAt: null });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('rejects PASSWORD and issues a separate cookie only for ADMINPASSWORD', async () => {
    expect((await POST(request('POST', undefined, { password: 'access-test' }))).status).toBe(403);
    const res = await POST(request('POST'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    const admin = res.cookies.get(ADMIN_SESSION_COOKIE);
    expect(admin).toMatchObject({ httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
    expect(admin?.maxAge).toBeGreaterThanOrEqual(12 * 60 * 60 - 1);
    expect(admin?.maxAge).toBeLessThanOrEqual(12 * 60 * 60);
    expect(verifyAdminSession(admin?.value, access)).toBe(true);
    expect(verifySession(admin?.value)).toBe(false);
    const state = await GET(request('GET', `${SESSION_COOKIE}=${access}; ${ADMIN_SESSION_COOKIE}=${admin!.value}`));
    expect(await state.json()).toMatchObject({ configured: true, accessVerified: true, verified: true, expiresAt: expect.any(Number) });
  });

  it('cannot use an admin session with a newly issued access session', async () => {
    const admin = signAdminSession(access).token;
    const newAccess = signSession().token;
    const res = await GET(request('GET', `${SESSION_COOKIE}=${newAccess}; ${ADMIN_SESSION_COOKIE}=${admin}`));
    expect(await res.json()).toMatchObject({ verified: false });
  });

  it('missing ADMINPASSWORD disables the entire settings authorization without blocking access', async () => {
    vi.stubEnv('ADMINPASSWORD', '');
    expect((await POST(request('POST'))).status).toBe(503);
    expect(await (await GET(request())).json()).toEqual({ configured: false, accessVerified: true, verified: false, expiresAt: null });
    expect(verifySession(access)).toBe(true);
  });

  it.each([null, {}, [], { password: true }, { password: ['admin-test'] }, { password: 'x'.repeat(4097) }])('rejects invalid password input %j', async (body) => {
    const res = await POST(request('POST', undefined, body));
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('invalid JSON fails without issuing a cookie', async () => {
    const res = await POST(new Request('https://app.example/api/admin', { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${access}`, 'x-real-ip': `admin-test-${ip}` }, body: '{' }));
    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('successful access logins cannot clear exhausted administrator attempts', async () => {
    for (let i = 0; i < 10; i++) expect((await POST(request('POST', undefined, { password: 'wrong' }))).status).toBe(403);
    const login = await accessLogin(new Request('https://app.example/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': `admin-test-${ip}` }, body: JSON.stringify({ password: 'access-test' }) }));
    expect(login.status).toBe(200);
    const limited = await POST(request('POST', `${SESSION_COOKIE}=${login.cookies.get(SESSION_COOKIE)!.value}`));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('600');
  });

  it('enforces secure production cookies without trusting a false override or HTTP proxy URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_SECURE', 'false');
    const res = await POST(new Request('http://internal/api/admin', { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${access}`, 'Content-Type': 'application/json', 'x-real-ip': `admin-test-${ip}` }, body: JSON.stringify({ password: 'admin-test' }) }));
    expect(res.cookies.get(ADMIN_SESSION_COOKIE)?.secure).toBe(true);
  });

  it('expired and malformed admin cookies are rejected by GET', async () => {
    const admin = signAdminSession(access);
    vi.useFakeTimers();
    vi.setSystemTime(admin.expiresAt);
    for (const value of [admin.token, '%E0%A4%A']) {
      const res = await GET(request('GET', `${SESSION_COOKIE}=${access}; ${ADMIN_SESSION_COOKIE}=${value}`));
      expect(await res.json()).toMatchObject({ verified: false, expiresAt: null });
    }
  });

  it('admin logout clears ONLY its own cookie, including after access expires', async () => {
    const res = await DELETE(request('DELETE', ''));
    expect(res.status).toBe(200);
    expect(res.cookies.get(ADMIN_SESSION_COOKIE)).toMatchObject({ value: '', maxAge: 0, httpOnly: true, sameSite: 'strict', secure: true });
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(verifySession(access)).toBe(true);
  });

  it('rejects cross-origin admin login/logout without writing any cookie', async () => {
    for (const res of [await POST(request('POST', undefined, undefined, { origin: 'https://evil.example' })), await DELETE(request('DELETE', undefined, undefined, { 'sec-fetch-site': 'cross-site' }))]) {
      expect(res.status).toBe(403);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
  });
});
