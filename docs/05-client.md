# 05 — Client 设计

阶段 2 的 Vite SPA 契约。页面、MVVM、控件复用、刷新时机、L1/L3 与原子提交步骤以本文为准。01 第 9 节只是信息架构摘要。HTTP 以 [04](04-server.md) 为准，JSON 以 [03](03-schema.md) 为准，测试分层以 [02](02-quality.md) 为准。

> 返回 [文档目录](README.md)

本文不评估工作量。阶段 2 不改 04 的路径、状态码或快照形状，除非评审强制先改编号文档。不写 Server 新 `/api`。无应用内登录页。

---

## 1. 范围

做：`src/client` Vite + React 19 SPA；只打同源 `/api/*`；用 `@nocoo/basalt@2.0.0-rc.1` 控件拼界面；L1 ViewModel 测试 + 02 §6 三条 L3；产物进 `dist/client`，由已落地 Worker `[assets]` 托管。

不做：平行控件库、本地 vendoring Basalt 源码、shadcn 再拷一份、Next.js、`@cloudflare/vite-plugin`、GitLab、Device Flow、fine-grained PAT、LLM digest、Kanban、Mentions、Dependents、顶层 CI Health、应用内登录 / OAuth / session cookie。

权威冲突时：质量 → 02，表与 JSON → 03，HTTP → 04，页面与刷新时机 → 本文。01 与本文冲突时以本文为准（01 是方向）。

---

## 2. 锁定决策

| 主题 | 决定 |
|------|------|
| 包 | `@nocoo/basalt@2.0.0-rc.1`。从 npm 安装（临时允许的 registry）。禁止把 `../basalt` 源码拷进本仓，禁止 `file:` 依赖，禁止把镜像 URL 写进 `bun.lock` |
| 控件 | 只用该包已发布的控件。根 barrel 没有的走 granular：`@nocoo/basalt/components/*`、`@nocoo/basalt/charts/*`。缺的用 HTML + 已有 Basalt 叶子，不自研第二套 widget |
| 布局语言 | 参考 `/Users/nocoo/workspace/work/whiteboard/intentional-kusto-queries` 的 **壳**，不是拷它的组件。侧栏展开 260px / 收起 68px，`transition-all duration-300 ease-in-out`，sticky flex 子项（不是 `fixed` + spacer）。主区 **ContentIsland** 浮岛。跳过链接。顶栏高 14（`h-14`）面包屑。中文 UI |
| 壳实现 | giraffe 的 `src/client/components/layout/*` **只组合** Basalt：`AppShell` / `AppMain` / `AppSkipLink`（`@nocoo/basalt/components/app-shell`，不在根 barrel）、`Sidebar*` + `ContentIsland`（根 barrel）、`ThemeProvider` / `ThemeToggle` / `LinkProvider`。禁止再写一套 `sidebar-context` |
| 路由 | React Router SPA。路径与 01 §9 一致，见第 8 节。无 `/login` |
| 分层 | MVVM。ViewModel 无 View/DOM/`@nocoo/basalt`/`react-dom` import。薄壳 `src/client/routes/*.tsx` L1 覆盖率豁免 |
| 出站 | 唯一 `fetch` 在 `src/client/lib/api.ts`，URL 必须是相对路径 `/api/...`。G1 `gate:client-fetch` 已扫。禁止打 `api.github.com` |
| 刷新 | GET 不刷新（04）。只由 Client 调 `POST /api/refresh`。时机见第 7 节 |
| PAT | 只出现在设置页输入（提交后清空）、该次请求体。禁止 `localStorage` / `sessionStorage` / 前端包 / 日志 |
| 筛选 | 04 GET 无 filter/sort。列表筛选、排序、网格/列表切换全在 Client ViewModel，不改 API |
| Origin | 生产页源 `https://giraffe.hexly.ai`，与 04 白名单一致。本机 `dev:server` 目标源 `https://giraffe.dev.hexly.ai`。L3 Playwright `baseURL` 为 `http://127.0.0.1:27045`，浏览器会带该 Origin。**04 必须补一条**：Access 短路条件成立时（`ENVIRONMENT=development` 且已设 `GITHUB_API_BASE` 且未设 team/aud），允许 `Origin === new URL(request.url).origin`。这不是把 loopback 写进生产白名单。生产与 `test` 模式不变。该补丁在 Client 功能代码之前、与本文同批 docs 提交之后立刻落地，否则 L3 设置页 POST 必 403 |
| 构建 | Vite 8 + `@vitejs/plugin-react`，`outDir = dist/client`。Tailwind CSS v4，按 Basalt README 顺序 `@source` + `@import "@nocoo/basalt/styles/tailwind"` + `@import "tailwindcss"`。不使用 `@cloudflare/vite-plugin` |
| TS | TypeScript 7 `strict` + `exactOptionalPropertyTypes`。Worker 与 Client 分 tsconfig：Client 加 `DOM`；Worker 继续 Workers types。`tsc --noEmit` 两个都跑 |
| 版本 | `APP_VERSION` 仍来自 `src/lib/version.ts` ← `package.json`。侧栏展示 `v{version}` |

