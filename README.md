# Jayflix 2.0

JAYFLIX 的独立升级版：Next.js / React / TypeScript 架构，保留自适应球体、参数缓存与四类调色盘。新版仓库及 Cloudflare Pages 项目独立发布，不覆盖 Jayflix 旧版。

[源码](https://github.com/AustrianArtPainter/jayflix-2.0) · [正式站](https://jayflix-2-0.pages.dev)

## 功能

- 流式聚合搜索、同名合并、源订阅、探活与健康管理。
- 豆瓣、Bangumi、影视榜单推荐；球体自适应显示前 1–1322 张封面。
- 自由拖动、惯性、始终朝上的封面与深度线性透明度。
- 球体 / 封面 50%–500%，转速 0%–100%；端侧默认值、缓存、折叠控制栏和统一重置。
- HLS 点播、换源测速、续播、缓存与下载；M3U / FLV 直播、收藏和 XMLTV 节目单。
- 四类调色盘统一正式页面、弹窗和播放器进度条；旧历史、配置与链接兼容迁移。

## 本地运行

需要 Node.js 22+。在忽略的 `.env.local` 中分别配置 `PASSWORD` 与 `ADMINPASSWORD`，勿提交密码。

```sh
npm ci
npm run dev -- --port 8081
```

`PASSWORD` 锁定整个访问入口；`ADMINPASSWORD` 独立锁定整个设置面板，包括播放、缓存、封面和新增设置。普通访问会话不能代替管理员会话。历史与个性化配置仍保存在本设备浏览器中，不自动跨域同步。

## Cloudflare Pages 部署

沿用旧站的 **GitHub `main` 自动部署 → Cloudflare Pages + 服务端接口** 方式。
新版需编译 Next.js，由 OpenNext 生成运行时代码，再打包为 Pages 高级模式 `_worker.js`。
这是本项目测试过的 Pages 适配层，并非把新版退化成静态网页，也不需要另建独立 Worker。

| 配置 | 值 |
| --- | --- |
| 项目名称 | `jayflix-2-0`（项目标题 Jayflix 2.0） |
| 生产分支 | `main` |
| 框架预设 | None |
| 根目录 | 仓库根目录（留空） |
| 构建命令 | `npm run pages:build` |
| 输出目录 | `.cf-pages` |
| Node.js | 22 或更新版本 |
| 兼容日期 / 标志 | `2026-10-01` / `nodejs_compat`, `global_fetch_strictly_public` |

在 Cloudflare 新项目的 **运行时变量 / Secrets** 中分别配置 `PASSWORD`、`ADMINPASSWORD`。
两道密码均必须配置，不写入 GitHub、README、构建文件或客户端。`PROXY_SECRET` 可选；
其他源、推荐和限制项见 [.env.example](.env.example)。`wrangler.jsonc` 不包含密码值，
不绑定 R2、KV、D1、Durable Objects 或付费资源。未配置访问密码时接口返回 503，不放行。

构建脚本移除传给 Next/OpenNext 的密码环境变量，且拒绝含 `.env*` / `.dev.vars` 的源码目录
（空白 `.env.example` 除外）。本地构建须用不含私密环境文件的独立检出，避免忽略文件进入编译产物。

## 测试与本地 Pages 预览

```sh
npm test
npm run typecheck
npm run lint
npm run pages:build
npm run pages:preview
# 另一个终端：不配置密码时验证 fail-closed 行为
node scripts/cloudflare-smoke.mjs http://127.0.0.1:8083 Pages
node scripts/cloudflare-runtime-smoke.mjs
```

访问入口、完整设置面板、全部原有新功能和定制视觉保持不变。Pages 预览可通过
`--binding` 添加一次性测试密码（构建完成后），对应冒烟测试用 `CF_SMOKE_PASSWORD` 与
`CF_SMOKE_ADMIN_PASSWORD`；不要用正式密码作为测试样例。Node.js / Docker 是备选云端运行方式。

[部署与资源限制](docs/DEPLOYMENT.md) · [视觉规范](UI.md)

`/orbit-test` 为无图片验证页，支持 1–1322 个实际空框；不虚拟化、不请求影视接口。几何容量不等于浏览器帧率；Workers 本地预览也不等于正式站 CPU / 免费套餐验收。

## 来源与许可

升级底座：[LibreSpark / LibreTV](https://github.com/LibreSpark/LibreTV)，固定提交 `a24ad336a3f7c8a16ca93d1f1198e08ac6b7e943`。本项目依照 [AGPL-3.0-or-later](LICENSE) 发布；提供网络服务时须提供对应版本源码入口。旧版数学、配色和配置的测试基线及其原始许可位于 [tests/legacy](tests/legacy/README.md)。

项目仅检索和播放第三方接口内容，不存储或分发影视文件。
