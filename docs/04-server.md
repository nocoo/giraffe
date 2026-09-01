# 04 — Server 设计

阶段 1 的 Worker / API 契约。接口清单、每接口行为、错误码、文件与原子提交步骤以本文为准。01 第 8 节只是方向摘要。表结构以 [03](03-schema.md) 为准，测试分层以 [02](02-quality.md) 为准。

> 返回 [文档目录](README.md)

本文不评估工作量。阶段 1 不写 `src/client/**` 功能代码，不写 L3。

---

## 1. 范围

做：Hono `/api/*`、Access 中间件、PAT 信封、D1 快照、经 `githubFetch` 回源、L1 + L2 套件 A/B。

不做：Client、Playwright、Cron、Device Flow、fine-grained PAT、GitLab、GraphQL 出站、额外未列入第 8 节的路径。

权威冲突时：质量 → 02，表与 JSON → 03，HTTP 契约 → 本文。不得在实现时另开一套路径或状态码。

---

## 2. 锁定决策

| 主题 | 决定 |
|------|------|
| 无可用 PAT | HTTP **409**，`code: "account_missing"`。不用 412 |
| 无快照 | HTTP **409**，`code: "snapshot_missing"`。GET 不回源、不写库 |
| 刷新时机 | 无 Cron。GET 不得刷新。只接受 `POST /api/refresh`。何时调用由 05，Server 不调度 |
| GitHub 出站 | 只走 REST。`githubFetch` 是除 Access JWKS 外唯一 `fetch` |
| 账号主键 | `login` 唯一。再次粘贴同一 login 则 **upsert**（保留 `id`，重加密 token） |
| 删除当前账号 | 不自动激活其它账号；之后快照类接口 409 `account_missing` |
| 查询参数 | 首版 GET 无 filter/sort。筛选在 Client |
| 快照响应 | GET 成功体 = 03 对应逻辑 kind 的 JSON。分页在服务端拼好，不暴露 `kind#n` |

---

## 3. 目标文件

现有 `src/lib/version.ts` 继续作为版本唯一来源。不要新建 `src/server/lib/version.ts`。

```
src/server/
  index.ts                         # createApp + 默认 fetch：/api → Hono，其它 → ASSETS
  env.ts                           # Env 类型与 ENVIRONMENT 归一
  middleware/access.ts             # JWT；development 短路
  middleware/origin.ts             # POST/DELETE 的 Origin 白名单
  routes/live.ts
  routes/me.ts
  routes/accounts.ts
  routes/refresh.ts
  routes/snapshots.ts              # 跨仓 GET
  routes/notifications.ts          # GET + 已读
  routes/repos.ts                  # 单仓 GET
  lib/errors.ts                    # 错误信封
  lib/sanitize.ts
  lib/token-crypto.ts
  lib/github-client.ts             # githubFetch + githubApi
  lib/github-map.ts                # REST → 03 形状
  lib/access-identity.ts
  lib/snapshot-pages.ts            # 1.5MB 切分 / 组装
  lib/insights.ts
  lib/digest.ts
  lib/db/schema.sql                # 仅 accounts / snapshots / snapshot_days
  lib/db/d1.ts
  lib/db/accounts.ts
  lib/db/snapshots.ts
  lib/db/snapshot-days.ts
tests/api/                         # L2 真 HTTP。由 scripts/run-e2e.ts 跑
```

静态路径必须先于参数路径注册：`/api/repos` 先于 `/api/repos/:owner/:name`。

`src/server/index.ts` 现有占位 `Response("giraffe")` 在挂上 Hono 的那次提交里删除。非 `/api` 一律 `env.ASSETS.fetch(request)`。

---

## 4. Env

```ts
interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ENVIRONMENT?: string;
  TOKEN_ENCRYPTION_KEY_CURRENT: string;
  TOKEN_ENCRYPTION_KEY_V1?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  GITHUB_API_BASE?: string;
  ACCESS_JWKS_URL?: string;
}
```

