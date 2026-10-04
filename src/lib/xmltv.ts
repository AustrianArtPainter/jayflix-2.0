import { gunzipSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import type { EpgProgram } from './types';
import { getServerEnv, isWorkerRuntime } from './cloudflare-env';

/**
 * XMLTV 节目单解析。
 *
 * XMLTV 文件常达数十 MB，这里不做完整 DOM 解析，而是单趟正则扫描
 * `<programme ...>` 节点，解析后按频道索引、按时间窗裁剪并丢弃原始文本，
 * 避免内存中同时持有原始 XML 与解析结果。
 *
 * 时间格式：`20240101120000 +0800`（秒可带毫秒小数，时区可省略或为 Z / ±hhmm）。
 */

const PROGRAMME_RE = /<programme\s+([^>]*?)\/>|<programme\s+([^>]*?)>([\s\S]*?)<\/programme>/g;
const ATTR_RE = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
const TITLE_RE = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i;
const DESC_RE = /<desc(?:\s[^>]*)?>([\s\S]*?)<\/desc>/i;

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MIB = 1024 * 1024;

export interface XmltvLimits {
  maxInputBytes: number;
  maxExpandedBytes: number;
  maxPrograms: number;
  maxParsedBytes: number;
}

export class XmltvLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmltvLimitError';
  }
}

function byteLimit(name: string, fallback: number, maximum: number): number {
  const raw = getServerEnv(name);
  if (!raw || !/^[1-9]\d*$/.test(raw)) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.min(value, maximum) : fallback;
}

/** Workers hard caps protect the shared 128MB isolate; Node can explicitly raise metadata limits. */
export function getXmltvLimits(): XmltvLimits {
  const worker = isWorkerRuntime();
  return {
    maxInputBytes: byteLimit('EPG_MAX_INPUT_BYTES', 4 * MIB, worker ? 4 * MIB : 16 * MIB),
    maxExpandedBytes: byteLimit('EPG_MAX_EXPANDED_BYTES', 8 * MIB, worker ? 8 * MIB : 64 * MIB),
    maxPrograms: byteLimit('EPG_MAX_PROGRAMS', 20_000, worker ? 20_000 : 100_000),
    maxParsedBytes: byteLimit('EPG_MAX_PARSED_BYTES', 8 * MIB, worker ? 8 * MIB : 32 * MIB),
  };
}

function programBytes(program: EpgProgram): number {
  // Conservative object/array overhead plus UTF-16 strings, including duplicate channel references.
  return 256 + 2 * (program.channelId.length + program.title.length + (program.desc?.length ?? 0));
}

/** Copy short retained strings so V8 slices cannot keep the entire expanded XML alive in cache. */
function retainedText(value: string): string {
  return Buffer.from(value, 'utf8').toString('utf8');
}

export function estimateXmltvBytes(programs: Map<string, EpgProgram[]>): number {
  let bytes = 128;
  for (const [channel, list] of programs) {
    bytes += 256 + channel.length * 2;
    for (const program of list) bytes += programBytes(program);
  }
  return bytes;
}

/** 安全解码码点：畸形实体（越界/NaN）返回空串而非抛 RangeError，避免单条脏数据毁掉整份 EPG */
function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** 解析 XMLTV 实体（含 CDATA 与数字实体） */
function decodeXmlText(raw: string): string {
  let text = raw.trim();
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  if (cdata) text = cdata[1];
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** 解析 `YYYYMMDDHHmmss(.fff)?( +hhmm | Z)?` 为 epoch ms；无法解析返回 NaN */
export function parseXmltvTime(raw: string): number {
  const m = raw
    .trim()
    .match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?(?:\.(\d{1,3}))?(?:\s*([+-])(\d{2})(\d{2})|Z)?$/);
  if (!m) return NaN;
  const [, y, mo, d, h, mi, s, frac, sign, tzh, tzm] = m;
  const utcMs = Date.UTC(
    +y,
    +mo - 1,
    +d,
    +(h || 0),
    +(mi || 0),
    +(s || 0),
    frac ? +(frac.padEnd(3, '0')) : 0
  );
  if (!sign) return utcMs; // 无时区按 UTC 处理
  const offsetMin = (+tzh) * 60 + (+tzm);
  const offsetMs = offsetMin * 60 * 1000 * (sign === '-' ? -1 : 1);
  return utcMs - offsetMs;
}

