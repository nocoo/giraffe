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

Giraffe 是面向个人的 GitHub 控制台。添加一个或多个账号的 classic PAT 后，可以集中查看仓库、开放的 Issue / PR、安全告警和通知，并比较每天的仓库指标变化。

Worker 从 GitHub 获取数据并保存到 D1，浏览器展示快照及其更新时间。数据按需刷新，没有后台定时采集。Insights 使用仓库活跃度、待办数量和安全告警规则；日报由快照差值计算。

PAT 使用 AES-256-GCM 加密后存入 D1；数据快照以 JSON 保存，未做应用层加密。这是个人部署，获准访问同一部署的人共享其中的账号与快照。

## 功能

- **多账号管理**：添加、更新、切换和删除 classic PAT 账号；同一时间使用一个当前账号，界面仅显示令牌末四位。
- **仓库总览**：列表 / 网格视图、搜索与筛选，以及仓库、Stars、Forks、Issue 指标。
- **跨仓待办**：汇总开放的 Issue 和 PR，跳转到 GitHub 继续处理。
- **单仓详情**：详情、安全、Actions、PR、Issue、Release、流量、语言和贡献者九个页签。
- **Insights 与告警**：按当前快照展示规则分类及 GitHub 安全告警，标明截断、权限不足或数据不可用状态。
- **通知处理**：浏览通知，标记单条或全部已读；这些操作会同步写回 GitHub。
- **每日变化**：按 UTC 日期比较 Stars、Forks 和开放 Issue 数量，支持复制 Markdown；缺少昨天的基线时显示缺失状态。

可见仓库与告警取决于 PAT 权限及 GitHub API 的返回结果。控制台不是持续运行的监控服务，也不执行独立的代码安全扫描。

## 使用

1. 打开[站点](https://giraffe.hexly.ai)，通过该部署的 Cloudflare Access 访问策略。应用没有单独的注册或登录页。
2. 在「设置」添加 GitHub **classic PAT**，需要 `repo`、`read:org`、`read:user` 和 `notifications` scope。当前不接受 fine-grained PAT。令牌输入框在提交时立即清空。
3. 第一个账号会成为当前账号并自动同步仓库；添加后续账号后，手动切换即可同步该账号。删除当前账号后，需要重新选择其他账号。
4. 在目标页面点击刷新以获取新数据。仓库详情中尚无快照的页签首次打开时会尝试加载；平时读取的是已有快照。

侧栏身份来自 Cloudflare Access。姓名与头像会通过邮箱的 SHA-256 摘要查询 `lizheng.blog` 作者档案，服务不可用时使用身份信息回退。

## 开发

本地使用 Bun 1.4 和 Node.js 22.12+。在仓库根目录安装依赖，并首次准备本地环境文件：

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

构建产物在 `dist/client`；`build` 不包含类型检查。自托管需要准备 D1、生产加密密钥和整站 Cloudflare Access，并同步修改自定义域名、Access team / audience 与写入 Origin 白名单。部署配置见 [Server 文档](docs/04-server.md)和 [wrangler.toml](wrangler.toml)。

主要代码位于 `src/client/routes`（页面）、`src/client/viewmodels`（界面数据逻辑）、`src/server/routes`（HTTP 接口）和 `src/server/lib`（GitHub 采集、派生指标与存储）。

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

| 技术 | 用途 |
| --- | --- |
| TypeScript | 页面、Worker 与开发脚本 |
| React、Basalt、Tailwind CSS | 控制台界面与交互 |
| Recharts | 仓库与待办指标图表 |
| Hono、Cloudflare Workers | HTTP API、GitHub 请求与静态资源托管 |
| Cloudflare D1 | 账号、加密 PAT 与数据快照 |
| Cloudflare Access | 部署入口认证与 API 身份校验 |
| GitHub REST / GraphQL API | 仓库、待办、告警与通知数据 |
| Vite | 本地开发与前端构建 |
| Vitest、Playwright | 单元、HTTP 与浏览器测试 |

## 文档

- [文档索引](docs/README.md)
- [架构与功能](docs/01-architecture.md)
- [数据 Schema](docs/03-schema.md)
- [Server 设计与部署](docs/04-server.md)
- [Client 设计](docs/05-client.md)
- [品牌资源](assets/brand/README.md)

## 许可证

[MIT](LICENSE)。