动态读取 `TOKEN_ENCRYPTION_KEY_V${n}`，不把 V2+ 写死在类型里。缺当前版本密钥 → 500 `encryption_misconfigured`。

`ENVIRONMENT` 归一：

| 原始值 | 模式 |
|--------|------|
| `development` | development |
| `test` | test |
| 空、`production` | production |
| 其它 | 当 production（Access **不**短路） |

G1 禁止把 `ENVIRONMENT=development` / `test`、`GITHUB_API_BASE`、`ACCESS_JWKS_URL` 写入 `wrangler.toml`。

模式行为：

| | development | test | production |
|--|-------------|------|------------|
| Access | 短路，不验 JWT | 必验；JWKS 只信 `ACCESS_JWKS_URL` | 必验；忽略 `ACCESS_JWKS_URL`，JWKS 只信 `CF_ACCESS_TEAM_DOMAIN` |
| GitHub origin | 必须 `GITHUB_API_BASE`；不匹配则 throw 且不 fetch | 同左 | 忽略 `GITHUB_API_BASE`，只许 `https://api.github.com` |
| 缺 Access 配置 | 短路，不需要 team/aud | 缺 `ACCESS_JWKS_URL` 或 aud → 失败关闭 | 缺 `CF_ACCESS_TEAM_DOMAIN` 或 `CF_ACCESS_AUD` → 失败关闭 |

`githubFetch` 的 origin 比较：`new URL(url).origin === new URL(base).origin`，禁止 hostname 对 origin。

---

## 5. 横切

### 5.1 错误信封

所有 4xx/5xx（除 204）的 body：

```json
{ "error": { "code": "<code>", "message": "<text>" } }
```

`Content-Type: application/json; charset=utf-8`。`message` 给人看，**不得**含 PAT、信封、`Authorization`。GitHub 的 `X-OAuth-Scopes` 可入库，不回传到错误体以外的调试字段。不转发 GitHub 原文响应头。

| HTTP | code | 何时 |
|------|------|------|
| 400 | `validation_failed` | Zod 失败、非法 token 形态、未知 kind、`kinds: []`、缺必填 JSON |
| 400 | `scopes_missing` | `POST /api/accounts` 的 `X-OAuth-Scopes` 未覆盖必填 |
| 401 | `access_unauthorized` | Access JWT 缺/坏/过期/错 aud/错 iss |
| 401 | `github_unauthorized` | 出站 GitHub 401（坏 PAT） |
| 403 | `origin_forbidden` | POST/DELETE 缺 Origin，或 Origin 不在白名单 |
| 404 | `not_found` | 未知 `/api`、未知 `accounts/:id`、单仓 GitHub 404 |
| 405 | `method_not_allowed` | 已注册路径上的未列出方法 |
| 409 | `account_missing` | 需要 active 账号但没有 |
| 409 | `snapshot_missing` | 该逻辑 kind 无快照 |
| 409 | `capability_missing` | 刷新某 kind 时 token 级 scope 不足 |
| 500 | `encryption_misconfigured` | 密钥环缺当前版本 |
| 502 | `github_error` | GitHub 5xx，或 origin 已通过后的网络失败 |

成功 JSON 不得出现 `error` 字段。成功不得把 token、信封、`token_ciphertext` 放入 body。

### 5.2 Access

文件：`src/server/middleware/access.ts`、`src/server/lib/access-identity.ts`。

- 公开：**仅** `GET /api/live`。其它 `/api/*` 都要过中间件。
- 读 `Cf-Access-Jwt-Assertion`。验签 + `iss` + `aud` + `exp`。只验签不够。
- development 短路：不读 JWT，身份固定 `{ "email": "dev@local", "name": "dev" }`。
- 禁止用 `Host`、`X-Forwarded-*`、域名后缀决定是否短路。
- JWKS `fetch` 只允许写在 `access.ts`（G1 白名单）。

