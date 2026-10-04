import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { applyPalette, buildAppVariables, buildVariables, DEFAULTS, getPaletteBootstrapScript, GROUPS,
  load, loadTheme, normalize, resolveColors, save, STORAGE_KEY, THEME_STORAGE_KEY, type PaletteColors } from './ui-palette';

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

function rootElement() {
  const variables = new Map<string, string>(), attributes = new Map<string, string>(), classes = new Set<string>();
  const root = {
    style: { setProperty: (name: string, value: string) => { variables.set(name, value); }, colorScheme: '' },
    classList: { toggle: (name: string, enabled: boolean) => { if (enabled) classes.add(name); else classes.delete(name); } },
    setAttribute: (name: string, value: string) => { attributes.set(name, value); },
    removeAttribute: (name: string) => { attributes.delete(name); },
  } as unknown as HTMLElement;
  return { root, variables, attributes, classes };
}

describe('legacy four-family palette compatibility', () => {
  it('retains the exact default families and shades', () => {
    expect(DEFAULTS).toEqual({ background: '#080d11', module: '#111e16', accent: '#a2e2ce', text: '#edf2ee' });
    expect(GROUPS).toEqual(['background', 'module', 'accent', 'text']);
    const variables = buildVariables(DEFAULTS);
    expect(variables['--home-ink']).toBe('#080d11');
    expect(variables['--ui-dialog']).toBe('#111e16');
    expect(variables['--ui-accent-ink']).toBe('#0b2118');
    expect(variables['--palette-accent-track']).toBe('rgba(162, 226, 206, 0.145)');
    expect(variables['--palette-player-overlay']).toBe('rgba(8, 13, 17, 0.9)');
  });

  it('matches every legacy variable for defaults, partial data and 80 custom palettes', () => {
    const exported = { exports: {} as { buildVariables: (value: unknown) => Record<string, string> } };
    runInNewContext(readFileSync(new URL('../../tests/legacy/js/ui-palette.js', import.meta.url), 'utf8'), { module: exported });
    const fixtures: unknown[] = [undefined, DEFAULTS, { module: '#000000' }, { text: '#010203', background: '#fbfcfd' }];
    let seed = 2166136261;
    for (let index = 0; index < 80; index++) {
      const colors = {} as PaletteColors;
      for (const group of GROUPS) {
        seed = Math.imul(seed ^ (index + 1), 16777619) >>> 0;
        colors[group] = `#${(seed & 0xffffff).toString(16).padStart(6, '0')}`;
      }
      fixtures.push(colors);
    }
    for (const fixture of fixtures) expect(buildVariables(fixture)).toEqual(exported.exports.buildVariables(fixture));
  });

  it('accepts only complete hex colors for known family keys', () => {
    expect(normalize({ background: '#ABCDEF', module: '#123', accent: 'red', text: '#11223344', blue: '#112233' }))
      .toEqual({ ...DEFAULTS, background: '#abcdef' });
    for (const value of [null, [], true, 123, 'red']) expect(normalize(value)).toEqual(DEFAULTS);
    expect(normalize(JSON.parse('{"__proto__":{"accent":"red"},"accent":"#AABBCC"}'))).toEqual({ ...DEFAULTS, accent: '#aabbcc' });
  });

  it('updates all utility and Artplayer progress bridges from one accent', () => {
    const vars = buildAppVariables({ ...DEFAULTS, accent: '#123456' });
    expect(vars['--home-accent']).toBe('#123456');
    expect(vars['--c-accent']).toBe('18 52 86');
    expect(vars['--palette-accent-track']).toBe('rgba(18, 52, 86, 0.145)');
    expect(vars['--palette-accent-loaded']).toBe('rgba(18, 52, 86, 0.25)');
    expect(vars['--ui-accent-ink']).toBe('#ffffff');
    expect(buildAppVariables({ ...DEFAULTS, accent: '#ffffff' })['--ui-accent-ink']).toBe('#000000');
  });
});

