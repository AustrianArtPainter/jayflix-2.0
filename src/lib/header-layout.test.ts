import { readFileSync } from 'node:fs';
import postcss, { type AnyNode, type Root } from 'postcss';
import { describe, expect, it } from 'vitest';

const current = postcss.parse(readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8'));
const legacy = postcss.parse(readFileSync(new URL('../../tests/legacy/css/home-orbit.css', import.meta.url), 'utf8'));

/** Resolve the relevant width-only rules in source order, including media ancestors. */
function atWidth(css: Root, selector: string | string[], width: number) {
  const result: Record<string, string> = {};
  const selectors = typeof selector === 'string' ? [selector] : selector;
  css.walkRules((rule) => {
    if (!rule.selectors.some((value) => selectors.includes(value))) return;
    for (let parent: AnyNode | undefined = rule.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule' || parent.name !== 'media') continue;
      const bounds = [...parent.params.matchAll(/(max|min)-width:\s*(\d+)px/g)];
      if (!bounds.length || bounds.some(([, type, limit]) => type === 'max' ? width > Number(limit) : width < Number(limit))) return;
    }
    rule.walkDecls((decl) => { result[decl.prop] = decl.value; });
  });
  return result;
}

describe('header keeps legacy upper-right alignment without hiding new entries', () => {
  it.each([280, 320, 375, 390, 440, 500, 600])('keeps every entry on one right-hand row at %ipx', (width) => {
    const header = atWidth(current, '.site-header-inner', width);
    const tools = atWidth(current, '.site-header-tools', width);
    expect(header.display).toBe('grid');
    expect(header['grid-template-columns']).toBe('max-content minmax(0, 1fr)');
    expect(header['align-items']).toBe('flex-start');
    expect(tools['justify-content']).toBe('flex-end');
    expect(tools['flex-wrap']).toBe('nowrap');
    expect(atWidth(current, '.site-header-extra-tools', width).display).toBe('contents');
    expect(atWidth(current, '.site-header-legacy-tools', width).display).toBe('contents');
    expect(tools['min-width']).toBe('0');
    expect(tools.width).toBeUndefined();
    expect(tools.overflow).toBeUndefined();
    expect(atWidth(current, '.home-tool-button', width).flex).toBe('0 1 34px');
    expect(atWidth(current, '.palette-control', width).flex).toBe('0 1 34px');
    expect(atWidth(current, '.palette-control > .home-tool-button', width).width).toBe('100%');
  });

  it('reuses the actual legacy mobile button dimensions, right gutter and spacing', () => {
    const button = atWidth(current, '.home-tool-button', 500);
    const oldButton = atWidth(legacy, '.home-tool button', 500);
    const oldSettings = atWidth(legacy, '.home-settings-tool', 500);
    const oldHistory = atWidth(legacy, '.home-history-tool', 500);
    expect(button.width).toBe(oldButton.width);
    expect(button.height).toBe(oldButton.height);
    expect(button.padding).toBe(oldButton.padding);
    expect(atWidth(current, '.site-header-inner', 500).padding.split(' ')[1]).toBe(oldSettings.right);
    const interval = parseFloat(oldHistory.right) - parseFloat(oldSettings.right);
    expect(atWidth(current, '.site-header-tools', 500).gap).toBe(`${interval - parseFloat(button.width)}px`);
  });

  it('compacts narrow mobile gaps instead of hiding, clipping or scrolling entries', () => {
    expect(atWidth(current, '.site-header-tools', 390).gap).toBe('2px');
    expect(atWidth(current, '.home-tool-button', 390)['min-width']).toBe('18px');
    expect(atWidth(current, '.palette-control', 390)['min-width']).toBe('18px');
    expect(atWidth(current, '.site-header-tools', 390).overflow).toBeUndefined();
  });

  it.each([601, 768, 900, 1100, 1280, 1600])('keeps the desktop/tablet tools right-aligned on the logo row at %ipx', (width) => {
    const tools = atWidth(current, '.site-header-tools', width);
    expect(atWidth(current, '.site-header-inner', width).display).toBe('flex');
    expect(tools.margin).toBe('2px 0 0 auto');
    expect(tools['flex-shrink']).toBe('0');
    expect(tools.width).toBeUndefined();
    expect(tools['flex-wrap']).toBeUndefined();
  });

  it('matches the legacy tool top offsets and max-width container', () => {
    for (const width of [390, 768, 1280]) {
      const paddingTop = parseFloat(atWidth(current, '.site-header-inner', width).padding);
      const tools = atWidth(current, '.site-header-tools', width);
      const marginTop = parseFloat(tools['margin-top'] ?? tools.margin);
      const oldTools = atWidth(legacy, ['.home-tool', '.home-history-tool'], width);
      expect(paddingTop + marginTop).toBe(parseFloat(oldTools.top));
    }
    expect(atWidth(current, '.site-header-inner', 1600).width).toBe(atWidth(legacy, '.home-shell', 1600).width);
  });

  it('hides mobile text labels only, never the toolbar or its controls', () => {
    expect(atWidth(current, '.home-tool-label', 390).display).toBe('none');
    expect(atWidth(current, '.site-header-tools', 390).display).toBe('flex');
    expect(atWidth(current, '.home-tool-button', 390).display).toBe('inline-flex');
    expect(atWidth(current, '.palette-control', 390).position).toBe('static');
    expect(atWidth(current, '.site-header-inner', 390).position).toBe('relative');
  });

  it.each([320, 390, 600, 1280])('aligns theme beside the palette title without mobile toolbar sizing at %ipx', (width) => {
    const heading = atWidth(current, '.ui-palette-heading-main', width);
    const theme = atWidth(current, '.ui-palette-theme', width);
    expect(heading.display).toBe('flex');
    expect(heading['align-items']).toBe('center');
    expect(heading.gap).toBe('8px');
    expect(theme.display).toBe('inline-flex');
    expect(theme.height).toBe('24px');
    expect(theme.padding).toBe('0 6px');
    expect(theme.width).toBeUndefined();
    expect(theme.flex).toBeUndefined();
    expect(theme.color).toBe('var(--palette-tool-text)');
  });
});