---

## 3. 目标文件

```
src/client/
  main.tsx                         # createRoot；ThemeProvider + LinkProvider + Router
  index.css                        # Basalt Tailwind 入口
  app.tsx                          # 路由表
  components/layout/app-shell.tsx  # 组合 Basalt 壳；含侧栏、岛、顶栏
  lib/navigation.ts                # 导航数据，与渲染分离
  lib/api.ts                       # 唯一 fetch
  lib/errors.ts                    # 04 信封 → 类型
  lib/format.ts                    # 日期、delta、markdown 纯函数
  viewmodels/
    accounts.ts
    repos.ts
    issues.ts
    pulls.ts
    insights.ts
    alerts.ts
    inbox.ts
    digest.ts
    repo-detail.ts
    me.ts
    refresh.ts
  routes/
    repos.tsx
    issues.tsx
    pulls.tsx
    insights.tsx
    alerts.tsx
    inbox.tsx
    digest.tsx
    repo-detail.tsx
    settings.tsx
vite.config.ts
tsconfig.client.json
playwright.config.ts
tests/e2e/                         # L3；由 scripts/run-e2e-bdd.ts 跑
```

`src/client/components/ui/` **不建**。不要本地 Button/Input/Card。01 目录树里的 `components/ui/` 作废。

`src/client/routes/*.tsx` 只绑定 ViewModel 输出到 Basalt 控件。禁止在 route 文件里写 fetch、写筛选算法。

---

## 4. 技术栈

| 层 | 选型 |
|----|------|
| 构建 | Vite 8，`bun run dev:client`（Vite :5173，只给人看；正式本机走 Worker assets） |
| UI | React 19 + React Router |
| 样式 | Tailwind CSS v4 + `@nocoo/basalt/styles/tailwind` |
| 控件 | `@nocoo/basalt@2.0.0-rc.1` |
| 图标 | `lucide-react`（Basalt peer） |
| 图表 | Basalt charts + peer `recharts@^3`（Traffic、Languages） |
| Toast | Basalt `toast` / `Toaster`（根 barrel；底层 sonner） |
| 命令面板 | Basalt `CommandPalette`（⌘K 跳路由） |
| 测试 | Vitest L1（jsdom 或 happy-dom 仅 Client 文件）；Playwright L3 Chromium |

`package.json` 脚本：

- `dev:client` — `vite`
- `build` — `vite build` → `dist/client`
- `test:e2e:bdd` — `scripts/run-e2e-bdd.ts`（阶段 2 起硬门；不再 `phase 1 has no client` 早退）

`dev:server` 已有：缺 `dist/client` 时写占位 `index.html`。阶段 2 起日常开发先 `bun run build` 或 Vite 与 wrangler 分进程。L3 runner **必须**先 `vite build` 再起 wrangler（02 §6）。

---