describe('browser-local persistence', () => {
  it('reads and writes the same v1 envelope as the old homepage', () => {
    const local = storage({ [STORAGE_KEY]: JSON.stringify({ version: 1, colors: { accent: '#AABBCC' } }) });
    expect(load(local)).toEqual({ ...DEFAULTS, accent: '#aabbcc' });
    expect(save(local, { ...DEFAULTS, module: '#223344' })).toBe(true);
    expect(JSON.parse(local.getItem(STORAGE_KEY)!)).toEqual({ version: 1, colors: { ...DEFAULTS, module: '#223344' } });
    expect(load(local).module).toBe('#223344');
    expect(save(local, DEFAULTS)).toBe(true);
    expect(load(local)).toEqual(DEFAULTS);
  });

  it('recovers malformed and unsupported data without unsafe style values', () => {
    for (const value of ['{', 'null', '[]', '"string"', '{"version":2,"colors":{"accent":"#000000"}}', '{"version":1,"colors":null}']) {
      expect(load(storage({ [STORAGE_KEY]: value }))).toEqual(DEFAULTS);
    }
    expect(load(storage({ [STORAGE_KEY]: '{"version":1,"colors":{"background":"url(javascript:alert(1))","text":"#AABBCC"}}' })))
      .toEqual({ ...DEFAULTS, text: '#aabbcc' });
  });

  it('survives unavailable storage, failed reads and quota errors', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); } };
    expect(load()).toEqual(DEFAULTS);
    expect(load(blocked)).toEqual(DEFAULTS);
    expect(save(undefined, DEFAULTS)).toBe(false);
    expect(save(blocked, DEFAULTS)).toBe(false);
    expect(loadTheme(blocked)).toBe('dark');
  });

  it('validates theme choices while preserving the existing theme storage key', () => {
    for (const theme of ['light', 'system', 'dark']) expect(loadTheme(storage({ [THEME_STORAGE_KEY]: theme }))).toBe(theme);
    expect(loadTheme(storage({ [THEME_STORAGE_KEY]: 'blue' }))).toBe('dark');
  });
});

describe('pre-paint and mounted runtime', () => {
  it('executes before the body exists and applies the saved palette to every token', () => {
    const state = rootElement();
    const colors = { ...DEFAULTS, background: '#121314', accent: '#123456' };
    const local = storage({ [STORAGE_KEY]: JSON.stringify({ version: 1, colors }) });
    runInNewContext(getPaletteBootstrapScript(), { document: { documentElement: state.root }, window: { localStorage: local } });
    expect(Object.fromEntries(state.variables)).toEqual(buildAppVariables(colors));
    expect(state.attributes.get('data-ui-palette')).toBe('custom');
    expect(state.attributes.get('data-ui-mode')).toBe('dark');
    expect(state.classes.has('dark')).toBe(true);
  });

  it('boots safely when accessing localStorage throws', () => {
    const state = rootElement();
    const fakeWindow = Object.defineProperty({}, 'localStorage', { get: () => { throw new Error('disabled'); } });
    expect(() => runInNewContext(getPaletteBootstrapScript(), { document: { documentElement: state.root }, window: fakeWindow })).not.toThrow();
    expect(state.variables.get('--home-ink')).toBe(DEFAULTS.background);
    expect(state.classes.has('dark')).toBe(true);
  });

  it('resolves system and light modes before paint without changing saved families', () => {
    for (const dark of [true, false]) {
      const state = rootElement();
      const local = storage({ [THEME_STORAGE_KEY]: 'system', [STORAGE_KEY]: JSON.stringify({ version: 1, colors: DEFAULTS }) });
      const before = local.getItem(STORAGE_KEY);
      runInNewContext(getPaletteBootstrapScript(), { document: { documentElement: state.root }, window: { localStorage: local, matchMedia: () => ({ matches: dark }) } });
      expect(Object.fromEntries(state.variables)).toEqual(buildAppVariables(DEFAULTS, dark ? 'dark' : 'light'));
      expect(state.root.style.colorScheme).toBe(dark ? 'dark' : 'light');
      expect(local.getItem(STORAGE_KEY)).toBe(before);
    }
    expect(resolveColors(DEFAULTS, 'light').background).toBe(DEFAULTS.text);
    expect(resolveColors(DEFAULTS, 'dark')).toEqual(DEFAULTS);
  });

  it('resets all custom values and the marker, including progress variables', () => {
    const state = rootElement();
    applyPalette(state.root, { accent: '#123456', module: '#ffffff' });
    expect(state.attributes.get('data-ui-palette')).toBe('custom');
    applyPalette(state.root, DEFAULTS);
    expect(Object.fromEntries(state.variables)).toEqual(buildAppVariables(DEFAULTS));
    expect(state.attributes.has('data-ui-palette')).toBe(false);
  });
});
