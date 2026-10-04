import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { checkLiveUrlAllowed } from '@/lib/ssrf';
import { fetchUpstream } from '@/lib/fetch-utils';
import { getLiveCache, setLiveCache } from '@/lib/live-cache';
import { currentAndNext, estimateXmltvBytes, getXmltvLimits, parseXmltv, XmltvLimitError } from '@/lib/xmltv';
import { readBoundedBody } from '@/lib/bounded-body';
import type { EpgProgram } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** XMLTV 文件较大，放宽抓取超时 */
const FETCH_TIMEOUT_MS = 30_000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 拉取并解析 XMLTV 节目单（支持 gzip）。
 * GET /api/live/epg?url=<xmltv>&channel=<tvgId>&force=1
 * 解析结果（按频道索引、24h 时间窗裁剪）整体缓存 6 小时；单频道按需查询。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const url = sp.get('url')?.trim();
  const channel = sp.get('channel')?.trim();
  if (!url || !channel) return jsonError('缺少 url 或 channel 参数', 400);
  const force = sp.get('force') === '1';

  // 直播专用校验 + allowPrivate：与 playlist/stream/probe 同一把尺子，
  // LIVE_ALLOW_PRIVATE=1 时内网自建 IPTV 的 XMLTV 节目单才能拉取
  const verdict = await checkLiveUrlAllowed(url);
  if (!verdict.ok) return jsonError(verdict.reason, 403);

  const key = `live:epg:${url}`;
  let programMap: Map<string, EpgProgram[]> | undefined = force ? undefined : getLiveCache(key);
  if (!programMap) {
    try {
      const res = await fetchUpstream(url, { timeoutMs: FETCH_TIMEOUT_MS, retries: 0, allowPrivate: true });
      if (!res.ok) {
        return jsonError(`节目单地址请求失败: ${res.status}`, 502);
      }
      const limits = getXmltvLimits();
      // Validate announced sizes too, but never trust Content-Length instead of counting chunks.
      const announced = res.headers.get('content-length');
      if (announced && /^\d+$/.test(announced) && Number(announced) > limits.maxInputBytes) {
        await res.body?.cancel();
        throw new XmltvLimitError(`节目单输入超过 ${limits.maxInputBytes} 字节限制`);
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedBody(res, limits.maxInputBytes);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('上游文档超过 ')) {
          throw new XmltvLimitError(`节目单输入超过 ${limits.maxInputBytes} 字节限制`);
        }
        throw error;
      }
      // Reuse the bounded input buffer; gzip output has its own allocation cap in parseXmltv.
      const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      programMap = parseXmltv(buf, WINDOW_MS, Date.now(), limits);
      setLiveCache(key, programMap, CACHE_TTL_MS, estimateXmltvBytes(programMap));
    } catch (err) {
      return jsonError(`节目单地址请求失败: ${err instanceof Error ? err.message : '未知错误'}`, err instanceof XmltvLimitError ? 413 : 502);
    }
  }

  const programs = programMap.get(channel) ?? [];
  const { current, next } = currentAndNext(programs);

  return NextResponse.json(
    { channelId: channel, current, next, programs },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
