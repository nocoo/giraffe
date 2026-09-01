# 02 — 质量保证

测试、覆盖率、门控与运行时机。功能代码开工前以本文为准。01 第 11 节只是方向摘要。

> 返回 [文档目录](README.md)

本文不评估工作量。接口清单以 04 为准；04 未写成前，阶段 1 的 API 面以 [01 §8](01-architecture.md) 为暂定清单。

---

## 1. 原则

- 正确性只由测试证明，不靠点页面、看日志、看部署是否 200。
- 严格 TDD：先在工作区写失败测试，再最小实现，再重构。红测试**不提交**。禁止 `--no-verify`。
- Server 与 Client 各自可测、可跑。Server 测试不得 `import` `src/client`。Client 单测不得启动 wrangler。
- 阶段 1（Server）完成前不写 Client 功能代码，也没有 Client 测试、没有 L3。
- 测试不得访问 `api.github.com`，不得连接远程 `giraffe-db`，不得使用开发者本机 `.dev.vars`。

---

## 2. 总表

| 维 | 命令 | 时机 | 时限 | 阶段 1 | 阶段 2 |
|----|------|------|------|--------|--------|
| L1 | `bun run test:coverage` | pre-commit | <30s | Server 单测 | Server + Client 单测 |
| L2 | `bun run test:e2e:api` | **pre-push**（不进 pre-commit） | <3min | 全部 `/api` 真 HTTP | 同左（随 04 增补） |
| L3 | `bun run test:e2e:bdd` | CI / 按需 | — | **N/A** | 核心界面路径 |
| G1 | `typecheck` + `lint` + `gate:test-skip` | pre-commit | 含在 30s 内 | 要 | 要 |
| G2 | `bun run gate:security` | pre-push | 与 L2 并行，合计 <3min | 要（有 lockfile 后） | 要 |
| 隔离 | 见第 8 节 | L2/L3 | — | L2 | L2 + L3 |

`bun run test` 只给人看，**不是**门控。门控必须是 `test:coverage`。

改 API 时：commit 前只需 L1+G1 绿；**push 前**必须 L2 绿。TDD 的「实现到绿」指当前层：纯逻辑到 L1 绿即可 commit；接口行为以 L2 为准，未 push 前必须跑过。

尚无 `/api` 路由时 L2 为 N/A，pre-push 只跑 G2。一旦出现第一个 `/api` 处理函数，L2 立即成为硬门。尚无 `bun.lock` 时 G2 的 osv-scanner 为 N/A。

---

## 3. TDD 与提交

1. 写失败测试（工作区）。
2. 写最小实现直到 `test:coverage` 绿。
3. 按需重构，测试保持绿。
4. 一次逻辑变更一次 commit。commit 必须过 pre-commit。改了 `/api` 则 push 前过 L2。

Hook：

| Hook | 顺序 | 命令 |
|------|------|------|
| pre-commit | G1 → L1 | `bun run typecheck && bun run lint && bun run gate:test-skip && bun run gate:wrangler-vars && bun run gate:github-fetch && bun run test:coverage` |
| pre-push | L2 ‖ G2 | `bun run test:e2e:api` 与 `bun run gate:security` 并行 |
| CI | 阶段 1：G1+L1+L2+G2；阶段 2：再加 L3 | 与本地同一命令 |

`gate:test-skip` 必须扫描 `src/` 与 `tests/`，命中任一则失败，包括链式写法：`.only`、`.skip`、`.todo`、`.fails`、`.runIf`、`.skipIf`、`xtest`、`xdescribe`、`it.todo`、`test.concurrent.todo`。Biome 开启 `noSkippedTests` / `noFocusedTests`（或等价规则）且 `--error-on-warnings`；脚本是双保险。

---

## 4. L1 单元

工具：Vitest 4。覆盖率：**statements、branches、functions、lines 每一项都 ≥ 90%**。任一项低于 90% 即失败。

`vitest` coverage 用 `include: ["src/**/*.{ts,tsx}"]` 把未 import 的生产文件算进分母（Vitest 4 没有 `coverage.all`）。`exclude` 必须包含测试自身：`**/*.test.ts`、`**/*.test.tsx`、`**/__tests__/**`，以及薄壳 `src/client/routes/*.tsx`。不得把测试文件算进分子。`src/server/routes/` 不豁免。

