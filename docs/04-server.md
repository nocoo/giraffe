# 04 — Server 设计

阶段 1 的 Worker / API 契约。接口清单、每接口行为、错误码、文件与原子提交步骤以本文为准。01 第 8 节只是方向摘要。表结构以 [03](03-schema.md) 为准，测试分层以 [02](02-quality.md) 为准。

> 返回 [文档目录](README.md)

本文不评估工作量。阶段 1 不写 `src/client/**` 功能代码，不写 L3。

---

## 1. 范围

做：Hono `/api/*`、Access 中间件、PAT 信封、D1 快照、经 `githubFetch` 回源、L1 + L2 套件 A/B。

不做：Client、Playwright、Cron、Device Flow、fine-grained PAT、GitLab、额外未列入第 11 节的路径。GraphQL 只允许 `POST {github origin}/graphql`，经 `githubFetch`。

权威冲突时：质量 → 02，表与 JSON → 03，HTTP 契约 → 本文。不得在实现时另开一套路径或状态码。

---

## 2. 锁定决策

| 主题 | 决定 |
|------|------|
| 无可用 PAT | HTTP **409**，`code: "account_missing"`。不用 412 |
| 无快照 | HTTP **409**，`code: "snapshot_missing"`。GET 不回源、不写库 |
| 刷新时机 | 无 Cron。GET 不得刷新。只接受 `POST /api/refresh`。何时调用由 05，Server 不调度 |
| GitHub 出站 | 同一允许 origin 上的 REST 与 `POST /graphql`。除 Access JWKS 外唯一 `fetch` 是 `githubFetch` |
| 出站上限 | 单次请求 `githubFetch` ≤ **40**。Cloudflare 把 GitHub、JWKS、**D1 statement**（含 `DB.batch` 内每一条）算进同一配额。生产必须 Workers **付费档**（1000 subrequest）。禁止按免费档 50 设计。`createDb(env)` 对本请求 statement 计数，**第 81 条在 execute 前 throw** → 500 `db_error`，不发送该 batch。L1 覆盖第 81 条 |
| 账号主键 | `login` 唯一。再次粘贴同一 login 则 **upsert**（保留 `id`，重加密 token） |
| 删除当前账号 | 不自动激活其它账号；之后快照类接口 409 `account_missing` |
| 查询参数 | 首版 GET 无 filter/sort。筛选在 Client |
| 快照响应 | GET 成功体 = 03 对应逻辑 kind 的 JSON。分页在服务端拼好，不暴露 `kind#n` |
| 多语句 D1 | 快照替换、激活、插入并激活必须 `DB.batch`。禁止跨 await 的非 batch 多写 |

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

Wrangler 生成的绑定类型是 `Env` 的底。`env.ts` 只补充文档化的 secrets / vars，**不要**给整个 `Env` 加宽 index signature。

`TOKEN_ENCRYPTION_KEY_V<n>` 用辅助函数读取：参数 `n` 为整数，拼出 `TOKEN_ENCRYPTION_KEY_V${n}`，**仅当**该字符串匹配 `/^TOKEN_ENCRYPTION_KEY_V\d+$/` 才去 `env` 上取值。缺当前版本密钥 → 500 `encryption_misconfigured`。

`ENVIRONMENT` 归一：

| 原始值 | 模式 |
|--------|------|
| `development` | development |
| `test` | test |
| 空、`production` | production |
| 其它 | 当 production（Access **不**短路） |

G1 禁止把 `ENVIRONMENT=development` / `test`、`GITHUB_API_BASE`、`ACCESS_JWKS_URL` 写入 `wrangler.toml`。Dashboard / secrets 仍可能误配，因此短路条件不得只看 `ENVIRONMENT`。

**Access 短路**当且仅当：模式为 development **且** 已设 `GITHUB_API_BASE` **且** `CF_ACCESS_TEAM_DOMAIN` 与 `CF_ACCESS_AUD` 都未设置。缺 `GITHUB_API_BASE` 的 development（生产误配）→ **不得短路**，按 production 验 JWT；缺 JWKS 配置则受保护路由 500 `access_misconfigured`。`GET /api/live` 仍公开。

