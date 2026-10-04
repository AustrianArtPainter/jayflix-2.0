import { getCloudflareContext } from '@opennextjs/cloudflare';

export type SecretBinding = 'PASSWORD' | 'ADMINPASSWORD' | 'PROXY_SECRET';

/**
 * Prefer request-time Worker bindings, including an explicitly absent secret.
 * Falling back to build-time process.env inside a Worker could revive a removed
 * credential. Plain Node/Docker, which has no Cloudflare context, uses process.env.
 */
export function getServerEnv(name: string): string | undefined {
  let bindings: Record<string, unknown>;
  try {
    bindings = getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    return process.env[name];
  }
  const value = bindings[name];
  return typeof value === 'string' ? value : undefined;
}

export function isWorkerRuntime(): boolean {
  try {
    getCloudflareContext();
    return true;
  } catch {
    return false;
  }
}
