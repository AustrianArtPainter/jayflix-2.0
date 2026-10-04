import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SiteFooter } from '../components/site-footer';

it('transforms a real imported Next TSX component with the automatic JSX runtime', () => {
  const markup = renderToStaticMarkup(createElement(SiteFooter));
  expect(markup).toContain('JAYFLIX');
  expect(markup).toContain('href="/about"');
  expect(markup).toContain('AGPL-3.0');
  expect(markup).toContain('href="https://github.com/AustrianArtPainter/jayflix-2.0"');
  expect(markup).toContain('JAYFLIX 源码');
  expect(markup).not.toMatch(/LibreTV|LibreSpark/i);
});
