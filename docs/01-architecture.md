# 01 — 架构、技术选型与功能

Giraffe 是个人 GitHub 监控控制台。仓库 code name 为 `giraffe`。本文是项目的方向文档：架构、技术选型、首版功能边界，以及后续实现必须遵守的工程约定。

> 返回 [文档目录](README.md)

本文不评估工作量。代码尚未落地；文中路径是约定的目标结构，实现时按此创建，不另开兼容层。

---

## 1. 产品定义

面向单人使用的 GitHub 监控台。用 PAT 在 Worker 侧拉取 GitHub 数据，落 D1 快照后给控制台展示。浏览器永不持有 GitHub token。

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
| 数据 | D1 快照（接近 Gitdeck 磁盘缓存，不是每次都直打 GitHub） |
| 提供商 | 只做 GitHub |
| 质量 | 6DQ（L1/L2/L3 + G1/G2 + D1） |
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

对标家族项目 **dove**（Vite SPA + Hono + 单 Worker 部署），UI 对标 **basalt** Gen 2。

| 层 | 选型 | 说明 |
|----|------|------|
| 语言 | TypeScript 7.0.x | `tsc --noEmit`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| 包管理 / 脚本 | Bun | `package.json` 为版本唯一来源 |
| 前端构建 | Vite 8 + `@vitejs/plugin-react` | 产物 `dist/client/` |
| UI | React 19 + React Router | SPA |
| 样式 | Tailwind CSS v4 + shadcn/ui | Basalt token（`palette.ts`、`--chart-*`） |
| 图表 | Recharts | Insights / Traffic |
| Toast / 命令面板 | sonner + cmdk | 家族指纹 |
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

不采用 `@cloudflare/vite-plugin`。家族内 dove 已验证：`vite build` 出静态资源，`wrangler dev` 同时拉 API 与 assets。本地 HMR 若不够用，再单开文档评估，不在首版切换工具链。

---

## 5. 系统架构

```
浏览器
  │  HTTPS
  ▼
Cloudflare Access          生产：giraffe.hexly.ai
  │  通过后带 JWT
  ▼
Giraffe Worker
  ├── 非 /api/*  → ASSETS（Vite SPA）
  └── /api/*     → Hono
        ├── Access JWT 中间件（生产必验；本机跳过）
        ├── PAT 管理（加密读写 D1）
        ├── GitHub Client（Bearer PAT，只在 Worker 内）
        └── Snapshot 读写（D1）
              │
              ▼
         Cloudflare D1
         giraffe-db / giraffe-db-test
```

本机：

```
https://giraffe.dev.hexly.ai
  → Caddy（mkcert）
  → wrangler dev :7045
```

Caddyfile 尚未登记 giraffe，实现脚手架时再改 `/opt/homebrew/etc/Caddyfile`。端口按家族规则分配（首次 commit 2026-09-01，Caddy 当前末号 7044 Fundly）：

| 用途 | 端口 | 域名 |
|------|------|------|
| 主开发（wrangler） | 7045 | `giraffe.dev.hexly.ai` |
| L2 API E2E | 17045 | 无 Caddy，runner 直连 |
| L3 BDD | 27045 | 无 Caddy |
| 生产 | 443 | `giraffe.hexly.ai` |

Worker 不另占 `dev+30000`。dove 同款：`wrangler.toml` 的 `[dev] port = 7045` 就是 Caddy 上游。

---

## 6. 身份与密钥

两道门，职责不混。

### 6.1 Cloudflare Access（谁能打开控制台）

- 生产自定义域挂 Access 应用。策略在 Cloudflare Dashboard，不进仓库。
- Worker 中间件读取 `Cf-Access-Jwt-Assertion`，用 Access 团队 JWKS 验签。失败 401。
- 从 JWT 取 email / name，仅用于顶栏展示，不作为 GitHub 身份。
- `giraffe.dev.hexly.ai` 与 `wrangler dev` **不** 套 Access。本地中间件短路，避免假 JWT。
- 应用内无 `/login`、无 OAuth、无 session cookie。

文件约定：

