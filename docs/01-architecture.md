# 01 — 架构、技术选型与功能

Giraffe 是个人 GitHub 监控控制台。仓库 code name 为 `giraffe`。本文是项目的方向文档：架构、技术选型、首版功能边界，以及后续实现必须遵守的工程约定。

> 返回 [文档目录](README.md)

本文不评估工作量。代码尚未落地；文中路径是约定的目标结构，实现时按此创建，不另开兼容层。

---

## 1. 产品定义

面向单人使用的 GitHub 监控台。用 PAT 在 Worker 侧拉取 GitHub 数据，落 D1 快照后给控制台展示。PAT 不得持久化在浏览器、打进前端包、写入日志，也不得出现在任何 API 响应里。设置页提交时明文只在该次 HTTPS 请求体内短暂存在。

参考实现：`/Users/nocoo/workspace/references/gh-dashboard`（产品名 Gitdeck）。本项目只借鉴其 **token 鉴权形态** 和 **HTTP API 资源划分**，界面按 Basalt Gen 2 完整重做。

生产域名规划：`giraffe.hexly.ai`（Cloudflare Worker + Cloudflare Access）。本机开发域名：`https://giraffe.dev.hexly.ai`。

---

## 2. 已锁定决策

| 主题 | 决定 |
|------|------|
| 语言 | TypeScript 7（`typescript@7`，strict，含 `exactOptionalPropertyTypes`） |
| 前端 | Vite 8 + React 19 SPA，不使用 Next.js |
| 运行时 | 单个 Cloudflare Worker：Hono 处理 `/api/*`，`[assets]` 托管 Vite 产物 |
| 包管理 | Bun。安装走临时 registry，不把镜像 URL 写进 `bun.lock` |
| Lint / 格式化 | Biome。无 ESLint |
| 设计系统 | Basalt Gen 2（`app-shell` + `sidebar` + `sidebar-context`） |
| 分层 | MVVM。ViewModel 不感知 View |
| GitHub 鉴权 | 设置页粘贴 PAT；服务端加密写入 D1；可多账号 |
| 控制台门禁 | Cloudflare Access 挡在 Worker 前面。应用内无登录页、无 Google OAuth |
| 数据 | D1 快照（默认读库，`fresh=1` 回源 GitHub） |
| 提供商 | 只做 GitHub |
| 质量 | 严格 TDD + 6DQ。正确性只由测试证明 |
| 分层隔离 | Server API 与 Client UI 可独立测试、运行、验证 |
| 实现阶段 | 第一阶段完整实现 Server；完成后再做 Client |
| Git | Conventional Commits，原子化提交，不主动 push |

---

## 3. 非目标（首版明确不做）

- GitLab / Forgejo / Codeberg
- OAuth Device Flow、`gh` CLI 读 token
- OpenAI 生成 Daily digest 叙事
- Kanban / Projects v2 看板
- Mentions（code / issues 搜索）
- Dependents
- 应用内登录页（身份完全交给 Cloudflare Access）
- KV session（Access 已提供身份，不再自建会话）

---

## 4. 技术选型

| 层 | 选型 | 说明 |
|----|------|------|
| 语言 | TypeScript 7.0.x | `tsc --noEmit`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| 包管理 / 脚本 | Bun | `package.json` 为版本唯一来源 |
| 前端构建 | Vite 8 + `@vitejs/plugin-react` | 产物 `dist/client/` |
| UI | React 19 + React Router | SPA |
| 样式 | Tailwind CSS v4 + shadcn/ui | Basalt Gen 2（`palette.ts`、`--chart-*`） |
| 图表 | Recharts | Insights / Traffic |
| Toast / 命令面板 | sonner + cmdk | |
| API | Hono | Worker 内 `/api/*` |
| 校验 | Zod v4 | 请求体与 PAT 录入 |
| 数据 | Cloudflare D1 | `accounts` + 通用 `snapshots` |
| 密钥 | Worker secrets | `TOKEN_ENCRYPTION_KEY`；PAT 不以明文落库 |
| 门禁 | Cloudflare Access JWT | 生产校验 `Cf-Access-Jwt-Assertion`；本机开发域名不走 Access |
| 部署 | `wrangler deploy` | `[assets]` + `run_worker_first = ["/api/*"]`，`not_found_handling = "single-page-application"` |
| Lint | Biome 2.x | `biome check --error-on-warnings` |
| L1 | Vitest 4 | 覆盖率 ≥ 90%（UI 薄壳豁免） |
| L2 | `scripts/run-e2e.ts` | 真 HTTP，打隔离 D1 |
| L3 | Playwright | 按需 / CI |
| G2 | osv-scanner + gitleaks | pre-push |
| Hooks | Husky 9 | pre-commit = L1 + G1；pre-push = L2 ‖ G2 |