### 必测

| 对象 | 阶段 | 例子 |
|------|------|------|
| 纯函数 | 1 | token 信封加解密、sanitize、digest 邻日差量、快照分页切分 |
| Server 路由处理的纯逻辑 | 1 | 缺 scope → `capability_missing`；无快照 GET → 409 |
| Access JWT 校验 | 1 | 缺 `iss`/`aud`/过期 → 401；非测试 JWKS 不得接受自签 token |
| Client ViewModel | 2 | 不碰 DOM |
| Client 可测组件 | 2 | 交互与状态，不启 Worker |

### 文件位置

- Server：`src/server/__tests__/` 或与模块同目录 `*.test.ts`
- Client：`src/client/**/*.test.ts`（阶段 2）
- 共享：`src/lib/**/*.test.ts`

L1 禁止：网络、真实 D1、真实 GitHub、启动 wrangler。`vitest` setup 默认把 `fetch` stub 成 throw（`network denied in L1`）。github-client 测试可注入 fake fetch，不得走真实网络。

---

## 5. L2 API

真 HTTP。对象是跑起来的 Worker，不是 `app.request()` 冒充。

### 5.1 Runner 隔离目录

禁止在仓库根对 wrangler 使用开发者的 `.dev.vars`。

Runner 必须：

1. 建临时目录（例如 `.wrangler/e2e-run/`），把 `wrangler.toml` 拷进去；`src/` 与 schema 文件（`src/server/lib/db/schema.sql` 或 `migrations/`，以 03 为准）必须能从该目录解析。
2. persist 使用**仓库根绝对路径** `.wrangler/e2e/`（L3 为 `.wrangler/e2e-pw/`），不要写成相对临时 cwd 的嵌套路径。
3. **只**用 runner 写的 `--env-file` 注入 fixture。L2/L3 **不写、不读** `.dev.vars`。本机 `dev:server` 才用 `.dev.vars`。仓库根 `.dev.vars` 不得传给 E2E wrangler。
4. Wrangler `--config` 指向拷贝的 toml，`--persist-to` 为绝对路径。

Fixture 至少：

```
ENVIRONMENT=
TOKEN_ENCRYPTION_KEY_CURRENT=1
TOKEN_ENCRYPTION_KEY_V1=<32 字节全 0 的 hex>
GITHUB_API_BASE=http://127.0.0.1:17046
CF_ACCESS_TEAM_DOMAIN=http://127.0.0.1:17047
CF_ACCESS_AUD=giraffe-e2e
ACCESS_JWKS_URL=http://127.0.0.1:17047/cdn-cgi/access/certs
```

`ENVIRONMENT`：套件 A 为 `development`，套件 B 为 `test`，生产为空或 `production`。

生产（空/`production`）**忽略** `GITHUB_API_BASE` 与 `ACCESS_JWKS_URL`。G1 检查 `wrangler.toml` 不得出现这两项，也不得出现 `ENVIRONMENT=development` 或 `ENVIRONMENT=test`。L1 覆盖：生产模式下即使注入这两项也不改 JWKS、不改 GitHub origin。

### 5.2 生命周期

`try/finally`：任何失败、超时、信号都要杀掉 wrangler 与 stub，释放 17045/17046/17047。

套件 A 与套件 B 的 Worker 环境不同，必须 **起停两次** wrangler，各用一份 env-file。不能在同一进程里改 `ENVIRONMENT`。

每个套件：