模式行为：

| | development（有 `GITHUB_API_BASE`，无 team/aud） | test | production |
|--|--------------------------------------------------|------|------------|
| Access | 短路，不验 JWT | 必验。必须同时有 `CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`、`ACCESS_JWKS_URL`。JWKS 只信 `ACCESS_JWKS_URL`。`iss` 必须精确等于 `CF_ACCESS_TEAM_DOMAIN`（无尾斜杠）。`alg` 仅 `RS256`。校验 `iss`/`aud`/`exp`，有 `nbf` 则验 | 必验；忽略 `ACCESS_JWKS_URL`，JWKS 只信 `CF_ACCESS_TEAM_DOMAIN`。同样 RS256 + `iss`/`aud`/`exp`，有 `nbf` 则验 |
| GitHub origin | 必须 `GITHUB_API_BASE`；不匹配则 throw 且不 fetch | 同左 | 忽略 `GITHUB_API_BASE`，只许 `https://api.github.com` |
| 缺 Access 配置 | 允许短路 | 受保护路由 500 `access_misconfigured` | 受保护路由 500 `access_misconfigured` |

`githubFetch` 的 origin 比较：`new URL(url).origin === new URL(base).origin`，禁止 hostname 对 origin。`POST /graphql` 的 url 必须是 `{base}/graphql`。

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
| 400 | `validation_failed` | Zod 失败、非法 token 形态、未知 kind、`kinds: []`、重复 kind、缺必填 JSON |
| 400 | `scopes_missing` | `POST /api/accounts` 的 `X-OAuth-Scopes` 未覆盖必填 |
| 401 | `access_unauthorized` | Access JWT 缺/坏/过期/错 aud/错 iss |
| 401 | `github_unauthorized` | 出站 GitHub 401（坏 PAT） |
| 403 | `origin_forbidden` | POST/DELETE 缺 Origin，或 Origin 不在白名单 |
| 403 | `github_forbidden` | 出站 GitHub 403，且不是 traffic/security/alerts 写入 `forbidden`/`unavailable` 的情况 |
| 404 | `not_found` | 未知 `/api`、未知 `accounts/:id`、任一单仓 kind 的 GitHub 404、notifications thread GitHub 404 |
| 405 | `method_not_allowed` | 已注册路径上的未列出方法 |
| 409 | `account_missing` | 需要 active 账号但没有 |
| 409 | `snapshot_missing` | 该逻辑 kind 无快照 |
| 409 | `capability_missing` | 刷新某 kind 时 token 级 scope 不足 |
| 500 | `encryption_misconfigured` | 密钥环缺当前版本 |
| 500 | `access_misconfigured` | 必验 JWT 但 team/aud/JWKS 缺 |
| 500 | `db_error` | D1 抛错 |
| 500 | `internal_error` | 未归类异常；`message` 经 sanitize，不得含栈里的密钥 |
| 502 | `github_error` | GitHub 5xx、422、body 非 JSON、origin 已通过后的网络失败 |
| 503 | `github_rate_limited` | GitHub 429。不转发 `Retry-After` 以外的 GitHub 头；不把 token 写入 message |

成功 JSON 不得出现 `error` 字段。成功不得把 token、信封、`token_ciphertext` 放入 body。Hono `onError` 把未列出的异常变成 500 `internal_error`；禁止未捕获导致非 JSON 响应。

### 5.2 Access

文件：`src/server/middleware/access.ts`、`src/server/lib/access-identity.ts`。

- 公开：**仅** `GET /api/live`。其它 `/api/*` 都要过中间件。
- 读 `Cf-Access-Jwt-Assertion`。验签 + `iss` + `aud` + `exp`。只验签不够。`alg` 仅 RS256。
- 短路条件见第 4 节（development **且**已设 `GITHUB_API_BASE` **且**未设置 team/aud）。短路时不读 JWT，身份固定 `{ "email": "dev@local", "name": "dev" }`。
- 禁止用 `Host`、`X-Forwarded-*`、域名后缀决定是否短路。
- JWKS `fetch` 只允许写在 `access.ts`（G1 白名单）。该 `fetch` 不计入 GitHub 的 40 次上限。

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

