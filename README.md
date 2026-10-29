<p align="center"><img src="assets/brand/icon-rounded.png" alt="Giraffe" width="128" height="128" /></p>

<h1 align="center">Giraffe</h1>

<p align="center">在个人控制台查看 GitHub 仓库、待办与每日变化。</p>

<p align="center">
  <a href="https://giraffe.hexly.ai">站点</a> ·
  <a href="docs/README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Cloudflare_Workers-Hono-orange" alt="Cloudflare Workers and Hono" />
  <img src="https://img.shields.io/badge/UI-Basalt-black" alt="Basalt" />
</p>

## 这是什么

Giraffe is a personal GitHub console for saved repository, Issue / PR, security and notification snapshots across connected accounts.

Version 0.27.4 completes unavailable security-day cache windows without inventing measurements, chains healthy A/B steps through slow I/O, and reduces D1 round trips. Same-day account reuse and fully cached single-repository refreshes need no upstream requests. Automatic refresh covers all explicitly starred repositories plus this account's unobserved non-fork repositories created during the current Asia/Shanghai day, without automatic starring. Saved reads never collect upstream; analysis and legacy refresh modes remain removed. See the [phase-2 contract](docs/15-unified-refresh.md).

PAT 使用 AES-256-GCM 加密后存入 D1；数据快照以 JSON 保存，未做应用层加密。这是个人部署，获准访问同一部署的人共享其中的账号与快照。

## 功能

- **多账号管理**：添加、更新、切换和删除 classic PAT 账号；同一时间使用一个当前账号，界面仅显示令牌末四位。
- **仓库总览**：列表 / 网格视图、搜索与筛选，以及仓库、Stars、Forks、Issue 指标。
- **跨仓待办**：汇总开放的 Issue 和 PR，跳转到 GitHub 继续处理。
- **单仓详情**：详情、安全、Actions、PR、Issue、Release、流量、语言和贡献者九个页签。
- **Insights 与告警**：按当前快照展示规则分类及 GitHub 安全告警，标明截断、权限不足或数据不可用状态。
- **通知处理**：浏览通知，标记单条或全部已读；这些操作会同步写回 GitHub。
- **Saved observations**: snapshot filters remain read-only. Unified refresh and its daily schedule collect new observations; legacy refresh modes and the analysis page remain removed. Missing evidence remains unavailable rather than zero.
- **机器 API**：`/api/v1/*` 的每个端点都要求固定账号、有限 scope 和有效期的 Bearer Token。Token 在受 Cloudflare Access 保护的网页中管理，有效期最长 90 天，须在到期前轮换；API 支持读取已保存快照及读写通用记录、报告和任务。

可见仓库与告警取决于 PAT 权限及 GitHub API 的返回结果。控制台不是持续运行的监控服务，也不执行独立的代码安全扫描。

## 使用

