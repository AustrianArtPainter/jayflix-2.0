import { MAX_DISPLAY_CARDS } from './orbit-math.js';

/** Keep the old capacity link useful without restoring its obsolete large preset. */
export function orbitTestCount(params: URLSearchParams): number {
  const raw = params.get('count');
  if (raw !== null && raw.trim() !== '') {
    const value = Number(raw);
    if (Number.isFinite(value)) return Math.max(1, Math.min(MAX_DISPLAY_CARDS, Math.floor(value)));
  }
  return params.get('mode') === 'capacity' ? MAX_DISPLAY_CARDS : 212;
}
