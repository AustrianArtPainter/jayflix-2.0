import { existsSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { describe, expect, it } from 'vitest';
import { config, middleware } from './middleware';

describe('legacy middleware is registered beside the src/app router', () => {
  it('lives in src, with no ignored root middleware duplicate', () => {
    expect(existsSync(new URL('./app', import.meta.url))).toBe(true);
    expect(existsSync(new URL('./middleware.ts', import.meta.url))).toBe(true);
    expect(existsSync(new URL('../middleware.ts', import.meta.url))).toBe(false);
    expect(config.matcher).toEqual(['/s=(.*)', '/index.html', '/about.html', '/watch.html', '/player.html', '/orbit-test.html']);
  });
  it.each([
    ['/index.html', '/'], ['/about.html', '/about'],
    ['/watch.html', '/watch'], ['/player.html', '/watch'],
    ['/orbit-test.html', '/orbit-test'], ['/s=movie', '/?s=movie'],
  ])('redirects %s to %s without changing the request origin', (path, target) => {
    expect(unstable_doesMiddlewareMatch({ config, url: `https://jayflix.example${path}` })).toBe(true);
    const response = middleware(new NextRequest(`https://jayflix.example${path}`));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`https://jayflix.example${target}`);
  });
  it('keeps real history source and episode position through the actual redirect response', () => {
    const response = middleware(new NextRequest('https://jayflix.example/player.html?source=OldName&source_code=bfzy&id=42&index=2&position=33'));
    const target = new URL(response.headers.get('location')!);
    expect(target.searchParams.get('source')).toBe('bfzy');
    expect(target.searchParams.get('position')).toBe('33');
    expect(target.searchParams.get('index')).toBe('2');
  });
  it('passes modern routes and malformed legacy search to the router', () => {
    for (const path of ['/watch?source=bfzy&id=42', '/live', '/s=%ZZ']) {
      const response = middleware(new NextRequest(`https://jayflix.example${path}`));
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
    }
  });
  it('uses the framework matcher for encoded search text and excludes modern/API routes', () => {
    expect(unstable_doesMiddlewareMatch({ config, url: 'https://jayflix.example/s=' + encodeURIComponent('肖申克的救赎') })).toBe(true);
    for (const path of ['/', '/watch', '/live', '/api/search', '/something/player.html']) {
      expect(unstable_doesMiddlewareMatch({ config, url: `https://jayflix.example${path}` })).toBe(false);
    }
  });
});
