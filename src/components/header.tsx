'use client';

import Link from 'next/link';
import { useLayoutEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ThemeToggle } from './theme';
import { PaletteControl } from './palette';
import { SourceManagerDrawer } from './source-manager';
import { HistoryPanel } from './history-panel';
import { requestShowDownloadManager } from './download-manager';
import { Icon } from './icon';
import { SearchHistoryDropdown, useSearchHistory } from './search-history';
import { cn } from '@/lib/utils';

/** 顶部导航：Logo、搜索框（首页外）、历史、设置 */
export function Header({ showSearch = false }: { showSearch?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [query, setQuery] = useState('');
  const headerRef = useRef<HTMLElement>(null);
  // 与首页搜索框共用同一套「最近搜索」下拉逻辑
  const searchHistory = useSearchHistory(query);

  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const measure = () => document.documentElement.style.setProperty('--site-header-height', `${header.getBoundingClientRect().height}px`);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  const submitSearch = (text: string) => {
    const q = text.trim().slice(0, 100);
    if (!q) return;
    searchHistory.close();
    router.push(`/?s=${encodeURIComponent(q)}`, { scroll: false });
    // 顶栏搜索一并写入最近搜索（此前只有首页会记录）
    searchHistory.record(q);
  };

  const pickHistory = (text: string) => {
    setQuery(text);
    submitSearch(text);
  };

  return (
    <>
      <header ref={headerRef} className="site-header sticky top-0 z-40">
        <div className="site-header-inner">
          <Link href="/" aria-label="JAYFLIX 首页" className="jayflix-brand">
            <CameraIcon />
            <span>JAYFLIX</span>
          </Link>

          {showSearch && (
            <form
              className="header-search hidden sm:block"
              onSubmit={(e) => {
                e.preventDefault();
                submitSearch(query);
              }}
            >
              <div ref={searchHistory.containerRef} className="relative">
                <input
                  className={cn(
                    'input w-full h-9',
                    // 展开时：上圆角与外框沿用聚焦样式，底边改为内部分隔线，与下拉拼成同一面板
                    searchHistory.visible &&
                      'rounded-b-none border-accent border-b-line bg-surface-raised focus-visible:ring-0'
                  )}
                  aria-label="搜索影片"
                  placeholder="搜索影片..."
                  value={query}
                  maxLength={100}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onBlur={(event) => {
                    if (!searchHistory.containerRef.current?.contains(event.relatedTarget as Node | null)) searchHistory.close();
                  }}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-expanded={searchHistory.visible}
                  aria-controls="header-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `header-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {searchHistory.visible && (
                  <SearchHistoryDropdown
                    id="header-search-history"
                    matches={searchHistory.matches}
                    activeIndex={searchHistory.activeIndex}
                    onPick={pickHistory}
                    onRemove={searchHistory.remove}
                    onClearAll={searchHistory.clearAll}
                  />
                )}
              </div>
            </form>
          )}

          <nav className="site-header-tools" aria-label="主导航">
            <div className="site-header-extra-tools">
              <HeaderLink href="/live" active={pathname === '/live'} icon="live">
                直播
              </HeaderLink>
              <HeaderLink href="/about" active={pathname === '/about'} icon="about">
                关于
              </HeaderLink>
              <IconButton label="下载管理" onClick={requestShowDownloadManager}>
                <Icon name="download" />
                <span className="home-tool-label">下载</span>
              </IconButton>
            </div>
            <div className="site-header-legacy-tools">
              <PaletteControl headingAction={<ThemeToggle />} />
              <IconButton label="观看历史" onClick={() => setHistoryOpen(true)}>
                <Icon name="clock" />
                <span className="home-tool-label">历史</span>
              </IconButton>
              <IconButton label="设置" onClick={() => setSettingsOpen(true)}>
                <Icon name="gear" />
                <span className="home-tool-label">设置</span>
              </IconButton>
            </div>
          </nav>
        </div>
      </header>

      <SourceManagerDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
    </>
  );
}

export function CameraIcon() {
  return (
    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  );
}

function HeaderLink({ href, active, children, icon }: { href: string; active: boolean; children: React.ReactNode; icon: 'live' | 'about' }) {
  return (
    <Link
      href={href}
      className={cn('home-tool-button', active && 'home-tool-active')}
      aria-label={icon === 'live' ? '直播' : '关于 JAYFLIX'}
      aria-current={active ? 'page' : undefined}
      title={icon === 'live' ? '直播' : '关于 JAYFLIX'}
    >
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        {icon === 'live' ? (
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 3l3 3 3-3M5 7h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V9a2 2 0 012-2zM9 11l6 3-6 3z" />
        ) : (
          <>
            <circle cx="12" cy="12" r="9" strokeWidth="2" />
            <path strokeLinecap="round" strokeWidth="2" d="M12 11v6m0-10v.01" />
          </>
        )}
      </svg>
      <span className="home-tool-label">{children}</span>
    </Link>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="home-tool-button"
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
