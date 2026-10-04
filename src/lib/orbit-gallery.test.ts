import { createElement } from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import { OrbitGallery } from '../components/orbit-gallery';
import { recommendLink } from './recommend-link';

describe('React sphere keeps data order and legacy card actions', () => {
  it('explicitly disables inherited text decoration on animated detail links', () => {
    const css = postcss.parse(readFileSync(new URL('../components/orbit-gallery.css', import.meta.url), 'utf8'));
    const decorations: string[] = [];
    css.walkRules('.orbit-gallery .orbit-link', (rule) => {
      rule.walkDecls('text-decoration', (decl) => { decorations.push(decl.value); });
    });
    // Tailwind Preflight uses inherit. Visually identical but costly in Chrome
    // when combined with continuous carrier transforms and face opacity.
    expect(decorations).toEqual(['none']);
  });

  it('renders only the first 1322 cards without repeating or sorting input', () => {
    const items = Array.from({ length: 1323 }, (_, index) => ({ id: String(index + 1), title: `Fixture ${index + 1}`, cover: '' }));
    const html = renderToStaticMarkup(createElement(OrbitGallery, { items, onPick() {}, placeholders: true }));
    expect((html.match(/data-orbit-card="true"/g) ?? [])).toHaveLength(1322);
    expect(html.indexOf('aria-label="Fixture 1"')).toBeLessThan(html.indexOf('aria-label="Fixture 1322"'));
    expect(html).not.toContain('Fixture 1323');
    expect(html).not.toMatch(/<img|<a /);
    expect(html).toContain('data-collapsed="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('任意方向拖动');
  });
  it('retains separate title/cover search actions and an external detail link outside the poster button', () => {
    const html = renderToStaticMarkup(createElement(OrbitGallery, { items: [{ id: '1292052', title: 'Fixture', cover: '', rating: '9.7' }], onPick() {} }));
    expect(html).toContain('aria-label="搜索Fixture"');
    expect(html).toContain('class="orbit-title"');
    expect(html).toContain('class="orbit-rating-star"');
    expect(html).toContain('href="https://movie.douban.com/subject/1292052/"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toMatch(/<\/button><a class="orbit-link"/);
  });
  it('uses the correct provider and never builds external links from arbitrary IDs', () => {
    expect(recommendLink('123', 'bangumi')).toBe('https://bgm.tv/subject/123');
    expect(recommendLink('123', 'baidu')).toBeUndefined();
    for (const id of ['baidu_0', 'javascript:alert(1)', '../other', '123?x=1']) expect(recommendLink(id, 'douban')).toBeUndefined();
  });
});