- `src/server/middleware/access.ts` — JWT 校验与本地短路
- `src/server/lib/access-identity.ts` — 从 JWT 解析展示用身份

### 6.2 GitHub PAT（Worker 怎么读 GitHub）

对齐 Gitdeck 的 **token 形态**，不对齐 device / gh-cli。

- 设置页提交 PAT。请求体只走 HTTPS 到 Worker，响应永不回传完整 token。
- Worker 用 `TOKEN_ENCRYPTION_KEY`（AES-GCM）加密后写入 D1 `accounts`。
- 列表接口只返回 `login`、`avatar_url`、`token_last4`、`scopes`、是否当前账号。
- 可多账号；`is_active` 标记当前用于拉取的账号。
- 调用 GitHub 时在 Worker 内解密，`Authorization: Bearer …`。日志与错误信息必须经过 sanitize。

文件约定：

- `src/server/routes/accounts.ts`
- `src/server/lib/token-crypto.ts`
- `src/server/lib/github-client.ts`
- `src/client/routes/settings.tsx`
- `src/client/viewmodels/use-accounts-view-model.ts`

---

## 7. 数据：D1 快照

不把 GitHub 资源拆成宽表。快照接近 Gitdeck 的磁盘缓存：按账号 + 种类存 JSON。

### `accounts`

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | TEXT PK | nanoid |
| `login` | TEXT | GitHub login |
| `avatar_url` | TEXT | |
| `token_ciphertext` | TEXT | AES-GCM 密文 |
| `token_last4` | TEXT | 展示用 |
| `scopes` | TEXT | 逗号分隔或 JSON |
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
| `digest` | 当日统计摘要（无 LLM） |
| `repo:{owner}/{name}:details` | 单仓概览 |
| `repo:{owner}/{name}:actions` | workflow runs |
| `repo:{owner}/{name}:traffic` | views/clones |
| `repo:{owner}/{name}:security` | 单仓安全告警 |
| `repo:{owner}/{name}:issues` | 单仓 issues |
| `repo:{owner}/{name}:prs` | 单仓 PRs |
| `repo:{owner}/{name}:releases` | releases |
| `repo:{owner}/{name}:languages` | 语言占比 |
| `repo:{owner}/{name}:contributors` | contributors |

读取路径：API 默认返回快照；`?fresh=1` 时打 GitHub、覆写快照再返回。首版不做 Cron 预热。

隔离：生产 `giraffe-db`，测试 `giraffe-db-test`。E2E 禁止打生产 D1。测试库含 `_test_marker`。详见 6DQ D1。

文件约定：

- `src/server/lib/db/d1.ts`
- `src/server/lib/db/accounts.ts`
- `src/server/lib/db/snapshots.ts`
- `src/server/lib/db/schema.sql`（或后续 Drizzle；首版原生 SQL，不提前上 ORM）

---

## 8. API（参考 Gitdeck，不抄实现）

前缀 `/api`。JSON。生产与本地均由同一 Hono 应用提供。GitHub token 不出 Worker。