1. 临时目录 + 占位 `dist/client/index.html`
2. 清空该套件 persist（可共用 `.wrangler/e2e/`，两次启动之间仍要执行 schema + marker）
3. **先**用仓库根绝对路径执行 schema：`wrangler d1 execute giraffe-db --local --persist-to=<绝对路径> --file=<schema.sql 绝对路径>`（若 03 改为 migrations，则换成 `migrations apply` + 同一绝对 persist）。写入 `_test_marker`
4. 启动 GitHub stub `:17046`、Access JWKS stub `:17047`
5. 启动 wrangler：`--local --persist-to=<绝对路径> --port 17045 --env-file=<该套件文件>`
6. 轮询 `GET /api/live`，60s 超时。响应必须带 `d1_marker=test`（Worker **经 D1 binding** 读 `_test_marker`）。对不上则失败——禁止 runner 用 CLI 再查同一 SQLite 充当验证
7. 跑该套件测试
8. 停 wrangler，再进入下一套件
9. finally 杀全部进程

GitHub 出站的**唯一**入口是 `githubFetch(env, url)`。比较用 `new URL(url).origin === new URL(base).origin`，不是 hostname 对 origin。

- `ENVIRONMENT` 为 `development` 或 `test`：必须用 `GITHUB_API_BASE`；origin 不匹配则 **throw 且不调用 fetch**
- 生产：忽略 `GITHUB_API_BASE`，origin 只能是 `https://api.github.com`
- L2 runner 未设 `GITHUB_API_BASE` 则失败关闭

G1：除 `github-client` 外禁止 `fetch(`。L1 的 github-client 测试必须 `vi.stubGlobal("fetch")`（或注入 fake fetch），禁止真实网络；覆盖 origin 不匹配 throw。这是强制边界。

端口占用则失败并打印占用方，禁止改打 7045。

### 5.3 两套 HTTP

**套件 A — 功能（可短路 Access）**

- 注入 `ENVIRONMENT=development`（仅该套件 `--env-file`，不是 wrangler.toml `[vars]`，不是 `.dev.vars`）
- GitHub 只允许 `GITHUB_API_BASE`。Worker 禁止在 `GITHUB_API_BASE` 之外发请求。Stub 记请求；套件结束时 `api.github.com` 命中必须为 0
- `GITHUB_API_BASE` 未注入则 Worker 与 runner 都失败关闭，不得默默打 GitHub

每个 04（或 01 §8）**方法+路径**至少：

| 种类 | 要求 |
|------|------|
| 成功路径 | 写类（POST/DELETE）带**允许的 Origin**；状态码与 body 符合契约；必须能在后续 GET 观察到状态变化。GET **不带 Origin** 也必须 200/409（按是否有快照），证明只读不依赖 Origin |
| 契约失败 | **快照类 GET**（repos/issues/prs/insights/alerts/notifications/digest 及单仓 GET）无快照 → 409。`GET /api/live`、`GET /api/me`、`GET /api/accounts` 不在此列。POST **与 DELETE**：缺 Origin → 403；Origin 不在允许列表 → 403。403 **不能**当作该路径唯一用例 |
| 只读 | GET 期间 GitHub stub 请求数为 0，且相关 D1 行（快照 payload / `fetched_at` / accounts）字节级不变 |

PAT `POST /api/accounts` 成功**与失败**路径（400 缺 scope、GitHub stub 401、非法 token）均断言：

- HTTP 响应、错误体、wrangler stdout/stderr 均不含 fixture PAT 明文
- 经 Worker 可读的账号详情 / live 不得含明文
- 成功路径：在 `GET /api/live` 已证明 `d1_marker=test` 之后，用同一绝对 persist 做 `wrangler d1 execute --local --persist-to=<绝对路径>` 读 `token_ciphertext`（不新增 dump API）。值必须是信封 JSON（`iv`/`ct`/`tag`），明文 PAT 不是子串

**套件 B — Access 中间件（真 HTTP）**

- `ENVIRONMENT=test`：必须验 JWT；JWKS 只允许 `ACCESS_JWKS_URL`
- 生产（`ENVIRONMENT` 空或 `production`）**必须忽略** `ACCESS_JWKS_URL`，只信 `CF_ACCESS_TEAM_DOMAIN` 的 JWKS。L1 覆盖「生产模式下 fixture JWKS 被忽略」
- 用 stub JWKS 签发 fixture JWT
- 除明确公开的 `GET /api/live` 外，**每一个**受保护的方法+路径：无 JWT / 坏签名 / 错 `aud` → 401。只测 `/api/me` 不够
- **每一个**受保护方法+路径：合法 fixture JWT 不得 401（允许 200/409/其它业务码）。只给 `/api/me` 发合法 JWT 不够
- 此套件覆盖「中间件是否挂上每一条受保护路由」，不替代套件 A 的业务断言