阶段 1 用 `bun run dev:server`（仅 Worker，本地 D1）。阶段 2 起 Client 用 `bun run dev:client`（Vite，打 mock 或本机 `/api`）。生产形态是 `vite build` + `wrangler deploy`（assets + Worker）。不使用 `@cloudflare/vite-plugin`。

---

## 5. 系统架构

```
浏览器
  │  HTTPS
  ▼
Cloudflare Access          生产：giraffe.hexly.ai
  │  通过后带 JWT
  ▼
Worker `giraffe`
  ├── 非 /api/*  → ASSETS（Vite SPA）
  └── /api/*     → Hono
        ├── Access JWT 中间件（生产必验；本机跳过）
        ├── PAT 管理（加密读写 D1）
        ├── GitHub Client（Bearer PAT，只在 Worker 内）
        └── Snapshot 读写（D1）
              │
              ▼
         D1 `giraffe-db`（仅生产远程库）
```

本机：

```
https://giraffe.dev.hexly.ai
  → Caddy（mkcert）
  → wrangler dev :7045
```

Caddyfile 尚未登记 giraffe，脚手架时再加。端口：

| 用途 | 端口 | 域名 |
|------|------|------|
| 主开发（wrangler） | 7045 | `giraffe.dev.hexly.ai` |
| L2 API E2E | 17045 | 无 Caddy，runner 直连 |
| L3 BDD | 27045 | 无 Caddy |
| 生产 | 443 | `giraffe.hexly.ai` |

`wrangler.toml` `[dev] port = 7045`，Caddy 反代到该端口。

### 5.1 Cloudflare 资源命名

线上只部署一套资源。L2 / L3 不占用 Cloudflare 上的第二套 Worker 或 D1，全部走本机 `wrangler dev --local --persist-to`（Miniflare SQLite）。L2 与 L3 用同一套 Worker 代码与启动方式，但是**两个进程**：不同 `--port`、不同 persist 目录。

| 资源 | 生产（远程） | L2 / L3（本机） |
|------|--------------|-----------------|
| Worker 脚本 | `giraffe` | 不部署。`wrangler dev --local` 起临时进程 |
| 自定义域 | `giraffe.hexly.ai` | 无。runner 打 `127.0.0.1` |
| D1 | `giraffe-db`（binding `DB`） | 不创建远程测试库。L2 用 `.wrangler/e2e/`，L3 用 `.wrangler/e2e-pw/` |
| Secret | `TOKEN_ENCRYPTION_KEY` | runner 用 `--var` / `.dev.vars` 注入，不写进远程 |

本机 `bun dev` / `wrangler dev` **默认本地 D1**（不要 `remote = true`）。调试生产数据必须显式、一次性的命令，不得写进默认脚本。

E2E 必须 `--local --persist-to`，每次先清空 persist 目录，再 apply schema，并写入 `_test_marker`。marker 不对则 runner 拒绝继续。L2 / L3 **禁止访问 api.github.com**：GitHub Client 注入确定性 stub（fixture PAT 与固定 JSON）。无 CF 凭证、无真实 PAT、不部署 `--env test`。

`wrangler.toml` 目标形态（ID 在创建生产库后填入）。没有 `[env.test]`，没有第二套 D1：

```toml
name = "giraffe"
main = "src/server/index.ts"
compatibility_date = "2026-04-01"
workers_dev = false
preview_urls = false

[dev]
port = 7045

[assets]
directory = "./dist/client"
binding = "ASSETS"
run_worker_first = ["/api/*"]
not_found_handling = "single-page-application"

[[routes]]
pattern = "giraffe.hexly.ai"
custom_domain = true

[[d1_databases]]
binding = "DB"
database_name = "giraffe-db"
database_id = "<prod>"
# 禁止 remote = true。本机 wrangler dev 默认本地 D1。
```

