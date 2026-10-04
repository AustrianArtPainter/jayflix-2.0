# Jayflix 2.0 deployment

The independently published app is the root of `AustrianArtPainter/jayflix-2.0`.
In the migration workspace it lives in `next-app/`; the old Jayflix repository and
site are not deployment targets. Local verification does not need account writes.

## Production: independent Cloudflare Pages project

Use GitHub `main` automatic deployments to the new Pages project `jayflix-2-0`.
Framework preset None, build command `npm run pages:build`, output `.cf-pages`,
root directory empty, Node 22+. The canonical `wrangler.jsonc` supplies Pages output
and Node compatibility flags. Runtime PASSWORD and ADMINPASSWORD are distinct
private bindings; never copy them to source, build substitutions or documentation.

`scripts/pages-build.mjs` builds OpenNext using `wrangler.workers.jsonc`, then uses
a **local-only Wrangler dry-run** to bundle the default fetch handler and the
Pages adapter. No separate Worker is created or uploaded. Static assets and the
resulting `_worker.js` go to `.cf-pages`; `_routes.json` excludes only public static
assets. All Next pages, 18 API paths, PWA manifest and legacy redirects remain
handled by Next. The ASSETS binding is provided automatically by Pages.

The adapter forwards the trusted request URL's host/protocol to Next so local HTTP
and production HTTPS keep correct origin checks. It preserves Origin, cookies,
body streams and execution context; it does not relax authentication or SSRF guards.
Unused durable-object exports are not included. No self-service Worker, paid
binding or persistent ISR is required with the existing dummy cache/queue adapters.

