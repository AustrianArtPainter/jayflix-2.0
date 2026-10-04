'use client';

import { DEFAULTS, buildAppVariables, getPaletteBootstrapScript } from '@/lib/ui-palette';

const FALLBACKS = buildAppVariables(DEFAULTS);

/**
 * 根布局级错误兜底：layout 本身崩溃时启用，必须自带 <html>/<body>。
 * 重用首屏色调脚本和内联回退样式，不依赖正常布局或 Provider。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: getPaletteBootstrapScript() }} /></head>
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          background: `var(--home-ink, ${DEFAULTS.background})`,
          color: `var(--home-white, ${DEFAULTS.text})`,
          fontFamily: 'system-ui, sans-serif',
          textAlign: 'center',
          padding: 16,
        }}
      >
        <h1 style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 12px', fontSize: 25, letterSpacing: '-.8px' }}>
          <svg width="25" height="25" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true" style={{ color: `var(--home-accent, ${DEFAULTS.accent})` }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          JAYFLIX
        </h1>
        <p style={{ margin: 0, fontSize: 14 }}>应用发生严重错误，请刷新页面重试。</p>
        <button
          onClick={reset}
          style={{
            padding: '6px 16px',
            borderRadius: 7,
            border: `1px solid var(--ui-control-border, ${FALLBACKS['--ui-control-border']})`,
            background: `var(--ui-control, ${FALLBACKS['--ui-control']})`,
            color: `var(--ui-button-text, ${FALLBACKS['--ui-button-text']})`,
            cursor: 'pointer',
          }}
        >
          刷新
        </button>
        {/* digest 用于线上日志定位，不含敏感信息，展示无妨 */}
        {error.digest && (
          <p style={{ margin: 0, fontSize: 11, color: `var(--home-muted, ${FALLBACKS['--home-muted']})` }}>错误编号：{error.digest}</p>
        )}
      </body>
    </html>
  );
}