两套都要跑。缺套件 B 不算 L2 绿。

---

## 6. L3 界面

阶段 2 才有。Playwright，Chromium。

L3 **只跑套件 A**（`ENVIRONMENT=development` Access 短路）。不做套件 B，浏览器不注入 CF Access JWT。隔离目录、`--env-file`、GitHub `githubFetch` 边界与 L2 套件 A 相同。差异：

1. 先 `vite build`，把真实 `dist/client` 放进临时目录（不要占位壳）
2. persist：`.wrangler/e2e-pw/`
3. 端口 27045；同样先执行 schema + marker 再启动
4. 与 L2 相同方式初始化 D1（schema.sql 或 03 指定的 migrations），再轮询 `GET /api/live` 且 `d1_marker=test`
5. finally 清理

最低路径（05 可加，不可减）：

1. 设置页提交 fixture PAT（输入框提交后为空）
2. 仓库列表有数据
3. 进入单仓详情

---

## 7. G1 / G2

**G1**

- `tsc --noEmit`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- `biome check --error-on-warnings .`：0 error、0 warning
- `bun run gate:test-skip`（见第 3 节）
- `bun run gate:wrangler-vars`：`wrangler.toml` 不得含 `GITHUB_API_BASE`、`ACCESS_JWKS_URL`、`ENVIRONMENT=development`、`ENVIRONMENT=test`
- `bun run gate:github-fetch`：除 `github-client` 外不得 `fetch(` 指向 GitHub

**G2**

- `gitleaks`：pre-push 扫将要推送的范围；命中密钥/PAT 形态则失败
- `osv-scanner --lockfile=bun.lock`：已知漏洞非零退出
- fixture 密钥必须是明显假值；gitleaks 允许名单只覆盖该 fixture 路径

---

## 8. 隔离

| 资源 | 生产 | L1 | L2 / L3 |
|------|------|----|---------|
| D1 | 远程 `giraffe-db` | 无 | persist 目录 SQLite；经 Worker binding 读到 `d1_marker=test` |
| GitHub | `https://api.github.com` | 无 | 仅 `GITHUB_API_BASE` stub；未配置则失败关闭 |
| Access | 真 JWT + 真 JWKS | 单测夹具 | 套件 A 可 development 短路；套件 B 真 HTTP + stub JWKS |
| 配置 | 生产 secrets | 无 | runner `--env-file`，不用任何 `.dev.vars` |
| PAT | 用户 classic PAT | 假数据 | fixture |

`wrangler.toml` 禁止 `remote = true`。默认 `bun run dev:server` 也是本地 D1。

---

## 9. 禁止

- 测真实 GitHub 或生产 D1
- GET 触发回源或写库
- 把 `ENVIRONMENT=development` 写进可部署 `[vars]`
- 在仓库根带着开发者 `.dev.vars` 启动 L2/L3 wrangler
- `--var KEY=VALUE`（必须 `KEY:VALUE`）
- 覆盖率门控用 `bun run test`；漏配 `include` 导致未引用文件不进分母
- 提交红测试、`--no-verify`
- Server 测试引用 Client，或 Client 单测启 Worker
- 阶段 1 写 L3 或 Client 测试冒充完成
- 仅用 Origin 403 充当某 POST 的唯一 L2 用例

---

## 10. 阶段完成线

**阶段 1 可宣告完成**，当且仅当：

- 04 列出的全部接口有 L1（该测的逻辑）和 L2 套件 A+B
- `test:coverage` 四项均 ≥ 90%，`include` 含全部生产 `src/`（测试文件与薄壳除外）
- pre-commit / pre-push 命令在干净树上可复现绿
- 无 Client 功能代码

**阶段 2 可宣告完成**，当且仅当：

- 05 列出的页面有 L1 ViewModel/组件测试
- 第 6 节最低 L3 路径绿
- 覆盖率仍四项 ≥ 90%