This is a project-owned advanced-mode Pages packaging layer, not an official
OpenNext Pages adapter. See [Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)
and [Pages Wrangler configuration](https://developers.cloudflare.com/pages/functions/wrangler-configuration/).
Wrangler Pages local preview passed 39 configured route/page/credential/asset checks
with disposable passwords during packaging validation. Local success does not
prove production CPU, real provider availability or sustained media throughput.

Build from a fresh checkout: the script refuses secret-bearing environment files
and stale `.cf-pages` output; runtime secrets are removed from child build variables.
Stop local previews before replacing build artifacts. Preview with
`npm run pages:preview` (port 8083), then run
`node scripts/cloudflare-smoke.mjs http://127.0.0.1:8083 Pages`;
use disposable `--binding` / CF_SMOKE_PASSWORD variables for configured checks.

The upstream Docker registry publishing workflows were removed from this independent
release; publishing a website must not write to upstream Docker Hub/GHCR packages.
Docker build/run support is retained. Tests include frozen legacy parity fixtures,
so a standalone clone does not depend on the old repository's files.

## Optional local Workers target / Node fallback

Pinned runtime/tooling: Next 15.5.27, `@opennextjs/cloudflare` 1.20.8,
Wrangler 4.147.0. Use Node 22 or newer and the committed npm lockfile.

```sh
cd next-app
npm ci
npm run test
npm run lint
npm run typecheck
npm run cf:build
npm run cf:dry-run
node scripts/cloudflare-runtime-smoke.mjs
npm run cf:preview
# In another terminal, against the local workerd preview:
node scripts/cloudflare-smoke.mjs http://127.0.0.1:8082
```

`cf:build` runs Next build, then creates `.open-next/worker.js` and
`.open-next/assets`. `cf:dry-run` bundles and reports sizes without uploading.
`cf:preview` serves the built Worker on loopback port 8082. A concurrent Node dev
preview must use a separate output, for example
`NEXT_DEV_OUTPUT=.next-dev npm run dev -- --port 8081`. Production/OpenNext builds
must leave `NEXT_DEV_OUTPUT` unset so the adapter uses `.next`. Rebuild after source edits.
Stop a built Worker preview before rebuilding: OpenNext recreates `.open-next/`,
which temporarily invalidates Wrangler's watched entrypoint and static assets.
Use separate `--persist-to` directories if running multiple local Wrangler instances.
Do not pass `--remote` to local verification.
Legacy routing middleware lives at `src/middleware.ts`, beside `src/app`.
`skipMiddlewareUrlNormalize` preserves the original request URL for compatibility
redirects, including literal loopback origins, rather than changing cookie hosts.

The optional local `.dev.vars` can set `NEXTJS_ENV=development` and fixture secrets.
Node development may use `.env.local`; both file types are ignored by Git and Docker.
Git ignores alone do not keep secrets out of an OpenNext build: the adapter
compiles Next `.env*` files into its server-side environment fallback module.
Build in a clean checkout without secret-bearing `.env*` files, and supply Worker
preview secrets with local Wrangler `--var` arguments or disposable `.dev.vars`.
For an authenticated smoke check, supply a disposable local password through
`CF_SMOKE_PASSWORD`, and optionally `CF_SMOKE_ADMIN_PASSWORD` to verify the separate
administrator session and admin-only logout. Never use a production password in
shell history or fixtures.
`NEXT_DEV_CLOUDFLARE=1 npm run dev` opts into Workers bindings in Next development.

`PASSWORD`, `ADMINPASSWORD`, and `PROXY_SECRET` are runtime secret bindings.
Their values must be configured privately if deployment is later authorized; they
are absent from Wrangler `vars`, Next client build substitutions and Docker build
arguments. The empty `.env.example` requires explicit configuration. A missing
access password must return 503 from protected routes. `getServerEnv()` reads
request-time Worker bindings and only falls back to `process.env` in Node/Docker.
Source/live/subscription defaults, recommendation/image defaults, the optional
Douban fallback proxy and 60s base, search budgets, probe UA and proxy configuration
likewise read current bindings. Absent Worker settings restore built-in defaults,
not stale build-time process values. Search snapshots its 1-50 page / 3-60 second
budgets once per request, defaults to 5 pages / 10 seconds, and partitions cached
results by those budgets. Hot-list caches are partitioned by the configured base.
`APP_VERSION` remains a build substitution and `NODE_ENV` remains the runtime mode.

Wrangler configuration disables public workers.dev and preview URLs and declares
only static assets and a reference to the same Worker. There are no R2, KV, D1,
Durable Objects, Queues, paid image bindings, schedules or paid CPU settings.
The OpenNext incremental/tag caches and revalidation queue use dummy adapters;
no persistent ISR or cross-isolate cache consistency is promised. Application
TTL caches and login attempt limits live in isolate memory. Durable rate limiting
or shared caches require a separately scoped design and resources.

Route handlers retain the Node runtime: OpenNext adapts it to Workers; declaring
the Next `edge` runtime would remove required compatible Node APIs. DNS validation
uses Workers-supported `node:dns/promises.resolve4` and `resolve6`; every A/AAAA
answer must be public. Only ENODATA is accepted as an absent address family.
NXDOMAIN, timeouts, unsupported DNS and empty results fail closed. Each redirect
is revalidated and its previous body is cancelled to release connection slots.
DNS preflight cannot pin the later connection in Node fetch; Workers also applies
`global_fetch_strictly_public` as a second boundary against private destinations.

Media and Range responses stream their upstream body; only HLS text manifests
are read for relative URL/key/map rewriting. Both proxy rewriting and live probes
bound manifests to 2 MiB of actual response chunks, cancel oversized upstream bodies,
and report an explicit error instead of treating partial metadata as playable.
The live FLV/TS stream timer covers
headers and is cleared before body streaming. XMLTV gzip and playlist parsing
necessarily materialize metadata and can consume memory/CPU for large sources.
EPG reads are bounded to 4 MiB input, gzip expansion to 8 MiB, retained metadata
to an estimated 8 MiB and 20,000 programmes by default. Oversize input/expansion/
retained metadata returns HTTP 413 and is not cached. These limits count real
response chunks even if Content-Length is missing or dishonest; gzip uses
`maxOutputLength` before allocating the entire expanded payload. Cache size hints
estimate parsed objects and UTF-16 strings instead of compressed input size.
Set `EPG_MAX_INPUT_BYTES`, `EPG_MAX_EXPANDED_BYTES`, `EPG_MAX_PARSED_BYTES`, or
`EPG_MAX_PROGRAMS` to lower the bounds. Workers caps remain 4 MiB/8 MiB/8 MiB/20,000;
Node/Docker may explicitly raise them to 16 MiB/64 MiB/32 MiB/100,000 respectively.
The parsed size is conservative accounting, not a measured JavaScript heap size;
multiple concurrent requests still share the isolate memory/CPU budget.
The live metadata cache defaults to 16 MiB estimated total and ten entries; an
oversized item is skipped even when empty. `LIVE_CACHE_MAX_BYTES` can lower that
budget. Workers caps it at 16 MiB; Node/Docker may explicitly raise it up to 256 MiB.
Replacement entries do not count twice, and retained XMLTV strings are copied to
avoid keeping an entire expanded XML document alive through string slices.
M3U playlists count input chunks too: the defaults are 4 MiB input, 8 MiB parsed
metadata estimate, and 20,000 unique channels. Set `M3U_MAX_INPUT_BYTES`,
`M3U_MAX_PARSED_BYTES`, or `M3U_MAX_CHANNELS` to lower the bounds. Workers cannot
raise those hard caps; Node/Docker can explicitly raise them to 16 MiB / 32 MiB /
100,000 channels respectively. Oversize input, channel count or metadata returns
413 without partial caching or silent truncation. Cache accounting includes all
channel strings as UTF-16 plus object/array/group overhead, not raw M3U length.
Private IPTV via `LIVE_ALLOW_PRIVATE=1` is a Node/Docker fallback capability:
Workers public-only networking cannot reach private networks even with that flag.

## Verified limits and remaining checks

The current [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
document Free limits of 10 ms CPU per request, 50 subrequests, six simultaneous
outgoing connections, 128 MB isolate memory and 64 MiB Worker size. DNS requests
also consume subrequests. A multi-source, multi-page search or a large XMLTV file
can exceed those budgets. Local preview does not establish production CPU usage,
Free-plan suitability or upstream CDN behavior. Retain Node/Docker if those workloads
need more capacity; this preparation does not enable paid resources.

The current size rule is 64 MiB **uncompressed** on both Free and Paid; the current
documentation explicitly says there is no compressed size limit. Wrangler's gzip
figure is informational. Also compare that figure against the requested historical/
conservative 3 MiB Free and 10 MiB Paid thresholds when reviewing an account with
different constraints; this comparison is not permission to enable a paid plan.
An initial 50-source search needs at least one upstream request per source and two
DNS queries per hostname, before additional pages, redirects, or other fetches.
It must not be advertised as validated within a 50-subrequest/10 ms Free budget.

The integration build and dry-run succeeded locally. The latest measured bundle
was 5,900.05 KiB uncompressed / 1,207.95 KiB gzip (about 5.76 / 1.18 MiB); gzip is
below both requested 3 MiB and 10 MiB comparison thresholds. Re-measure after changes.
Build ID: `2pEIoyOwy_r0w1t0esn7y`; no production source, public assets or configuration
files were newer than this build when verified. The built middleware manifest
registers the legacy handler. Node standalone passed all 39 configured route/page/
PWA/compatibility checks, and workerd passed all 31 missing-configuration checks
and all 39 configured checks with disposable access/admin secret bindings. The
Wrangler dry-run bundled 108 static assets; Worker JavaScript was 6,041,648 bytes
uncompressed / 1,236,944 bytes gzip. No assets or Worker code were uploaded.
The legacy checks enforce same-origin redirects, real source IDs, episode/position
preservation, custom API/detail aliases, safe return links and encoded search titles.
The original `/s=:path*` matcher required a slash after `=` in Next's compiled
regexp; `/s=(.*)` correctly matches the historical `/s=encoded-title` links.
These smoke checks intentionally do not publish data or fetch real media;
successful upstream features are covered by deterministic route fixtures, and
actual workerd helper fixtures cover streaming/DNS/gzip. No production CPU, heap,
upstream-provider reliability, startup-limit or deployment results are claimed.

The runtime-scope Vitest run passed eleven files / 209 tests; lint and typecheck passed.
Final main integration passed 62 files / 778 application tests, plus typecheck,
lint and icon determinism checks. The retained legacy suite passed 189 tests.
The middleware/matcher regression run passed four files / 23 tests after the
final configuration changes. All 18 API
route paths are enumerated by the capability fixture
test, including admin and both encoded-path proxy aliases. Large jsdom pressure
fixtures exceeded their 5-second deadlines with host-wide parallel execution;
limiting the pool to two workers passes without loosening assertion deadlines.
Docker Compose configuration was validated with disposable input. The Docker
daemon was unavailable, so the image and container were not built or run; only
the generated Node standalone server and its local route/page checks were run.

Authentication now reads runtime secrets through `getServerEnv()`. Real workerd
helper fixtures set deliberately stale `process.env` values and verify that absent
bindings still disable access/admin auth, current bindings verify both credentials,
and both session HMACs use the bound `PROXY_SECRET`. These checks only use synthetic
fixtures and do not read environment files or expose real credentials.

Dependency audit after the adapter and compatible patches: 7 high, 0 critical,
0 moderate (previously 14 total, including 1 critical). Remaining findings derive
from the unpatched `braces` dependency through Tailwind 3 and Next ESLint tooling.
The separate `npm audit --omit=dev --json` production audit reports 0 findings.
The audit suggests Tailwind 4 / ESLint framework version changes, which need
separate migration review; `npm audit fix --force` is not an appropriate patch.
Vitest 4.1.11 removes the known test-server findings; a same-major PostCSS override
8.5.28 removes the nested Next PostCSS findings. Re-run `npm audit --json` to review
fresh advisories.

`cloudflare-runtime-smoke.mjs` uses the pinned Wrangler toolchain's workerd through
Miniflare and bundles the actual SSRF/fetch/XMLTV helpers in memory. All outbound
requests are intercepted with fixtures: public/mixed/mapped A/AAAA answers, DNS
outage, private redirect, and a never-ending Range media stream. It verifies gzip
expansion limits in workerd as well as Node: workerd's uncoded `RangeError: Memory
limit exceeded` is classified as a metadata limit, producing 413 rather than 502.
It does not deploy a fixture Worker or add test-only endpoints to the application.
The runtime fixture suite also includes the missing/current secret-binding checks
above and absent/current non-auth settings, including Worker private-network
opt-in rejection (15 checks total).

## Node and Docker fallback

```sh
cd next-app
npm run build
npm run start
# Standalone output used by the Dockerfile:
DOCKER_BUILD=1 npm run build
# Set private runtime values in .env, then build locally:
docker compose config --quiet
docker compose build
docker compose up -d
```

Compose builds `jayflix-next:local`, binds port 8080 to loopback by default and
passes secrets only at container runtime. The image runs as a non-root user and
checks `/api/status` for health. Browser history/settings remain local; no volumes
or upstream production image are required. Adjust the host binding explicitly
only when external access is intended. Docker daemon availability must be checked
before claiming image/container validation.

Official configuration references:
[OpenNext setup](https://opennext.js.org/cloudflare/get-started),
[runtime variables](https://opennext.js.org/cloudflare/howtos/env-vars),
[Workers DNS](https://developers.cloudflare.com/workers/runtime-apis/nodejs/dns/).

## Runtime-scope changed paths

All paths below are relative to `next-app/`; root legacy assets were not edited.
Main integration owns the final commit.

```text
package.json
package-lock.json
next.config.ts
wrangler.jsonc
open-next.config.ts
vitest.config.ts
.gitignore
.dockerignore
Dockerfile
docker-compose.yml
.env.example
src/lib/ssrf.ts
src/lib/ssrf.test.ts
src/lib/fetch-utils.ts
src/lib/fetch-utils.test.ts
src/lib/cloudflare-env.ts
src/lib/cloudflare-env.test.ts
src/lib/cloudflare-config.test.ts
src/lib/cloudflare-jsx.test.ts
src/lib/cloudflare-routes.test.ts
src/lib/xmltv.ts
src/lib/xmltv.test.ts
src/lib/live-cache.ts
src/lib/live-cache.test.ts
src/lib/env-sources.ts
src/lib/env-live-sources.ts
src/lib/env-subscriptions.ts
src/lib/env-recommend-source.ts
src/lib/env-image-mode.ts
src/lib/douban.ts
src/lib/douban-weekly.ts
src/lib/search-settings.ts
src/lib/runtime-settings.test.ts
src/middleware.ts
src/middleware.test.ts
src/app/api/search/route.ts
src/app/api/live/probe/route.ts
src/app/api/live/probe/route.test.ts
src/app/api/live/epg/route.ts
src/app/api/live/epg/route.test.ts
scripts/cloudflare-smoke.mjs
scripts/cloudflare-runtime-smoke.mjs
docs/DEPLOYMENT.md
```
