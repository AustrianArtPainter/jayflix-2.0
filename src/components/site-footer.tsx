'use client';

import Link from 'next/link';
import { JAYFLIX_REPOSITORY_URL } from '@/lib/branding';

/** 全站统一页脚：当前项目源码、许可及免责声明。来源归属保留在源码的许可文档中。 */
export function SiteFooter() {
  return (
    <footer className="site-footer">
      <p className="text-center text-xs text-faint">
        <Link href="/" className="footer-brand">JAYFLIX</Link>
        {' · '}
        <a href={JAYFLIX_REPOSITORY_URL} target="_blank" rel="noopener noreferrer">JAYFLIX 源码</a>
        {' · '}
        AGPL-3.0 License
        {' · '}
        <Link href="/about">关于与免责声明</Link>
      </p>
    </footer>
  );
}
