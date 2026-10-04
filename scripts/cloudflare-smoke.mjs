import assert from 'node:assert/strict';
import fs from 'node:fs';

// Read route names only. This script never reads .env/.dev.vars or credentials.
const base = new URL(process.argv[2] || 'http://127.0.0.1:8082');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Smoke tests must target a local preview');
const password = process.env.CF_SMOKE_PASSWORD;
const adminPassword = process.env.CF_SMOKE_ADMIN_PASSWORD;
const runtimeLabel = process.argv[3] || 'Workers';
const target = 'https://93.184.216.34/fixture.ts';
const manifest = JSON.parse(fs.readFileSync(new URL('../.next/server/app-paths-manifest.json', import.meta.url), 'utf8'));
const mutations = new Set(['search', 'source/test', 'publish', 'live/probe']);
let passed = 0;
let homeHtml = '';

async function call(route, init = {}) {
  const url = new URL(route, base);
  return fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...init });
}

const status = await call('/api/status');
assert.equal(status.status, 200, 'status route');
const state = await status.json();
assert.equal(state.verified, false, 'anonymous status');
const configured = state.passwordConfigured ?? state.passwordRequired;
const expected = configured ? 401 : 503;

// All built API paths except the session/status endpoints must fail closed with
// no authenticated cookie. A public literal avoids accidentally fetching real data.
for (const key of Object.keys(manifest).filter((key) => key.startsWith('/api/') && key.endsWith('/route'))) {
  const route = key.slice('/api/'.length, -'/route'.length);
  if (['auth', 'status', 'admin/auth'].includes(route)) continue;
  const method = mutations.has(route) ? 'POST' : 'GET';
  const pathname = `/api/${route.replace('[url]', encodeURIComponent(target))}`;
  const res = await call(`${pathname}?url=${encodeURIComponent(target)}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  assert.equal(res.status, expected, `${method} ${pathname} fails closed`);
  await res.body?.cancel();
  passed++;
}

if (password) {
  const login = await call('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base.origin },
    body: JSON.stringify({ password }),
  });
  assert.equal(login.status, 200, 'fixture access login');
  const cookie = login.headers.getSetCookie().find((value) => value.startsWith('ltv_session='))?.split(';')[0];
  assert(cookie, 'access cookie present');
  const verified = await call('/api/auth', { headers: { Cookie: cookie } });
  assert.equal((await verified.json()).verified, true, 'fixture session verification');
  const rejected = await call('/api/proxy?url=http%3A%2F%2F127.0.0.1%2Fsecret', { headers: { Cookie: cookie } });
  assert([400, 403].includes(rejected.status), 'private IP rejected');
  passed += 3;
  if (adminPassword) {
    const before = await call('/api/admin', { headers: { Cookie: cookie } });
    assert.equal((await before.json()).verified, false, 'access alone must not unlock admin');
    const admin = await call('/api/admin', {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base.origin },
      body: JSON.stringify({ password: adminPassword }),
    });
    assert.equal(admin.status, 200, 'fixture administrator login');
    const adminCookie = admin.headers.getSetCookie().find((value) => value.startsWith('ltv_admin_session='))?.split(';')[0];
    assert(adminCookie, 'administrator cookie present');
    const both = `${cookie}; ${adminCookie}`;
    const verifiedAdmin = await call('/api/admin', { headers: { Cookie: both } });
    assert.equal((await verifiedAdmin.json()).verified, true, 'fixture administrator verification');
    const logout = await call('/api/admin', { method: 'DELETE', headers: { Cookie: both, Origin: base.origin } });
    assert.equal(logout.status, 200, 'administrator logout');
    assert(logout.headers.get('set-cookie').includes('Max-Age=0'));
    assert(!logout.headers.get('set-cookie').includes('ltv_session='), 'admin logout preserves access cookie');
    const accessAfter = await call('/api/auth', { headers: { Cookie: cookie } });
    assert.equal((await accessAfter.json()).verified, true, 'access remains valid after admin logout');
    passed += 5;
  }
}

for (const key of Object.keys(manifest).filter((key) => key.endsWith('/page') && !key.startsWith('/_'))) {
  const pathname = key.slice(0, -'/page'.length) || '/';
  const res = await call(pathname);
  assert.equal(res.status, 200, `page ${pathname}`);
  if (pathname === '/') homeHtml = await res.text();
  else await res.body?.cancel();
  passed++;
}

async function legacyRedirect(pathname) {
  const res = await call(pathname);
  assert.equal(res.status, 307, `legacy redirect ${pathname}`);
  const location = new URL(res.headers.get('location'), base);
  assert.equal(location.origin, base.origin, 'legacy redirects remain same-origin');
  await res.body?.cancel();
  passed++;
  return location;
}
const history = await legacyRedirect('/player.html?source=DisplayName&source_code=actual-key&id=8&index=3&position=125');
assert.equal(history.pathname, '/watch');
assert.equal(history.searchParams.get('source'), 'actual-key');
for (const [key, value] of [['source_code', 'actual-key'], ['id', '8'], ['index', '3'], ['position', '125']]) {
  assert.equal(history.searchParams.get(key), value, `legacy ${key}`);
}
const custom = await legacyRedirect('/watch.html?customApi=https%3A%2F%2Ffixture.example%2Fapi&customDetail=https%3A%2F%2Ffixture.example%2Fdetail&back=%2Findex.html%3Fs%3Dfixture%23results');
assert.equal(custom.searchParams.get('sourceUrl'), 'https://fixture.example/api');
assert.equal(custom.searchParams.get('detail'), 'https://fixture.example/detail');
assert.equal(custom.searchParams.get('returnUrl'), '/?s=fixture#results');
const unsafe = await legacyRedirect('/watch.html?back=https%3A%2F%2Foutside.invalid%2F');
assert.equal(unsafe.searchParams.has('returnUrl'), false, 'unsafe legacy back rejected');
const oldSearch = await legacyRedirect('/s=' + encodeURIComponent('旧版搜索'));
assert.equal(oldSearch.pathname, '/');
assert.equal(oldSearch.searchParams.get('s'), '旧版搜索');

const webmanifest = await call('/manifest.webmanifest');
assert.equal(webmanifest.status, 200, 'PWA manifest');
const pwa = await webmanifest.json();
assert.equal(pwa.display, 'standalone');
assert(pwa.icons?.length, 'PWA icons declared');
passed++;
async function checkPng(pathname, size) {
  const url = new URL(pathname, base);
  assert.equal(url.origin, base.origin, 'PWA assets must remain local');
  const asset = await call(url.pathname);
  assert.equal(asset.status, 200, `PWA asset ${pathname}`);
  assert(asset.headers.get('content-type')?.includes('image/png'), `PNG content type ${pathname}`);
  const bytes = Buffer.from(await asset.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `PNG signature ${pathname}`);
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  if (size) {
    const [width, height] = size.split('x').map(Number);
    assert.equal(bytes.readUInt32BE(16), width, `PNG width ${pathname}`);
    assert.equal(bytes.readUInt32BE(20), height, `PNG height ${pathname}`);
  }
  passed++;
}
for (const icon of pwa.icons) await checkPng(icon.src, icon.sizes);
const apple = homeHtml.match(/<link\b[^>]*rel="apple-touch-icon"[^>]*href="([^"]+)"/);
assert(apple, 'iOS apple-touch-icon metadata');
await checkPng(apple[1], '180x180');
console.log(`Local ${runtimeLabel} preview: ${passed} route/page checks passed; configured=${Boolean(configured)}.`);