## 5. 设计语言

参考对象是 kusto dashboard 的壳，控件来自 Basalt。

### 5.1 壳

```
[Skip link]
AppShell (flex h-screen)
  SidebarProvider defaultWidth=260
    Sidebar（收起 w-[68px]，展开 width=260）
      SidebarHeader：标记 + 「Giraffe」+ 版本 pill + 折叠钮
      SidebarNav：第 8 节条目
      SidebarFooter：SidebarUser = GET /api/me 的 name/email；ThemeToggle
    AppMain
      header.h-14：移动端打开钮 + 面包屑（Basalt Breadcrumbs / PageHeader 的 trail）
      右上固定 chrome（pointer-events 隔离，对齐 kusto ShellChrome）：ThemeToggle 已在侧栏则此处不重复
      ContentIsland：页面
Toaster
```

移动端：`SidebarProvider overlay` 或 Basalt `Sheet` 打开同一套 `SidebarNav`。不要自写 overlay 动画。

折叠态只显示图标（`SidebarIconItem`）。展开显示中文标签。

### 5.2 浮岛

Basalt `ContentIsland` 已是 `rounded-[16px] bg-basalt-card … ring-1 ring-basalt-border/40 md:rounded-basalt-island`。不要再包一层自定义 card 当岛。岛内用 `PageHeader`（granular）、`LayerCard`、`StatStrip`、`Toolbar`、`DataTable`。

### 5.3 控件映射（强制）

| 用途 | 控件 | 导入 |
|------|------|------|
| 壳 | `AppShell` `AppMain` `AppSkipLink` | `@nocoo/basalt/components/app-shell` |
| 侧栏 / 岛 | `Sidebar*` `ContentIsland` `SidebarProvider` | `@nocoo/basalt` |
| 顶栏标题 | `PageHeader` | `@nocoo/basalt/components/page-header` |
| 面包屑 | `Breadcrumbs`（若 PageHeader 不够） | `@nocoo/basalt/components/breadcrumbs` |
| 按钮 / 输入 / 字段 | `Button` `Input` `Field` `Label` | `@nocoo/basalt` |
| PAT | `SensitiveInput` | `@nocoo/basalt/components/sensitive-input` |
| 列表 | `DataTable` | `@nocoo/basalt/components/data-table` |
| 空态 | `Empty` | `@nocoo/basalt/components/empty` |
| 统计 | `StatStrip` | `@nocoo/basalt` |
| 卡片 | `LayerCard` | `@nocoo/basalt` |
| 分段（列表/网格、筛选） | `SegmentControl` | `@nocoo/basalt` |
| 页级 tab（单仓） | `Tabs*` | `@nocoo/basalt` |
| 工具条 | `Toolbar` | `@nocoo/basalt` |
| 徽章（health / severity） | `Badge` | `@nocoo/basalt` |
| 头像 | `Avatar*` | `@nocoo/basalt` |
| 确认删除账号 | `ConfirmDialog` / `useConfirm` | `@nocoo/basalt` |
| Toast | `toast` `Toaster` | `@nocoo/basalt` |
| 主题 | `ThemeProvider` `ThemeToggle` | `@nocoo/basalt` |
| Router 链接 | `Link` + `LinkProvider` | `@nocoo/basalt` |
| ⌘K | `CommandPalette*` | `@nocoo/basalt` |
| 复制 digest | `ClipboardText` | `@nocoo/basalt/components/clipboard-text` |
| Traffic | `AreaChart` 或 `LineChart` | `@nocoo/basalt/charts/area` / `line` |
| Languages | `DonutChart` | `@nocoo/basalt/charts/donut` |
| 加载 | `Loader` / `SkeletonLine` | granular / 内部 |

禁止：再引入 shadcn、再包一层 `src/client/components/ui/button.tsx`、用 kusto 的 `cn.ts` / `sidebar-context.tsx`。

