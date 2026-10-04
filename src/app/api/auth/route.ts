import { NextResponse } from 'next/server';
import {
  ADMIN_SESSION_COOKIE, SESSION_COOKIE, checkPassword, checkRateLimit, clearRateLimit,
  isPasswordConfigured, requestClientIp, sessionCookieOptions, sessionFromCookieHeader, signSession,
} from '@/lib/auth';
import { AUTH_RESPONSE_HEADERS, guardAuthMutation, jsonError } from '@/lib/api-guard';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  const origin = guardAuthMutation(req);
  if (origin) return origin;
  if (!isPasswordConfigured()) return jsonError('服务器未设置 PASSWORD 环境变量，请联系管理员配置', 503);
  const ip = requestClientIp(req);
  if (!checkRateLimit(ip)) {
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
  if (!checkPassword(password)) return jsonError('密码错误', 401);
  clearRateLimit(ip);
  const { token, expiresAt } = signSession();
  const res = NextResponse.json({ success: true }, { headers: AUTH_RESPONSE_HEADERS });
  const options = sessionCookieOptions(req);
  res.cookies.set(SESSION_COOKIE, token, { ...options, maxAge: Math.floor((expiresAt - Date.now()) / 1000) });
  // A fresh access session invalidates any previously bound admin session.
  res.cookies.set(ADMIN_SESSION_COOKIE, '', { ...options, maxAge: 0 });
  return res;
}

export async function GET(req: Request) {
  return NextResponse.json({ success: true, verified: sessionFromCookieHeader(req.headers.get('cookie')) }, { headers: AUTH_RESPONSE_HEADERS });
}

export async function DELETE(req: Request) {
  const origin = guardAuthMutation(req);
  if (origin) return origin;
  const res = NextResponse.json({ success: true }, { headers: AUTH_RESPONSE_HEADERS });
  const options = { ...sessionCookieOptions(req), maxAge: 0 };
  res.cookies.set(SESSION_COOKIE, '', options);
  res.cookies.set(ADMIN_SESSION_COOKIE, '', options);
  return res;
}
