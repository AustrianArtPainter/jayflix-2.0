import type { MetadataRoute } from 'next';
import { DEFAULTS } from '@/lib/ui-palette';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'JAYFLIX - 免费在线视频搜索与观看平台',
    short_name: 'JAYFLIX',
    description: '免费在线视频搜索与观看平台',
    start_url: '/',
    display: 'standalone',
    background_color: DEFAULTS.background,
    theme_color: DEFAULTS.background,
    icons: [
      {
        src: '/icons/jayflix-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/jayflix-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/jayflix-maskable-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/jayflix-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
