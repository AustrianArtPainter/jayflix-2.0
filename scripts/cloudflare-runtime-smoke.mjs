import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash, createHmac } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

// Uses the pinned Wrangler toolchain's local workerd. Bundle production helpers
// in memory; no account, environment files, deploy, or external network is used.
const root = fileURLToPath(new URL('../', import.meta.url));
const compiled = await build({
  stdin: {
    resolveDir: root,
    sourcefile: 'runtime-fixture.ts',
    loader: 'ts',
    contents: `
      import { Buffer } from 'node:buffer';
      import process from 'node:process';
      import { resolveWorkerAddresses } from './src/lib/worker-dns';
      import { parseXmltv, XmltvLimitError } from './src/lib/xmltv';
      import { isBlockedByDNS, isPrivateIP, allowLivePrivate, checkLiveUrlAllowed } from './src/lib/ssrf';
      import { getEnvSources } from './src/lib/env-sources';
      import { getEnvLiveSources } from './src/lib/env-live-sources';
      import { getEnvSubscriptions } from './src/lib/env-subscriptions';
      import { getEnvRecommendSource } from './src/lib/env-recommend-source';
      import { getEnvImageMode } from './src/lib/env-image-mode';
      import { getSearchSettings } from './src/lib/search-settings';
      import { fetchWithSafeRedirects } from './src/lib/fetch-utils';
      import { isPasswordConfigured, isAdminPasswordConfigured, checkPassword, checkAdminPassword, signSession, signAdminSession, verifySession, verifyAdminSession } from './src/lib/auth';
      export default { async fetch(request, env, ctx) {
        // Match OpenNext's test-only request context/global bootstrap. These
        // fixtures are never a production Worker entry point.
        globalThis[Symbol.for('__cloudflare-context__')] = { env, ctx, cf: {} };
        globalThis.Buffer = Buffer;
        globalThis.process = process;
        const pathname = new URL(request.url).pathname;
        if (pathname === '/settings') {
          process.env.DEFAULT_SOURCES = '[{"name":"stale","url":"https://stale.example/cms"}]';
          process.env.DEFAULT_LIVE_SOURCES = '[{"name":"stale","url":"http://10.0.0.1/live"}]';
          process.env.DEFAULT_SUBSCRIPTIONS = '["https://stale.example/sources"]';
          process.env.DEFAULT_RECOMMEND_SOURCE = 'douban';
          process.env.DEFAULT_IMAGE_MODE = 'proxy';
          process.env.SEARCH_MAX_PAGES = '50';
          process.env.SEARCH_SOURCE_TIMEOUT_MS = '60000';
          process.env.LIVE_ALLOW_PRIVATE = '1';
          return Response.json({
            sources: getEnvSources().map((entry) => entry.name),
            live: getEnvLiveSources().map((entry) => entry.name),
            subscriptions: getEnvSubscriptions().map((entry) => entry.url),
            recommend: getEnvRecommendSource() ?? null, image: getEnvImageMode() ?? null,
            search: getSearchSettings(), private: allowLivePrivate(),
            privateAllowed: (await checkLiveUrlAllowed('http://10.0.0.1/live')).ok,
          });
        }
        if (pathname === '/auth-bindings') {
          process.env.PASSWORD = 'stale-access-fixture';
          process.env.ADMINPASSWORD = 'stale-admin-fixture';
          process.env.PROXY_SECRET = 'stale-signature-fixture';
          const configured = isPasswordConfigured();
          let access, admin;
          if (configured) {
            access = signSession().token;
            if (isAdminPasswordConfigured()) admin = signAdminSession(access).token;
          }
          return Response.json({
            configured, adminConfigured: isAdminPasswordConfigured(),
            accessMatches: checkPassword('bound-access-fixture'),
            adminMatches: checkAdminPassword('bound-admin-fixture'),
            verified: access ? verifySession(access) : false,
            adminVerified: admin ? verifyAdminSession(admin, access) : false,
            access, admin,
          });
        }
        if (pathname === '/stream') {
          const { res } = await fetchWithSafeRedirects('https://93.184.216.34/fixture.ts', { headers: { Range: 'bytes=0-2' } }, { headerTimeoutMs: 100 });
          return new Response(res.body, { status: res.status, headers: res.headers });
        }
        if (pathname === '/redirect') {
          try {
            await fetchWithSafeRedirects('https://93.184.216.34/redirect');
            return Response.json({ blocked: false });
          } catch {
            return Response.json({ blocked: true });
          }
        }
        if (pathname === '/dns') {
          return Response.json({ blocked: await isBlockedByDNS('https://fixture.example.com/') });
        }
        if (pathname === '/dns-details') {
          const answers = await Promise.allSettled([resolveWorkerAddresses('fixture.example.com', 1), resolveWorkerAddresses('fixture.example.com', 28)]);
          return Response.json(answers.map((entry) => entry.status === 'fulfilled' ? entry : { status: entry.status, reason: { code: entry.reason.code, message: entry.reason.message } }));
        }
        if (pathname === '/ips') {
          return Response.json({
            mapped: isPrivateIP('::ffff:127.0.0.1'),
            expanded: isPrivateIP('0:0:0:0:0:ffff:a00:1'),
            public: isPrivateIP('2606:4700:4700::1111'),
          });
        }
        try {
          const limits = { maxInputBytes: 4096, maxExpandedBytes: 4096, maxPrograms: 20, maxParsedBytes: 4096 };
          const parsed = parseXmltv(Buffer.from(await request.arrayBuffer()), undefined, Date.UTC(2024, 5, 1, 12), limits);
          return Response.json({ channels: parsed.size });
        } catch (error) {
          return Response.json({ limited: error instanceof XmltvLimitError, message: error.message }, { status: error instanceof XmltvLimitError ? 413 : 500 });
        }
      }};
    `,
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  external: ['node:*', 'wrangler'],
  write: false,
});

let dnsAttempts = 0;
let dnsMode = 'outage';
const dnsQueries = [];
let rangeHeader;
let privateRequests = 0;
const runtimeOptions = {
  modules: true,
  script: compiled.outputFiles[0].text,
  compatibilityDate: '2026-10-01',
  compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  host: '127.0.0.1',
  port: 0,
  outboundService: async (request) => {
    const query = new URL(request.url);
    if (query.hostname === '127.0.0.1') privateRequests++;
    if (query.pathname === '/redirect') return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } });
    if (query.pathname === '/fixture.ts') {
      rangeHeader = request.headers.get('range');
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); } }), {
        status: 206,
        headers: { 'Content-Type': 'video/mp2t', 'Content-Range': 'bytes 0-2/100', 'Accept-Ranges': 'bytes' },
      });
    }
    dnsAttempts++;
    dnsQueries.push(query.search);
    if (dnsMode === 'outage') return new Response('Fixture DNS outage', { status: 503 });
    const type = query.searchParams.get('type');
    const ipv6 = type === 'AAAA' || type === '28';
    const addresses = ipv6 ? ['2606:4700:4700::1111'] : ['93.184.216.34'];
    if (dnsMode === 'mixed' && !ipv6) addresses.push('10.0.0.1');
    if (dnsMode === 'mapped' && ipv6) addresses.push('::ffff:127.0.0.1');
    if (dnsMode === 'nodata' && ipv6) addresses.length = 0;
    if (dnsMode === 'cname' && ipv6) addresses.length = 0;
    return Response.json({
      Status: dnsMode === 'nxdomain' ? 3 : 0, TC: false, RD: true, RA: true, AD: false, CD: false,
      Question: [{ name: 'fixture.example.com', type: ipv6 ? 28 : 1 }],
      Answer: [...(dnsMode === 'cname' ? [{ name: 'fixture.example.com', type: 5, TTL: 60, data: 'alias.example.com.' }] : []),
        ...addresses.map((data) => ({ name: 'fixture.example.com', type: ipv6 ? 28 : 1, TTL: 60, data }))],
    }, { headers: { 'Content-Type': 'application/dns-json' } });
  },
};
const runtime = new Miniflare(convertV4MiniflareOptions(runtimeOptions));