品牌标记：不要用 `BasaltMark`（那是 Basalt 自己的山标）。用 `lucide-react` 的 `Giraffe` 不存在则用 `Binoculars` 或简单 SVG 放 `src/client/components/layout/mark.tsx`，仅此一个非 Basalt 图形。

---

## 6. MVVM 与 API 客户端

### 6.1 ViewModel

每个 `src/client/viewmodels/*.ts`：

- 导出纯函数：把 03 JSON + UI 状态（query、sort、view）变成渲染用的 plain object。
- 可导出 `useXViewModel()`：只依赖 `react`（`useState` / `useCallback` / `useMemo`）和 `../lib/api.ts`。
- **禁止** import：`react-dom`、`@nocoo/basalt`、`*.tsx`、`document` / `window`（测 clipboard 的纯函数只返回字符串，真正写剪贴板在 route 里调 Basalt `ClipboardText`）。
- L1 测纯函数；hook 用 mock 掉的 `api.ts`。不启 Worker。

### 6.2 `api.ts`

```
api.get<T>(path): Promise<T>
api.post<T>(path, body?): Promise<T>
api.delete(path): Promise<void>
```

- `path` 以 `/api/` 开头的相对 URL。`fetch(path, { credentials: "same-origin", headers })`。
- POST/DELETE：`Content-Type: application/json`（有 body 时）。Origin 由浏览器设，代码不得手写 `Origin`。
- 4xx/5xx：解析 04 信封 `{ error: { code, message } }`，抛 `ApiError`。`code` 联合类型列出 04 的 code。响应体不得当 token 用。
- 204：无 JSON。
- 成功 JSON 不得假设存在 `error` 字段。

`src/client/lib/errors.ts` 与 server 的信封对齐，但 **不要** import `src/server`。需要的话把联合类型放 `src/lib/api-error.ts`（前后端可共享纯类型）。默认两份相同的字面量联合，避免为共享而拉 Worker 类型进 Client。

### 6.3 错误 → UI

| code / HTTP | UI |
|-------------|----|
| `access_unauthorized` 401 | 整页说明「未通过 Access」，不跳应用内登录（没有这个页） |
| `account_missing` 409 | 横幅 + 链到 `/settings` |
| `snapshot_missing` 409 | 该页 `Empty` +「刷新」按钮（调第 7 节对应 kind） |
| `origin_forbidden` 403 | toast；开发者看 04 Origin |
| `capability_missing` 409 | toast，说明缺 notifications scope |
| `github_rate_limited` 503 | toast |
| `validation_failed` / `scopes_missing` 400 | 设置页字段错 |
| 其它 5xx | toast `message`（已 sanitize） |

成功写操作：toast 短中文（「已添加账号」「已刷新」）。

---

## 7. 刷新时机

Server 不调度。Client 调用 `POST /api/refresh`。

| 触发 | `kinds` | 随后 |
|------|---------|------|
| 设置页 **成功** `POST /api/accounts`（201） | `["repos"]` | 输入框已空；再 `GET /api/repos`；失败则 toast，仍留在设置页 |
| 工具条「刷新」在跨仓页 | 该页逻辑 kind（repos/issues/prs/alerts/notifications）。Insights 页刷 `["repos","issues","alerts","insights"]`。Digest 页刷 `["repos","digest"]` | 用响应或随后 GET 更新 ViewModel |
| 工具条「刷新」在单仓页 | 当前 tab 对应 `repo:{owner}/{name}:…` | 同上 |
| 进入单仓且该 tab 409 | 自动一次该 kind（避免空壳无法点刷新）。同一 tab 同一 session 不连打 | |
| 路由切换到跨仓页且 409 | **不**自动刷新（设置页是唯一「从零到有」入口，L3 依赖「提交 PAT → 刷 repos」） | Empty + 按钮 |
| 轮询 / focus / interval | **不做** | |

`kinds: "all"` 只给设置页一个显式「刷新全部」按钮，不在每次导航触发。单次 `githubFetch` ≤ 40（04）；Client 不得并发两个 refresh。进行中按钮 disabled + Basalt `Loader`。