### 5.3 Origin（CSRF）

文件：`src/server/middleware/origin.ts`。

适用于全部 POST 与 DELETE。GET **不**要求 Origin。

精确匹配（无尾斜杠、无前缀匹配）：

| 模式 | 允许的 Origin |
|------|----------------|
| production | `https://giraffe.hexly.ai` |
| development | `https://giraffe.dev.hexly.ai` |
| test | `https://giraffe.dev.hexly.ai` |

白名单 **不含** `http://127.0.0.1:*`。L2/L3 请求头带上表 Origin，即使打的是 loopback。缺头或其它值 → 403 `origin_forbidden`。403 不得当作该路径唯一 L2 用例。

### 5.4 Sanitize

`src/server/lib/sanitize.ts`。从字符串中去掉：

- `ghp_[A-Za-z0-9]{36}`
- `github_pat_[A-Za-z0-9_]+`
- `Bearer .+`
- 信封 JSON 子串（含 `"ct"` / `"iv"` / `"tag"` 的 token 信封）

用于错误 `message`、准备写进日志的文本。Worker 代码不得 `console.log` 请求体或 `Authorization`。

### 5.5 请求体

有 JSON 的 POST：`Content-Type` 必须是 `application/json`（可带 `charset=utf-8`），否则 400 `validation_failed`。无 body 的 POST（activate、read-all）不要求 Content-Type。Body 上限：accounts 4 KiB，其它 64 KiB，超过 400。

---

## 6. GitHub 客户端

`src/server/lib/github-client.ts`：

- `githubFetch(env, url, init)`：按第 4 节核对 origin，通过才 `fetch`。这是 github-client 里唯一的 `fetch` 调用点。
- `githubApi(env, token, path, init)`：拼 `base + path`（path 以 `/` 开头），加头后走 `githubFetch`：
  - `Authorization: Bearer <token>`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `User-Agent: giraffe/<APP_VERSION>`
- 列表分页：`per_page=100`，最多 **10** 页。还有下一页则调用方把快照 `truncated: true`。
- 单仓扇出（issues / prs / alerts）：最多前 **100** 个 `name_with_owner`，超出则 `truncated: true`。

GitHub 401 → 抛出后映射 401 `github_unauthorized`。GitHub 5xx → 502 `github_error`。刷新 traffic/security 时单仓 403/404：写入 03 的 `forbidden` / `unavailable`，**不**把整次 refresh 打成 403。

L1：注入 fake fetch；setup 默认 fetch throw（`network denied in L1`）。

---

## 7. PAT 信封

`src/server/lib/token-crypto.ts`。AES-256-GCM。

- 只接受 classic PAT：`^ghp_[A-Za-z0-9]{36}$`。`github_pat_` 或其它 → 400 `validation_failed`。
- `TOKEN_ENCRYPTION_KEY_CURRENT` 为十进制整数（如 `"1"`）。密钥字节：32 字节，secret 为 64 hex 或 32 字节标准 base64。
- IV：每次加密 12 字节 `crypto.getRandomValues`，禁止复用。
- 信封：`{"v":1,"iv":"<b64>","ct":"<b64>","tag":"<b64>"}`，写入 `token_ciphertext`。
- 解密用行上 `key_version` 选 `TOKEN_ENCRYPTION_KEY_V<n>`。
- `token_last4`：PAT 最后 4 个字符。
- 必填 scope（录入时 `X-OAuth-Scopes` 必须全部出现）：`repo`、`read:org`、`read:user`、`notifications`。
- `capabilities`：03 的 token 级 boolean，不是仓库权限。

明文 PAT 只允许：本次请求体、解密后的内存、出站 `Authorization`。禁止 D1 明文列、响应、日志、trace。

---

## 8. D1

`schema.sql` **不含** `_test_marker`。L2/L3 runner 在执行 schema 之后另跑 03 的 marker SQL。生产禁止建 `_test_marker`。

