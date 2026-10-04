import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

const presets = vi.hoisted(() => ({
  sources: [{ key: 'env_0', name: 'Test VOD', url: 'https://vod.example/api' }],
  live: [{ key: 'envlive_0', name: 'Test live', url: 'https://live.example/list.m3u' }],
  subscriptions: [{ url: 'https://subs.example/list.json' }],
}));
vi.mock('@/lib/env-sources', () => ({ getEnvSources: () => presets.sources }));
vi.mock('@/lib/env-live-sources', () => ({ getEnvLiveSources: () => presets.live }));
vi.mock('@/lib/env-subscriptions', () => ({ getEnvSubscriptions: () => presets.subscriptions }));
vi.mock('@/lib/env-recommend-source', () => ({ getEnvRecommendSource: () => 'douban' }));
vi.mock('@/lib/env-image-mode', () => ({ getEnvImageMode: () => 'proxy' }));

beforeEach(() => { vi.stubEnv('PASSWORD', 'access-test'); vi.stubEnv('ADMINPASSWORD', 'admin-test'); vi.stubEnv('APP_VERSION', '2.16.12-test'); });
afterEach(() => vi.unstubAllEnvs());

function request(cookie?: string) {
  return new Request('https://app.example/api/status', { headers: cookie ? { cookie } : undefined });
}

describe('/api/status', () => {
  it('publishes booleans and version, withholding deployment presets before access validation', async () => {
    const res = await GET(request());
    expect(await res.json()).toEqual({ passwordRequired: true, verified: false, adminPasswordConfigured: true, version: '2.16.12-test', defaultSources: [], defaultLiveSources: [], defaultSubscriptions: [], defaultRecommendSource: null, defaultImageMode: null });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('vary')).toBe('Cookie');
  });

  it('preserves all upstream deployment presets for authenticated viewers without requiring admin', async () => {
    const token = signSession().token;
    const res = await GET(request(`${SESSION_COOKIE}=${token}`));
    expect(await res.json()).toEqual({ passwordRequired: true, verified: true, adminPasswordConfigured: true, version: '2.16.12-test', defaultSources: presets.sources, defaultLiveSources: presets.live, defaultSubscriptions: presets.subscriptions, defaultRecommendSource: 'douban', defaultImageMode: 'proxy' });
  });

  it('retains upstream fail-closed missing PASSWORD behavior even with ADMINPASSWORD configured', async () => {
    const token = signSession().token;
    vi.stubEnv('PASSWORD', '');
    expect(await (await GET(request(`${SESSION_COOKIE}=${token}`))).json()).toMatchObject({ passwordRequired: false, verified: false, adminPasswordConfigured: true, defaultSources: [], defaultLiveSources: [], defaultSubscriptions: [] });
  });

  it('returns only a configuration boolean for missing ADMINPASSWORD and handles malformed cookies', async () => {
    vi.stubEnv('ADMINPASSWORD', '');
    const body = await (await GET(request(`${SESSION_COOKIE}=%E0%A4%A`))).json();
    expect(body).toMatchObject({ adminPasswordConfigured: false, verified: false });
    expect(JSON.stringify(body)).not.toMatch(/access-test|admin-test|digest|hash|secret/i);
  });
});
