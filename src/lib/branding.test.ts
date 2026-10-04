import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { JAYFLIX_REPOSITORY_URL, JAYFLIX_USER_AGENT } from './branding';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

// These exact, file-scoped identifiers are persisted data or wire contracts,
// not UI text. Keep them stable so cleanup cannot silently orphan user data.
const compatibility: Record<string, string[]> = {
  'src/lib/auth.ts': ['libretv:session:v1'],
  'src/lib/client-api.ts': ['libretv:unauthorized'],
  'src/lib/db.ts': ['libretv'],
  'src/lib/m3u8-downloader.ts': ['libretv-dl-v1', 'https://dl.libretv.local'],
  'src/lib/persist-storage.ts': ['libretv-settings'],
  'src/lib/settings-backup.ts': ['LibreTV-Settings'],
  'src/lib/types.ts': ['LibreTV-Settings', 'libretv'],
  'src/lib/tvbox-parser.ts': ['libretv'],
  'src/lib/ui-palette.ts': ['libretv-theme'],
  'src/lib/video-cache.ts': ['libretv-video-v1'],
  'src/lib/video-cache-settings.ts': ['libretv-video-cache-settings'],
  'src/components/auth.tsx': ['libretv:auth-changed', 'libretv-auth-event'],
  'src/components/download-manager.tsx': ['libretv:add-download', 'libretv:show-download-manager', 'libretv:downloads-updated'],
  'src/components/source-manager.tsx': ['libretv-settings-tab', 'LibreTV-SourceList'],
  'src/app/api/publish/route.ts': ['LibreTV-SourceList'],
};

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('JAYFLIX public branding audit', () => {
  it('scans all production TS/TSX text and permits only explicit compatibility identifiers', () => {
    const files = sourceFiles(join(root, 'src'));
    expect(files.length).toBeGreaterThan(0);
    const unexpected: string[] = [];
    const retained = new Set<string>();
    for (const path of files) {
      const file = relative(root, path);
      const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          const text = node.text;
          if (/libretv|librespark/i.test(text)) {
            if (!ts.isJsxText(node) && compatibility[file]?.includes(text)) {
              retained.add(`${file}:${text}`);
            } else {
              const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
              unexpected.push(`${file}:${line + 1}: ${text}`);
            }
          }
          if (/player-poster\.png|\/icons\/icon-\d+\.png|\/icons\/apple-touch-icon\.png|favicon\.ico/.test(text)) {
            unexpected.push(`${file}: obsolete artwork reference: ${text}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(unexpected).toEqual([]);
    for (const [file, values] of Object.entries(compatibility)) {
      for (const value of values) expect(retained.has(`${file}:${value}`), `${file}: ${value} must remain compatible`).toBe(true);
    }
  });

  it('uses one public repository and request identity without bringing back upstream footer requests', () => {
    expect(JAYFLIX_REPOSITORY_URL).toBe('https://github.com/AustrianArtPainter/jayflix-2.0');
    expect(JAYFLIX_USER_AGENT).toBe(`JAYFLIX (+${JAYFLIX_REPOSITORY_URL})`);
    for (const path of ['src/lib/bangumi.ts', 'src/lib/douban-weekly.ts', 'src/lib/source-list-publish.ts']) {
      expect(read(path)).toContain("from './branding'");
      expect(read(path)).toContain('JAYFLIX_USER_AGENT');
    }
    expect(read('src/components/site-footer.tsx')).not.toMatch(/\bfetch\(|upstream-latest-tag|useUpstreamUpdate/);
  });

  it('removes only obsolete brand artwork and keeps the current install icons', () => {
    for (const path of ['player-poster.png', 'favicon.ico', 'icons/apple-touch-icon.png',
      ...[48, 96, 144, 192, 512].map((size) => `icons/icon-${size}.png`)]) {
      expect(existsSync(join(root, 'public', path)), path).toBe(false);
    }
    for (const path of ['icon.svg', 'apple-touch-icon.png', 'icons/jayflix-192.png', 'icons/jayflix-512.png',
      'icons/jayflix-maskable-192.png', 'icons/jayflix-maskable-512.png']) {
      expect(existsSync(join(root, 'public', path)), path).toBe(true);
    }
  });

  it('brands project metadata and overviews without deleting license or provenance', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    expect(pkg.name).toBe('jayflix-2.0');
    expect(pkg.version).toBe('2.0.0');
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[''].name).toBe(pkg.name);
    expect(pkg.license).toBe('AGPL-3.0-or-later');
    const [overview, notice] = read('README.md').split('## 来源与许可');
    expect(overview).not.toMatch(/LibreTV|LibreSpark/i);
    expect(notice).toContain('https://github.com/LibreSpark/LibreTV');
    expect(notice).toContain('AGPL-3.0-or-later');
    expect(read('migration-baseline.json')).toContain('https://github.com/LibreSpark/LibreTV');
    expect(read('LICENSE')).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');
  });
});
