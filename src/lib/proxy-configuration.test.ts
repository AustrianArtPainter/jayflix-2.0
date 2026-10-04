import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getProxyConfiguration } from './proxy-handlers';

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: vi.fn() }));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); });

describe('per-request proxy configuration', () => {
  it('uses Node runtime values with bounded retry and timeout settings', () => {
    vi.mocked(getCloudflareContext).mockImplementation(() => { throw new Error('Node'); });
    vi.stubEnv('REQUEST_TIMEOUT', '45000'); vi.stubEnv('MAX_RETRIES', '2'); vi.stubEnv('USER_AGENT', 'Node fixture');
    expect(getProxyConfiguration()).toEqual({ timeoutMs: 45000, maxRetries: 2, userAgent: 'Node fixture' });
  });
  it('does not freeze Worker bindings when the module is initialized', () => {
    vi.mocked(getCloudflareContext).mockReturnValue({ env: { REQUEST_TIMEOUT: '2500', MAX_RETRIES: '0', USER_AGENT: 'Worker fixture' } } as never);
    expect(getProxyConfiguration()).toEqual({ timeoutMs: 2500, maxRetries: 0, userAgent: 'Worker fixture' });
    vi.mocked(getCloudflareContext).mockReturnValue({ env: { REQUEST_TIMEOUT: '3500' } } as never);
    expect(getProxyConfiguration().timeoutMs).toBe(3500);
  });
  it('ignores removed and malformed values instead of producing NaN or stale build settings', () => {
    vi.stubEnv('REQUEST_TIMEOUT', '100000'); vi.stubEnv('MAX_RETRIES', '999');
    vi.mocked(getCloudflareContext).mockReturnValue({ env: { REQUEST_TIMEOUT: 'Infinity', MAX_RETRIES: '2x' } } as never);
    expect(getProxyConfiguration()).toMatchObject({ timeoutMs: 8000, maxRetries: 1 });
    vi.mocked(getCloudflareContext).mockReturnValue({ env: { REQUEST_TIMEOUT: '100000', MAX_RETRIES: '999' } } as never);
    expect(getProxyConfiguration()).toMatchObject({ timeoutMs: 60000, maxRetries: 3 });
  });
});
