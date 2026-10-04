import { describe, expect, it } from 'vitest';
import { legacyRedirect } from './legacy-links';

describe('legacy routes retain source, episode, media and saved-position parameters', () => {
  it('preserves a full old playback link', () => {
    const original = new URL('https://jayflix.example/player.html?source=bfzy&id=123&index=2&position=130&title=%E5%B8%8C%E6%9C%9B&url=https%3A%2F%2Fmedia.example%2Findex.m3u8&sourceUrl=https%3A%2F%2Fapi.example%2Fvod');
    const next = legacyRedirect(original)!;
    expect(next.pathname).toBe('/watch');
    expect(next.search).toBe(original.search);
  });
  it('normalizes old Chinese search and double-encoded same-origin return routes', () => {
    const search = '/s=' + encodeURIComponent('肖申克的救赎');
    expect(legacyRedirect(new URL(search, 'https://jayflix.example'))!.searchParams.get('s')).toBe('肖申克的救赎');
    const player = new URL('/watch.html', 'https://jayflix.example');
    player.searchParams.set('returnUrl', encodeURIComponent('https://jayflix.example' + search));
    expect(legacyRedirect(player)!.searchParams.get('returnUrl')).toBe('/?s=%E8%82%96%E7%94%B3%E5%85%8B%E7%9A%84%E6%95%91%E8%B5%8E');
  });
  it('uses the actual source ID in old history links instead of its display name', () => {
    const original = new URL('https://jayflix.example/player.html?source=%E6%9A%B4%E9%A3%8E%E8%B5%84%E6%BA%90&source_code=bfzy&id=8&index=3&position=125&url=https%3A%2F%2Fmedia.example%2Fa.m3u8');
    const next = legacyRedirect(original)!;
    expect(next.searchParams.get('source')).toBe('bfzy');
    for (const key of ['source_code', 'id', 'index', 'position', 'url']) {
      expect(next.searchParams.get(key)).toBe(original.searchParams.get(key));
    }
  });
  it('maps legacy custom API parameters without overwriting newer explicit values', () => {
    const url = new URL('/watch.html?source=custom&customApi=https%3A%2F%2Fcustom.example%2Fapi&customDetail=https%3A%2F%2Fcustom.example%2Fdetail', 'https://jayflix.example');
    expect(legacyRedirect(url)!.searchParams.get('sourceUrl')).toBe('https://custom.example/api');
    expect(legacyRedirect(url)!.searchParams.get('detail')).toBe('https://custom.example/detail');
    url.searchParams.set('sourceUrl', 'https://new.example/api');
    url.searchParams.set('detail', 'https://new.example/detail');
    expect(legacyRedirect(url)!.searchParams.get('sourceUrl')).toBe('https://new.example/api');
    expect(legacyRedirect(url)!.searchParams.get('detail')).toBe('https://new.example/detail');
  });
  it('accepts safe legacy back links, but not external or credential-bearing ones', () => {
    const url = new URL('/watch.html', 'https://jayflix.example');
    url.searchParams.set('back', '/index.html?s=movie#results');
    expect(legacyRedirect(url)!.searchParams.get('returnUrl')).toBe('/?s=movie#results');
    url.searchParams.set('returnUrl', '/about.html');
    expect(legacyRedirect(url)!.searchParams.get('returnUrl')).toBe('/about');
    for (const value of ['https://evil.example', 'https://user:password@jayflix.example', 'javascript:alert(1)', '/%0aevil']) {
      url.searchParams.delete('returnUrl');
      url.searchParams.set('back', value);
      expect(legacyRedirect(url)!.searchParams.has('returnUrl')).toBe(false);
    }
  });
  it('rejects malformed search and removes off-site return URLs', () => {
    expect(legacyRedirect(new URL('https://jayflix.example/s=%ZZ'))).toBeNull();
    expect(legacyRedirect(new URL('https://jayflix.example/player.html?returnUrl=https%3A%2F%2Fevil.example'))!.searchParams.has('returnUrl')).toBe(false);
    expect(legacyRedirect(new URL('https://jayflix.example/watch?id=1'))).toBeNull();
  });
});
