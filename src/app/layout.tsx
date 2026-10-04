import type { Metadata, Viewport } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { DEFAULTS, getPaletteBootstrapScript } from '@/lib/ui-palette';

export const metadata: Metadata = {
  title: {
    default: 'JAYFLIX - 免费在线视频搜索与观看平台',
    template: '%s - JAYFLIX',
  },
  description:
    'JAYFLIX 是一个免费的在线视频搜索平台，提供来自多个视频源的内容搜索、观看、直播与下载服务。',
  manifest: '/manifest.webmanifest',
  // SVG favicon plus install PNGs generated from the same code-native camera.
  // Imported upstream bitmaps stay available for recovery, not brand metadata.
  icons: {
    icon: [
      { url: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    ],
    shortcut: '/icon.svg',
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  themeColor: DEFAULTS.background,
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="dark" suppressHydrationWarning>
      <head>
        {/* 首屏前同步主题，避免亮暗闪烁 */}
        <script
          dangerouslySetInnerHTML={{
            __html: getPaletteBootstrapScript(),
          }}
        />
      </head>
      <body className="jayflix-ui">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
