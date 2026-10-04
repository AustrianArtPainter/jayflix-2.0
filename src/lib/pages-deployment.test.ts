import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPagesWorker } from '../../scripts/pages-worker.mjs';
import { assertCleanBuildInputs, buildEnvironment, pagesRoutes, publicAssetPaths } from '../../scripts/pages-build.mjs';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

describe('independent Pages deployment without touching Jayflix 1.x', () => {
  it('locks Vite’s optional esbuild peer and every platform binary for npm 10 clean installs', () => {
    const lock = JSON.parse(read('package-lock.json'));
    const vite = lock.packages['node_modules/vitest/node_modules/vite'];
    expect(vite.peerDependencies.esbuild).toBe('^0.27.0 || ^0.28.0');
    const peer = lock.packages['node_modules/vitest/node_modules/esbuild'];
    expect(peer.version).toMatch(/^0\.(27|28)\./);
    for (const [name, version] of Object.entries(peer.optionalDependencies)) {
      const binary = lock.packages[`node_modules/vitest/node_modules/${name}`]
        ?? lock.packages[`node_modules/${name}`];
      expect(binary?.version, name).toBe(version);
      expect(binary?.integrity, name).toMatch(/^sha512-/);
    }
    expect(lock.packages['node_modules/wrangler'].version).toBe('4.147.0');
    expect(lock.packages['node_modules/@opennextjs/cloudflare'].version).toBe('1.20.8');
  });

  it('uses a new Pages project with no service, paid binding, route or credential value', () => {
    const config = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));
    expect(config.name).toBe('jayflix-2-0');
    expect(config.pages_build_output_dir).toBe('.cf-pages');
    expect(config.compatibility_flags).toEqual(['nodejs_compat', 'global_fetch_strictly_public']);
    for (const key of ['main', 'assets', 'services', 'vars', 'routes', 'r2_buckets', 'kv_namespaces', 'd1_databases', 'durable_objects', 'queues']) {
      expect(config).not.toHaveProperty(key);
    }
    expect(read('wrangler.pages-bundle.jsonc')).toContain('exclusively with --dry-run');
    expect(read('scripts/pages-build.mjs')).toContain("'--dry-run'");
  });

  it('keeps runtime passwords out of Next/OpenNext build environment', () => {
    const original = { PASSWORD: 'fixture-access', ADMINPASSWORD: 'fixture-admin', PROXY_SECRET: 'fixture-key',
      NEXT_DEV_OUTPUT: '.next-dev', NEXT_DEV_CLOUDFLARE: '1', NODE_VERSION: '22', PATH: '/fixture' };
    const safe = buildEnvironment(original);
    for (const key of ['PASSWORD', 'ADMINPASSWORD', 'PROXY_SECRET', 'NEXT_DEV_OUTPUT', 'NEXT_DEV_CLOUDFLARE']) {
      expect(safe).not.toHaveProperty(key);
    }
    expect(safe.PATH).toBe('/fixture');
    expect(original.PASSWORD).toBe('fixture-access');
    const directory = mkdtempSync(join(tmpdir(), 'jayflix-pages-inputs-'));
    writeFileSync(join(directory, '.env.example'), 'PASSWORD=\n');
    expect(() => assertCleanBuildInputs(directory)).not.toThrow();
    writeFileSync(join(directory, '.env.local'), 'PASSWORD=fixture\n');
    expect(() => assertCleanBuildInputs(directory)).toThrow('clean checkout');
    expect(read('scripts/pages-build.mjs')).not.toMatch(/readFileSync\([^\n]*(?:\.env|\.dev.vars)/);
  });

  it('keeps static routes separate while all pages/APIs/legacy routes reach Next', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jayflix-pages-assets-'));
    mkdirSync(join(directory, '_next/static'), { recursive: true });
    writeFileSync(join(directory, '_next/static/app.js'), '/* fixture */');
    writeFileSync(join(directory, 'icon.svg'), '<svg/>');
    const paths = publicAssetPaths(directory);
    expect(paths).toEqual(['/_next/static/app.js', '/icon.svg']);
    const routes = pagesRoutes(paths);
    expect(routes).toEqual({ version: 1, include: ['/*'], exclude: ['/_next/static/*', '/icons/*', '/icon.svg'] });
    expect(routes.exclude).not.toContain('/api/*');
    expect(() => pagesRoutes(Array.from({ length: 100 }, (_, i) => `/asset-${i}`))).toThrow('platform limit');
  });

  it.each(['GET', 'HEAD'])('serves exact static %s requests from Pages ASSETS without Next execution', async (method) => {
    const next = { fetch: vi.fn() };
    const env = { ASSETS: { fetch: vi.fn(async () => new Response(method === 'HEAD' ? null : 'static')) } };
    const request = new Request('https://jayflix-2-0.pages.dev/icon.svg', { method });
    const result = await createPagesWorker(next, ['/icon.svg']).fetch(request, env, {});
    expect(result.status).toBe(200);
    expect(env.ASSETS.fetch).toHaveBeenCalledWith(request);
    expect(next.fetch).not.toHaveBeenCalled();
    if (method === 'HEAD') expect(result.body).toBeNull();
  });

  it('preserves request body, origin and cookies while replacing spoofed forwarding headers', async () => {
    const next = { fetch: vi.fn<(request: Request, env: unknown, ctx: unknown) => Promise<Response>>(async () => new Response('next')) };
    const env = { ASSETS: { fetch: vi.fn() } };
    const ctx = { waitUntil: vi.fn() };
    const request = new Request('http://127.0.0.1:8083/api/auth', { method: 'POST', body: '{"password":"fixture"}',
      headers: { origin: 'https://evil.invalid', cookie: 'ltv_session=fixture', host: 'evil.invalid',
        'x-forwarded-host': 'evil.invalid', 'x-forwarded-proto': 'https' } });
    await createPagesWorker(next, ['/icon.svg']).fetch(request, env, ctx);
    const forwarded = next.fetch.mock.calls[0][0] as unknown as Request;
    expect(forwarded.headers.get('host')).toBe('127.0.0.1:8083');
    expect(forwarded.headers.get('x-forwarded-host')).toBe('127.0.0.1:8083');
    expect(forwarded.headers.get('x-forwarded-proto')).toBe('http');
    expect(forwarded.headers.get('origin')).toBe('https://evil.invalid');
    expect(forwarded.headers.get('cookie')).toBe('ltv_session=fixture');
    expect(await forwarded.text()).toBe('{"password":"fixture"}');
    expect(next.fetch.mock.calls[0].slice(1)).toEqual([env, ctx]);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it.each(['/api/search', '/watch', '/manifest.webmanifest', '/player.html?id=1', '/s=fixture', '/icon.svg/extra'])('does not swallow dynamic route %s', async (path) => {
    const next = { fetch: vi.fn(async () => new Response('dynamic')) };
    const env = { ASSETS: { fetch: vi.fn() } };
    expect(await (await createPagesWorker(next, ['/icon.svg']).fetch(new Request(`https://example.test${path}`), env, {})).text()).toBe('dynamic');
    expect(next.fetch).toHaveBeenCalledTimes(1);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  });

  it('ships parity baselines and cannot publish the upstream Docker registries', () => {
    for (const file of ['js/home-orbit.js', 'js/ui-palette.js', 'js/config.js', 'css/home-orbit.css', 'LICENSE', 'README.md']) {
      expect(existsSync(new URL(`tests/legacy/${file}`, root))).toBe(true);
    }
    for (const file of ['docker-publish.yml', 'docker-sync-hub.yml']) {
      expect(existsSync(new URL(`.github/workflows/${file}`, root))).toBe(false);
    }
    expect(read('README.md')).toContain('jayflix-2-0.pages.dev');
    expect(read('README.md')).toContain('npm run pages:build');
  });
});
