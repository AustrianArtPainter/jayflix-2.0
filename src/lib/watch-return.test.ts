import { describe, expect, it } from 'vitest';
import { safeWatchReturnUrl } from './watch-return';

describe('watch return URL fallback', () => {
  const origin = 'https://jayflix.example';
  it('returns local paths and preserves search/hash for old shared links', () => {
    expect(safeWatchReturnUrl('/?s=%E7%94%B5%E5%BD%B1#results', origin)).toBe('/?s=%E7%94%B5%E5%BD%B1#results');
    expect(safeWatchReturnUrl('https://jayflix.example/index.html?s=movie', origin)).toBe('/index.html?s=movie');
    expect(safeWatchReturnUrl('%2F%3Fs%3Dmovie', origin)).toBe('/?s=movie');
  });
  it('rejects external origins, scripts, credentials and malformed encodings', () => {
    for (const value of [null, '', 'javascript:alert(1)', 'data:text/html,foo', '//evil.example/path',
      'https://evil.example/', 'http://jayflix.example/', 'https://jayflix.example.evil.example/',
      'https://user:password@jayflix.example/', '/\\evil.example/', '/%0aevil', '%', ' relative ', '/path\n', '///jayflix.example//evil']) {
      expect(safeWatchReturnUrl(value, origin), String(value)).toBeNull();
    }
  });
});
