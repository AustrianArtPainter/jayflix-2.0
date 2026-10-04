/** Pages advanced-mode adapter. No credentials or application state live here. */
export function createPagesWorker(nextWorker, assetPaths) {
  const assets = new Set(assetPaths);
  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (assets.has(url.pathname) && (request.method === 'GET' || request.method === 'HEAD')) {
        return env.ASSETS.fetch(request);
      }
      // OpenNext/Next default forwarded protocol to HTTPS. Preserve loopback HTTP
      // and derive forwarding headers from the trusted URL, never client input.
      const headers = new Headers(request.headers);
      headers.set('host', url.host);
      headers.set('x-forwarded-host', url.host);
      headers.set('x-forwarded-proto', url.protocol.slice(0, -1));
      return nextWorker.fetch(new Request(request, { headers }), env, ctx);
    },
  };
}