有 JSON 的 POST：`Content-Type` 必须是 `application/json`（可带 `charset=utf-8`），否则 400 `validation_failed`。无 body 的 POST（activate、read-all）不要求 Content-Type。

Body 上限：accounts 4 KiB，其它 64 KiB。用 `request.body` 流式读，累计超过上限立即 cancel 并 400。禁止 `arrayBuffer()` / `request.json()` 在限长之前把整包读进内存。

---

## 6. GitHub 客户端

`src/server/lib/github-client.ts`：

每个入站请求 `createGithubClient(env)` 一次，返回 `{ githubFetch, githubApi, githubGraphql }`。计数器在该对象上，**禁止**模块级可变全局。

- `githubFetch(url, init)`：按第 4 节核对 origin，通过才 `fetch`。这是 github-client 里唯一的 `fetch` 调用点。每次成功进入 `fetch` 前把本请求计数 +1，**第 41 次起不再调用 fetch**，抛内部截断（调用方只给**正在收集**的那个 kind 标 `truncated: true`）。
- `githubApi(token, path, init)`：拼 `base + path`（path 以 `/` 开头），加头后走 `githubFetch`：
  - `Authorization: Bearer <token>`
  - `Accept: application/vnd.github+json`
  - `X-GitHub-Api-Version: 2022-11-28`
  - `User-Agent: giraffe/<APP_VERSION>`
- `githubGraphql(token, query, variables)`：`POST {base}/graphql`，`Accept: application/json`，走 `githubFetch`。HTTP 200 且 `errors` 含 `RATE_LIMITED` → 503 `github_rate_limited`。`errors` **全部**为路径级 `FORBIDDEN` / `NOT_FOUND` → 丢掉对应节点，不当硬失败，**且该 kind `truncated: true`**。其它 `errors` → 502 `github_error`。`data` 为 JSON 对象才解析。REST 单仓 403/404 跳过时同样 `truncated: true`。
- GraphQL 分页：`first: 100`，直到 `hasNextPage` 为假或本请求 GitHub 次数用尽。REST 列表：`per_page=100`，同样直到没有下一页或次数用尽。用尽时当前 kind `truncated: true`。
- 空成功体：HTTP **205**（以及 204）视为成功，不按 JSON 解析。notifications 的 PATCH/PUT 走这条。其它 2xx 若声明 JSON 却非 JSON → 502 `github_error`。

状态映射：GitHub 401 → 401 `github_unauthorized`。429 → 503。HTTP 403 且 `X-RateLimit-Remaining` 为 `0`，或 body 表明 rate limit → 503 `github_rate_limited`。5xx / 422 / 应 JSON 却非 JSON → 502 `github_error`。单仓 traffic/security/alerts 的 403/404：写入 03 的 `forbidden` / `unavailable`，不把整次 refresh 打成 403。其它 403 → 403 `github_forbidden`。单仓 **任意** kind（details/actions/traffic/security/issues/prs/releases/languages/contributors）GitHub 404，以及 `PATCH /notifications/threads/{id}` 的 404 → 404 `not_found`（不写该 kind / 不写快照）。跨仓列表里单项 404 跳过该项。

L1：注入 fake fetch；setup 默认 fetch throw（`network denied in L1`）。

---

## 7. PAT 信封

`src/server/lib/token-crypto.ts`。AES-256-GCM。

