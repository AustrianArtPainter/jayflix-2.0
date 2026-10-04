'use client';

import { useState } from 'react';
import { Drawer } from './drawer';
import { DEFAULT_MOVIE_TAGS, DEFAULT_TV_TAGS, normalizeTags } from '@/lib/recommend-tags';

export function RecommendTagManager({ open, onClose, type, tags, onChange }: {
  open: boolean; onClose: () => void; type: 'movie' | 'tv'; tags: string[]; onChange: (tags: string[]) => void;
}) {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  return <Drawer open={open} onClose={onClose} title={`标签管理 · ${type === 'movie' ? '电影' : '电视剧'}`}>
    <div className="flex flex-wrap gap-2">
      {tags.map((tag) => <span className="flex items-center gap-2 bg-chip text-content rounded px-3 py-2 text-sm" key={tag}>{tag}{tag !== '热门' && <button aria-label={`删除${tag}标签`} onClick={() => onChange(tags.filter((name) => name !== tag))}>×</button>}</span>)}
    </div>
    <form className="flex gap-2 mt-5" onSubmit={(event) => {
      event.preventDefault(); const name = input.trim();
      if (!name || name.length > 32 || tags.includes(name) || tags.length >= 64) { setError('标签不能为空、重复或超过数量及长度限制。'); return; }
      onChange(normalizeTags([...tags, name], [])); setInput(''); setError('');
    }}>
      <input className="input flex-1 min-w-0" placeholder="输入标签名称" maxLength={32} aria-label="新标签名称" value={input} onChange={(event) => setInput(event.target.value)} />
      <button className="btn-primary" type="submit">添加</button>
    </form>
    {error && <p role="alert" className="text-danger text-sm mt-2">{error}</p>}
    <button className="btn-ghost mt-5" onClick={() => onChange(type === 'movie' ? [...DEFAULT_MOVIE_TAGS] : [...DEFAULT_TV_TAGS])}>恢复默认标签</button>
  </Drawer>;
}
