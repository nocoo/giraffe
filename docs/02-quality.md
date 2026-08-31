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
- 测试不得访问 `api.github.com`，不得连接远程 `giraffe-db`，不得依赖开发者本机 `.dev.vars`。

---

## 2. 总表

| 维 | 命令 | 时机 | 时限 | 阶段 1 | 阶段 2 |
|----|------|------|------|--------|--------|
| L1 | `bun run test:coverage` | pre-commit | <30s | Server 单测 | Server + Client 单测 |
| L2 | `bun run test:e2e:api` | pre-push | <3min | 全部 `/api` 真 HTTP | 同左（随 04 增补） |
| L3 | `bun run test:e2e:bdd` | CI / 按需 | — | **N/A** | 核心界面路径 |
| G1 | `bun run typecheck` + `bun run lint` | pre-commit | 含在 30s 内 | 要 | 要 |
| G2 | `bun run gate:security` | pre-push | 与 L2 并行，合计 <3min | 要（有 lockfile 后） | 要 |
| 隔离 | runner `--local --persist-to` + `_test_marker` + GitHub stub | L2/L3 | — | L2 | L2 + L3 |

`bun run test` 只给人看，**不是**门控。门控必须是 `test:coverage`。

尚无 `/api` 路由时 L2 为 N/A，pre-push 只跑 G2。一旦出现第一个 `/api` 处理函数，L2 立即成为硬门。尚无 `bun.lock` 时 G2 的 osv-scanner 为 N/A。

---

## 3. TDD 与提交

1. 写失败测试（工作区）。
2. 写最小实现直到 `test:coverage` 与相关 L2 绿。
3. 按需重构，测试保持绿。
4. 一次逻辑变更一次 commit。绿提交必须通过将要跑的 hook。

Hook：

| Hook | 顺序 | 命令 |
|------|------|------|
| pre-commit | G1 → L1 | `bun run typecheck` && `bun run lint` && `bun run test:coverage` |
| pre-push | L2 ‖ G2 | `bun run test:e2e:api` 与 `bun run gate:security` 并行 |
| CI | 阶段 1：G1+L1+L2+G2；阶段 2：再加 L3 | 与本地同一命令 |

禁止 `describe.only` / `test.only` / `test.skip` / `xtest`。G1 用静态检查拦（例如 `gate:test-skip`），命中则非零退出。

---

## 4. L1 单元

工具：Vitest 4。覆盖率：**statements / branches / functions / lines 均 ≥ 90%**。四项全部不达标即失败。

### 必测

| 对象 | 阶段 | 例子 |
|------|------|------|
| 纯函数 | 1 | token 信封加解密、sanitize、digest 邻日差量、快照分页切分 |
| Server 路由处理的纯逻辑 | 1 | 缺 scope → `capability_missing`；无快照 GET → 409 |
| Access JWT 校验 | 1 | 缺 `iss`/`aud`/过期 → 401；`ENVIRONMENT` 非 `development` 不得短路 |
| Client ViewModel | 2 | 不碰 DOM |
| Client 可测组件 | 2 | 交互与状态，不启 Worker |

### 豁免

仅 `src/client/routes/*.tsx` 薄壳。必须写进 `vitest` coverage `exclude`。`src/server/routes/` **不豁免**。

### 文件位置

- Server：`src/server/__tests__/` 或与模块同目录 `*.test.ts`
- Client：`src/client/**/*.test.ts`（阶段 2）
- 共享：`src/lib/**/*.test.ts`

L1 禁止：网络、真实 D1、真实 GitHub、启动 wrangler。

---

## 5. L2 API

真 HTTP。对象是跑起来的 Worker，不是 `app.request()` 冒充。

### Runner 契约（`scripts/run-e2e.ts`）

1. 若 `dist/client` 无 `index.html`，写入占位文件。
2. 清空 `.wrangler/e2e/`。
3. 注入（`--var KEY:VALUE`，不读 `.dev.vars`）：
   - `ENVIRONMENT:development`
   - `TOKEN_ENCRYPTION_KEY_CURRENT:1`
   - `TOKEN_ENCRYPTION_KEY_V1:<32 字节 fixture，提交在测试仓库内的固定值>`