刷新请求必须带浏览器 Origin。失败零写入（04）；Client 不得把部分结果当成成功。

---

## 8. 页面

中文。侧栏顺序固定。

| 路由 | 侧栏 | 图标（lucide） | 读 | 刷新 kind |
|------|------|----------------|----|-----------|
| `/` | 仓库 | `Warehouse` 或 `Box` | `GET /api/repos` | `repos` |
| `/issues` | Issues | `CircleDot` | `GET /api/issues` | `issues` |
| `/pulls` | Pull Requests | `GitPullRequest` | `GET /api/prs` | `prs` |
| `/insights` | Insights | `Activity` | `GET /api/insights` | 见 §7 |
| `/alerts` | 安全告警 | `ShieldAlert` | `GET /api/alerts` | `alerts` |
| `/inbox` | 通知 | `Inbox` | `GET /api/notifications` | `notifications` |
| `/digest` | 日报 | `Newspaper` | `GET /api/digest` | 见 §7 |
| `/repos/:owner/:name` | （钻取，侧栏不高亮新项） | — | 按 tab GET 单仓 | 该 tab kind |
| `/settings` | 设置 | `Settings` | `GET /api/accounts`、`GET /api/me` | 见 §7 |

未知路径：岛内 404 文案，不调用 API。

### 8.1 `/` 仓库

`PageHeader` 标题「仓库」。`Toolbar`：搜索（name/description）、`SegmentControl` 列表 | 网格、排序（star / push 时间 / name）。

列表：`DataTable` 列 = 仓库、语言、★、fork、open issues、最近 push、可见性、health（若 insights 已有则显示，没有则不加列，不为此自动刷 insights）。

网格：`LayerCard` 卡，点整卡进 `/repos/:owner/:name`。

字段用 03 `repos[]`。`truncated: true` 时 PageHeader 下 `Badge`「已截断」。

空数组且有快照：`Empty`「没有仓库」，不是 409。

### 8.2 `/issues` `/pulls`

跨仓表。列：仓、编号、标题（外链 `url`，`target=_blank`）、作者、更新时间；PR 另加 draft、review、+add/−del。Client 侧按仓 / 标题过滤。不改 GET query。

### 8.3 `/insights`

按 `health`：`strong` / `watch` / `risky` 分三组或 Segment 过滤。`opportunities`、`alerts` 数组展示为列表。数字与 03 一致，Client 不算 health。

### 8.4 `/alerts`

`unavailable: true` → Empty「无权限」。否则 `StatStrip`（Dependabot / code scanning open）+ 表（仓、source、severity、summary 外链）。

### 8.5 `/inbox`

表：未读、仓、title、reason、时间。行内「已读」→ `POST /api/notifications/read` `{ id }`（id 为数字字符串）。工具条「全部已读」→ `POST /api/notifications/read-all`。无快照 409 不打 GitHub（04）。成功后 body 即新 notifications 快照，ViewModel 替换。

### 8.6 `/digest`

`StatStrip`：stars / forks / open issues 的 delta。`baseline_missing` → 文案「没有昨天的基线」，delta 显示「—」不得显示 0。`ClipboardText` 复制 Markdown。Markdown 由 `viewmodels/digest.ts` 纯函数生成（仓表 + 合计），**无** LLM。

### 8.7 `/repos/:owner/:name`

`owner`/`name` 校验同 04（`^[A-Za-z0-9_.-]+$`，不是 `.`/`..`），非法 → 岛内校验错误，不请求。

`Tabs`：概览、Security、Actions、PRs、Issues、Releases、Traffic、Languages、Contributors。默认概览。

| Tab | GET | 要点 |
|-----|-----|------|
| 概览 | `.../:owner/:name` | 描述、★、fork、issues、默认分支、license、外链 GitHub |
| Security | `/security` | `unavailable` 空态；否则 open 计数 |
| Actions | `/actions` | runs 表，conclusion Badge |
| PRs / Issues | `/prs` `/issues` | 同跨仓列，无仓列 |
| Releases | `/releases` | tag、时间、prerelease |
| Traffic | `/traffic` | `forbidden` → Empty「无 Traffic 权限」；否则 views/clones `StatStrip` + 面积图 |
| Languages | `/languages` | Donut，字节数 |
| Contributors | `/contributors` | Avatar + login + contributions |

