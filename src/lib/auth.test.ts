import crypto from 'node:crypto';
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_SESSION_COOKIE, SESSION_COOKIE, adminSessionExpiryFromCookieHeader, adminSessionFromCookieHeader,
  checkAdminPassword, checkPassword, checkRateLimit, clearRateLimit, isAdminPasswordConfigured,
  sessionCookieOptions, sessionFromCookieHeader, signAdminSession, signSession, tokenFromCookieHeader, verifyAdminSession, verifySession,
} from './auth';

/**
 * 会话鉴权单测：HMAC 签名/校验、过期、防篡改、密码恒定时间比较、登录限流。
 * 纯函数 + 内存状态，不需要网络与 IndexedDB。
 */

const TEST_PASSWORD = 'test-password-123';

beforeAll(() => {
  process.env.PASSWORD = TEST_PASSWORD;
  vi.stubEnv('ADMINPASSWORD', 'admin-only-456');
});

afterAll(() => {
  delete process.env.PASSWORD;
  vi.unstubAllEnvs();
});

afterEach(() => vi.useRealTimers());

describe('signSession / verifySession', () => {
  it(' freshly 签发的会话 token 校验通过', () => {
    const { token, expiresAt } = signSession();
    expect(expiresAt).toBeGreaterThan(Date.now());
    expect(verifySession(token)).toBe(true);
  });

  it('过期会话被拒绝', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { token } = signSession();
    // 快进 91 天（TTL 90 天）
    vi.setSystemTime(new Date('2026-04-02T00:00:00Z'));
    expect(verifySession(token)).toBe(false);
    vi.useRealTimers();
  });

  it('篡改 payload（替换过期时间但沿用旧签名）被拒绝', () => {
    const { token } = signSession();
    const sig = token.slice(token.lastIndexOf('.') + 1);
    // 用与真实 TTL（90 天）不同的偏移构造新 payload，保证签名与 payload 不匹配
    const forged = `${String(Date.now() + 95 * 24 * 3600 * 1000)}.${sig}`;
    expect(verifySession(forged)).toBe(false);
  });

  it('用自算 HMAC 伪造签名也无法通过（密钥派生含盐）', () => {
    // 攻击者知道 PASSWORD 时最常见的伪造路径：按可猜想的派生方式构造签名
    const payload = String(Date.now() + 60_000);
    const naiveSecret = crypto.createHash('sha256').update(TEST_PASSWORD).digest('hex');
    const naive = crypto.createHmac('sha256', naiveSecret).update(payload).digest('hex');
    expect(verifySession(`${payload}.${naive}`)).toBe(false);
  });

  it('格式非法的 token 一律拒绝', () => {
    expect(verifySession(undefined)).toBe(false);
    expect(verifySession('')).toBe(false);
    expect(verifySession('no-dot-token')).toBe(false);
    expect(verifySession('.sig')).toBe(false);
    expect(verifySession('abc.not-hex-sig')).toBe(false);
  });
});

describe('checkPassword', () => {
  it('正确密码通过', () => {
    expect(checkPassword(TEST_PASSWORD)).toBe(true);
  });

  it('错误密码拒绝', () => {
    expect(checkPassword('wrong')).toBe(false);
    expect(checkPassword('')).toBe(false);
  });

  it('未配置 PASSWORD 时一律拒绝', () => {
    const saved = process.env.PASSWORD;
    delete process.env.PASSWORD;
    try {
      expect(checkPassword(TEST_PASSWORD)).toBe(false);
    } finally {
      process.env.PASSWORD = saved;
    }
  });
});

describe('sessionFromCookieHeader', () => {
  it('含有效会话的 Cookie 头通过', () => {
    const { token } = signSession();
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${token}`)).toBe(true);
    expect(sessionFromCookieHeader(`other=1; ${SESSION_COOKIE}=${token}; x=2`)).toBe(true);
  });

  it('缺失 / 篡改 / 无关 Cookie 头拒绝', () => {
    const { token } = signSession();
    expect(sessionFromCookieHeader(null)).toBe(false);
    expect(sessionFromCookieHeader('')).toBe(false);
    expect(sessionFromCookieHeader(`other=1`)).toBe(false);
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${token}x`)).toBe(false);
  });
});