阶段 1 的 `dev:server` 在启动前若 `dist/client` 不存在，写入占位 `index.html`（空壳即可），这样 wrangler 不因缺 assets 目录而拒绝启动。`wrangler deploy` 前必须 `vite build` 换成真实产物。账号里目前没有 `giraffe` / `giraffe-db`，脚手架阶段 `wrangler d1 create giraffe-db` 只建生产库。

---

## 6. 身份与密钥

两道门，职责不混。

### 6.1 Cloudflare Access（谁能打开控制台）

- 生产自定义域挂 Access 应用。策略在 Cloudflare Dashboard，不进仓库。
- Worker secrets / vars：`CF_ACCESS_TEAM_DOMAIN`（如 `https://<team>.cloudflareaccess.com`）、`CF_ACCESS_AUD`（Access 应用 audience）。缺任一则生产请求失败关闭，不得放行。
- 中间件读取 `Cf-Access-Jwt-Assertion`，用该 team 的 JWKS 验签，并校验 `iss`、`aud`、`exp`。只验签名不够。失败 401。
- 从 JWT 取 email / name，仅用于顶栏展示，不作为 GitHub 身份。
- Access 短路只允许 `ENVIRONMENT === "development"`。该值**禁止**写入会随 `wrangler deploy` 上去的 `[vars]`。只允许 gitignore 的 `.dev.vars`，或本地脚本 `--var ENVIRONMENT:development`。缺省、未知、或生产部署中出现 `development` 一律失败关闭。禁止用 `Host`、`X-Forwarded-*` 或域名后缀判断。
- `wrangler.toml` 设 `workers_dev = false`，关闭 `*.workers.dev` 与 preview URL。只通过 Access 保护的 `giraffe.hexly.ai` 对外。
- 自定义域未挂好 Access 应用与策略前，禁止 `wrangler deploy` 把该域对外。部署检查清单写入 04。
- 所有会改状态的 `/api`（POST / DELETE，含无 body 的 activate / read-all）必须校验 `Origin` 与允许列表一致，否则 403。防止 Access 会话被跨站触发。
- 应用内无 `/login`、无 OAuth、无 session cookie。

文件约定：

- `src/server/middleware/access.ts` — JWT 校验与本地短路
- `src/server/lib/access-identity.ts` — 从 JWT 解析展示用身份

### 6.2 GitHub PAT（Worker 怎么读 GitHub）

只接受用户粘贴的 **classic PAT**。不做 Device Flow，不从 `gh` CLI 读 token，首版不支持 fine-grained PAT。

必填 scope：`repo`、`read:org`、`read:user`、`notifications`。Traffic / security alerts 额外需要对应权限；录入时读取 `X-OAuth-Scopes`，写入 `accounts.scopes` 与 `accounts.capabilities` JSON。缺能力的端点返回结构化错误（例如 `capability_missing`），不得装成空列表。

`POST /api/accounts` 校验：

1. `GET https://api.github.com/user` 必须成功
2. 响应头 `X-OAuth-Scopes` 必须覆盖必填 scope，否则 400
3. 通过后再加密入库

加密约定（AES-256-GCM）：

- `TOKEN_ENCRYPTION_KEY`：32 字节密钥，hex 或 base64，Worker secret
- 每次加密使用 **12 字节随机 IV**，不得复用
- D1 `token_ciphertext` 存 JSON 信封：`{"v":1,"iv":"<b64>","ct":"<b64>","tag":"<b64>"}`
- `accounts.key_version` 整数，默认 1，轮换密钥时用
- 列表接口只返回 `login`、`avatar_url`、`token_last4`、`scopes`、`capabilities`、是否当前账号
- 可多账号；`is_active` 标记当前用于拉取的账号
- 调用 GitHub 时在 Worker 内解密。日志、错误体、trace 必须 sanitize，禁止出现 token 或信封明文

文件约定：

- `src/server/routes/accounts.ts`
- `src/server/lib/token-crypto.ts`
- `src/server/lib/github-client.ts`
- `src/client/routes/settings.tsx`
- `src/client/viewmodels/use-accounts-view-model.ts`

---

## 7. 数据：D1 快照

不把 GitHub 资源拆成宽表。当前视图按账号 + 种类存 JSON；日报差量另表按天保留。单行 `payload` 不得超过 D1 2 MB 上限：超限按页切成 `kind` + `#` + `page`（如 `repos#2`），API 组装后返回。切分算法细节由 03 定。