侧栏「仓库」在钻取时保持祖先高亮。

### 8.8 `/settings`

`PageHeader`「设置」。`GET /api/me` 展示 Access 身份（非 GitHub）。

账号表：login、avatar、`token_last4`、scopes、是否当前。无 token 列。

添加：`SensitiveInput`（`revealLabel`/`hideLabel` 中文），提交 `POST /api/accounts` `{ token }`。**无论成功失败都清空输入**（L3 断言成功路径清空；失败路径同样清空以免 PAT 留在 DOM）。成功 201 后按 §7 刷 `repos`。

`POST /api/accounts/:id/activate` 切换当前。`DELETE` 经 `ConfirmDialog`。删除当前账号后快照页将 409 `account_missing`。

classic PAT 形态提示；缺 scope 的 `scopes_missing` 展示在字段下。

---

## 9. 导航数据

`src/client/lib/navigation.ts` 只导出数据：

```ts
export type NavItem = { href: string; label: string; icon: string /* lucide name */ };
export const NAV_ITEMS: readonly NavItem[];
export function breadcrumbsFor(pathname: string): { href: string; label: string }[];
```

图标组件在 layout 里用 `ICON_MAP` 映射。`navigation.ts` 不 import `lucide-react`（避免 ViewModel/数据层绑图标实现；layout 属于 View）。

⌘K：`CommandPalette` 列出 `NAV_ITEMS` + 当前账号仓库名（若 repos 快照已在内存）。没有快照则只有静态路由。

---

## 10. L1 / L3

### 10.1 L1

覆盖率四项 ≥ 95%。`include` 含 `src/client/**`。`exclude`：`src/client/routes/*.tsx`、`**/*.test.ts(x)`。layout 组合文件不豁免，因此 layout 里业务分支要薄：折叠态 class 由 Basalt 处理，giraffe layout 尽量无分支。

必测纯函数（mock `api.ts`，`fetch` 在 L1 仍是 throw）：

| 模块 | 例子 |
|------|------|
| `api.ts` | 用注入的 fetch：相对 URL、信封抛 `ApiError`、204、成功无 error 字段 |
| `accounts` | 提交后 token 状态为空串；列表不含 ciphertext |
| `repos` | 搜索/排序/列表|网格；truncated 标记 |
| `issues` / `pulls` | 过滤 |
| `insights` | 按 health 分组 |
| `alerts` | unavailable |
| `inbox` | 已读后 unread false（对返回体归约，不打网） |
| `digest` | `baseline_missing` → markdown 不含假 0；copy 字符串稳定 |
| `repo-detail` | 非法 owner；forbidden traffic；languages 排序 |
| `refresh` | 进行中互斥；409 不自动连刷 |

Client 单测环境：Vitest `environment` 对 `src/client/**` 用 `happy-dom` 或在文件顶 `// @vitest-environment happy-dom`。不得 `import` `src/server`。

### 10.2 L3

02 §6 最低三条，本文不可减：

1. 打开 `/settings`，在 PAT 框填 L2 同款 fixture PAT，提交。输入框为空。响应不得在 DOM 留下 PAT。
2. 随后 `/` 仓库列表 **有至少一行**（§7 成功添加后刷 `repos`；GitHub stub 与 L2 套件 A 相同，`octocat/hello-world`）。
3. 点进该仓详情，概览可见描述或名称。

Runner：`scripts/run-e2e-bdd.ts`。先 `vite build`，persist `.wrangler/e2e-pw/`，端口 27045，schema + `_test_marker`，`GET /api/live` 且 `d1_marker=test`，GitHub stub 端口按 02（L3 可与 L2 错开，不得占用 17045）。套件 **只 A**（development 短路）。Playwright Chromium。`baseURL = http://127.0.0.1:27045`。

