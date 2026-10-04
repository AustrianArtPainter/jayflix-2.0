import { getServerEnv } from './cloudflare-env';

export interface SearchSettings {
  maxPages: number;
  sourceTimeoutMs: number;
}

/**
 * Snapshot request-time bindings once for a search and its asynchronous source tasks.
 * Pagination defaults to 5 pages (1-50); the whole-source deadline defaults to 10s (3-60s).
 */
export function getSearchSettings(): SearchSettings {
  const pages = parseInt(getServerEnv('SEARCH_MAX_PAGES') || '5', 10);
  const timeout = parseInt(getServerEnv('SEARCH_SOURCE_TIMEOUT_MS') || '10000', 10);
  return {
    maxPages: Number.isFinite(pages) ? Math.min(50, Math.max(1, pages)) : 5,
    sourceTimeoutMs: Number.isFinite(timeout) ? Math.min(60000, Math.max(3000, timeout)) : 10000,
  };
}