访问层只用绑定参数，不用字符串拼 SQL。读快照：按逻辑 kind 取 `kind` 与全部 `kind#n`，交给 `snapshot-pages` 组装。写：先删该逻辑 kind 全部物理行再插入。切分规则见 03 §3。

`GET /api/live` 用 **D1 binding** 读 `_test_marker`：有 `value=test` 则 `d1_marker: "test"`，否则 `null`。不得用 wrangler CLI 查同一 SQLite 充当 live 实现。

---

## 9. 刷新

`POST /api/refresh`。需要 active 账号。Origin 必过。

Body（Zod）：`kinds` 可选。

```json
{ "kinds": "all" }
```

或

```json
{ "kinds": ["repos", "issues"] }
```

或 `{}`。

- 缺 `kinds` 或 `"all"`：刷新全部跨仓 GitHub kind：`repos`、`issues`、`prs`、`alerts`、`notifications`，然后重算 `insights` 与 `digest`。
- 数组：只刷新列出的逻辑 kind。`insights` / `digest` 不打 GitHub，只从已有（含本次刚写的）`repos`/`issues`/`alerts`/`snapshot_days` 重算；源快照缺失 → 409 `snapshot_missing`。
- `kinds: []`、未知字符串、非法 `repo:` 形状 → 400 `validation_failed`。
- 单仓 kind：`repo:{owner}/{name}:details` 等，与 03 逻辑 kind 一致。`owner`/`name` 各匹配 `^[A-Za-z0-9_.-]+$`，且不是 `.` / `..`。

Token 级 scope：刷新 `notifications` 需要 `capabilities.notifications === true`，否则 409 `capability_missing`（不写库）。其它跨仓 kind 需要 `capabilities.repo === true`。

GitHub REST（均经 `githubApi`）：

| 逻辑 kind | 方法 |
|-----------|------|
| `repos` | `GET /user/repos?per_page=100&affiliation=owner,collaborator,organization_member&page=` |
| `issues` | 对至多 100 仓 `GET /repos/{o}/{n}/issues?state=open&per_page=100`（过滤 `pull_request` 字段，只要 issue） |
| `prs` | 对至多 100 仓 `GET /repos/{o}/{n}/pulls?state=open&per_page=100` |
| `alerts` | 每仓 `GET /repos/{o}/{n}/dependabot/alerts?state=open` 与 `GET /repos/{o}/{n}/code-scanning/alerts?state=open`。全仓均 403/404 → `unavailable: true` |
| `notifications` | `GET /notifications?per_page=100`（默认未读） |
| `repo:…:details` | `GET /repos/{o}/{n}` |
| `repo:…:actions` | `GET /repos/{o}/{n}/actions/runs?per_page=100` |
| `repo:…:traffic` | `GET /repos/{o}/{n}/traffic/views` 与 `/traffic/clones` |
| `repo:…:security` | 该仓 dependabot + code scanning 计数 |
| `repo:…:issues` / `:prs` | 与跨仓同一 REST，仅该仓 |
| `repo:…:releases` | `GET /repos/{o}/{n}/releases?per_page=100` |
| `repo:…:languages` | `GET /repos/{o}/{n}/languages` |
| `repo:…:contributors` | `GET /repos/{o}/{n}/contributors?per_page=100` |

映射在 `github-map.ts`，字段名对齐 03（snake_case）。

副作用（成功后，同一请求内）：

1. 写对应 snapshots（含分页）。
2. 若写了 `repos`：按 `fetched_at` 的 UTC 日 upsert `snapshot_days`（stars/forks/open_issues/repos 合计），删除早于 30 天的行。
3. 若本次使得 `repos`+`issues`+`alerts` 都存在：重算并写 `insights`。
4. 若写了 `repos`：重算并写 `digest` 当前副本（无昨天 → `baseline_missing: true`，delta 全 `null`）。
5. 更新 `accounts.last_used_at`。

响应：

