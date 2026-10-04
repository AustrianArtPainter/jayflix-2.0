import crypto from 'node:crypto';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_SESSION_COOKIE, SESSION_COOKIE, checkAdminPassword, checkPassword, clearRateLimit,
  isAdminPasswordConfigured, isPasswordConfigured, sessionCookieOptions, signAdminSession,
  signSession, verifyAdminSession, verifySession,
} from '@/lib/auth';
import { guardAdminRequest, guardRequest } from '@/lib/api-guard';
import { DELETE as logout, GET as accessState, POST as login } from './route';
import { DELETE as adminLogout, GET as adminState, POST as adminLogin } from '../admin/route';
import { GET as status } from '../status/route';

// Exercise the real request-time reader, not a mocked getServerEnv implementation.
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: vi.fn() }));
vi.mock('@/lib/env-sources', () => ({ getEnvSources: () => [] }));
vi.mock('@/lib/env-live-sources', () => ({ getEnvLiveSources: () => [] }));
vi.mock('@/lib/env-subscriptions', () => ({ getEnvSubscriptions: () => [] }));
vi.mock('@/lib/env-recommend-source', () => ({ getEnvRecommendSource: () => null }));
vi.mock('@/lib/env-image-mode', () => ({ getEnvImageMode: () => null }));

const privateEnvNames = ['PASSWORD', 'ADMINPASSWORD', 'PROXY_SECRET', 'COOKIE_SECURE'] as const;
let bindings: Record<string, unknown>;
let requestNumber = 0;
let clientIp: string;

beforeEach(() => {
  // No .env files or build-time credentials: these exist only on the Worker request.
  for (const name of privateEnvNames) vi.stubEnv(name, undefined);
  vi.stubEnv('NODE_ENV', 'test');
  bindings = {
    PASSWORD: 'worker-access-fixture', ADMINPASSWORD: 'worker-admin-fixture',
    PROXY_SECRET: 'worker-signing-fixture', COOKIE_SECURE: 'true',
  };
  vi.mocked(getCloudflareContext).mockImplementation(() => ({ env: bindings }) as never);
  clientIp = `worker-auth-fixture-${++requestNumber}`;
  clearRateLimit(clientIp);
  clearRateLimit(clientIp, 'admin');
});

