import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { getServerEnv, isWorkerRuntime } from './cloudflare-env';

/** 去掉 URL.hostname 对 IPv6 附加的方括号（"[::1]" → "::1"） */
function stripBrackets(host: string): string {
  return host.trim().replace(/^\[+|\]+$/g, '');
}

/** 展开已由 isIP 验证的 IPv6，包含混合点分十进制和完整八组写法。 */
function ipv6Words(ip: string): number[] {
  const hex = ip.replace(/\d+\.\d+\.\d+\.\d+$/, (v) => {
    const [a, b, c, d] = v.split('.').map(Number);
    return `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  });
  const [left, right] = hex.split('::');
  const a = left ? left.split(':').map((v) => parseInt(v, 16)) : [];
  if (right === undefined) return a;
  const b = right ? right.split(':').map((v) => parseInt(v, 16)) : [];
  return [...a, ...Array<number>(8 - a.length - b.length).fill(0), ...b];
}

/** 判断 IP 是否为私有/回环/链路本地/保留地址（SSRF 防护） */
export function isPrivateIP(ip: string): boolean {
  const v = stripBrackets(ip.trim());
  const family = isIP(v);
  if (family === 4) {
    const [a, b, c] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (family !== 6 || v.includes('%')) return true; // 无效地址/接口作用域不能放行
  const w = ipv6Words(v);
  if (w.slice(0, 5).every((word) => word === 0) && (w[5] === 0 || w[5] === 0xffff)) {
    return isPrivateIP(`${w[6] >>> 8}.${w[6] & 255}.${w[7] >>> 8}.${w[7] & 255}`);
  }
  // 仅全球单播 2000::/3；排除文档地址、Teredo，以及映射到私网的 6to4。
  if ((w[0] & 0xe000) !== 0x2000) return true;
  if (w[0] === 0x2001 && (w[1] === 0 || w[1] === 0x0db8)) return true;
  if (w[0] === 0x3fff && (w[1] & 0xf000) === 0) return true;
  if (w[0] === 0x2002) {
    return isPrivateIP(`${w[1] >>> 8}.${w[1] & 255}.${w[2] >>> 8}.${w[2] & 255}`);
  }
  return false;
}

function isLocalHostname(host: string): boolean {
  return host === 'localhost' || /\.(?:localhost|local|internal|invalid|onion)$/.test(host);
}

/** URL 字面量校验：协议白名单 + 主机名/字面量 IP 黑名单 */
export function isValidProxyUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    const host = stripBrackets(parsed.hostname).toLowerCase().replace(/\.$/, '');
    if (!host || isLocalHostname(host)) return false;
    if (isIP(host) || host.includes(':')) {
      if (isPrivateIP(host)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** DNS 解析后校验所有 A/AAAA 地址。Workers 不支持 lookup，不能以失败为由放行。 */
export async function isBlockedByDNS(urlString: string): Promise<boolean> {
  try {
    if (!isValidProxyUrl(urlString)) return true;
    const hostname = stripBrackets(new URL(urlString).hostname).replace(/\.$/, '');
    if (isIP(hostname)) {
      return isPrivateIP(hostname);
    }
    const results = await Promise.allSettled([dns.resolve4(hostname), dns.resolve6(hostname)]);
    const addresses: string[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') addresses.push(...result.value);
      else if ((result.reason as { code?: string } | null)?.code !== 'ENODATA') {
        return true; // 超时、NXDOMAIN、未实现、DNS 错误均 fail closed
      }
    }
    return addresses.length === 0 || addresses.some(isPrivateIP);
  } catch {
    return true;
  }
}

export type UpstreamVerdict = { ok: true } | { ok: false; reason: string };

/**
 * 出网请求的统一校验入口：字面量校验 + DNS 解析校验。
 *
 * 任何由用户输入驱动的服务端请求（采集站搜索/详情、代理转发）都必须先过这一关，
 * 否则服务器会变成内网探测跳板（/api/search 曾直接用用户传的 source.url 发请求）。
 */
export async function checkUpstreamAllowed(urlString: string): Promise<UpstreamVerdict> {
  if (!isValidProxyUrl(urlString)) {
    return { ok: false, reason: '目标地址不在允许范围内（仅支持公网 http/https）' };
  }
  if (await isBlockedByDNS(urlString)) {
    return { ok: false, reason: '目标地址无法安全解析或解析到私有/保留网络' };
  }
  return { ok: true };
}

/** 直播场景是否放行内网地址（自建 IPTV）；由部署者显式开启 */
export function allowLivePrivate(): boolean {
  return !isWorkerRuntime() && getServerEnv('LIVE_ALLOW_PRIVATE') === '1';
}

/**
 * 直播地址专用校验：协议必须 http(s)，默认仍拒绝内网，但部署者可用
 * LIVE_ALLOW_PRIVATE=1 显式放行（自建 IPTV 常位于内网）。
 *
 * 与点播侧 checkUpstreamAllowed 的区别只在这一处开关：
 * 订阅/播放列表若沿用点播那把尺子，会静默过滤掉内网自建源。
 */
export async function checkLiveUrlAllowed(urlString: string): Promise<UpstreamVerdict> {
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, reason: '直播地址仅支持 http/https 协议' };
    }
  } catch {
    return { ok: false, reason: '无效的直播地址' };
  }
  if (allowLivePrivate()) return { ok: true };
  return checkUpstreamAllowed(urlString);
}
