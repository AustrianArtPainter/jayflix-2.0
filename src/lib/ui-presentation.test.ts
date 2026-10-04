import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import config from '../../tailwind.config';
import { buildAppVariables, DEFAULTS } from './ui-palette';
import manifest from '../app/manifest';

const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8');
const parsed = postcss.parse(css);

describe('shared JAYFLIX presentation contracts', () => {
  it('keeps the CSS fallback colors and utility bridges equal to the pre-paint runtime', () => {
    const variables = buildAppVariables(DEFAULTS);
    parsed.walkRules(':root', (rule) => {
      rule.walkDecls((decl) => {
        if (!(decl.prop in variables)) return;
        // RGB triples and hex colors must agree exactly before hydration.
        if (decl.value.startsWith('#') || /^\d+ \d+ \d+$/.test(decl.value)) expect(decl.value, decl.prop).toBe(variables[decl.prop]);
      });
    });
    expect(css).not.toMatch(/linear-gradient|#00ccff|#ff3c78|--c-accent:\s*0 184 230/);
  });

  it('overrides inline Artplayer themes and connects played/loaded tracks to the palette', () => {
    const found = new Map<string, { value: string; important: boolean }>();
    parsed.walkRules((rule) => {
      if (!rule.selector.includes('.art-video-player')) return;
      rule.walkDecls((decl) => { found.set(`${rule.selector}:${decl.prop}`, { value: decl.value, important: Boolean(decl.important) }); });
    });
    expect(found.get('.jayflix-ui .art-video-player:--art-theme')).toEqual({ value: 'var(--home-accent)', important: true });
    const played = [...found].find(([key]) => key.includes('.art-progress-played') && key.endsWith(':background-color'));
    const loaded = [...found].find(([key]) => key.includes('.art-progress-loaded') && key.endsWith(':background-color'));
    expect(played?.[1]).toEqual({ value: 'var(--home-accent)', important: true });
    expect(loaded?.[1]).toEqual({ value: 'var(--palette-accent-loaded)', important: true });
  });

  it('compiles the complete shared stylesheet with the unchanged upstream utility configuration', async () => {
    const result = await postcss([tailwindcss(config)]).process(css, { from: undefined });
    expect(result.warnings()).toHaveLength(0);
    expect(result.css).not.toContain('@apply');
    expect(result.css).toContain('rgb(var(--c-accent)');
    expect(result.css).toContain('--art-theme: var(--home-accent) !important');
  });

  it('brands the installed app using the same default background', () => {
    const result = manifest();
    expect(result.short_name).toBe('JAYFLIX');
    expect(result.name).toContain('JAYFLIX');
    expect(result.theme_color).toBe(DEFAULTS.background);
    expect(result.background_color).toBe(DEFAULTS.background);
    expect(result.icons).toHaveLength(4);
  });
});