afterEach(() => {
  clearRateLimit(clientIp);
  clearRateLimit(clientIp, 'admin');
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function request(path: 'auth' | 'admin' | 'status', method = 'GET', cookie = '', password?: string) {
  return new Request(`http://worker-internal/api/${path}`, {
    method,
    headers: { cookie, 'Content-Type': 'application/json', 'x-real-ip': clientIp },
    ...(method === 'POST' ? { body: JSON.stringify({ password }) } : {}),
  });
}

function cookies(access: string, admin?: string) {
  return `${SESSION_COOKIE}=${access}${admin ? `; ${ADMIN_SESSION_COOKIE}=${admin}` : ''}`;
}

describe('authentication with request-time Worker bindings', () => {
  it('supports independent access/admin login, state, guards, and logout without process.env secrets', async () => {
    for (const name of privateEnvNames) expect(process.env[name]).toBeUndefined();
    const initialState = await status(request('status'));
    expect(await initialState.json()).toMatchObject({ passwordRequired: true, verified: false, adminPasswordConfigured: true });
    expect((await login(request('auth', 'POST', '', 'worker-admin-fixture'))).status).toBe(401);

    const accessResponse = await login(request('auth', 'POST', '', 'worker-access-fixture'));
    expect(accessResponse.status).toBe(200);
    expect(await accessResponse.json()).toEqual({ success: true });
    const accessCookie = accessResponse.cookies.get(SESSION_COOKIE)!;
    expect(accessCookie).toMatchObject({ httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
    expect(verifySession(accessCookie.value)).toBe(true);
    expect(await (await accessState(request('auth', 'GET', cookies(accessCookie.value)))).json()).toEqual({ success: true, verified: true });
    expect(await (await status(request('status', 'GET', cookies(accessCookie.value)))).json()).toMatchObject({ verified: true, adminPasswordConfigured: true });
    expect(guardRequest(request('status', 'GET', cookies(accessCookie.value)))).toBeNull();
    expect(guardAdminRequest(request('admin', 'GET', cookies(accessCookie.value)))?.status).toBe(403);
    expect(await (await adminState(request('admin', 'GET', cookies(accessCookie.value)))).json()).toEqual({ configured: true, accessVerified: true, verified: false, expiresAt: null });
    expect((await adminLogin(request('admin', 'POST', cookies(accessCookie.value), 'worker-access-fixture'))).status).toBe(403);

    const adminResponse = await adminLogin(request('admin', 'POST', cookies(accessCookie.value), 'worker-admin-fixture'));
    expect(adminResponse.status).toBe(200);
    expect(await adminResponse.json()).toEqual({ success: true });
    expect(adminResponse.cookies.get(SESSION_COOKIE)).toBeUndefined();
    const adminCookie = adminResponse.cookies.get(ADMIN_SESSION_COOKIE)!;
    expect(adminCookie).toMatchObject({ httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
    const authorizedCookies = cookies(accessCookie.value, adminCookie.value);
    expect(verifyAdminSession(adminCookie.value, accessCookie.value)).toBe(true);
    expect(verifySession(adminCookie.value)).toBe(false);
    expect(verifyAdminSession(accessCookie.value, accessCookie.value)).toBe(false);
    expect(verifyAdminSession(adminCookie.value, signSession().token)).toBe(false);
    expect(guardAdminRequest(request('admin', 'GET', authorizedCookies))).toBeNull();
    const verifiedState = await adminState(request('admin', 'GET', authorizedCookies));
    const body = await verifiedState.json();
    expect(body).toMatchObject({ configured: true, accessVerified: true, verified: true, expiresAt: expect.any(Number) });
    expect(JSON.stringify(body)).not.toMatch(/worker-access-fixture|worker-admin-fixture|worker-signing-fixture|digest|hash|secret/i);
    expect(verifiedState.headers.get('cache-control')).toBe('no-store');

    const adminLogoutResponse = await adminLogout(request('admin', 'DELETE', authorizedCookies));
    expect(adminLogoutResponse.cookies.get(SESSION_COOKIE)).toBeUndefined();
    expect(adminLogoutResponse.cookies.get(ADMIN_SESSION_COOKIE)).toMatchObject({ value: '', maxAge: 0, httpOnly: true, sameSite: 'strict', secure: true });
    const logoutResponse = await logout(request('auth', 'DELETE', authorizedCookies));
    for (const name of [SESSION_COOKIE, ADMIN_SESSION_COOKIE]) {
      expect(logoutResponse.cookies.get(name)).toMatchObject({ value: '', maxAge: 0, httpOnly: true, sameSite: 'strict', secure: true });
    }
  });

  it('prefers all four runtime values over conflicting Node/build environment values', async () => {
    vi.stubEnv('PASSWORD', 'stale-build-access');
    vi.stubEnv('ADMINPASSWORD', 'stale-build-admin');
    vi.stubEnv('PROXY_SECRET', 'stale-build-signing');
    vi.stubEnv('COOKIE_SECURE', 'false');
    expect(checkPassword('worker-access-fixture')).toBe(true);
    expect(checkPassword('stale-build-access')).toBe(false);
    expect(checkAdminPassword('worker-admin-fixture')).toBe(true);
    expect(checkAdminPassword('stale-build-admin')).toBe(false);
    expect(sessionCookieOptions(request('auth')).secure).toBe(true);

    const access = signSession().token;
    const admin = signAdminSession(access).token;
    // Changing only Node env cannot revoke Worker sessions; changing bindings must.
    for (const name of privateEnvNames) vi.stubEnv(name, 'another-build-value');
    expect(verifySession(access)).toBe(true);
    expect(verifyAdminSession(admin, access)).toBe(true);
    bindings.PROXY_SECRET = 'rotated-worker-signing';
    expect(verifySession(access)).toBe(false);
    expect(verifyAdminSession(admin, access)).toBe(false);
  });

  it.each([undefined, '', { secret: 'invalid-binding' }])('fails closed for missing/invalid Worker PASSWORD %j despite a stale Node password', async (missing) => {
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    vi.stubEnv('PASSWORD', 'worker-access-fixture');
    bindings.PASSWORD = missing;
    expect(isPasswordConfigured()).toBe(false);
    expect(checkPassword('worker-access-fixture')).toBe(false);
    expect(verifySession(access)).toBe(false);
    expect(verifyAdminSession(admin, access)).toBe(false);
    expect(() => signSession()).toThrow('PASSWORD');
    const authorizedCookies = cookies(access, admin);
    expect(guardRequest(request('status', 'GET', authorizedCookies))?.status).toBe(503);
    expect(guardAdminRequest(request('admin', 'GET', authorizedCookies))?.status).toBe(503);
    expect((await login(request('auth', 'POST', '', 'worker-access-fixture'))).status).toBe(503);
    expect((await adminLogin(request('admin', 'POST', authorizedCookies, 'worker-admin-fixture'))).status).toBe(503);
    expect((await adminState(request('admin', 'GET', authorizedCookies))).status).toBe(503);
    expect(await (await accessState(request('auth', 'GET', authorizedCookies))).json()).toMatchObject({ verified: false });
    expect(await (await status(request('status', 'GET', authorizedCookies))).json()).toMatchObject({ passwordRequired: false, verified: false, defaultSources: [], defaultLiveSources: [], defaultSubscriptions: [] });
  });

  it.each([undefined, '', { secret: 'invalid-binding' }])('locks admin only for missing/invalid Worker ADMINPASSWORD %j despite a stale Node admin password', async (missing) => {
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    vi.stubEnv('ADMINPASSWORD', 'worker-admin-fixture');
    bindings.ADMINPASSWORD = missing;
    expect(isAdminPasswordConfigured()).toBe(false);
    expect(checkAdminPassword('worker-admin-fixture')).toBe(false);
    expect(verifySession(access)).toBe(true);
    expect(verifyAdminSession(admin, access)).toBe(false);
    expect(() => signAdminSession(access)).toThrow('ADMINPASSWORD');
    const authorizedCookies = cookies(access, admin);
    expect(guardRequest(request('status', 'GET', authorizedCookies))).toBeNull();
    expect(guardAdminRequest(request('admin', 'GET', authorizedCookies))?.status).toBe(503);
    expect((await adminLogin(request('admin', 'POST', authorizedCookies, 'worker-admin-fixture'))).status).toBe(503);
    expect(await (await adminState(request('admin', 'GET', authorizedCookies))).json()).toEqual({ configured: false, accessVerified: true, verified: false, expiresAt: null });
    expect(await (await status(request('status', 'GET', authorizedCookies))).json()).toMatchObject({ passwordRequired: true, verified: true, adminPasswordConfigured: false });
  });

  it('revokes only admin on request-time ADMINPASSWORD rotation with fixed PROXY_SECRET', async () => {
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    bindings = { ...bindings, ADMINPASSWORD: 'next-worker-admin' };
    expect(checkAdminPassword('worker-admin-fixture')).toBe(false);
    expect(checkAdminPassword('next-worker-admin')).toBe(true);
    expect(verifySession(access)).toBe(true);
    expect(verifyAdminSession(admin, access)).toBe(false);
    expect(guardAdminRequest(request('admin', 'GET', cookies(access, admin)))?.status).toBe(403);
    expect(await (await adminState(request('admin', 'GET', cookies(access, admin)))).json()).toMatchObject({ verified: false });
    const response = await adminLogin(request('admin', 'POST', cookies(access), 'next-worker-admin'));
    expect(response.status).toBe(200);
    expect(verifyAdminSession(response.cookies.get(ADMIN_SESSION_COOKIE)?.value, access)).toBe(true);
  });

  it('revokes access and its bound admin on request-time PASSWORD rotation with fixed PROXY_SECRET', async () => {
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    bindings = { ...bindings, PASSWORD: 'next-worker-access' };
    expect(checkPassword('worker-access-fixture')).toBe(false);
    expect(checkPassword('next-worker-access')).toBe(true);
    expect(verifySession(access)).toBe(false);
    expect(verifyAdminSession(admin, access)).toBe(false);
    expect(guardRequest(request('status', 'GET', cookies(access, admin)))?.status).toBe(401);
    expect((await adminState(request('admin', 'GET', cookies(access, admin)))).status).toBe(401);
    expect(await (await status(request('status', 'GET', cookies(access, admin)))).json()).toMatchObject({ verified: false });
    const response = await login(request('auth', 'POST', '', 'next-worker-access'));
    expect(response.status).toBe(200);
    expect(verifySession(response.cookies.get(SESSION_COOKIE)?.value)).toBe(true);
  });

  it.each([undefined, '', { secret: 'invalid-binding' }])('does not resurrect stale Node signing material when Worker PROXY_SECRET is removed/invalid %j', (missing) => {
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    vi.stubEnv('PROXY_SECRET', 'worker-signing-fixture');
    bindings.PROXY_SECRET = missing;
    expect(verifySession(access)).toBe(false);
    expect(verifyAdminSession(admin, access)).toBe(false);
    // PROXY_SECRET is optional: scoped keys still include the current credential.
    const nextAccess = signSession().token;
    const nextAdmin = signAdminSession(nextAccess).token;
    expect(verifySession(nextAccess)).toBe(true);
    expect(verifyAdminSession(nextAdmin, nextAccess)).toBe(true);
    const payload = nextAdmin.slice(0, nextAdmin.lastIndexOf('.'));
    const guessedKey = crypto.createHash('sha256').update(JSON.stringify(['libretv:session:v1', 'admin', '', 'worker-access-fixture'])).digest();
    const forged = `${payload}.${crypto.createHmac('sha256', guessedKey).update(payload).digest('hex')}`;
    expect(verifyAdminSession(forged, nextAccess)).toBe(false);
  });

  it('does not carry credentials across different Worker request contexts', () => {
    const firstAccess = signSession().token;
    const firstAdmin = signAdminSession(firstAccess).token;
    bindings = { PASSWORD: 'other-worker-access', ADMINPASSWORD: 'other-worker-admin', PROXY_SECRET: 'other-worker-signing' };
    expect(checkPassword('worker-access-fixture')).toBe(false);
    expect(checkAdminPassword('worker-admin-fixture')).toBe(false);
    expect(verifySession(firstAccess)).toBe(false);
    expect(verifyAdminSession(firstAdmin, firstAccess)).toBe(false);
    const nextAccess = signSession().token;
    expect(verifyAdminSession(signAdminSession(nextAccess).token, nextAccess)).toBe(true);
  });

  it.each([
    ['true', 'false', 'http:', true],
    ['false', 'true', 'http:', false],
    [undefined, 'true', 'http:', false],
    [undefined, 'false', 'https:', true],
  ])('uses runtime COOKIE_SECURE=%s over Node=%s on %s', (runtimeValue, nodeValue, protocol, secure) => {
    bindings.COOKIE_SECURE = runtimeValue;
    vi.stubEnv('COOKIE_SECURE', nodeValue);
    expect(sessionCookieOptions(new Request(`${protocol}//worker.example/api/auth`))).toEqual({ httpOnly: true, sameSite: 'strict', secure, path: '/' });
  });

  it('always issues secure access/admin cookies in production even when Worker COOKIE_SECURE is false', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    bindings.COOKIE_SECURE = 'false';
    const accessResponse = await login(request('auth', 'POST', '', 'worker-access-fixture'));
    const access = accessResponse.cookies.get(SESSION_COOKIE)!;
    expect(access.secure).toBe(true);
    const adminResponse = await adminLogin(request('admin', 'POST', cookies(access.value), 'worker-admin-fixture'));
    expect(adminResponse.cookies.get(ADMIN_SESSION_COOKIE)?.secure).toBe(true);
    expect((await logout(request('auth', 'DELETE'))).cookies.get(SESSION_COOKIE)?.secure).toBe(true);
    expect((await adminLogout(request('admin', 'DELETE'))).cookies.get(ADMIN_SESSION_COOKIE)?.secure).toBe(true);
  });

  it('retains Node/Docker authentication when no Cloudflare request context exists', async () => {
    vi.mocked(getCloudflareContext).mockImplementation(() => { throw new Error('No Worker context'); });
    vi.stubEnv('PASSWORD', 'node-access-fixture');
    vi.stubEnv('ADMINPASSWORD', 'node-admin-fixture');
    vi.stubEnv('PROXY_SECRET', 'node-signing-fixture');
    vi.stubEnv('COOKIE_SECURE', 'true');
    expect(checkPassword('node-access-fixture')).toBe(true);
    expect(checkAdminPassword('node-admin-fixture')).toBe(true);
    expect(checkPassword('worker-access-fixture')).toBe(false);
    const accessResponse = await login(request('auth', 'POST', '', 'node-access-fixture'));
    expect(accessResponse.status).toBe(200);
    const access = accessResponse.cookies.get(SESSION_COOKIE)!;
    expect(access.secure).toBe(true);
    const adminResponse = await adminLogin(request('admin', 'POST', cookies(access.value), 'node-admin-fixture'));
    expect(adminResponse.status).toBe(200);
    expect(verifyAdminSession(adminResponse.cookies.get(ADMIN_SESSION_COOKIE)?.value, access.value)).toBe(true);
  });
});