- 只接受 classic PAT：`^ghp_[A-Za-z0-9]{36}$`。`github_pat_` 或其它 → 400 `validation_failed`。
- `TOKEN_ENCRYPTION_KEY_CURRENT` 为十进制整数（如 `"1"`）。密钥字节：32 字节，secret 为 64 hex 或 32 字节标准 base64。
- IV：每次加密 12 字节 `crypto.getRandomValues`，禁止复用。
- Web Crypto `AES-GCM` 的 encrypt 结果是 **密文 ‖ 16 字节 tag**。拆信封：`tag` = 末 16 字节，`ct` = 其余部分。二者与 `iv` 均用标准 base64（非 URL）。解密时先 `ct ‖ tag` 再 `decrypt`。`ct` **不含** tag。
- 信封：`{"v":1,"iv":"<b64>","ct":"<b64>","tag":"<b64>"}`，写入 `token_ciphertext`。
- 解密用行上 `key_version` 选 `TOKEN_ENCRYPTION_KEY_V<n>`。
- `token_last4`：PAT 最后 4 个字符。
- 必填 scope（录入时 `X-OAuth-Scopes` 必须全部出现）：`repo`、`read:org`、`read:user`、`notifications`。
- `capabilities`：03 的 token 级 boolean，不是仓库权限。

明文 PAT 只允许：本次请求体、解密后的内存、出站 `Authorization`。禁止 D1 明文列、响应、日志、trace。

---

## 8. D1

`schema.sql` **不含** `_test_marker`。L2/L3 runner 在执行 schema 之后另跑 03 的 marker SQL。生产禁止建 `_test_marker`。

访问层只用绑定参数，不用字符串拼 SQL。读/删逻辑 kind 的物理页：`SELECT kind FROM snapshots WHERE account_id=?`，在 JS 里筛 `kind === logical || /^${escapeRegExp(logical)}#\\d+$/.test(kind)`，再按精确 `kind` 绑定读写。禁止 `LIKE` / `GLOB`（`_` 可出现在仓库名里，且 D1 对 LIKE 有长度限制）。

写快照：同一 `DB.batch` 里删除该逻辑 kind 的全部物理行并插入新页。激活：同一 batch 里 `UPDATE … is_active=0` 再 `UPDATE … is_active=1 WHERE id=?`。插入首个账号：`INSERT` 时直接 `is_active=1`，不要先插 0 再改。batch 失败整段回滚，禁止留下半页快照或两个 `is_active=1`。`accounts_one_active` 冲突 → 再读再写一次，仍失败则 500 `db_error`。不得手写双活。

`last_used_at`：只在**已经落库的账号**上、且该次 HTTP 处理**整段成功**时，与其它 D1 写**同一** `DB.batch` 更新（accounts 写入、refresh 最终 batch、notifications 快照 batch）。禁止先提交业务 batch 再单独 UPDATE 时间戳。`GET /user` 成功但缺 scope **不**写。中途 GitHub 失败则本请求不写库。

`createDb(env)` 每请求一次，放入 Hono context，所有 store 复用同一句柄。禁止在 store 内再 `createDb`（否则计数器归零）。

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

- 缺 `kinds` 或 `"all"`：刷新全部跨仓 GitHub kind：`repos`、`issues`、`prs`、`alerts`、`notifications`。
- 数组：只对列出的 GitHub kind 出站，按数组顺序串行。重复 kind → 400 `validation_failed`（不去重）。`issues` / `prs` / `alerts` 需要已有 `repos` 快照，或本次数组**同时含** `repos` 并**先在内存收集** repos（仍不写库直到最终 batch）。否则 409 `snapshot_missing`，**不得**偷偷持久化 repos。
- `all` 的串行顺序固定：`repos` → `issues` → `prs` → `alerts` → `notifications`。同一时刻只收集一个 kind。
- `insights` / `digest` 出现在数组里：不打 GitHub。最终 batch 里：仅当写入或已有的源 kind 均 `truncated === false` 才重算并写派生。源不足：跳过；仅当 kinds **显式**要求该派生且源不足时才 409 `snapshot_missing`。
- `kinds: []`、未知字符串、非法 `repo:` 形状 → 400 `validation_failed`。
- 单仓 kind：`repo:{owner}/{name}:details` 等，与 03 逻辑 kind 一致。`owner`/`name` 各匹配 `^[A-Za-z0-9_.-]+$`，且不是 `.` / `..`。

Token 级 scope：刷新 `notifications` 需要 `capabilities.notifications === true`，否则 409 `capability_missing`（不写库）。其它跨仓 kind 需要 `capabilities.repo === true`。