### `accounts`

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | TEXT PK | nanoid |
| `login` | TEXT | GitHub login |
| `avatar_url` | TEXT | |
| `token_ciphertext` | TEXT | AES-GCM 信封 JSON（含 iv / ct / tag / v） |
| `token_last4` | TEXT | 展示用 |
| `key_version` | INTEGER | 加密密钥版本，默认 1 |
| `scopes` | TEXT | GitHub `X-OAuth-Scopes` 原文 |
| `capabilities` | TEXT | JSON，如 `{"notifications":true,"traffic":false}` |
| `is_active` | INTEGER | 0/1 |
| `created_at` | TEXT | UTC ISO-8601，以 `Z` 结尾 |
| `updated_at` | TEXT | 同上 |
| `last_used_at` | TEXT | 上次成功打 GitHub |

### `snapshots`

| 列 | 类型 | 说明 |
|----|------|------|
| `account_id` | TEXT | FK → accounts |
| `kind` | TEXT | 见下表 |
| `payload` | TEXT | JSON |
| `fetched_at` | TEXT | UTC ISO-8601 |
| PK | `(account_id, kind)` | |

`kind` 约定（可增，不改主键语义）：

| kind | 内容 |
|------|------|
| `repos` | 仓库列表 |
| `issues` | 跨仓 issues |
| `prs` | 跨仓 pull requests |
| `insights` | 聚合健康/告警/机会 |
| `alerts` | Dependabot + code scanning |
| `notifications` | inbox |
| `digest` | 最近一次摘要的**当前**副本。差量历史不放这里 |
| `repo:{owner}/{name}:details` | 单仓概览 |
| `repo:{owner}/{name}:actions` | workflow runs |
| `repo:{owner}/{name}:traffic` | views/clones |
| `repo:{owner}/{name}:security` | 单仓安全告警 |
| `repo:{owner}/{name}:issues` | 单仓 issues |
| `repo:{owner}/{name}:prs` | 单仓 PRs |
| `repo:{owner}/{name}:releases` | releases |
| `repo:{owner}/{name}:languages` | 语言占比 |
| `repo:{owner}/{name}:contributors` | contributors |

### `snapshot_days`

日报差量用。主键 `(account_id, day)`，`day` 为 UTC `YYYY-MM-DD`。`payload` 存当天 star/fork/issue 计数。刷新 `digest` 前若当天尚无行，先把当前 `repos` 快照的计数写入昨天或今天的基线，再算差。保留最近 30 天，更早的删除。没有基线时 `/api/digest` 返回 `baseline_missing`，不编造差量。

读取路径：

- 有快照且无 `fresh=1`：直接返回，并带 `fetched_at`
- 无快照（新账号或从未拉过）：服务端同步回源一次，再返回；不得对空库 200 + 空列表装成「没有仓库」
- `fresh=1`：回源 GitHub，覆写当前快照（及必要的 `snapshot_days`）再返回
- 首版不做 Cron。Client 在进入页面时带 `fresh=1` 的策略由 05 定；Server 必须能在无 Client 的情况下仅靠上述规则自洽

