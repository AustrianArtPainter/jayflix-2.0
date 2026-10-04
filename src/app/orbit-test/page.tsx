'use client';

import { useEffect, useMemo, useState } from 'react';
import { Header } from '@/components/header';
import { OrbitGallery } from '@/components/orbit-gallery';
import { MAX_DISPLAY_CARDS } from '@/lib/orbit-math.js';
import { orbitTestCount } from '@/lib/orbit-test-config';

export default function OrbitTestPage() {
  const [count, setCount] = useState(212);
  useEffect(() => { setCount(orbitTestCount(new URLSearchParams(window.location.search))); }, []);
  const items = useMemo(() => Array.from({ length: count }, (_, index) => ({ id: String(index + 1), title: `空框 ${index + 1}`, cover: '' })), [count]);
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="w-full max-w-[1480px] mx-auto px-4 sm:px-8 py-6">
        <h1 className="text-lg font-semibold text-content">{count} 个空框，同一个球体。</h1>
        <p className="text-sm text-muted mt-2">与正式首页共用同一套排列、控制和动画；不请求封面图片或影视接口。</p>
        <div className="flex flex-wrap items-center gap-3 mt-4 text-sm text-muted">
          <label htmlFor="orbit-test-count">空框数量</label>
          <input id="orbit-test-count" className="input w-28" type="number" min={1} max={MAX_DISPLAY_CARDS} value={count} onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) setCount(Math.max(1, Math.min(MAX_DISPLAY_CARDS, Math.floor(value))));
          }} />
          {[16, 212, 1322].map((value) => <button key={value} className="btn-ghost" onClick={() => setCount(value)}>{value}</button>)}
        </div>
        <OrbitGallery items={items} onPick={() => {}} placeholders />
      </main>
    </div>
  );
}