GitHub 调用（均经请求内 client，计入 40 次上限）。跨仓 `repos` / `issues` / `prs` 用 GraphQL，以便一次拿到 03 所需字段（含 PR 的 `additions`、`deletions`、`reviewDecision`）。

收集结果先放内存。GitHub **硬失败**（401/403-非豁免/429/502 等）→ 本请求 **不写 D1**，直接返回错误信封。次数用尽是成功截断，不是硬失败。调用必须串行。

| 逻辑 kind | 方法 |
|-----------|------|
| `repos` | GraphQL `viewer.repositories(first: 100, affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER])`。跟 REST `affiliation=owner,collaborator,organization_member` 同一集合。有下一页继续，直到没有或次数用尽 |
| `issues` | 把当前 repos 快照（或本轮内存中的 repos）的 `name_with_owner` 按 **字典序** 每 20 个一组。每组 GraphQL `search(type: ISSUE, query: "is:issue is:open repo:o/n …")`，跟 `pageInfo` 直到该组 `hasNextPage` 为假。若 `issueCount`（或等价 total）> 已收集条数，或还有未查询的仓，或次数用尽 → 该 kind `truncated: true`。GitHub search 最多约 1000 条，达到也必须 `truncated: true`。禁止每仓 REST |
| `prs` | 同 issues，query 为 `is:pr is:open repo:…`，节点取 `additions`、`deletions`、`reviewDecision`。同样用 total 与 1000 上限判断 truncated |
| `alerts` | Dependabot：按字典序 **每仓一次** GraphQL `repository(owner, name) { vulnerabilityAlerts(first: 20, after) }`，该仓跟 cursor 直到 `hasNextPage` 为假或次数用尽。某仓未跟完 → alerts `truncated: true`。code scanning：字典序 **前 10** 仓各一次 REST；仓数 > 10 → `truncated: true`。单仓 REST 403/404 或 GraphQL 路径级 FORBIDDEN 跳过该仓。零仓成功 → `unavailable: true`，`truncated` 仍按上规则 |
| `notifications` | REST `GET /notifications?per_page=100`，直到没有下一页或次数用尽 |
| `repo:…:details` | REST `GET /repos/{o}/{n}` |
| `repo:…:actions` | REST `GET /repos/{o}/{n}/actions/runs?per_page=100` |
| `repo:…:traffic` | REST views + clones（2 次） |
| `repo:…:security` | 该仓 GraphQL `vulnerabilityAlerts(first: 20, after)` 跟 cursor；未跟完 → `truncated: true`。加 code scanning REST 1 次 |
| `repo:…:issues` / `:prs` | GraphQL 单个 `repo:o/n`，PR 仍取 additions/deletions/reviewDecision |
| `repo:…:releases` | REST releases |
| `repo:…:languages` | REST languages |
| `repo:…:contributors` | REST contributors |

映射在 `github-map.ts`，字段名对齐 03（snake_case）。

全部目标 kind 收集完（或次数用尽）后 **一次** `DB.batch`：

1. 写入本轮**实际完成**的 snapshots（每个逻辑 kind：删旧页+插新页）。
2. 仅当本轮写入的 `repos` 为 `truncated: false` 时 upsert 当天 `snapshot_days` 并删除 30 天前行。repos truncated 则 **不** 写 `snapshot_days`。
3. 仅当 insights 的三个源（repos/issues/alerts，含 D1 已有且本轮未刷新的）都存在且 `truncated: false` 才写 insights。digest 同理：需要未截断的 repos 以及当天 `snapshot_days`。否则跳过该派生，避免假差量或假 healthy。
4. 更新 `accounts.last_used_at`（与上述语句同一 batch）。

响应：

- 单个 kind（含单独刷新 `insights` / `digest`）：200，body 与对应 GET 成功体相同（含该 kind 的 `truncated`）。
- `"all"` 或多个 kind：

```json
{
  "fetched_at": "<iso>",
  "kinds": ["repos", "issues", "alerts", "insights"],
  "truncated_kinds": ["issues", "alerts"]
}
```