function extractAttrs(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrText))) attrs[m[1].toLowerCase()] = m[2];
  return attrs;
}

/**
 * 解析 XMLTV 内容。string 直接入扫描；Buffer 自动识别 gzip（1f 8b 魔数）解压。
 * 只保留 `[now, now + windowMs]` 窗口内的节目，按频道分组并按开播时间排序。
 */
export function parseXmltv(
  content: string | Buffer,
  windowMs: number = DEFAULT_WINDOW_MS,
  now: number = Date.now(),
  limits: XmltvLimits = getXmltvLimits()
): Map<string, EpgProgram[]> {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Invalid XMLTV limit');
  }
  const inputBytes = typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;
  if (inputBytes > limits.maxInputBytes) throw new XmltvLimitError(`节目单输入超过 ${limits.maxInputBytes} 字节限制`);
  let text: string;
  if (Buffer.isBuffer(content)) {
    let expanded = content;
    if (content.length >= 2 && content[0] === 0x1f && content[1] === 0x8b) {
      try {
        expanded = gunzipSync(content, { maxOutputLength: limits.maxExpandedBytes });
      } catch (error) {
        // Node exposes a code; workerd reports the same maxOutputLength boundary
        // as a RangeError without a code. A small local gzip fixture verifies both.
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE' ||
            error instanceof RangeError && error.message === 'Memory limit exceeded') {
          throw new XmltvLimitError(`节目单解压后超过 ${limits.maxExpandedBytes} 字节限制`);
        }
        throw error;
      }
    }
    if (expanded.byteLength > limits.maxExpandedBytes) throw new XmltvLimitError(`节目单文本超过 ${limits.maxExpandedBytes} 字节限制`);
    text = expanded.toString('utf8');
  } else {
    if (inputBytes > limits.maxExpandedBytes) throw new XmltvLimitError(`节目单文本超过 ${limits.maxExpandedBytes} 字节限制`);
    text = content;
  }

  const result = new Map<string, EpgProgram[]>();
  const windowEnd = now + windowMs;
  let count = 0;
  let parsedBytes = 128;

  PROGRAMME_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PROGRAMME_RE.exec(text))) {
    const attrText = m[1] ?? m[2] ?? '';
    const inner = m[3] ?? '';
    const attrs = extractAttrs(attrText);
    const channelId = attrs['channel']?.trim();
    if (!channelId) continue;
    const start = parseXmltvTime(attrs['start'] || '');
    const stop = parseXmltvTime(attrs['stop'] || '');
    if (!Number.isFinite(start) || !Number.isFinite(stop)) continue;
    // 窗口裁剪：节目已完全播完或完全在未来窗口之外则丢弃
    if (stop <= now || start >= windowEnd) continue;

    const titleMatch = inner.match(TITLE_RE);
    const descMatch = inner.match(DESC_RE);
    const program: EpgProgram = {
      channelId: retainedText(channelId),
      start,
      stop,
      title: titleMatch ? retainedText(decodeXmlText(titleMatch[1])) : '',
    };
    if (descMatch) program.desc = retainedText(decodeXmlText(descMatch[1]));
    if (!program.title) continue;

    const list = result.get(channelId);
    count++;
    parsedBytes += programBytes(program) + (list ? 0 : 256 + channelId.length * 2);
    if (count > limits.maxPrograms) throw new XmltvLimitError(`节目单有效节目超过 ${limits.maxPrograms} 条限制`);
    if (parsedBytes > limits.maxParsedBytes) throw new XmltvLimitError(`节目单解析结果超过 ${limits.maxParsedBytes} 字节预算`);
    if (list) list.push(program);
    else result.set(program.channelId, [program]);
  }

  // 按开播时间排序（XMLTV 不保证顺序）
  for (const list of result.values()) list.sort((a, b) => a.start - b.start);
  return result;
}

/** 取某频道当前正在播出的节目与下一个节目 */
export function currentAndNext(
  programs: EpgProgram[],
  at: number = Date.now()
): { current?: EpgProgram; next?: EpgProgram } {
  let current: EpgProgram | undefined;
  let next: EpgProgram | undefined;
  for (const p of programs) {
    if (p.start <= at && p.stop > at) {
      current = p;
      continue; // 同一时刻可能有重叠节目，取最后一个命中者
    }
    if (p.start > at) {
      next = p;
      break;
    }
  }
  return { current, next };
}