L3 依赖第 2 节 Origin 补丁。未补丁前不算 L3 绿。

---

## 11. 04 补丁（Client 开工前）

在 `docs/04-server.md` §5 Origin 与 `src/server/middleware/origin.ts`：

- 生产：仅 `https://giraffe.hexly.ai`
- `test`：仅 `https://giraffe.dev.hexly.ai`（L2 套件 B 继续手设该头）
- development **且** Access 短路条件成立：允许 `Origin` 等于 `new URL(request.url).origin`，或 `https://giraffe.dev.hexly.ai`

禁止：生产放行 loopback；用 `Host` / `X-Forwarded-*` 判断。L1 覆盖短路同源允许、生产拒绝 `http://127.0.0.1:27045`。

此补丁是阶段 2 的 **docs+server** 前置，不是新 API。提交信息 `fix: allow same-origin posts in dev`。

---

## 12. 原子提交步骤

每步：工作区红测 → 最小实现 → pre-commit 绿 → **一次** commit。有 Client 之后 L3 在步骤 14 起为硬门（本地 push 前）。禁止整阶段一次 commit。禁止 `--no-verify`。

| # | 提交 | 内容 | 证明 |
|---|------|------|------|
| 0 | `docs: add client design document` | 本文 + docs 索引 | 人工 + Codex signoff |
| 1 | `fix: allow same-origin posts in dev` | 04 + `origin.ts` | L1；L2 套件 A/B 仍绿 |
| 2 | `feat: scaffold vite client toolchain` | Vite、Tailwind、Basalt 依赖、`tsconfig.client.json`、空 `main.tsx` 壳、无业务页 | `bun run build`；G1 client-fetch 仍绿 |
| 3 | `feat: add same-origin api client` | `api.ts` + errors | L1 注入 fetch |
| 4 | `feat: add app shell layout` | layout 组合 Basalt；`navigation.ts`；Router 空岛 | L1 navigation/breadcrumbs |
| 5 | `feat: add settings accounts page` | settings + accounts VM；PAT 清空 | L1 |
| 6 | `feat: add repos list page` | `/` | L1 筛选排序 |
| 7 | `feat: add issues and pulls pages` | `/issues` `/pulls` | L1 |
| 8 | `feat: add insights and alerts pages` | | L1 |
| 9 | `feat: add inbox write-through page` | GET + 已读 | L1 归约 |
| 10 | `feat: add digest page` | markdown 纯函数 | L1 baseline_missing |
| 11 | `feat: add repo detail tabs` | 单仓全部 tab | L1 forbidden/unavailable |
| 12 | `feat: add command palette` | ⌘K | L1 静态项 |
| 13 | `feat: wire refresh toolbar` | §7 互斥 | L1 |
| 14 | `test: add l3 three-path suite` | Playwright + `run-e2e-bdd.ts` | L3 三条 |

步骤 2 不得出现业务 route 的数据逻辑。步骤 5 未绿之前不要做仓库页。步骤 14 未绿不得宣称阶段 2 完成。

阶段 2 完成线见 02 §10：本文页面有 L1，三条 L3 绿，覆盖率四项 ≥ 95%，阶段 1 的 L2/G1/G2 仍绿，无平行控件库。

---

## 13. 禁止

- 在 `api.ts` 以外 `fetch`
- 绝对 URL、`api.github.com`、把 PAT 写入 storage
- import `src/server` 进 Client；Server 测试 import Client
- 复制 Basalt 或 kusto 源码当本仓控件
- GET 触发 refresh（必须用户动作或 §7 写明的 201/单仓 409）
- 应用内 `/login`
- 用 `Host` 做 Origin
- L3 打远程 `giraffe-db` 或真实 GitHub
- 提交红测试、`--no-verify`
- 未 signoff 本文就开始步骤 2 以外的脚手架（步骤 0 的索引改动除外）