1. 打开[站点](https://giraffe.hexly.ai)，通过该部署的 Cloudflare Access 访问策略。应用没有单独的注册或登录页。
2. 在「设置」添加 GitHub **classic PAT**，需要 `repo`、`read:org`、`read:user` 和 `notifications` scope。当前不接受 fine-grained PAT。令牌输入框在提交时立即清空。
3. The first account becomes active. Adding or switching an account never silently collects data.
4. View existing saved snapshots, or the empty state when no data is available. Collection is unavailable in this delete-only release.
5. If needed, create a least-privilege, fixed-account API token in settings for an external consumer. Tokens expire within 90 days. Generic machine resources remain available, but Giraffe does not execute or display analysis jobs.

侧栏身份来自 Cloudflare Access。姓名与头像会通过邮箱的 SHA-256 摘要查询 `lizheng.blog` 作者档案，服务不可用时使用身份信息回退。

## 开发

本地使用 Bun 1.4 和 Node.js 22.23.4+。在仓库根目录安装依赖，并首次准备本地环境文件：

```bash
bun install --frozen-lockfile
cp -n dev.vars.example .dev.vars
```

模板中的 `TOKEN_ENCRYPTION_KEY_V1` 是公开示例。录入真实 PAT 前，用 `openssl rand -hex 32` 生成独立密钥并替换该值，保留 `TOKEN_ENCRYPTION_KEY_CURRENT=1`。已有 `.dev.vars` 时保留自己的配置；启动脚本不会覆盖它，也不会替换模板里格式有效的示例密钥。

当前开发入口是 `https://giraffe.dev.hexly.ai`，需要本地 DNS 和受信 HTTPS 反向代理，将该域名指向 `127.0.0.1:7045`。Vite 的 HMR 与写入 Origin 校验都依赖此配置。

```bash
bun run dev
```

该命令初始化本地 D1，并启动 Vite `:7045` 与 Wrangler API 服务 `:37045`。Vite 将 `/api` 转发到 Worker；开发数据库保存在本机 `.wrangler/state`。默认 GitHub API 地址仍是真实的 `api.github.com`。

```bash
bun run typecheck
bun run lint
bun run build
```

构建产物在 `dist/client`；`build` 不包含类型检查。自托管需要准备 D1、生产加密密钥及 Cloudflare Access：保护控制台和除 `/api/v1/*` 外的路径；仅为 `/api/v1/*` 配置 Access bypass，并由 Worker 对该路径的每个请求强制校验 Bearer Token。还需同步修改自定义域名、Access team / audience 与浏览器写入 Origin 白名单。部署配置见 [Server 文档](docs/04-server.md)和 [wrangler.toml](wrangler.toml)。

主要代码位于 `apps/web/src/client`（页面与 ViewModel）及 `apps/web/src/server`（API 与采集）。根目录统一版本、安装、测试和部署。

## 测试

```bash
bun run test                  # 单元测试
bun run test:coverage         # 单元测试及覆盖率报告
bun run test:e2e:api          # 本地 Worker HTTP 测试
bunx playwright install chromium
bun run test:e2e:bdd          # Chromium 浏览器流程
```

HTTP 与浏览器脚本自动准备隔离的本地 D1 和 GitHub stub，不需要真实 PAT、`.dev.vars` 或远程测试资源。API 测试使用 `17045`、`17046`、`17047`，浏览器测试使用 `27045`、`27046`；运行前保持这些端口空闲。请通过上述 runner 启动测试。

浏览器测试使用开发认证分支；线上 GitHub 与真实 Access 登录不在这些脚本的验证范围内。

## 技术栈

| 技术                        | 用途                                |
| --------------------------- | ----------------------------------- |
| TypeScript                  | 页面、Worker 与开发脚本             |
| React、Basalt、Tailwind CSS | 控制台界面与交互                    |
| Recharts                    | 仓库与待办指标图表                  |
| Hono、Cloudflare Workers    | HTTP API、GitHub 请求与静态资源托管 |
| Cloudflare D1               | 账号、加密 PAT 与数据快照           |
| Cloudflare Access           | 部署入口认证与 API 身份校验         |
| GitHub REST / GraphQL API   | 仓库、待办、告警与通知数据          |
| Vite                        | 本地开发与前端构建                  |
| Vitest、Playwright          | 单元、HTTP 与浏览器测试             |

## 文档

- [文档索引](docs/README.md)
- [架构与功能](docs/01-architecture.md)
- [数据 Schema](docs/03-schema.md)
- [Server 设计与部署](docs/04-server.md)
- [Client 设计](docs/05-client.md)
- [品牌资源](assets/brand/README.md)

## 许可证

[MIT](LICENSE)。

## Machine API and external analysis

The Worker and React/Basalt application live in `apps/web`; root Bun scripts,
Wrangler configuration and migrations remain the operational entrypoints. The
machine API reads saved observations and stores externally produced reports,
records and jobs. It does not run local code or model inference. See the
[v1 API contract](docs/11-agent-api.md) and the [complete API reference](docs/api.md)
for bearer authentication, token rotation, evidence and report contracts.
