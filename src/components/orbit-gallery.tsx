'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DoubanItem } from '@/lib/types';
import { useAppStore } from '@/lib/store';
import { createOrbitController } from '@/lib/orbit-controller.js';
import { MAX_DISPLAY_CARDS } from '@/lib/orbit-math.js';
import { SmartImage } from './smart-image';
import { recommendLink, type RecommendProvider } from '@/lib/recommend-link';
import './orbit-gallery.css';

/** React owns cards and data; animation never updates React state per frame. */
export function OrbitGallery({ items, onPick, placeholders = false, provider = 'douban' }: {
  items: DoubanItem[];
  onPick: (title: string) => void;
  placeholders?: boolean;
  provider?: RecommendProvider;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const imageMode = useAppStore((s) => s.imageProxyMode);
  const customProxy = useAppStore((s) => s.customImageProxy);
  const displayed = useMemo(() => items.slice(0, MAX_DISPLAY_CARDS), [items]);

  useEffect(() => {
    if (!root.current) return;
    const controller = createOrbitController(root.current);
    return () => controller?.destroy();
  }, []);

  return (
    <div className="orbit-gallery" ref={root}>
      <section id="recommendationOrbit" className="orbit-scene" tabIndex={0} aria-label="影视推荐球体">
        <div className="orbit-scene-meta" aria-hidden="true">
          <span>CURATED IN ORBIT</span><span><b id="orbitCount">{displayed.length}</b> 部精选</span>
        </div>
        <div className="orbit-camera"><div className="orbit-world">
          <div className="orbit-wireframe" aria-hidden="true">
            {[0, 1, 2].map((axis) => <i key={axis} className="orbit-great-circle" style={{ '--orbit-circle-transform': axis === 2 ? 'rotateX(90deg)' : `rotateY(${axis * 90}deg)` } as React.CSSProperties} />)}
          </div>
          <div id="douban-results" className="orbit-sphere">
            {displayed.map((item, index) => (
              <div className="orbit-card" data-orbit-card="true" key={`${item.id}:${index}`} role="group" aria-label={item.title} tabIndex={0} draggable={false}>
                <div className="orbit-card-front">
                  <button className="orbit-poster" type="button" onClick={() => onPick(item.title)} aria-label={`搜索${item.title}`} draggable={false}>
                    {placeholders || !item.cover ? <span className="orbit-empty-poster">{index + 1}</span> : <SmartImage url={item.cover} mode={imageMode} customProxy={customProxy} alt={item.title} />}
                    {item.rating && <span className="orbit-rating"><span className="orbit-rating-star">★</span> {item.rating}</span>}
                  </button>
                  {!placeholders && recommendLink(item.id, provider) && <a className="orbit-link" href={recommendLink(item.id, provider)} target="_blank" rel="noopener noreferrer" draggable={false} aria-label={`在${provider === 'bangumi' ? 'Bangumi' : '豆瓣'}查看${item.title}`}>🔗</a>}
                  <button className="orbit-title" type="button" onClick={() => onPick(item.title)}>{item.title}</button>
                  <span className="orbit-card-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                </div>
              </div>
            ))}
          </div>
        </div></div>
        <div className="orbit-loading" role="status" hidden><span />正在载入推荐</div>
      </section>
      <div className="orbit-toolbar" id="orbitToolbar" data-collapsed={String(!expanded)}>
        <button type="button" id="orbitToolbarToggle" className="orbit-gesture-icon orbit-toolbar-toggle" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls="orbitToolbarContent" aria-label={expanded ? '收起球体控制栏' : '展开球体控制栏'}>{expanded ? '↘' : '→'}</button>
        <div id="orbitToolbarContent" className="orbit-toolbar-content" hidden={!expanded}>
          <div className="orbit-control-stack">
            <div className="orbit-controls" role="group" aria-label="球体显示控制">
              <span className="orbit-control-label">球体</span>
              <Control action="zoom-out" label="缩小球体10%">−</Control>
              <span id="orbitZoom" className="orbit-value">200%</span>
              <Control action="zoom-in" label="放大球体10%">+</Control>
              <span className="orbit-control-divider" aria-hidden="true" />
              <button type="button" data-orbit-action="pause" id="orbitPause" aria-pressed="false"><span className="orbit-pause-icon" aria-hidden="true" /><span className="orbit-pause-label">暂停</span></button>
            </div>
            <div className="orbit-controls" role="group" aria-label="封面尺寸控制">
              <span className="orbit-control-label">封面</span>
              <Control action="card-size-out" label="缩小封面10%">−</Control>
              <span id="orbitCardScale" className="orbit-value">70%</span>
              <Control action="card-size-in" label="放大封面10%">+</Control>
              <span className="orbit-control-divider" aria-hidden="true" />
              <button type="button" data-orbit-action="reset" id="orbitReset">重置</button>
            </div>
            <div className="orbit-controls" role="group" aria-label="自动旋转转速控制">
              <span className="orbit-control-label">转速</span>
              <Control action="speed-out" label="降低转速10个百分点">−</Control>
              <span id="orbitSpeed" className="orbit-value">50%</span>
              <Control action="speed-in" label="提高转速10个百分点">+</Control>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Control({ action, label, children }: { action: string; label: string; children: React.ReactNode }) {
  return <button type="button" data-orbit-action={action} aria-label={label}>{children}</button>;
}
