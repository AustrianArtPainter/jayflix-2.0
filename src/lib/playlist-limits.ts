import { getServerEnv, isWorkerRuntime } from './cloudflare-env';
import type { LivePlaylistResponse } from './types';

const MiB = 1024 * 1024;
const DEFAULTS = { maxInputBytes: 4 * MiB, maxParsedBytes: 8 * MiB, maxChannels: 20_000 };

export function getPlaylistLimits() {
  const worker = isWorkerRuntime();
  function limit(name: string, fallback: number, nodeMaximum: number) {
    const raw = getServerEnv(name);
    const requested = raw && /^[1-9]\d*$/.test(raw) ? Number(raw) : fallback;
    return Math.min(Number.isSafeInteger(requested) ? requested : fallback, worker ? fallback : nodeMaximum);
  }
  return {
    maxInputBytes: limit('M3U_MAX_INPUT_BYTES', DEFAULTS.maxInputBytes, 16 * MiB),
    maxParsedBytes: limit('M3U_MAX_PARSED_BYTES', DEFAULTS.maxParsedBytes, 32 * MiB),
    maxChannels: limit('M3U_MAX_CHANNELS', DEFAULTS.maxChannels, 100_000),
  };
}

/** Conservative cache accounting for objects, arrays and UTF-16 text, not measured heap size. */
export function estimatePlaylistBytes(playlist: LivePlaylistResponse): number {
  let bytes = 256 + (playlist.name?.length ?? 0) * 2;
  for (const group of playlist.groups) bytes += 32 + group.length * 2;
  for (const channel of playlist.channels) {
    bytes += 256;
    for (const value of Object.values(channel)) if (typeof value === 'string') bytes += value.length * 2;
  }
  return bytes;
}