- 单个 kind：200，body 与对应 GET 成功体相同。
- `"all"` 或多个 kind：200 `{ "fetched_at": "<iso>", "kinds": ["repos", "..."] }`，不内嵌 payload。

顺序：串行调用 GitHub，避免无界并发。

---

## 10. Insights 与 digest

纯函数，L1 必测。`fetched_at` 用本次计算时刻的 UTC ISO。

**health**（`days_since_push` 用 `repos.pushed_at` 相对本次 `fetched_at` 的整天数，缺 `pushed_at` 视为 9999）：

| 条件（自上而下先命中） | health |
|------------------------|--------|
| `days_since_push >= 90` 或该仓 alerts 含 `high`/`critical` | `risky` |
| `days_since_push >= 30` 或 `open_issue_count >= 20` 或该仓 alerts 非空 | `watch` |
| 其它 | `strong` |

`opportunities` 封闭枚举，可多选：`stale_push`、`many_issues`、`open_alerts`。`alerts` 数组复制该仓 alerts `items`。

digest 只对比 `day` 与 UTC 日历昨天。无昨天行：`baseline_missing: true`，三个 delta 与每仓 delta 均为 `null`，禁止填 `0`。

---

## 11. 接口契约

公共规则：JSON UTF-8；GET 成功 200；列表类无数据但是有快照 → 200 且数组空；**不是** 409。

### `GET /api/live`

公开。不读 PAT。不写库。

```json
{
  "name": "giraffe",
  "version": "0.0.0",
  "environment": "development",
  "d1_marker": "test"
}
```

`version` = `APP_VERSION`（`package.json`）。`environment` 为归一后的模式。`d1_marker` 为 `"test"` 或 `null`。无 D1 表时 `null`，不得 500。

### `GET /api/me`

```json
{ "email": "a@b.c", "name": "n" }
```

development 为 stub `dev@local` / `dev`。不返回 GitHub login。无账号也 200。

### `GET /api/accounts`

```json
{
  "accounts": [
    {
      "id": "…",
      "login": "octocat",
      "avatar_url": "",
      "token_last4": "xxxx",
      "scopes": "repo, read:org, read:user, notifications",
      "capabilities": { "repo": true, "read:org": true, "read:user": true, "notifications": true },
      "is_active": true
    }
  ]
}
```

零账号 → `{ "accounts": [] }`。无 token、无信封。

### `POST /api/accounts`

Body：`{ "token": "ghp_…" }`。Origin 必过。

1. 形态校验。
2. `GET /user`。GitHub 401 → 401 `github_unauthorized`。
3. 读 `X-OAuth-Scopes`，缺必填 → 400 `scopes_missing`（不写库）。
4. 加密。同 login upsert；新 login 则 nanoid(21)。零账号时该行 `is_active=1`，否则保持原 `is_active`（新行默认 0）。
5. 201，body 同列表元素。响应、wrangler 日志、随后 `GET /api/live` / `GET /api/accounts` 均不得出现 PAT 明文。L2 成功路径还要用同一 persist 读 `token_ciphertext`，必须是信封且 PAT 不是子串（02 §5.3）。

### `POST /api/accounts/:id/activate`

无 body。Origin 必过。未知 id → 404。把全部账号 `is_active=0` 再把目标置 1。200 `{ "id": "…", "is_active": true }`。

### `DELETE /api/accounts/:id`

Origin 必过。未知 id → 404。删除行，CASCADE 快照。204 无 body。

### 快照 GET

下列路径无 active 账号 → 409 `account_missing`；有账号但无该逻辑 kind → 409 `snapshot_missing`。成功 200，body = 03 JSON。GET 期间 GitHub stub 请求数必须为 0，相关 D1 行字节级不变。

