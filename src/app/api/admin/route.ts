import { NextResponse } from 'next/server';
import {
  ADMIN_SESSION_COOKIE, adminSessionExpiryFromCookieHeader, checkAdminPassword, checkRateLimit, clearRateLimit,
  isAdminPasswordConfigured, requestClientIp, sessionCookieOptions, signAdminSession, tokenFromCookieHeader,
} from '@/lib/auth';
import { AUTH_RESPONSE_HEADERS, guardAuthMutation, guardRequest, jsonError } from '@/lib/api-guard';

export const runtime = 'nodejs';

/** Validates both sessions on every read. Never publishes passwords, digests, or signing material. */
export async function GET(req: Request) {
  const access = guardRequest(req);
  if (access) return access;
  const expiresAt = adminSessionExpiryFromCookieHeader(req.headers.get('cookie'));
  return NextResponse.json({
    configured: isAdminPasswordConfigured(), accessVerified: true, verified: expiresAt !== null, expiresAt,
  }, { headers: AUTH_RESPONSE_HEADERS });
}

export async function POST(req: Request) {
  const origin = guardAuthMutation(req);
  if (origin) return origin;
  const access = guardRequest(req);
  if (access) return access;
  if (!isAdminPasswordConfigured()) return jsonError('服务器未设置 ADMINPASSWORD 环境变量，请联系管理员配置', 503);
  const ip = requestClientIp(req);
  if (!checkRateLimit(ip, 'admin')) {
    const res = jsonError('尝试次数过多，请 10 分钟后再试', 429);
    res.headers.set('Retry-After', '600');
    return res;
  }
  let password: string;
  try {
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || !('password' in body) || typeof body.password !== 'string' || body.password.length > 4096) {
      return jsonError('请求格式错误', 400);
    }
    password = body.password;
  } catch {
    return jsonError('请求格式错误', 400);
  }
  if (!checkAdminPassword(password)) return jsonError('管理员密码错误', 403);
  clearRateLimit(ip, 'admin');
  const { token, expiresAt } = signAdminSession(tokenFromCookieHeader(req.headers.get('cookie'))!);
  const res = NextResponse.json({ success: true }, { headers: AUTH_RESPONSE_HEADERS });
  res.cookies.set(ADMIN_SESSION_COOKIE, token, { ...sessionCookieOptions(req), maxAge: Math.floor((expiresAt - Date.now()) / 1000) });
  return res;
}

/** Admin logout affects only the admin cookie; access remains usable. */
export async function DELETE(req: Request) {
  const origin = guardAuthMutation(req);
  if (origin) return origin;
  const res = NextResponse.json({ success: true }, { headers: AUTH_RESPONSE_HEADERS });
  res.cookies.set(ADMIN_SESSION_COOKIE, '', { ...sessionCookieOptions(req), maxAge: 0 });
  return res;
}
