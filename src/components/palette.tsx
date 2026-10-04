'use client';

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { applyPalette, DEFAULTS, GROUPS, load, normalize, save, STORAGE_KEY, type PaletteColors, type PaletteGroup, type PaletteMode } from '@/lib/ui-palette';
import { Icon } from './icon';

interface PaletteContextValue {
  colors: PaletteColors;
  setColor: (group: PaletteGroup, color: string) => void;
  reset: () => void;
}
const PaletteContext = createContext<PaletteContextValue>({ colors: { ...DEFAULTS }, setColor: () => {}, reset: () => {} });
export const usePalette = () => useContext(PaletteContext);

function localStorageIfAvailable() {
  try { return window.localStorage; } catch { return undefined; }
}

/** ThemeProvider mounts this once around every page, popup and player. */
export function PaletteProvider({ children, resolved = 'dark' }: { children: ReactNode; resolved?: PaletteMode }) {
  const [colors, setColors] = useState<PaletteColors>({ ...DEFAULTS });
  const loaded = useRef(false);
  useLayoutEffect(() => {
    // Read before applying defaults so hydration does not flash or overwrite a
    // palette already installed by the pre-paint script.
    const current = loaded.current ? colors : load(localStorageIfAvailable());
    if (!loaded.current) {
      loaded.current = true;
      setColors(current);
    }
    applyPalette(document.documentElement, current, resolved);
  }, [colors, resolved]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      const storage = localStorageIfAvailable();
      if (event.storageArea && event.storageArea !== storage) return;
      if (event.key === STORAGE_KEY || event.key === null) setColors(load(storage));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const update = useCallback((value: PaletteColors) => {
    const current = normalize(value);
    setColors(current);
    // Immediate local writes make navigation/pagehide and colour-picker change
    // safe without a timer. Cross-tab storage events never echo a write.
    save(localStorageIfAvailable(), current);
  }, []);
  const setColor = useCallback((group: PaletteGroup, color: string) => {
    update({ ...colors, [group]: color });
  }, [colors, update]);
  const reset = useCallback(() => update({ ...DEFAULTS }), [update]);

  return <PaletteContext.Provider value={{ colors, setColor, reset }}>{children}</PaletteContext.Provider>;
}

export function PaletteIcon() {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.5-3.3 1.5 1.5 0 0 1 1.1-2.5H17a4 4 0 0 0 4-4c0-4.4-4-8.2-9-8.2z" />
      <circle cx="7.5" cy="10.5" r=".7" strokeWidth="2" />
      <circle cx="10" cy="6.8" r=".7" strokeWidth="2" />
      <circle cx="15" cy="7.4" r=".7" strokeWidth="2" />
    </svg>
  );
}

const LABELS: Record<PaletteGroup, string> = { background: '背景', module: '模块', accent: '强调', text: '文字' };

export function PaletteControl({ headingAction }: { headingAction?: ReactNode }) {
  const { colors, setColor, reset } = usePalette();
  const [open, setOpen] = useState(false);
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) toggleRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(true); }
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, [open, close]);

  return (
    <div ref={containerRef} className="palette-control">
      <button ref={toggleRef} type="button" className="home-tool-button" title="色调" aria-label="色调"
        aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen((value) => !value)}>
        <PaletteIcon /><span className="home-tool-label">色调</span>
      </button>
      {open && (
        <section id={`${id}-panel`} className="ui-palette-panel" role="dialog" aria-labelledby={`${id}-title`}>
          <div className="ui-palette-heading">
            <div className="ui-palette-heading-main">
              <h2 id={`${id}-title`}>色调</h2>
              {headingAction}
            </div>
            <button ref={closeRef} type="button" className="ui-palette-close" aria-label="关闭色调" onClick={() => close(true)}>
              <Icon name="close" className="w-4 h-4" />
            </button>
          </div>
          <div className="ui-palette-grid">
            {GROUPS.map((group) => (
              <label key={group} htmlFor={`${id}-${group}`}>
                {LABELS[group]}
                <input id={`${id}-${group}`} type="color" value={colors[group]}
                  aria-label={group === 'accent' ? '强调颜色，包含进度条' : `${LABELS[group]}颜色`}
                  onChange={(event) => setColor(group, event.target.value)} />
              </label>
            ))}
          </div>
          <button type="button" className="ui-palette-reset" onClick={reset}>恢复默认</button>
        </section>
      )}
    </div>
  );
}