`kinds` 为本轮实际写入的逻辑 kind（**含**本次写入的 insights/digest）。`truncated_kinds` 为本轮 `truncated: true` 的 GitHub kind 数组，可多个；没有则为 `[]`。未开始的 kind 不出现。不内嵌 payload。

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

digest 只对比 `day` 与 UTC 日历昨天的 `snapshot_days`（含 `by_repo`）。无昨天行：`baseline_missing: true`，账号级与每仓 delta 均为 `null`，禁止填 `0`。昨天没有的仓：该仓 delta 为 `null`。

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

`email` 取 JWT `email`；缺省或空 → 401 `access_unauthorized`。`name`：JWT `name` 为非空字符串则用之，否则用 `email`。development stub：`dev@local` / `dev`。不返回 GitHub login。无 GitHub 账号也 200。

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

Body：`{ "id": "<thread id>" }`。`id` 必须匹配 `^[0-9]{1,20}$`，否则 400 `validation_failed`。Origin 必过。无账号 → 409。无 notifications 快照 → 409 `snapshot_missing`，**不**打 GitHub。有快照则 `PATCH /notifications/threads/{id}`（GitHub 已读，成功为 205 空体），再把快照里该 id 的 `unread` 置 `false`。200，body 同 GET notifications。

### `POST /api/notifications/read-all`

无 body。Origin 必过。`PUT /notifications`（GitHub mark all read）。成功 HTTP **205 或 202**（空体或可忽略 body）。无快照 409，不打 GitHub。成功后快照内全部 `unread: false`。200，body 同 GET。

### 未列出的 `/api`

404 `not_found`。已列出路径的其它方法 405。

---

## 12. L1 / L2

L1 必测（注入 DB / fake fetch，无网络、无 wrangler）：

| 模块 | 例子 |
|------|------|
| `token-crypto` | 往返解密；IV 不重复；错 key_version；ct 不含 tag |
| `sanitize` | PAT / Bearer 被剥掉 |
| `githubFetch` | 生产忽略 `GITHUB_API_BASE`；development origin 不匹配不调用 fetch；第 41 次不 fetch；client 按请求创建 |
| `access` | 缺 iss/aud/过期 → 401；production 忽略 fixture JWKS；development+team 不短路；有 nbf 则验 |
| `origin` | 缺头 / 错 Origin → 403；GET 不查 Origin |
| `snapshot-pages` | 切分与组装；单元素过大 `truncated` |
| `digest` | 邻日差量；无昨天 → `baseline_missing` 且 delta `null` |
| `insights` | health 三档与 opportunities |
| `errors` / 路由 | 信封；body 超限 400；未知 `/api` 404；已知路径错误方法 405；`onError` → 500 `internal_error` |
| `createDb` | 第 81 条 statement 不 execute |
| refresh 收集 | 硬失败零写入；search total/1000 → truncated；多 kind 同时 truncated；路径级 FORBIDDEN → truncated 且跳过派生；单独 insights/digest 响应体 |
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
2. 该 Worker 在付费档（subrequest 1000）。免费档不得绑定自定义域。
3. `wrangler.toml`：`workers_dev = false`，`preview_urls = false`，无 `[env.test]`，无 `remote = true`，无 development/test `[vars]`。
4. 生产 D1 `giraffe-db` 已创建，`database_id` 已填真实 UUID；已对**远程**库执行 `schema.sql`（不是 persist 目录）。
5. Secrets：`TOKEN_ENCRYPTION_KEY_V1`、`TOKEN_ENCRYPTION_KEY_CURRENT`、`CF_ACCESS_TEAM_DOMAIN`、`CF_ACCESS_AUD`。
6. 先 `vite build`（阶段 1 可用占位 `dist/client`），再 `wrangler deploy`。
7. 部署后 `GET https://giraffe.hexly.ai/api/live` 不得在无 Access 的匿名请求中返回业务数据（live 本身公开，只含 version/environment/`d1_marker`）。`GET /api/me` 无 JWT 必须 401。

---

## 14. 原子提交步骤

每步：工作区红测 → 最小实现 → pre-commit 绿 → **一次** commit。有 `/api` 之后，push 前 L2 绿。禁止把整阶段打成一次 commit。禁止 `--no-verify`。Commit 信息示例可改，须 Conventional、祈使、≤50 字符。

