/** Port of legacy js/ui-palette.js. Keep this factory self-contained: the same
 * runtime is serialized into <head> and used by the mounted React provider. */
export type PaletteGroup = 'background' | 'module' | 'accent' | 'text';
export type PaletteColors = Record<PaletteGroup, string>;
export type PaletteMode = 'dark' | 'light';
export type ThemeChoice = PaletteMode | 'system';
export interface PaletteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function createPaletteRuntime() {
  const STORAGE_KEY = 'jayflix.ui.palette.v1';
  const THEME_STORAGE_KEY = 'libretv-theme';
  const DEFAULTS: Readonly<PaletteColors> = Object.freeze({
    background: '#080d11', module: '#111e16', accent: '#a2e2ce', text: '#edf2ee',
  });
  const GROUPS = Object.freeze(Object.keys(DEFAULTS) as PaletteGroup[]);
  const HEX = /^#[0-9a-f]{6}$/i;
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  const rgb = (hex: string) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const hex = (channels: number[]) => '#' + channels.map((value) => clamp(value).toString(16).padStart(2, '0')).join('');
  const luminance = (colour: string) => rgb(colour).map((value) => {
    value /= 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);

  function normalize(value: unknown): PaletteColors {
    const result = { ...DEFAULTS };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    const record = value as Record<string, unknown>;
    for (const group of GROUPS) {
      const colour = record[group];
      if (typeof colour === 'string' && HEX.test(colour)) result[group] = colour.toLowerCase();
    }
    return result;
  }

  function shade(original: string, group: PaletteGroup, colours: PaletteColors) {
    if (colours[group] === DEFAULTS[group]) return original;
    const target = rgb(colours[group]), reference = rgb(DEFAULTS[group]), source = rgb(original);
    if (group === 'text') {
      const weight = Math.min(1, source.reduce((a, b) => a + b, 0) / reference.reduce((a, b) => a + b, 0));
      const background = rgb(colours.background);
      return hex(target.map((value, index) => background[index] + (value - background[index]) * weight));
    }
    return hex(source.map((value, index) => value + target[index] - reference[index]));
  }

  /** These token names and default shades match the old homepage exactly. */
  function buildVariables(value: unknown): Record<string, string> {
    const colours = normalize(value), result: Record<string, string> = {};
    const families: Record<PaletteGroup, Record<string, string>> = {
      background: { '--home-ink': '#080d11' },
      module: { '--home-surface': '#10181d', '--ui-panel': '#0e1812', '--ui-dialog': '#111e16',
        '--ui-inset': '#142019', '--ui-input': '#101718', '--ui-control': '#17241e', '--ui-hover': '#21362b',
        '--ui-border': '#385240', '--ui-control-border': '#365044', '--ui-input-border': '#2b3a36' },
      accent: { '--home-accent': '#a2e2ce', '--ui-accent-hover': '#c0efde', '--ui-focus': '#789e91',
        '--palette-tag-active': '#b0d9bf', '--palette-card-focus': '#c2edcd' },
      text: { '--home-white': '#edf2ee', '--home-muted': '#82938f', '--ui-title': '#d4e9d9',
        '--ui-button-text': '#b7d5c5', '--ui-footer-text': '#657b6c', '--ui-footer-brand': '#9fbda8',
        '--ui-footer-link': '#a0b9a7', '--palette-tool-text': '#bac7c2', '--palette-placeholder': '#61746e',
        '--palette-subtle-text': '#63796c', '--palette-label-text': '#829a87', '--palette-value-text': '#b7c9bb',
        '--palette-card-text': '#e4ecdf', '--palette-number-text': '#ecf3e4' },
    };
    for (const group of GROUPS) {
      for (const [name, original] of Object.entries(families[group])) result[name] = shade(original, group, colours);
    }
    const accent = rgb(colours.accent), background = rgb(colours.background);
    result['--ui-accent-ink'] = colours.accent === DEFAULTS.accent ? '#0b2118' : luminance(colours.accent) > .179 ? '#000000' : '#ffffff';
    result['--home-line'] = `rgba(${rgb(shade('#d2e5df', 'text', colours)).join(', ')}, 0.12)`;
    for (const [name, opacity] of Object.entries({ '--palette-accent-faint': .04, '--palette-accent-track': .145,
      '--palette-accent-loaded': .25, '--palette-accent-hover': .125, '--palette-accent-focus': .19 })) {
      result[name] = `rgba(${accent.join(', ')}, ${opacity})`;
    }
    result['--palette-overlay'] = `rgba(${background.join(', ')}, 0.88)`;
    result['--palette-player-overlay'] = `rgba(${background.join(', ')}, 0.9)`;
    result['--palette-number-background'] = `rgba(${rgb(shade('#0b110d', 'module', colours)).join(', ')}, 0.55)`;
    result['--palette-card-border'] = `rgba(${rgb(shade('#bedac6', 'text', colours)).join(', ')}, 0.24)`;
    result['--palette-wire'] = `rgba(${accent.join(', ')}, 0.11)`;
    result['--palette-glow'] = `rgba(${accent.join(', ')}, 0.12)`;
    return result;
  }

  function load(storage?: Pick<PaletteStorage, 'getItem'>): PaletteColors {
    try {
      const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
      if (saved?.version === 1) return normalize(saved.colors);
    } catch { /* Disabled storage and malformed data must not block UI. */ }
    return { ...DEFAULTS };
  }

  function save(storage: PaletteStorage | undefined, value: unknown): boolean {
    try {
      if (!storage) return false;
      storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, colors: normalize(value) }));
      return true;
    } catch { return false; }
  }

  function loadTheme(storage?: Pick<PaletteStorage, 'getItem'>): ThemeChoice {
    try {
      const value = storage?.getItem(THEME_STORAGE_KEY);
      if (value === 'light' || value === 'system') return value;
    } catch { /* Private browsing may deny reads as well as writes. */ }
    return 'dark';
  }

  const mix = (a: string, b: string, weight: number) => {
    const target = rgb(b);
    return hex(rgb(a).map((value, index) => value + (target[index] - value) * weight));
  };
  const contrast = (a: string, b: string) => {
    const first = luminance(a), second = luminance(b);
    return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
  };

  /** Light mode derives from the saved families; it never overwrites them or
   * introduces an unrelated preset. Dark mode is the unchanged legacy palette. */
  function resolveColors(value: unknown, mode: PaletteMode): PaletteColors {
    const colours = normalize(value);
    if (mode === 'dark') return colours;
    const background = colours.text;
    let accent = colours.accent;
    for (let step = 1; step <= 100 && contrast(accent, background) < 4.5; step++) {
      accent = mix(colours.accent, colours.background, step / 100);
    }
    return {
      background,
      module: mix(colours.module, background, .94),
      accent,
      text: colours.background,
    };
  }

  function buildAppVariables(value: unknown, mode: PaletteMode = 'dark'): Record<string, string> {
    const result = buildVariables(resolveColors(value, mode));
    const bridges: Record<string, string> = {
      '--c-page': '--home-ink', '--c-surface': '--ui-panel', '--c-surface-raised': '--ui-dialog',
      '--c-card': '--ui-dialog', '--c-chip': '--ui-input', '--c-hover': '--ui-hover', '--c-line': '--ui-input-border',
      '--c-content': '--home-white', '--c-muted': '--home-muted', '--c-faint': '--palette-placeholder',
      '--c-accent': '--home-accent', '--c-accent-hover': '--ui-accent-hover', '--c-on-accent': '--ui-accent-ink',
      '--c-success': '--home-accent', '--c-info': '--home-accent',
      '--c-success-solid': '--home-accent', '--c-info-solid': '--home-accent',
    };
    // Legacy status colours remain semantic, independent of the four pickers.
    result['--ui-danger'] = '#e7a3a3';
    result['--ui-warning'] = '#ddc18f';
    for (const name of ['--c-danger', '--c-danger-hover', '--c-danger-solid']) bridges[name] = '--ui-danger';
    for (const name of ['--c-warning', '--c-rating', '--c-warning-solid']) bridges[name] = '--ui-warning';
    for (const [name, token] of Object.entries(bridges)) result[name] = rgb(result[token]).join(' ');
    return result;
  }

  function applyPalette(root: HTMLElement, value: unknown, mode: PaletteMode = 'dark') {
    const colours = normalize(value);
    for (const [name, colour] of Object.entries(buildAppVariables(colours, mode))) root.style.setProperty(name, colour);
    if (GROUPS.some((group) => colours[group] !== DEFAULTS[group])) root.setAttribute('data-ui-palette', 'custom');
    else root.removeAttribute('data-ui-palette');
    root.classList.toggle('dark', mode === 'dark');
    root.setAttribute('data-ui-mode', mode);
    root.style.colorScheme = mode;
  }

  function boot() {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Render the defaults. */ }
    const theme = loadTheme(storage);
    const mode = theme === 'system'
      ? (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : theme;
    applyPalette(document.documentElement, load(storage), mode);
  }

  return { STORAGE_KEY, THEME_STORAGE_KEY, DEFAULTS, GROUPS, normalize, shade, buildVariables,
    buildAppVariables, resolveColors, load, save, loadTheme, applyPalette, boot };
}

export const palette = createPaletteRuntime();
export const { STORAGE_KEY, THEME_STORAGE_KEY, DEFAULTS, GROUPS, normalize, shade, buildVariables,
  buildAppVariables, resolveColors, load, save, loadTheme, applyPalette } = palette;

/** Serialization reuses the actual pure implementation, including validation. */
export function getPaletteBootstrapScript(): string {
  return `(${createPaletteRuntime.toString()})().boot();`;
}
