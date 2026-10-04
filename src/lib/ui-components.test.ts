import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CameraIcon, Header } from '../components/header';
import { PaletteControl } from '../components/palette';
import { PlayerShell } from '../components/player-shell';
import { LivePlayer } from '../components/live-player';
import { ThemeProvider, ThemeToggle } from '../components/theme';
import GlobalError from '../app/global-error';
import AboutPage from '../app/about/page';
import { DEFAULTS } from './ui-palette';

vi.mock('next/navigation', () => ({
  usePathname: () => '/about',
  useRouter: () => ({ push: vi.fn() }),
}));

describe('server-rendered JAYFLIX UI fixtures', () => {
  it('keeps six direct header entries and moves theme inside the initially closed palette', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Header)));
    const nav = html.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? '';
    expect((nav.match(/class="home-tool-button/g) ?? [])).toHaveLength(6);
    for (const label of ['直播', '关于 JAYFLIX', '下载管理', '色调', '观看历史', '设置']) {
      expect(nav).toContain(`aria-label="${label}"`);
    }
    expect(nav).toContain('aria-current="page"');
    expect(nav).not.toContain('切换主题');
    expect(nav).toMatch(/site-header-legacy-tools[^]*aria-label="色调"[^]*aria-label="观看历史"[^]*aria-label="设置"/);
    expect(nav).not.toMatch(/更多|class="[^"]*\bhidden\b/);
    client.clear();
  });
  it('renders the outlined legacy camera without an upstream bitmap or gradient', () => {
    const html = renderToStaticMarkup(createElement(CameraIcon));
    expect(html).toContain('fill="none"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('M15 10l4.553-2.276');
    expect(html).not.toContain('<img');
  });

  it('centers only the loading wordmark over the full player frame, without a camera or spacing wrapper', () => {
    const html = renderToStaticMarkup(createElement(PlayerShell, {
      url: 'https://player.invalid/fixture.m3u8', title: '测试影片', adFilter: false, autoplayNext: false,
    }));
    const poster = html.match(/<div class="([^"]*)" role="status">([\s\S]*?)<\/div>/);
    expect(poster).not.toBeNull();
    for (const token of ['absolute', 'inset-0', 'flex', 'items-center', 'justify-center', 'pointer-events-none']) {
      expect(poster![1].split(' ')).toContain(token);
    }
    expect(poster![2]).toBe('<span class="text-2xl font-semibold text-content">JAYFLIX</span><span class="sr-only">正在加载播放器</span>');
    expect(poster![2]).not.toMatch(/<svg|<img|<div|gap-/);
  });

  it('uses the same centered JAYFLIX text for live loading, with no legacy poster bitmap', () => {
    const html = renderToStaticMarkup(createElement(LivePlayer, {
      url: 'https://player.invalid/live.m3u8', title: '测试频道',
    }));
    const poster = html.match(/<div class="([^"]*)" role="status">([\s\S]*?)<\/div>/);
    expect(poster).not.toBeNull();
    for (const token of ['absolute', 'inset-0', 'bg-page', 'flex', 'items-center', 'justify-center', 'pointer-events-none']) {
      expect(poster![1].split(' ')).toContain(token);
    }
    expect(poster![2]).toBe('<span class="text-2xl font-semibold text-content">JAYFLIX</span><span class="sr-only">正在加载直播</span>');
    expect(poster![2]).not.toMatch(/<svg|<img|<div/);
    expect(html).not.toMatch(/LibreTV|player-poster\.png|background-image/i);
    expect(html).toContain('LIVE');
  });

  it('removes upstream promotion from the About page while keeping source, privacy and license information', () => {
    const client = new QueryClient();
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(AboutPage)));
    expect(html).toContain('关于 JAYFLIX');
    expect(html).toContain('JAYFLIX 是一个免费在线视频搜索与观看平台');
    expect(html).toContain('https://github.com/AustrianArtPainter/jayflix-2.0');
    for (const text of ['快捷键', '隐私与数据', '免责声明', 'AGPL-3.0 License']) expect(html).toContain(text);
    expect(html).not.toMatch(/LibreTV|LibreSpark|上游项目/i);
    client.clear();
  });

  it('keeps default dark theme and focus-triggered palette controls stable during SSR', () => {
    const html = renderToStaticMarkup(createElement(ThemeProvider, null,
      createElement(PaletteControl, { headingAction: createElement(ThemeToggle) })));
    expect(html).not.toContain('切换主题');
    expect(html).toContain('home-tool-label">色调');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('type="color"');
    expect(html).not.toContain('LibreTV');
  });

  it('renders the root error fallback with brand, palette tokens and safe defaults', () => {
    const html = renderToStaticMarkup(createElement(GlobalError, { error: Object.assign(new Error('fixture'), { digest: 'test-digest' }), reset: () => {} }));
    expect(html).toContain('JAYFLIX');
    expect(html).toContain(`var(--home-ink, ${DEFAULTS.background})`);
    expect(html).toContain(`var(--home-white, ${DEFAULTS.text})`);
    expect(html).toContain('var(--ui-control,');
    expect(html).toContain('test-digest');
    expect(html).toContain('jayflix.ui.palette.v1');
    expect(html).not.toContain('#0b101a');
    expect(html).toContain('libretv-theme');
  });
});