| 方法 | 路径 | 逻辑 kind |
|------|------|-----------|
| GET | `/api/repos` | `repos` |
| GET | `/api/issues` | `issues` |
| GET | `/api/prs` | `prs` |
| GET | `/api/insights` | `insights` |
| GET | `/api/alerts` | `alerts` |
| GET | `/api/notifications` | `notifications` |
| GET | `/api/digest` | `digest` |
| GET | `/api/repos/:owner/:name` | `repo:{owner}/{name}:details` |
| GET | `/api/repos/:owner/:name/actions` | `:actions` |
| GET | `/api/repos/:owner/:name/traffic` | `:traffic` |
| GET | `/api/repos/:owner/:name/security` | `:security` |
| GET | `/api/repos/:owner/:name/issues` | `:issues` |
| GET | `/api/repos/:owner/:name/prs` | `:prs` |
| GET | `/api/repos/:owner/:name/releases` | `:releases` |
| GET | `/api/repos/:owner/:name/languages` | `:languages` |
| GET | `/api/repos/:owner/:name/contributors` | `:contributors` |

`:owner` `:name` 校验失败 → 400 `validation_failed`（不当成 409）。

### `POST /api/notifications/read`

Body：`{ "id": "<github thread id>" }`。Origin 必过。无账号 → 409。`POST /notifications/threads/{id}` 到 GitHub，再把当前 notifications 快照里该 id 的 `unread` 置 `false`（无快照则 409 `snapshot_missing`，仍可向 GitHub 标记？**否**：无快照 409，不打 GitHub）。200，body 同 GET notifications。

### `POST /api/notifications/read-all`

无 body。Origin 必过。`PUT /notifications`（GitHub mark all read）。无快照 409，不打 GitHub。成功后快照内全部 `unread: false`。200，body 同 GET。

### 未列出的 `/api`

404 `not_found`。已列出路径的其它方法 405。

---

## 12. L1 / L2

L1 必测（注入 DB / fake fetch，无网络、无 wrangler）：

| 模块 | 例子 |
|------|------|
| `token-crypto` | 往返解密；IV 不重复；错 key_version |
| `sanitize` | PAT / Bearer 被剥掉 |
| `githubFetch` | 生产忽略 `GITHUB_API_BASE`；development origin 不匹配不调用 fetch |
| `access` | 缺 iss/aud/过期 → 401；production 忽略 fixture JWKS |
| `origin` | 缺头 / 错 Origin → 403；GET 不查 Origin |
| `snapshot-pages` | 切分与组装；单元素过大 `truncated` |
| `digest` | 邻日差量；无昨天 → `baseline_missing` 且 delta `null` |
| `insights` | health 三档与 opportunities |
| 路由纯逻辑 | 无快照 409；`scopes_missing`；`capability_missing` |

L2 真 HTTP，隔离与套件 A/B 以 02 为准。第一个 `/api` 处理函数落地的**同一批变更**必须实现 `scripts/run-e2e.ts`（不再 N/A）。本文第 11 节每一个方法+路径都必须进入套件 A 与套件 B。

套件 A 最低：

| 路径类 | 必须 |
|--------|------|
| 每个 GET 快照 | 无 Origin 仍 200 或 409；有快照时 stub 计数 0 且 D1 字节不变 |
| 每个 POST/DELETE | 允许 Origin 的成功路径；缺 Origin 403；错 Origin 403。403 不是唯一用例 |
| `POST /api/accounts` | 成功、缺 scope 400、GitHub 401、非法 token 400；四处都不泄漏 PAT；成功后再查信封 |
| `GET /api/live` | `d1_marker=test` 来自 Worker 读 D1 |

套件 B：除 `GET /api/live` 外，每个受保护方法+路径：无 JWT / 坏签 / 错 aud → 401；合法 fixture JWT **不得** 401（允许 200/409/其它业务码）。只测 `/api/me` 不够。

L2 fixture 仓用 `octocat/hello-world`。

---

## 13. 部署清单

自定义域对外之前必须全部满足。未完成禁止 `wrangler deploy` 绑定 `giraffe.hexly.ai`：

