import type { NextConfig } from 'next';
import fs from 'node:fs';
import path from 'node:path';
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';

// opt-in bindings in next dev; Node/Docker build/start must not launch Wrangler.
if (process.env.NEXT_DEV_CLOUDFLARE === '1') {
  initOpenNextCloudflareForDev();
}

/** 版本号以 package.json 为单一来源，构建时注入 process.env.APP_VERSION（/api/status 使用） */
function readAppVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const nextConfig: NextConfig = {
  // Isolate a concurrent local dev preview from the default production build output.
  distDir: process.env.NEXT_DEV_OUTPUT || '.next',
  // standalone 输出仅供 Docker 镜像构建使用（DOCKER_BUILD=1）；
  // 本地 next start 在 standalone 模式下不受支持，故按环境切换
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : undefined,
  // Keep dependency tracing inside the imported app, separate from the legacy root.
  outputFileTracingRoot: path.resolve(process.cwd()),
  reactStrictMode: true,
  devIndicators: false,
  // Legacy redirects must retain the incoming origin (including literal loopback hosts).
  skipMiddlewareUrlNormalize: true,
  env: { APP_VERSION: readAppVersion() },
  // 采集站/豆瓣等上游地址在运行时由用户配置，构建期无法枚举，关闭图片优化改用 <img>
  images: { unoptimized: true },
};

export default nextConfig;
