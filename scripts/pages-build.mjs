import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, cpSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const SECRET_KEYS = Object.freeze(['PASSWORD', 'ADMINPASSWORD', 'PROXY_SECRET']);
export function buildEnvironment(input) {
  const result = { ...input, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: '.wrangler/logs' };
  for (const key of [...SECRET_KEYS, 'NEXT_DEV_OUTPUT', 'NEXT_DEV_CLOUDFLARE']) delete result[key];
  return result;
}

export function assertCleanBuildInputs(root) {
  const unsafe = readdirSync(root).filter((file) =>
    (file === '.env' || file.startsWith('.env.') || file.startsWith('.dev.vars')) && file !== '.env.example');
  if (unsafe.length) throw new Error('Pages build requires a clean checkout without .env* or .dev.vars files. Runtime secrets belong in Cloudflare, never in the bundle.');
}

export function publicAssetPaths(root) {
  return readdirSync(root, { recursive: true }).filter((file) => statSync(join(root, file)).isFile())
    .map((file) => '/' + file.split('\\').join('/')).sort();
}

export function pagesRoutes(paths) {
  const roots = paths.filter((file) => !file.startsWith('/_next/') && !file.startsWith('/icons/'));
  const exclude = ['/_next/static/*', '/icons/*', ...roots];
  if (exclude.length + 1 > 100) throw new Error('Pages route rules exceed the platform limit; review new public assets before publishing.');
  return { version: 1, include: ['/*'], exclude };
}

export function buildPages(root) {
  assertCleanBuildInputs(root);
  const env = buildEnvironment(process.env);
  const run = (tool, args) => {
    const result = spawnSync(process.execPath, [join(root, 'node_modules/.bin', tool), ...args], { cwd: root, env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${tool} failed (${result.status ?? result.signal}); Pages output was not finalized.`);
  };
  run('opennextjs-cloudflare', ['build', '--config', 'wrangler.workers.jsonc']);
  const assets = join(root, '.open-next/assets');
  const paths = publicAssetPaths(assets);
  const entry = join(root, '.open-next/pages-entry.mjs');
  writeFileSync(entry, `import nextWorker from './worker.js';\nimport { createPagesWorker } from '../scripts/pages-worker.mjs';\nexport default createPagesWorker(nextWorker, ${JSON.stringify(paths)});\n`);
  // This command only bundles locally. It never uploads or creates a Worker.
  run('wrangler', ['deploy', '--config', 'wrangler.pages-bundle.jsonc', '--dry-run', '--minify', '--outdir', '.open-next/pages-bundle']);
  const output = join(root, '.cf-pages');
  // CI uses a fresh checkout. Refuse stale local output instead of deleting
  // user data or accidentally carrying removed assets into a release.
  if (existsSync(output)) throw new Error('Existing .cf-pages output: use a fresh checkout for a reproducible release.');
  mkdirSync(output);
  cpSync(assets, output, { recursive: true });
  copyFileSync(join(root, '.open-next/pages-bundle/pages-entry.js'), join(output, '_worker.js'));
  writeFileSync(join(output, '_routes.json'), JSON.stringify(pagesRoutes(paths), null, 2) + '\n');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(`Jayflix ${pkg.version}: Pages advanced-mode bundle + ${paths.length} static assets ready in .cf-pages (no account writes).`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { buildPages(fileURLToPath(new URL('../', import.meta.url))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