| 方法 | 路径 | 来源 | 行为 |
|------|------|------|------|
| GET | `/api/live` | 家族惯例 | 版本、环境，无鉴权数据 |
| GET | `/api/me` | 新增 | Access 身份（email/name）；本地返回 stub |
| GET | `/api/accounts` | Gitdeck | 账号列表（无 token） |
| POST | `/api/accounts` | Gitdeck `add-token` | 校验 PAT（`GET /user`），加密入库 |
| POST | `/api/accounts/:id/activate` | Gitdeck | 切换当前账号 |
| DELETE | `/api/accounts/:id` | Gitdeck | 删除账号与其快照 |
| GET | `/api/repos` | Gitdeck | 快照；`fresh=1` 刷新 |
| GET | `/api/issues` | Gitdeck | 同上 |
| GET | `/api/prs` | Gitdeck | 同上 |
| GET | `/api/insights` | Gitdeck `repo-insights` | 同上 |
| GET | `/api/alerts` | Gitdeck 安全数据 | 独立告警视图 |
| GET | `/api/notifications` | Gitdeck | inbox |
| POST | `/api/notifications/read` | Gitdeck | 标记已读（透传 GitHub，并更新快照） |
| POST | `/api/notifications/read-all` | Gitdeck | 全部已读 |
| GET | `/api/digest` | Gitdeck `daily-digests` | 统计摘要，无 LLM |
| GET | `/api/repos/:owner/:name` | Gitdeck `repo-details` | 单仓概览 |
| GET | `/api/repos/:owner/:name/actions` | 单仓 Actions | |
| GET | `/api/repos/:owner/:name/traffic` | 单仓 Traffic | |
| GET | `/api/repos/:owner/:name/security` | 单仓安全 | |
| GET | `/api/repos/:owner/:name/issues` | 单仓 issues | |
| GET | `/api/repos/:owner/:name/prs` | 单仓 PRs | |
| GET | `/api/repos/:owner/:name/releases` | releases | |
| GET | `/api/repos/:owner/:name/languages` | languages | |
| GET | `/api/repos/:owner/:name/contributors` | contributors | |

不做：`/api/auth/*`（device flow）、`/api/projects*`、`/api/mentions/*`、`/api/stargazers`、GitLab OAuth。

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
| L1 | Vitest；ViewModel / 纯函数 / token-crypto / snapshot 合并逻辑；覆盖率 ≥ 90%；薄壳 `routes/*.tsx` 豁免 | pre-commit，<30s |
| L2 | 真 HTTP 打 `wrangler dev --local`；覆盖上表全部 `/api` 方法组合；绑定 `giraffe-db-test` | pre-push，<3min |
| L3 | Playwright：Access 短路下的设置 PAT → 仓库列表 → 单仓钻取 | CI / 按需 |
| G1 | `tsc --noEmit` + `biome check --error-on-warnings`，0 error 0 warning | pre-commit |
| G2 | `gitleaks` + `osv-scanner --lockfile=bun.lock` | pre-push |
| D1 | `giraffe-db` vs `giraffe-db-test`；构建期校验 binding 名含 `-test`；运行时拒绝非 test 资源跑 E2E；`_test_marker` | L2/L3 强制 |

无状态或未建库的脚手架阶段，D1 维度标 N/A 直到第一次接入 D1。一旦有 D1，测试不得打生产库。

---

## 12. 原子化提交

全程坚持，不攒大批量 diff。

- Conventional Commits：`<type>: <short description>`，祈使句，全小写，≤50 字符
- type：`fix` `feat` `docs` `test` `refactor` `chore`
- 一次 commit 只含一个逻辑变更
- 只 `git add` 具体文件，不用 `git add -A` / `git add .`
- 不主动 push
- 每个 commit 后代码可 typecheck / 可测（脚手架早期至少可 `tsc` + `biome`）

实现阶段建议的提交切片（可按实际增删，不可把整仓一次提交）：

1. `chore: scaffold bun vite worker toolchain`
2. `chore: add biome husky and 6dq hooks`
3. `feat: add hono worker and spa shell`
4. `feat: validate cloudflare access jwt`
5. `feat: add d1 accounts and snapshot tables`
6. `feat: store encrypted github pats`
7. `feat: proxy github repos issues and prs`
8. `feat: add insights alerts and inbox`
9. `feat: add daily digest snapshot`
10. `feat: add repository detail views`
11. `test: cover api routes over isolated d1`
12. `chore: add giraffe.dev.hexly.ai caddy site`

文档变更同样原子化：本文与 `CLAUDE.md` 分两次提交。

---

## 13. 后续编号文档（尚未写）

实现前不必一次写完，缺哪块补哪号。

| 预留 | 内容 |
|------|------|
| 02 | 本地运行与 Caddy / Access 开发短路 |
| 03 | 6DQ 细则与覆盖率门控 |
| 04 | D1 schema 与快照刷新语义 |
| 05 | GitHub API 映射与限流 |

根目录 `README.md` 在脚手架落地时再写，并链回本文。当前 Agent 入口是根目录 `CLAUDE.md`。
