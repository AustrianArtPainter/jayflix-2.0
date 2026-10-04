'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { ErrorState } from '@/components/states';

/**
 * 路由段级错误边界：捕获页面渲染/数据异常，避免落到 Next 默认英文白屏。
 * 刻意不放 Header——它依赖 zustand store，若异常源正是 store 会二次崩溃。
 */
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[JAYFLIX] 页面渲染异常:', error);
  }, [error]);

  return (
    <div className="error-page min-h-screen flex flex-col">
      <div className="site-header-inner">
        <Link href="/" className="jayflix-brand" aria-label="JAYFLIX 首页">
          <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <span>JAYFLIX</span>
        </Link>
      </div>
      <main className="flex-1 flex items-center justify-center px-4">
        <ErrorState
          message="页面出了点问题，请重试。若持续失败请返回首页。"
          onRetry={reset}
          retryLabel="重试"
        />
      </main>
      <footer className="site-footer">
        <p className="text-center text-xs text-faint">
          问题持续存在？{' '}
          <Link href="/" className="hover:text-accent">
            返回首页
          </Link>
        </p>
      </footer>
    </div>
  );
}
