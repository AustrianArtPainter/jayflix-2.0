import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { getServerEnv, isWorkerRuntime } from './cloudflare-env';

vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe('runtime secret bindings', () => {
  it('reads Node/Docker environment when there is no Worker context', () => {
    vi.mocked(getCloudflareContext).mockImplementation(() => { throw new Error('no Worker context'); });
    vi.stubEnv('PASSWORD', 'node-fixture');
    expect(getServerEnv('PASSWORD')).toBe('node-fixture');
    expect(isWorkerRuntime()).toBe(false);
  });

  it.each(['PASSWORD', 'ADMINPASSWORD', 'PROXY_SECRET'])('prefers runtime %s over build environment', (name) => {
    vi.stubEnv(name, 'stale-build-fixture');
    vi.mocked(getCloudflareContext).mockReturnValue({ env: { [name]: 'worker-fixture' } } as never);
    expect(getServerEnv(name)).toBe('worker-fixture');
    expect(isWorkerRuntime()).toBe(true);
  });

  it('missing/empty/object bindings never fall back to stale build credentials', () => {
    vi.stubEnv('PASSWORD', 'stale-build-fixture');
    vi.mocked(getCloudflareContext).mockReturnValue({ env: {} } as never);
    expect(getServerEnv('PASSWORD')).toBeUndefined();
    vi.mocked(getCloudflareContext).mockReturnValue({ env: { PASSWORD: '' } } as never);
    expect(getServerEnv('PASSWORD')).toBe('');
    vi.mocked(getCloudflareContext).mockReturnValue({ env: { PASSWORD: { secret: 'bad' } } } as never);
    expect(getServerEnv('PASSWORD')).toBeUndefined();
  });
});