| # | 提交 | 内容 | 证明 |
|---|------|------|------|
| 1 | `feat: add server env and error helpers` | `env.ts` `errors.ts` `sanitize.ts` | L1 |
| 2 | `feat: add token envelope crypto` | `token-crypto.ts` | L1 往返、IV、ct/tag 拆分 |
| 3 | `feat: add githubFetch origin gate` | `github-client.ts` | L1：不匹配不 fetch；生产忽略 base；第 41 次不 fetch |
| 4 | `feat: add snapshot paging helpers` | `snapshot-pages.ts` | L1 |
| 5 | `feat: add insights and digest math` | `insights.ts` `digest.ts`（含 `by_repo`） | L1 |
| 6 | `feat: add d1 schema and stores` | `schema.sql` 与 `lib/db/*`（含 batch 与 `accounts_one_active`） | L1 用 fake D1 |
| 7 | `feat: add access and origin middleware` | `middleware/*` `access-identity.ts` | L1：development+team 不短路；test 验 iss |
| 8 | `feat: add live api and l2 runner` | Hono、`routes/live.ts`、替换占位 fetch、**实现** `run-e2e.ts` + `tests/api/live.test.ts` | L1 + L2 A/B（仅 live） |
| 9 | `feat: add me endpoint` | `routes/me.ts` | L1 + L2 A/B |
| 10 | `feat: add accounts crud api` | `routes/accounts.ts` | L1 + L2（PAT 非泄漏与信封） |
| 11 | `feat: add snapshot get routes` | 跨仓 GET：repos/issues/prs/insights/alerts/digest（**不含** notifications） | L1 + L2：无快照 409，不打 GitHub |
| 12 | `feat: add refresh for repos` | `refresh.ts` + repos GraphQL 映射 | L2：refresh 响应体为 03 JSON；随后 GET `/api/repos` 200 |
| 13 | `feat: add refresh for issues and prs` | issues/prs GraphQL | L2 GET 200 |
| 14 | `feat: add refresh for alerts` | alerts 收集 | L2 GET 200 |
| 15 | `feat: add digest and insights refresh` | 派生写入 | L2 GET digest/insights |
| 16 | `feat: add notifications snapshot api` | notifications GET + refresh | L2 |
| 17 | `feat: add notification write-through` | PATCH 已读与 read-all | L2；无快照不打 GitHub |
| 18 | `feat: add single-repo details api` | details GET + refresh | L2 |
| 19 | `feat: add single-repo traffic security` | traffic + security | L2 |
| 20 | `feat: add single-repo actions releases` | actions + releases | L2 |
| 21 | `feat: add single-repo issues and prs` | 单仓 issues/prs | L2 |
| 22 | `feat: add languages and contributors` | languages + contributors | L2 |

步骤 8 起 L2 为硬门。步骤 8 不得只交 live 而不交 runner。步骤 10 未绿之前不要做 refresh。步骤 11 先于 refresh，使 409 路径可测；步骤 12 起才出站。每步只引入表格「内容」列的那些路径。

阶段 1 完成线见 02 §10：上表全部接口 L1 + L2 A/B 绿，覆盖率四项 ≥ 95%，无 Client 功能代码。

---

## 15. 禁止

- 新 `/api` 路径或把 409 改成 412
- GET 回源或写 D1
- 只凭 `ENVIRONMENT=development` 短路 Access（必须同时已设 `GITHUB_API_BASE` 且未设 team/aud）
- 每仓 REST 扇出 issues/prs（必须用 GraphQL 聚合）
- `github-client.ts` / `access.ts` 以外的 `fetch`
- Client 或 L3 代码
- 把 fixture PAT 写进仓库非测试路径；L2 fixture 必须是明显假值
- 生产 schema 含 `_test_marker`
- 用 `Host` 做 Access 短路
- Origin 白名单放行 loopback
- 响应或日志出现 PAT / 信封
- 未实现 L2 runner 就合并第一个 `/api` 处理函数
