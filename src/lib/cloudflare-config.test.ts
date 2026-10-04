import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { config as middlewareConfig } from '../middleware';

const appRoot = path.resolve(__dirname, '../..');
const read = (name: string) => fs.readFileSync(path.join(appRoot, name), 'utf8');

describe('Cloudflare / Node packaging constraints', () => {
  it('uses the OpenNext Workers entry/assets, public-only fetch, and no paid bindings', () => {
    // Config comments occupy their own lines; reject accidentally introduced syntax changes.
    const config = JSON.parse(read('wrangler.workers.jsonc').replace(/^\s*\/\/.*$/gm, ''));
    expect(config.main).toBe('.open-next/worker.js');
    expect(config.assets).toEqual({ directory: '.open-next/assets', binding: 'ASSETS' });
    expect(config.compatibility_flags).toContain('nodejs_compat');
    expect(config.compatibility_flags).toContain('global_fetch_strictly_public');
    expect(config.compatibility_date >= '2024-09-23').toBe(true);
    expect(config.services[0].service).toBe(config.name);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.keep_vars).toBe(true);
    expect(config.dev.port).toBe(8082);
    for (const name of ['r2_buckets', 'kv_namespaces', 'd1_databases', 'durable_objects', 'queues', 'images', 'limits', 'vars', 'routes']) {
      expect(config).not.toHaveProperty(name);
    }
  });

  it('pins compatible adapter/runtime tooling and provides local-only preview/dry-run commands', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.dependencies.next).toMatch(/^15\.\d+\.\d+$/);
    expect(pkg.dependencies['@opennextjs/cloudflare']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.devDependencies.wrangler).toMatch(/^4\.\d+\.\d+$/);
    expect(pkg.scripts['cf:build']).toBe('opennextjs-cloudflare build --config wrangler.workers.jsonc');
    expect(pkg.scripts['cf:dry-run']).toContain('--dry-run');
    expect(pkg.scripts['cf:preview']).toContain('--port 8082');
    expect(pkg.scripts.deploy).toBeUndefined();
    expect(read('vitest.config.ts')).toContain('maxWorkers: 2');
  });

  it('keeps runtime credentials empty in examples and ignored/excluded from Docker', () => {
    for (const name of ['PASSWORD', 'ADMINPASSWORD', 'PROXY_SECRET']) {
      expect(read('.env.example')).toMatch(new RegExp(`^${name}=\\s*$`, 'm'));
      expect(read('next.config.ts')).not.toContain(`${name}:`);
    }
    for (const ignore of ['.gitignore', '.dockerignore']) {
      for (const secretPath of ['.env.*', '.dev.vars', '.dev.vars.*', '.wrangler', '.open-next']) {
        expect(read(ignore)).toContain(secretPath);
      }
    }
    expect(read('Dockerfile')).not.toMatch(/(?:ARG|ENV)\s+(?:PASSWORD|ADMINPASSWORD|PROXY_SECRET)/);
    expect(read('docker-compose.yml')).toContain('PASSWORD=${PASSWORD:?');
    expect(read('docker-compose.yml')).toContain('image: jayflix-next:local');
  });

  it('isolates concurrent dev output without changing the default production directory', () => {
    expect(read('next.config.ts')).toContain("distDir: process.env.NEXT_DEV_OUTPUT || '.next'");
    expect(read('.gitignore')).toContain('.next-dev/');
    expect(read('.dockerignore')).toContain('.next-dev');
    expect(read('next.config.ts')).toContain('devIndicators: false');
    expect(read('next.config.ts')).toContain('skipMiddlewareUrlNormalize: true');
    for (const url of ['/s=fixture', '/s=' + encodeURIComponent('旧版搜索'), '/player.html?id=8']) {
      expect(unstable_doesMiddlewareMatch({ config: middlewareConfig, nextConfig: {}, url })).toBe(true);
    }
    for (const url of ['/search', '/api/search', '/watch']) {
      expect(unstable_doesMiddlewareMatch({ config: middlewareConfig, nextConfig: {}, url })).toBe(false);
    }
  });

  it('configures caches without creating remote resource prerequisites', () => {
    const config = read('open-next.config.ts');
    for (const name of ['incrementalCache', 'tagCache', 'queue']) {
      expect(config).toContain(`${name}: 'dummy'`);
    }
  });

  it('documents the runtime hot-list base without claiming public-provider capacity', () => {
    const example = read('.env.example');
    const provider = read('src/lib/douban-weekly.ts');
    expect(example).toContain('# 60S_API_BASE=https://60s.crystelf.top');
    expect(provider).toContain("getServerEnv('60S_API_BASE') || 'https://60s.crystelf.top'");
    expect(example).not.toContain('通常够用');
  });
});