1. Cloudflare Access 应用与策略已挂在 `giraffe.hexly.ai`。
2. `wrangler.toml`：`workers_dev = false`，`preview_urls = false`，无 `[env.test]`，无 `remote = true`，无 development/test `[vars]`。
3. 生产 D1 `giraffe-db` 已创建，`database_id` 已填真实 UUID；已对**远程**库执行 `schema.sql`（不是 persist 目录）。
4. Secrets：`TOKEN_ENCRYPTION_KEY_V1`、`TOKEN_ENCRYPTION_KEY_CURRENT`、`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`。
5. 先 `vite build`（阶段 1 可用占位 `dist/client`），再 `wrangler deploy`。
6. 部署后 `GET https://giraffe.hexly.ai/api/live` 不得在无 Access 的匿名请求中返回业务数据（live 本身公开，只含 version/environment/`d1_marker`）。`GET /api/me` 无 JWT 必须 401。

---

## 14. 原子提交步骤

每步：工作区红测 → 最小实现 → pre-commit 绿 → **一次** commit。有 `/api` 之后，push 前 L2 绿。禁止把整阶段打成一次 commit。禁止 `--no-verify`。Commit 信息示例可改，须 Conventional、祈使、≤50 字符。

| # | 提交 | 内容 | 证明 |
|---|------|------|------|
| 1 | `feat: add server env and error helpers` | `env.ts` `errors.ts` `sanitize.ts` | L1 |
| 2 | `feat: add token envelope crypto` | `token-crypto.ts` | L1 往返与 IV |
| 3 | `feat: add githubFetch origin gate` | `github-client.ts` | L1 不匹配不 fetch；生产忽略 base |
| 4 | `feat: add snapshot paging helpers` | `snapshot-pages.ts` | L1 |
| 5 | `feat: add insights and digest math` | `insights.ts` `digest.ts` | L1 |
| 6 | `feat: add d1 schema and stores` | `schema.sql` 与 `lib/db/*` | L1 用 fake D1 |
| 7 | `feat: add access and origin middleware` | `middleware/*` `access-identity.ts` | L1 |
| 8 | `feat: add live api and l2 runner` | Hono 挂载、`routes/live.ts`、替换占位 fetch、**实现** `scripts/run-e2e.ts` + `tests/api/live.test.ts` | L1 + L2 A/B（仅 live） |
| 9 | `feat: add me endpoint` | `routes/me.ts` | L1 + L2 A/B |
| 10 | `feat: add accounts crud api` | `routes/accounts.ts` 加解密入库 | L1 + L2（含 PAT 非泄漏与信封） |
| 11 | `feat: add refresh for list snapshots` | `refresh.ts` `github-map.ts` 跨仓 kind | L1 + L2：refresh 后 GET 能读到 |
| 12 | `feat: add snapshot get routes` | `routes/snapshots.ts` | L1 + L2 409/200/只读 |
| 13 | `feat: add notification write-through` | `routes/notifications.ts` | L1 + L2；无快照不打 GitHub |
| 14 | `feat: add single-repo snapshot api` | `routes/repos.ts` + refresh 单仓 kind | L1 + L2 |

步骤 8 起 L2 为硬门。步骤 8 不得只交 live 而不交 runner。步骤 10 未绿之前不要做 refresh（没有 PAT）。

阶段 1 完成线见 02 §10：上表全部接口 L1 + L2 A/B 绿，覆盖率四项 ≥ 95%，无 Client 功能代码。

---

## 15. 禁止

- 新 `/api` 路径或把 409 改成 412
- GET 回源或写 D1
- `github-client.ts` / `access.ts` 以外的 `fetch`
- Client 或 L3 代码
- 把 fixture PAT 写进仓库非测试路径；L2 fixture 必须是明显假值
- 生产 schema 含 `_test_marker`
- 用 `Host` 做 Access 短路
- Origin 白名单放行 loopback
- 响应或日志出现 PAT / 信封
- 未实现 L2 runner 就合并第一个 `/api` 处理函数
