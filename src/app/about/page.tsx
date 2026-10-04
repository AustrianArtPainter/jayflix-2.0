'use client';

import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { JAYFLIX_REPOSITORY_URL } from '@/lib/branding';

export default function AboutPage() {
  return (
    <div className="about-page min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-10 space-y-8">
        <section>
          <h1 className="text-xl font-bold text-content mb-3">关于 JAYFLIX</h1>
          <p className="text-sm text-muted leading-relaxed">
            JAYFLIX 是一个免费在线视频搜索与观看平台。输入片名即可在多个点播源中聚合搜索，
            通过访问密码进入，不向服务器上传或保存影视文件；播放内容来自第三方接口。缓存与下载保存在本设备。
          </p>
          <div className="flex flex-wrap gap-2 mt-4">
            <a href={JAYFLIX_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" className="btn-ghost btn-sm">JAYFLIX 源码</a>
          </div>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">快捷键</h2>
          <ul className="text-sm text-muted space-y-1.5 list-disc list-inside">
            <li><code className="text-accent">空格</code> 播放 / 暂停</li>
            <li><code className="text-accent">←</code> / <code className="text-accent">→</code> 快退 / 快进 5 秒</li>
            <li><code className="text-accent">↑</code> / <code className="text-accent">↓</code> 音量调节</li>
            <li><code className="text-accent">F</code> 切换全屏</li>
            <li><code className="text-accent">Alt + ←/→</code> 上一集 / 下一集</li>
            <li>移动端长按视频可 3 倍速播放</li>
          </ul>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">隐私与数据</h2>
          <p className="text-sm text-muted leading-relaxed">
            你的搜索历史、观看进度等数据仅保存在本设备浏览器中（IndexedDB），不会上传到服务器。
            聚合搜索请求由服务端转发；封面与媒体的直连或代理方式取决于所选设置。
          </p>
        </section>

        <section>
          <h2 className="text-base font-semibold text-content mb-2.5">免责声明</h2>
          <p className="text-sm text-faint leading-relaxed">
            本项目不存储、不制作任何视频内容，仅提供第三方公开接口的聚合与播放能力。
            请尊重版权，所有内容的合法性由对应数据源负责。
          </p>
        </section>
      </main>
      <SiteFooter />
    </div>
  );
}