describe('checkRateLimit', () => {
  afterEach(() => {
    clearRateLimit('1.2.3.4');
    clearRateLimit('5.6.7.8');
  });

  it('窗口内允许 MAX_ATTEMPTS 次后拒绝', () => {
    clearRateLimit('1.2.3.4');
    for (let i = 0; i < 10; i++) {
      expect(checkRateLimit('1.2.3.4')).toBe(true);
    }
    expect(checkRateLimit('1.2.3.4')).toBe(false);
  });

  it('不同 IP 互不影响', () => {
    expect(checkRateLimit('5.6.7.8')).toBe(true);
    // 耗尽 1.2.3.4 不影响 5.6.7.8
    for (let i = 0; i < 11; i++) checkRateLimit('1.2.3.4');
    expect(checkRateLimit('5.6.7.8')).toBe(true);
  });

  it('clearRateLimit 解除限制', () => {
    clearRateLimit('1.2.3.4');
    for (let i = 0; i < 11; i++) checkRateLimit('1.2.3.4');
    expect(checkRateLimit('1.2.3.4')).toBe(false);
    clearRateLimit('1.2.3.4');
    expect(checkRateLimit('1.2.3.4')).toBe(true);
  });
});

describe('independent admin sessions', () => {
  it('requires the administrator credential, independently from PASSWORD', () => {
    expect(isAdminPasswordConfigured()).toBe(true);
    expect(checkAdminPassword('admin-only-456')).toBe(true);
    expect(checkAdminPassword(TEST_PASSWORD)).toBe(false);
    expect(checkPassword('admin-only-456')).toBe(false);
  });

  it('signs separate, random scoped sessions and validates both cookies', () => {
    const access = signSession();
    const admin = signAdminSession(access.token);
    const cookies = `${SESSION_COOKIE}=${access.token}; ${ADMIN_SESSION_COOKIE}=${admin.token}`;
    expect(signSession().token).not.toBe(access.token);
    expect(signAdminSession(access.token).token).not.toBe(admin.token);
    expect(verifyAdminSession(admin.token, access.token)).toBe(true);
    expect(adminSessionFromCookieHeader(cookies)).toBe(true);
    expect(adminSessionExpiryFromCookieHeader(cookies)).toBe(admin.expiresAt);
    expect(verifySession(admin.token)).toBe(false);
    expect(verifyAdminSession(access.token, access.token)).toBe(false);
    expect(adminSessionFromCookieHeader(`${ADMIN_SESSION_COOKIE}=${access.token}; ${SESSION_COOKIE}=${access.token}`)).toBe(false);
    expect(adminSessionFromCookieHeader(`${ADMIN_SESSION_COOKIE}=${admin.token}`)).toBe(false);
  });

  it('cannot promote an access signature by replacing its purpose or binding', () => {
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    const accessSignature = access.split('.').at(-1)!;
    const forged = `${admin.slice(0, admin.lastIndexOf('.'))}.${accessSignature}`;
    expect(verifyAdminSession(forged, access)).toBe(false);
    expect(verifyAdminSession(admin.replace('v1.admin', 'v1.access'), access)).toBe(false);
    expect(verifyAdminSession(admin, signSession().token)).toBe(false);
    expect(verifyAdminSession(admin, null)).toBe(false);
  });

  it('expires admin in 12 hours while the access session still works', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const access = signSession().token;
    const admin = signAdminSession(access);
    vi.setSystemTime(admin.expiresAt);
    expect(verifyAdminSession(admin.token, access)).toBe(false);
    expect(verifySession(access)).toBe(true);
  });

  it('admin expiry never outlives the bound access session', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const access = signSession();
    vi.setSystemTime(access.expiresAt - 1000);
    const admin = signAdminSession(access.token);
    expect(admin.expiresAt).toBe(access.expiresAt);
    vi.setSystemTime(access.expiresAt);
    expect(verifyAdminSession(admin.token, access.token)).toBe(false);
  });

  it('fails closed without either configured password, including previously issued sessions', () => {
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    vi.stubEnv('ADMINPASSWORD', '');
    expect(isAdminPasswordConfigured()).toBe(false);
    expect(checkAdminPassword('')).toBe(false);
    expect(verifyAdminSession(admin, access)).toBe(false);
    expect(() => signAdminSession(access)).toThrow();
    vi.stubEnv('ADMINPASSWORD', 'admin-only-456');
    vi.stubEnv('PASSWORD', '');
    expect(verifySession(access)).toBe(false);
    expect(verifyAdminSession(admin, access)).toBe(false);
    expect(() => signSession()).toThrow();
    vi.stubEnv('PASSWORD', TEST_PASSWORD);
  });

  it('password rotation invalidates sessions even with a fixed PROXY_SECRET', () => {
    vi.stubEnv('PROXY_SECRET', 'test-signing-key');
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    vi.stubEnv('ADMINPASSWORD', 'rotated-admin');
    expect(verifyAdminSession(admin, access)).toBe(false);
    expect(verifySession(access)).toBe(true);
    vi.stubEnv('ADMINPASSWORD', 'admin-only-456');
    vi.stubEnv('PASSWORD', 'rotated-access');
    expect(verifySession(access)).toBe(false);
    expect(verifyAdminSession(admin, access)).toBe(false);
    vi.stubEnv('PASSWORD', TEST_PASSWORD);
    vi.stubEnv('PROXY_SECRET', '');
  });

  it('replaces both credentials without accepting previous passwords or sessions', () => {
    const previousAccess = process.env.PASSWORD!;
    const previousAdmin = process.env.ADMINPASSWORD!;
    const oldAccessSession = signSession().token;
    const oldAdminSession = signAdminSession(oldAccessSession).token;
    try {
      process.env.PASSWORD = 'replacement-access-fixture';
      process.env.ADMINPASSWORD = 'replacement-admin-fixture';
      expect(checkPassword(previousAccess)).toBe(false);
      expect(checkAdminPassword(previousAdmin)).toBe(false);
      expect(verifySession(oldAccessSession)).toBe(false);
      expect(verifyAdminSession(oldAdminSession, oldAccessSession)).toBe(false);
      expect(checkPassword(process.env.PASSWORD)).toBe(true);
      expect(checkAdminPassword(process.env.ADMINPASSWORD)).toBe(true);
      expect(checkAdminPassword(process.env.PASSWORD)).toBe(false);
      expect(checkPassword(process.env.ADMINPASSWORD)).toBe(false);
      const access = signSession().token;
      const admin = signAdminSession(access).token;
      expect(verifySession(access)).toBe(true);
      expect(verifyAdminSession(admin, access)).toBe(true);
    } finally {
      process.env.PASSWORD = previousAccess;
      process.env.ADMINPASSWORD = previousAdmin;
    }
  });

  it('access password knowledge cannot derive an admin signing key', () => {
    const access = signSession().token;
    const admin = signAdminSession(access).token;
    const payload = admin.slice(0, admin.lastIndexOf('.'));
    const key = crypto.createHash('sha256').update(JSON.stringify(['libretv:session:v1', 'admin', '', TEST_PASSWORD])).digest();
    const forged = `${payload}.${crypto.createHmac('sha256', key).update(payload).digest('hex')}`;
    expect(verifyAdminSession(forged, access)).toBe(false);
  });

  it('rejects malformed, noncanonical and oversized tokens and cookie encodings', () => {
    const access = signSession().token;
    for (const token of [access.replace('v1.access', 'v1.admin'), `${access}x`, access.replace(/\d{13}/, '$&junk'), 'x'.repeat(300), '%E0%A4%A']) {
      expect(verifySession(token)).toBe(false);
    }
    expect(() => sessionFromCookieHeader(`${SESSION_COOKIE}=%E0%A4%A`)).not.toThrow();
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=%E0%A4%A`)).toBe(false);
    expect(tokenFromCookieHeader(`${SESSION_COOKIE}=${access}; ${SESSION_COOKIE}=${access}`)).toBeNull();
    expect(sessionFromCookieHeader(`${SESSION_COOKIE}=${encodeURIComponent(access)}`)).toBe(true);
  });
});

describe('credential-scoped rate limits', () => {
  afterEach(() => {
    clearRateLimit('scoped');
    clearRateLimit('scoped', 'admin');
    clearRateLimit('window-test');
  });

  it('successful access authentication cannot reset the admin limit', () => {
    for (let i = 0; i < 10; i++) expect(checkRateLimit('scoped', 'admin')).toBe(true);
    expect(checkRateLimit('scoped', 'admin')).toBe(false);
    expect(checkRateLimit('scoped')).toBe(true);
    clearRateLimit('scoped');
    expect(checkRateLimit('scoped', 'admin')).toBe(false);
  });

  it('allows attempts again at the exact window boundary', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) expect(checkRateLimit('window-test')).toBe(true);
    expect(checkRateLimit('window-test')).toBe(false);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(checkRateLimit('window-test')).toBe(true);
  });
});

describe('cookie transport policy', () => {
  it('uses HttpOnly, Strict SameSite, and Secure in production despite an insecure override', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COOKIE_SECURE', 'false');
    expect(sessionCookieOptions(new Request('http://internal/api/auth'))).toEqual({ httpOnly: true, sameSite: 'strict', secure: true, path: '/' });
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COOKIE_SECURE', '');
  });
});
