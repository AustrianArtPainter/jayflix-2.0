import { NextResponse } from 'next/server';
import { adminSessionFromCookieHeader, isAdminPasswordConfigured, isPasswordConfigured, sessionFromCookieHeader } from './auth';

export const AUTH_RESPONSE_HEADERS = { 'Cache-Control': 'no-store', Vary: 'Cookie' };

/** API Route 共享守卫：未配置密码返回 503，未登录返回 401 */
export function guardRequest(req: Request): NextResponse | null {
  if (!isPasswordConfigured()) {
    return NextResponse.json(
      { error: '服务器未设置 PASSWORD 环境变量' },
      { status: 503, headers: AUTH_RESPONSE_HEADERS }
    );
  }
  if (!sessionFromCookieHeader(req.headers.get('cookie'))) {
    return jsonError('未登录', 401);
  }
  return null;
}

export function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: AUTH_RESPONSE_HEADERS });
}

/** Reusable server guard: access alone never authorizes an administrator operation. */
export function guardAdminRequest(req: Request): NextResponse | null {
  const access = guardRequest(req);
  if (access) return access;
  if (!isAdminPasswordConfigured()) return jsonError('服务器未设置 ADMINPASSWORD 环境变量', 503);
  if (!adminSessionFromCookieHeader(req.headers.get('cookie'))) return jsonError('需要管理员验证', 403);
  return null;
}

/** Prevent browser cross-origin login/logout requests; non-browser clients may omit Origin. */
export function guardAuthMutation(req: Request): NextResponse | null {
  if (req.headers.get('sec-fetch-site') === 'cross-site') return jsonError('不允许跨站请求', 403);
  const origin = req.headers.get('origin');
  if (!origin) return null;
  try {
    const url = new URL(req.url);
    const host = req.headers.get('host') || url.host;
    const protocol = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || url.protocol.slice(0, -1);
    if (origin === `${protocol}://${host}` && /^https?$/.test(protocol)) return null;
  } catch {
    // Invalid origins fail closed.
  }
  return jsonError('不允许跨站请求', 403);
}
