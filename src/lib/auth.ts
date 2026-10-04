import crypto from 'node:crypto';
import { getServerEnv } from './cloudflare-env';

/** Passwords and signing keys stay on the server; access and admin tokens have distinct purposes. */
export const SESSION_COOKIE = 'ltv_session';
export const ADMIN_SESSION_COOKIE = 'ltv_admin_session';
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
type SessionScope = 'access' | 'admin';

export function getPassword(): string {
  return getServerEnv('PASSWORD') || '';
}

export function isPasswordConfigured(): boolean {
  return getPassword().length > 0;
}

export function isAdminPasswordConfigured(): boolean {
  return !!getServerEnv('ADMINPASSWORD');
}

function digest(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest();
}

function checkCredential(input: string, configured: string): boolean {
  if (!configured || typeof input !== 'string') return false;
  return crypto.timingSafeEqual(digest(input), digest(configured));
}

export function checkPassword(input: string): boolean {
  return checkCredential(input, getPassword());
}

export function checkAdminPassword(input: string): boolean {
  return checkCredential(input, getServerEnv('ADMINPASSWORD') || '');
}

function signature(scope: SessionScope, payload: string): string {
  // Include the credential even with PROXY_SECRET set so password rotation revokes old sessions.
  // The admin key cannot be derived from an access password or an access session signature.
  const credential = scope === 'admin' ? getServerEnv('ADMINPASSWORD') || '' : getPassword();
  const key = digest(JSON.stringify(['libretv:session:v1', scope, getServerEnv('PROXY_SECRET') || '', credential]));
  return crypto.createHmac('sha256', key).update(payload).digest('hex');
}

export function signSession(): { token: string; expiresAt: number } {
  if (!isPasswordConfigured()) throw new Error('PASSWORD is not configured');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const payload = `v1.access.${expiresAt}.${crypto.randomBytes(16).toString('hex')}`;
  return { token: `${payload}.${signature('access', payload)}`, expiresAt };
}

function sessionExpiry(scope: SessionScope, token: string | undefined | null, accessToken?: string): number | null {
  if (!isPasswordConfigured() || (scope === 'admin' && !isAdminPasswordConfigured())) return null;
  if (!token || token.length > 256) return null;
  const parts = token.split('.');
  const expectedParts = scope === 'admin' ? 6 : 5;
  if (parts.length !== expectedParts || parts[0] !== 'v1' || parts[1] !== scope) return null;
  if (!/^\d{13}$/.test(parts[2]) || !/^[a-f0-9]{32}$/.test(parts[3])) return null;
  const expiresAt = Number(parts[2]);
  const ttl = scope === 'admin' ? ADMIN_SESSION_TTL_MS : SESSION_TTL_MS;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + ttl) return null;
  if (scope === 'admin') {
    if (!accessToken || !verifySession(accessToken)) return null;
    if (parts[4] !== digest(accessToken).toString('hex')) return null;
  }
  const sig = parts[parts.length - 1];
  if (!/^[a-f0-9]{64}$/.test(sig)) return null;
  const payload = parts.slice(0, -1).join('.');
  return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(signature(scope, payload), 'hex'))
    ? expiresAt
    : null;
}

export function verifySession(token: string | undefined | null): boolean {
  return sessionExpiry('access', token) !== null;
}

/** Admin sessions are bound to the exact access session that authorized their creation. */
export function signAdminSession(accessToken: string): { token: string; expiresAt: number } {
  const accessExpiresAt = sessionExpiry('access', accessToken);
  if (!accessExpiresAt || !isAdminPasswordConfigured()) throw new Error('Access and ADMINPASSWORD are required');
  const expiresAt = Math.min(Date.now() + ADMIN_SESSION_TTL_MS, accessExpiresAt);
  const payload = `v1.admin.${expiresAt}.${crypto.randomBytes(16).toString('hex')}.${digest(accessToken).toString('hex')}`;
  return { token: `${payload}.${signature('admin', payload)}`, expiresAt };
}

export function verifyAdminSession(token: string | undefined | null, accessToken: string | undefined | null): boolean {
  return sessionExpiry('admin', token, accessToken || undefined) !== null;
}

/** Reject malformed encodings and duplicate authentication cookies instead of throwing/ambiguously choosing. */
export function tokenFromCookieHeader(cookieHeader: string | null, name = SESSION_COOKIE): string | null {
  if (!cookieHeader) return null;
  let value: string | null = null;
  for (const cookie of cookieHeader.split(';')) {
    const eq = cookie.indexOf('=');
    if (eq === -1 || cookie.slice(0, eq).trim() !== name) continue;
    if (value !== null) return null;
    try {
      value = decodeURIComponent(cookie.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return value;
}

export function sessionFromCookieHeader(cookieHeader: string | null): boolean {
  return verifySession(tokenFromCookieHeader(cookieHeader));
}

export function adminSessionExpiryFromCookieHeader(cookieHeader: string | null): number | null {
  return sessionExpiry('admin', tokenFromCookieHeader(cookieHeader, ADMIN_SESSION_COOKIE), tokenFromCookieHeader(cookieHeader) || undefined);
}

export function adminSessionFromCookieHeader(cookieHeader: string | null): boolean {
  return adminSessionExpiryFromCookieHeader(cookieHeader) !== null;
}

/** Production always requires HTTPS cookies, including behind a reverse proxy. */
export function sessionCookieOptions(req?: Request) {
  const cookieSecure = getServerEnv('COOKIE_SECURE');
  const secure = process.env.NODE_ENV === 'production' || cookieSecure === 'true' ||
    (cookieSecure !== 'false' && !!req && (
      new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https'
    ));
  return { httpOnly: true, sameSite: 'strict' as const, secure, path: '/' };
}

// Per-process limits are separate for each credential. Bound storage and fail closed when full.
const attemptMap = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_BUCKETS = 10_000;
let nextCleanup = 0;

export function checkRateLimit(ip: string, scope: SessionScope = 'access'): boolean {
  const now = Date.now();
  if (now >= nextCleanup) {
    for (const [key, entry] of attemptMap) {
      if (now >= entry.resetAt) attemptMap.delete(key);
    }
    nextCleanup = now + 60_000;
  }
  const key = JSON.stringify([scope, ip]);
  const entry = attemptMap.get(key);
  if (!entry || now >= entry.resetAt) {
    if (!entry && attemptMap.size >= MAX_BUCKETS) return false;
    attemptMap.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS) return false;
  entry.count += 1;
  return true;
}

export function clearRateLimit(ip: string, scope: SessionScope = 'access'): void {
  attemptMap.delete(JSON.stringify([scope, ip]));
}

export function requestClientIp(req: Request): string {
  // Forwarded IP headers must be overwritten by the deployment's trusted ingress proxy.
  return (req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip')?.trim() || 'unknown').slice(0, 200);
}
