# JAYFLIX UI integration

The JAYFLIX Next app uses the existing homepage palette and camera wordmark. The root HTML/JS/CSS remain the legacy recovery implementation. The presentation ports `css/ui-tokens.css`, `css/ui-theme.css`, `css/home-orbit.css` and `js/ui-palette.js`; there is no independent blue/pink theme.

## Provider contract

`ThemeProvider` composes `PaletteProvider` internally. Keep the existing single `ThemeProvider` in `components/providers.tsx`; do not add another palette wrapper there. `app/layout.tsx` installs `getPaletteBootstrapScript()` in the head before paint. The script serializes the same self-contained runtime used by the client provider, so normalization, family math, theme resolution and variable bridges stay identical.

`lib/ui-palette.ts` exports `buildVariables`, `buildAppVariables`, `normalize`, `load`, `save`, `applyPalette`, `DEFAULTS` and `GROUPS`. `components/palette.tsx` exports `PaletteProvider`, `usePalette` and `PaletteControl`. The picker exposes only `background`, `module`, `accent` and `text`; data is stored as `{ version: 1, colors: { background, module, accent, text } }` under `jayflix.ui.palette.v1`, compatible with the old homepage. Defaults are `#080d11`, `#111e16`, `#a2e2ce` and `#edf2ee` respectively. Same-origin tabs synchronize storage changes, including reset/clear, without echoing writes. Unavailable storage leaves the controls usable in memory.

`buildVariables` preserves all original shades and family mathematics. `buildAppVariables` adds RGB `--c-*` bridges for the upstream Tailwind utilities. Light/system mode uses the existing `libretv-theme` preference and derives its colors from these same four families without overwriting the saved palette. Returning to dark mode restores the saved colors exactly.

Artplayer selectors in `globals.css` bind its inline theme, played/loaded/hover progress, volume and popups to `--home-accent`, `--palette-accent-*` and `--ui-*`. New player implementations should use these tokens rather than literal colors. The gallery can consume the same `--home-*`, `--ui-*` and `--palette-*` variables.

Header entry points for live, about, palette, history, download and settings remain available at all responsive widths; the theme control is inside the palette heading. Settings still invokes `SourceManagerDrawer`; its internal authentication gate remains authoritative. Search history remains focus-triggered, keyboard-accessible and anchored to the complete home/input/search wrapper. No hero slogan is added.

## Validation

### Installation icons and build handoff

`public/icon.svg` is the sole artwork source. `node scripts/generate-icons.mjs` uses the existing Sharp 0.35.4 to produce `public/apple-touch-icon.png` (180px), `public/icons/jayflix-192.png`, `public/icons/jayflix-512.png`, and matching `jayflix-maskable-192.png` / `jayflix-maskable-512.png` files. Output PNGs are opaque sRGB, contain no embedded timestamps or metadata, and retain the SVG's background, mint camera and maskable safe area. Unused legacy brand bitmaps are removed. Both on-demand and live loading overlays use a centered JAYFLIX text wordmark, without a poster bitmap or camera icon.

Public project links and outbound request identity share `lib/branding.ts`. The About page, footer and subscription help use JAYFLIX branding; the footer no longer queries another project's tags. Attribution remains in the README license section and migration baseline. Existing storage/database/cache keys, authentication and download events, and exported backup/source-list format names remain unchanged for compatibility.

The favicon and shortcut remain `/icon.svg`. The Apple Touch Icon metadata uses the generated 180px PNG, matching [Apple's Web Clip icon requirements](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/SafariWebContent/ConfiguringWebApplications/ConfiguringWebApplications.html). The manifest advertises both 192px and 512px PNGs for `any` and `maskable` purposes. Validate icon assets with `npm test -- src/lib/ui-icon.test.ts src/lib/ui-icon-png.test.ts`.

Before the Cloudflare/OpenNext build, synchronize `app/layout.tsx`, `app/manifest.ts`, `public/icon.svg`, all five generated PNGs, `scripts/generate-icons.mjs`, and the updated icon tests. From `next-app/`, run `node scripts/generate-icons.mjs --check` before `npm run cf:build`; it reads only and fails on missing/stale images. If the SVG changes, regenerate with the pinned renderer and rerun the icon tests. This change does not edit the package scripts or deployment configuration.

Run `npm test -- src/lib/ui-palette.test.ts src/lib/ui-presentation.test.ts src/lib/ui-components.test.ts src/lib/watch-return.test.ts` and `npm run typecheck`. Palette tests compare every generated variable with the legacy implementation across defaults and generated custom palettes, validate storage failures, execute the pre-paint script without a body, and check utility/progress propagation and reset. Presentation tests compile the full stylesheet and check CSS fallback parity, Artplayer overrides and manifest colors. Component fixtures cover server-rendered camera branding, theme/palette controls and the root error fallback. Watch return tests cover safe same-origin fallback links and reject external or script URLs.