隔离见 [5.1](#51-cloudflare-资源命名)：生产只用远程 `giraffe-db`。E2E 打本机 persist 目录里的 SQLite，库内含 `_test_marker`。详见 6DQ D1。细节表结构以 03 为准。

隔离见 [5.1](#51-cloudflare-资源命名)：生产只用远程 `giraffe-db`。E2E 打本机 persist 目录里的 SQLite，库内含 `_test_marker`。详见 6DQ D1。

文件约定：

- `src/server/lib/db/d1.ts`
- `src/server/lib/db/accounts.ts`
- `src/server/lib/db/snapshots.ts`
- `src/server/lib/db/snapshot-days.ts`
- `src/server/lib/db/schema.sql`（或后续 Drizzle；首版原生 SQL，不提前上 ORM）

---

## 8. API

前缀 `/api`。JSON。生产与本地均由同一 Hono 应用提供。GitHub token 不出 Worker。

| 方法 | 路径 | 行为 |
|------|------|------|
| GET | `/api/live` | 版本、环境，无鉴权数据 |
| GET | `/api/me` | Access 身份（email/name）；本地返回 stub |
| GET | `/api/accounts` | 账号列表（无 token） |
| POST | `/api/accounts` | classic PAT：`GET /user` + 必填 scope；AES-GCM 信封入库 |
| POST | `/api/accounts/:id/activate` | 切换当前账号 |
| DELETE | `/api/accounts/:id` | 删除账号与其快照 |
| GET | `/api/repos` | 快照；`fresh=1` 刷新 |
| GET | `/api/issues` | 同上 |
| GET | `/api/prs` | 同上 |
| GET | `/api/insights` | 同上 |
| GET | `/api/alerts` | Dependabot + code scanning |
| GET | `/api/notifications` | inbox |
| POST | `/api/notifications/read` | 标记已读（透传 GitHub，并更新快照） |
| POST | `/api/notifications/read-all` | 全部已读 |
| GET | `/api/digest` | 统计摘要，无 LLM |
| GET | `/api/repos/:owner/:name` | 单仓概览 |
| GET | `/api/repos/:owner/:name/actions` | 单仓 Actions |
| GET | `/api/repos/:owner/:name/traffic` | 单仓 Traffic |
| GET | `/api/repos/:owner/:name/security` | 单仓安全 |
| GET | `/api/repos/:owner/:name/issues` | 单仓 issues |
| GET | `/api/repos/:owner/:name/prs` | 单仓 PRs |
| GET | `/api/repos/:owner/:name/releases` | releases |
| GET | `/api/repos/:owner/:name/languages` | languages |
| GET | `/api/repos/:owner/:name/contributors` | contributors |

不做 Device Flow、Projects 看板、Mentions、stargazers、GitLab。

错误码：未过 Access → 401；无可用 PAT → 409（或 412，实现时定一种，全局一致）；GitHub 4xx/5xx 映射为结构化 JSON，不把 GitHub 原文 token 相关头回传。

---

## 9. 界面信息架构

Basalt Gen 2。侧栏展开 260px / 收起 68px。主区浮岛。中文 UI。

| 路由 | 侧栏 | 首版内容 |
|------|------|----------|
| `/` | 仓库 | 列表/网格：描述、语言、star、fork、open issues、最近 push、健康标记；筛选与排序 |
| `/issues` | Issues | 跨仓列表 + 筛选 |
| `/pulls` | Pull Requests | 跨仓列表 + 筛选 |
| `/insights` | Insights | 需关注的 issue/安全/久未 push；Strong / Watch / Risky |
| `/alerts` | 安全告警 | Dependabot + code scanning |
| `/inbox` | 通知 | GitHub notifications |
| `/digest` | 日报 | 当日 star/fork/issue 变动；可复制 Markdown；**无** LLM 叙事 |
| `/repos/:owner/:name` | （钻取） | 概览、Security、Actions、PRs、Issues、Releases、Traffic、Languages、Contributors |
| `/settings` | 设置 | PAT 增删、切换当前账号 |

单仓不做 Mentions、Dependents。不做顶层 Kanban、顶层 CI Health（CI 放在单仓 Actions）。

文件约定：

- `src/client/components/layout/app-shell.tsx`
- `src/client/components/layout/sidebar.tsx`
- `src/client/components/layout/sidebar-context.ts`
- `src/client/lib/navigation.ts` — 导航数据与渲染分离
- `src/client/viewmodels/*.ts`
- `src/client/routes/*.tsx` — 薄壳页面

---

## 10. 目标目录

```
giraffe/
  CLAUDE.md
  docs/
    README.md
    01-architecture.md          # 本文
  src/
    server/
      index.ts                  # Hono 入口 + 路由挂载
      env.ts
      middleware/access.ts
      routes/
      lib/
        db/
        github-client.ts
        token-crypto.ts
        sanitize.ts
        version.ts
      __tests__/
    client/
      main.tsx
      routes/
      viewmodels/
      components/layout/
      components/ui/
      lib/api.ts
    lib/                        # 前后端可共享的纯函数
  scripts/
    run-e2e.ts
    gate-security.ts
  wrangler.toml
  vite.config.ts
  biome.json
  vitest.config.ts
  package.json
```

---

## 11. 6DQ 实施

| 维 | 要求 | 时机 |
|----|------|------|
| L1 | `bun run test:coverage`（不是 `bun run test`）；覆盖率 ≥ 90%；薄壳 `routes/*.tsx` 豁免 | pre-commit，<30s |
| L2 | 真 HTTP。`scripts/run-e2e.ts` 清空 `.wrangler/e2e/`，拉起 `wrangler dev --local --persist-to=.wrangler/e2e --port 17045`，覆盖全部 `/api` 方法组合。GitHub 出站必须是 stub | pre-push，<3min |
| L3 | Playwright 打另一本地进程（`--local --persist-to=.wrangler/e2e-pw --port 27045`）：设置 PAT → 仓库列表 → 单仓钻取。同样禁止 GitHub 出站 | CI / 按需 |
| G1 | `tsc --noEmit` + `biome check --error-on-warnings`，0 error 0 warning | pre-commit |
| G2 | `gitleaks` + `osv-scanner --lockfile=bun.lock` | pre-push |
| D1 | 无远程测试库。隔离靠 `--local --persist-to` 目录 + `_test_marker`；runner 不见 marker 则退出 | L2/L3 强制 |

脚手架尚未接入 D1 时，D1 维度标 N/A。一旦有生产 `giraffe-db`，E2E 仍不得连远程。

第一阶段只要求 L1（Server 单测）+ L2（真 HTTP）。L3 在 Client 落地后才启用。

---

## 12. 开发方式

### TDD

严格测试驱动。先写会失败的测试，再写最小实现让它通过，再按需重构。正确性只由测试证明，不靠手动点页面、看日志或「跑起来看看」。

红测试只存在于工作区，**不提交**。pre-commit 跑 L1（含覆盖率），失败则无法 commit，因此仓库里只允许绿提交。没有对应测试的行为变更不算完成。

### API 与界面隔离

`src/server` 与 `src/client` 互不耦合实现细节。

| 层 | 独立能力 | 证明手段 |
|----|----------|----------|
| Server | 单独 `wrangler dev`、单独 L1 / L2 | 单测 + 真 HTTP 打 `/api/*` |
| Client | 单独 Vite、单独 ViewModel / 组件测试 | 单测；不依赖点开整站来证明逻辑 |

Client 只通过 HTTP 契约消费 Server。Server 测试不得 import Client。Client 单测不得启动 Worker，除非那是明确的 L3。

### 文档与实现顺序

先写编号文档，再写代码。质量规范与数据 Schema 必须先于任何功能实现，避免先污染后治理。

| 顺序 | 文档 | 之后才允许 |
|------|------|------------|
| 02 | 质量保证 | 写测试与功能代码 |
| 03 | 数据 Schema | 建表、抓取、落库 |
| 04 | Server 设计 | 阶段 1：实现 Worker / API |
| — | 阶段 1 完成 | L1 + L2 绿 |
| 05 | Client 设计 | 阶段 2：实现 Vite 界面 |

阶段 1 完成标准：04 列出的全部接口有测试，L1 + L2 绿，无 Client 功能代码。阶段 2 完成标准：05 列出的页面有测试，L1 绿，核心路径 L3 绿。未完成阶段 1，不得开始阶段 2（工具链脚手架除外）。

本文第 8、11 节只是方向摘要。测试细则以 02 为准，表结构以 03 为准，接口以 04 为准，页面以 05 为准。

---

## 13. 原子化提交

全程坚持，不攒大批量 diff。

- Conventional Commits：`<type>: <short description>`，祈使句，全小写，≤50 字符
- type：`fix` `feat` `docs` `test` `refactor` `chore`
- 一次 commit 只含一个逻辑变更
- 只 `git add` 具体文件，不用 `git add -A` / `git add .`
- 不主动 push
- 每个 commit 必须通过 pre-commit（G1 + L1 覆盖率）。不使用 `--no-verify` 提交红测试

阶段内：步骤写在 04 / 05。每步在工作区走红 → 绿，只把绿结果和必要重构原子提交。禁止把一整阶段打成一次 commit。

---

## 14. 后续编号文档（尚未写）

| # | 文档 | 必须写清 |
|---|------|----------|
| 02 | 质量保证 | 测试分层、覆盖率、何时跑哪一层；TDD 与门控细则。功能代码之前完成 |
| 03 | 数据 Schema | 对照 GitHub API 返回与参考项目，定义抓取/维护/展示用的库表与 JSON 形状。建表之前完成 |
| 04 | Server 设计 | 全部接口、每接口职责、返回约定、拆到原子化提交的步骤。阶段 1 开工前完成 |
| 05 | Client 设计 | Vite 页面结构与展示形式、拆到原子化提交的步骤。阶段 1 完成且本文 review 后，阶段 2 开工前完成 |

对应文档未写成并 review 前，不开始该层功能代码。当前 Agent 入口是根目录 `CLAUDE.md`。