try {
  const xml = '<tv><programme channel="fixture" start="20240601110000Z" stop="20240601130000Z"><title>Fixture</title></programme></tv>';
  const valid = await runtime.dispatchFetch('http://runtime.test/gzip', { method: 'POST', body: gzipSync(xml) });
  assert.equal(valid.status, 200);
  assert.equal((await valid.json()).channels, 1);
  const bomb = await runtime.dispatchFetch('http://runtime.test/gzip', { method: 'POST', body: gzipSync('x'.repeat(65536)) });
  assert.equal(bomb.status, 413, 'real workerd gzip maxOutputLength classification');
  assert.equal((await bomb.json()).limited, true);
  const ips = await runtime.dispatchFetch('http://runtime.test/ips');
  assert.deepEqual(await ips.json(), { mapped: true, expanded: true, public: false });
  const dns = await runtime.dispatchFetch('http://runtime.test/dns');
  assert.equal((await dns.json()).blocked, true, 'DNS outage must fail closed');
  assert(dnsAttempts > 0, 'typed Workers resolver must attempt DoH: ' + JSON.stringify(await (await runtime.dispatchFetch('http://runtime.test/dns-details')).json()));
  dnsMode = 'public';
  const publicDNS = await runtime.dispatchFetch('http://runtime.test/dns');
  const diagnostic = await runtime.dispatchFetch('http://runtime.test/dns-details');
  assert.equal((await publicDNS.json()).blocked, false, `all-public DNS fixture ${JSON.stringify(dnsQueries)} ${JSON.stringify(await diagnostic.json())}`);
  dnsMode = 'mixed';
  const privateDNS = await runtime.dispatchFetch('http://runtime.test/dns');
  assert.equal((await privateDNS.json()).blocked, true, 'one private answer rejects the entire A/AAAA set');
  dnsMode = 'mapped';
  assert.equal((await (await runtime.dispatchFetch('http://runtime.test/dns')).json()).blocked, true, 'mapped private IPv6 answer');
  dnsMode = 'nodata';
  assert.equal((await (await runtime.dispatchFetch('http://runtime.test/dns')).json()).blocked, false, 'public A plus absent AAAA');
  dnsMode = 'cname';
  assert.equal((await (await runtime.dispatchFetch('http://runtime.test/dns')).json()).blocked, false, 'CNAME records are names, not IP addresses; public A with CNAME-only AAAA');
  dnsMode = 'nxdomain';
  assert.equal((await (await runtime.dispatchFetch('http://runtime.test/dns')).json()).blocked, true, 'NXDOMAIN is not successful absent AAAA');
  const live = await runtime.dispatchFetch('http://runtime.test/stream');
  assert.equal(live.status, 206);
  assert.equal(rangeHeader, 'bytes=0-2');
  assert.equal(live.headers.get('content-range'), 'bytes 0-2/100');
  // The fixture never reaches EOF. Headers must return, and the headers-only
  // timeout must not cut off the live body afterwards.
  await delay(150);
  const reader = live.body.getReader();
  assert.deepEqual([...((await reader.read()).value)], [1, 2, 3]);
  await reader.cancel();
  assert.equal((await (await runtime.dispatchFetch('http://runtime.test/redirect')).json()).blocked, true);
  assert.equal(privateRequests, 0, 'private redirect must never reach outbound fetch');
  const absentSettings = await runtime.dispatchFetch('http://runtime.test/settings');
  assert.deepEqual(await absentSettings.json(), {
    sources: [], live: [], subscriptions: [], recommend: null, image: null,
    search: { maxPages: 5, sourceTimeoutMs: 10000 }, private: false, privateAllowed: false,
  }, 'absent Worker runtime settings ignore stale process.env values');
  const absent = await runtime.dispatchFetch('http://runtime.test/auth-bindings');
  assert.deepEqual(await absent.json(), {
    configured: false, adminConfigured: false, accessMatches: false, adminMatches: false, verified: false, adminVerified: false,
  }, 'missing Worker bindings must not revive stale process.env credentials');
  await runtime.setOptions(convertV4MiniflareOptions({
    ...runtimeOptions,
    bindings: {
      PASSWORD: 'bound-access-fixture', ADMINPASSWORD: 'bound-admin-fixture', PROXY_SECRET: 'bound-signature-fixture',
      DEFAULT_SOURCES: '[{"name":"bound source","url":"https://bound.example/cms"}]',
      DEFAULT_LIVE_SOURCES: '[{"name":"bound live","url":"https://bound.example/live"}]',
      DEFAULT_SUBSCRIPTIONS: '["https://bound.example/sources"]',
      DEFAULT_RECOMMEND_SOURCE: 'bangumi', DEFAULT_IMAGE_MODE: 'direct',
      SEARCH_MAX_PAGES: '2', SEARCH_SOURCE_TIMEOUT_MS: '4000', LIVE_ALLOW_PRIVATE: '1',
    },
  }));
  const bound = await (await runtime.dispatchFetch('http://runtime.test/auth-bindings')).json();
  for (const name of ['configured', 'adminConfigured', 'accessMatches', 'adminMatches', 'verified', 'adminVerified']) {
    assert.equal(bound[name], true, `actual request binding ${name}`);
  }
  for (const [scope, token, credential] of [
    ['access', bound.access, 'bound-access-fixture'], ['admin', bound.admin, 'bound-admin-fixture'],
  ]) {
    const parts = token.split('.');
    const actual = parts.pop();
    const key = createHash('sha256').update(JSON.stringify(['libretv:session:v1', scope, 'bound-signature-fixture', credential])).digest();
    const expected = createHmac('sha256', key).update(parts.join('.')).digest('hex');
    assert.equal(actual, expected, `${scope} HMAC must consume bound PROXY_SECRET, not stale process.env`);
  }
  const boundSettings = await runtime.dispatchFetch('http://runtime.test/settings');
  assert.deepEqual(await boundSettings.json(), {
    sources: ['bound source'], live: ['bound live'], subscriptions: ['https://bound.example/sources'],
    recommend: 'bangumi', image: 'direct', search: { maxPages: 2, sourceTimeoutMs: 4000 },
    private: false, privateAllowed: false,
  }, 'current Worker settings consumed; LIVE_ALLOW_PRIVATE=1 must still stay disabled');
  console.log('Local workerd runtime: gzip, typed DNS A/AAAA/CNAME/NODATA/NXDOMAIN, Range streaming, redirects, missing/current secrets and runtime settings passed (17 checks).');
} finally {
  await runtime.dispose();
}