4. `wrangler dev --local --persist-to=.wrangler/e2e --port 17045` + 上述 `--var`。
5. apply schema，写入 `_test_marker (env=test)`。marker 不对则退出。
6. 探测 `GET /api/live` 直到就绪，超时 60s 失败。
7. 跑 API 测试。
8. 杀进程，退出码跟测试走。

GitHub：Worker 内必须走 stub（fetch mock / 注入 client）。测试进程探测到对 `api.github.com` 的出站即失败。

### 覆盖

04（或暂定 01 §8）里每一个 **方法 + 路径** 至少一条真 HTTP。包括：

- GET 只读：有快照 200；无快照 409；不写 D1
- `POST /api/refresh` 与其它 POST/DELETE：缺 Origin 或 Origin 不在允许列表 → 403
- PAT 录入：非 classic / 缺必填 scope → 400；成功后响应无 token 明文
- Access：生产逻辑下缺 JWT → 401（L2 用 `ENVIRONMENT:development` 短路，另用单测锁死生产路径）

端口被占用则失败并打印占用方，禁止改打 7045。

---

## 6. L3 界面

阶段 2 才有。Playwright，Chromium。

Runner（可与 L2 分文件，命令 `test:e2e:bdd`）：

1. `vite build`
2. 清空 `.wrangler/e2e-pw/`
3. 与 L2 相同的 `--var` fixture
4. `wrangler dev --local --persist-to=.wrangler/e2e-pw --port 27045`
5. schema + `_test_marker`
6. 跑 spec，杀进程

GitHub stub 与 L2 相同。禁止真实 PAT。

最低路径（05 可加，不可减）：

1. 设置页提交 fixture PAT（输入框提交后为空）
2. 仓库列表有数据
3. 进入单仓详情

---

## 7. G1 / G2

**G1**

- `tsc --noEmit`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
- `biome check --error-on-warnings .`：0 error、0 warning
- 禁止 skip/only 的静态门

**G2**

- `gitleaks`：pre-push 扫将要推送的范围；命中密钥/PAT 形态则失败
- `osv-scanner --lockfile=bun.lock`：已知漏洞非零退出
- 测试 fixture 密钥必须是明显假值（例如全 `0` / 文档声明的 32 字节），并保证 gitleaks 允许名单只覆盖该 fixture 路径

---

## 8. 隔离

| 资源 | 生产 | L1 | L2 | L3 |
|------|------|----|----|----|
| D1 | 远程 `giraffe-db` | 无 | `.wrangler/e2e/` SQLite | `.wrangler/e2e-pw/` SQLite |
| GitHub | 真 API | 无 | stub | stub |
| Access | JWT | 单测夹具 | `ENVIRONMENT:development` | 同 L2 |
| PAT | 用户 classic PAT | 假数据 | fixture，只进请求体 | fixture |

`wrangler.toml` 禁止 `remote = true`。默认 `bun run dev:server` 也是本地 D1。

`_test_marker` 不是给生产用的。L2/L3 在 apply schema 之后、跑用例之前查询 `value=test`，否则拒绝。

---

## 9. 禁止

- 测真实 GitHub 或生产 D1
- GET 触发回源或写库
- 把 `ENVIRONMENT=development` 写进可部署 `[vars]`
- `--var KEY=VALUE`（必须 `KEY:VALUE`）
- 覆盖率门控用 `bun run test`
- 提交红测试、`--no-verify`
- Server 测试引用 Client，或 Client 单测启 Worker
- 阶段 1 写 L3 或 Client 测试冒充完成

---

## 10. 阶段完成线

**阶段 1 可宣告完成**，当且仅当：

- 04 列出的全部接口有 L1（该测的逻辑）和 L2
- `test:coverage` ≥ 90%（四项）
- pre-commit / pre-push 命令在干净树上可复现绿
- 无 Client 功能代码

**阶段 2 可宣告完成**，当且仅当：

- 05 列出的页面有 L1 ViewModel/组件测试
- 第 6 节最低 L3 路径绿
- 覆盖率仍 ≥ 90%
