# 05 — Client 设计

阶段 2 的 Vite SPA 契约。页面、MVVM、控件复用、刷新时机、L1/L3 与原子提交步骤以本文为准。01 第 9 节只是信息架构摘要。HTTP 以 [04](04-server.md) 为准，JSON 以 [03](03-schema.md) 为准，测试分层以 [02](02-quality.md) 为准。

> 返回 [文档目录](README.md)

本文不评估工作量。阶段 2 不改 04 的路径、状态码或快照形状，除非评审强制先改编号文档。不写 Server 新 `/api`。无应用内登录页。

Codex Sign Off 本文之前，禁止第 12 节步骤 1 及之后（含 Vite 脚手架与任何 `src/client` 功能代码）。步骤 0 仅本文与索引。

---

## 1. 范围

做：`src/client` Vite + React 19 SPA；只打同源 `/api/*`；用 `@nocoo/basalt@2.0.2` 控件拼界面；L1 ViewModel 测试 + 02 §6 三条 L3；产物进 `dist/client`，由已落地 Worker `[assets]` 托管。

不做：平行控件库、本地 vendoring Basalt 源码、shadcn 再拷一份、Next.js、`@cloudflare/vite-plugin`、独立 Vite 开发服务器打 Worker API、GitLab、Device Flow、fine-grained PAT、LLM digest、Kanban、Mentions、Dependents、顶层 CI Health、应用内登录 / OAuth / session cookie。

权威冲突时：质量 → 02，表与 JSON → 03，HTTP → 04，页面与刷新时机 → 本文。01 与本文冲突时以本文为准（01 是方向）。L3 时机以 02 为准：CI / 按需，**不**进 pre-push。

---

## 2. 锁定决策

| 主题 | 决定 |
|------|------|
| 包 | `@nocoo/basalt@2.0.2`。从 npm 安装（临时允许的 registry）。禁止把 `../basalt` 源码拷进本仓，禁止 `file:` 依赖，禁止把镜像 URL 写进 `bun.lock`。岛内表面嵌套见 §5.2 |
| 控件 | 只用该包已发布的控件。根 barrel 没有的走 granular：`@nocoo/basalt/components/*`、`@nocoo/basalt/charts/*`。缺的用 HTML + 已有 Basalt 叶子，不自研第二套 widget |
| 布局语言 | 参考 `/Users/nocoo/workspace/work/whiteboard/intentional-kusto-queries` 的 **壳**，不是拷它的组件。侧栏展开 260px / 收起 68px，`transition-all duration-300 ease-in-out`，sticky flex 子项（不是 `fixed` + spacer）。主区 **ContentIsland** 浮岛。跳过链接。顶栏高 14（`h-14`）面包屑。中文 UI |
| 壳实现 | giraffe 的 `src/client/components/layout/*` **只组合** Basalt：`AppShell` / `AppMain` / `AppSkipLink`、`AppHeader`、`PageHeader`、`SectionRule`（均不在根 barrel）、`Sidebar*` + `ContentIsland`（根 barrel）、`ThemeProvider` / `ThemeToggle` / `LinkProvider`。禁止 `SidebarProvider`、禁止再写一套 `sidebar-context`。`AppMain` 必须传 `tabIndex={-1}`，否则 skip link 无法聚焦 |
| 路由 | React Router SPA。路径与 01 §9 一致，见第 8 节。无 `/login` |
| 分层 | MVVM。ViewModel 无 View/DOM/`@nocoo/basalt`/`react-dom` import。L1 覆盖率豁免：`src/client/routes/*.tsx` 与 `src/client/components/layout/**/*.tsx`（薄壳组合）。`main.tsx` / `app.tsx` 同样豁免（只挂 provider 与路由表） |
| 出站 | 唯一 `fetch` 在 `src/client/lib/api.ts`。G1 `gate:client-fetch` 只接受**字面量**或以 `/api/` 开头的**模板字面量**。因此必须写成 `` fetch(`/api/${resource}`) `` 或 `` fetch(`/api/accounts/${id}/activate`) ``，禁止 `fetch(path)` 变量 |
| 刷新 | GET 不刷新（04）。只由 Client 调 `POST /api/refresh`。时机见第 7 节。进行中互斥见 `viewmodels/refresh.ts` 模块单例 |
| PAT | 只出现在设置页输入（提交后清空）、该次请求体。禁止 `localStorage` / `sessionStorage` / 前端包 / 日志 |
| 筛选 | 04 GET 无 filter/sort。搜索、排序、网格/列表切换全在 Client ViewModel。列表用 Basalt `Table`（`@nocoo/basalt/components/table`），**不用** `DataTable`（其内部自带不可关闭的列头排序，会与 VM 双真相） |
| Origin | 以 04 §5.3 与 02 §6 为准：生产/test 不含 loopback；development Access 短路允许同源 `url.origin`（L3 `:27045`）。步骤 1 实现 `origin.ts`，L1+L2 绿 |
| 构建 | Vite 8 + `@vitejs/plugin-react` + `@tailwindcss/vite`。仓库根 `index.html`（Vite 入口，`src/client/main.tsx`）。`outDir = dist/client`。Tailwind CSS v4，按 Basalt README：`@source` + `@import "@nocoo/basalt/styles/tailwind"` + `@import "tailwindcss"`。不使用 `@cloudflare/vite-plugin` |
| 开发拓扑 | 日常 `bun run dev`：Vite `:7045`（Caddy 域名、HMR），`/api` proxy 到 wrangler `:7046`。不把 Vite 当无 Worker 的可写 API，无 mock。L2/L3 仍 `vite build` + wrangler 托管 `dist/client` |
| TS | TypeScript 7 `strict` + `exactOptionalPropertyTypes`。Worker 与 Client 分 tsconfig：Client 加 `DOM`；Worker 继续 Workers types。`tsc --noEmit` 两个都跑 |
| 版本 | `APP_VERSION` 仍来自 `src/lib/version.ts` ← `package.json`。侧栏展示 `v{version}` |
| L3 时机 | 02：CI / 按需。pre-push 仍是 L2 ‖ G2。步骤 20 实现 runner 与三条路径，不改 husky pre-push |

---

## 3. 目标文件

```
index.html                         # Vite 入口，根目录
logo.png                           # 品牌源图
public/logo-24.png                 # 侧栏
public/logo-32.png                 # favicon
public/apple-touch-icon.png        # Apple touch icon
src/client/
  main.tsx                         # createRoot；ThemeProvider + LinkProvider + Router + Toaster
  index.css                        # Basalt Tailwind 入口
  app.tsx                          # 路由表
  components/layout/app-shell.tsx  # 组合 Basalt 壳；含侧栏、岛、顶栏
  lib/navigation.ts                # 导航数据，与渲染分离
  lib/routes.ts                    # 全部 SPA 路径表；app.tsx 只消费它
  lib/api.ts                       # 唯一 fetch；每个调用站点都是 /api/ 模板字面量
  lib/errors.ts                    # 04 信封 → 类型
  lib/format.ts                    # 日期、delta 纯函数
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
    session.ts                     # activeAccountId + ensureSession
    refresh.ts                     # 模块单例互斥锁 + POST /api/refresh
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
vite.config.ts                     # react + tailwind 插件；outDir dist/client
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
| 构建 | Vite 8 + `@vitejs/plugin-react` + `@tailwindcss/vite`。`bun run dev` 开 HMR |
| UI | React 19 + React Router |
| 样式 | Tailwind CSS v4 + `@nocoo/basalt/styles/tailwind` |
| 控件 | `@nocoo/basalt@2.0.2` |
| 图标 | `lucide-react`（Basalt peer） |
| 图表 | Basalt charts + peer `recharts@^3`（Traffic、Languages） |
| Toast | Basalt `toast` / `Toaster`（根 barrel；底层 sonner） |
| 命令面板 | Basalt `CommandPalette`（⌘K 跳路由） |
| 测试 | Vitest L1（`src/client/**` 用 happy-dom）；Playwright L3 Chromium |

peers：`react` / `react-dom` ^19、`lucide-react`、`recharts` ^3。不用 `DataTable`，因此 **不安** `@tanstack/react-table`。

`package.json` 脚本：

- `dev` — Vite `:7045` HMR + wrangler `:7046`（`/api` proxy）
- `build` — `vite build` → `dist/client`
- `test:e2e:bdd` — `scripts/run-e2e-bdd.ts`（有 `src/client` 后不再 phase-1 早退；失败即非 0。pre-push **不**跑它）

`dev:server` 仍是 wrangler `:7045` 托管 `dist/client`（无 HMR；缺 assets 时写占位 `index.html`）。L3 runner **必须**先 `vite build` 再起 wrangler（02 §6）。

`LinkProvider`：`render` 把 Basalt 的 `{ href, className, children }` 转成 React Router `<Link to={href} className={className}>{children}</Link>`。

---

## 5. 设计语言

参考对象是 kusto dashboard 的壳，控件来自 Basalt。

### 5.1 壳

```
[Skip link → #main-content]
AppShell (flex h-screen)
  Sidebar collapsed 状态（展开 260 / 收起 68；不要 SidebarProvider）
    SidebarHeader：标记 + 「Giraffe」+ 版本 pill + 折叠钮
    SidebarNav：第 8 节条目
    SidebarFooter：SidebarUser = GET /api/me 的 name/email/`avatar`（lizheng.blog）
  AppMain tabIndex={-1}
    AppHeader h-14：移动端打开钮 + 祖先面包屑 + 当前页名；右侧 GitHub 外链 + ThemeToggle
    island wrap px-2 pb-2 md:px-3 md:pb-3
      ContentIsland：PageHeader 然后卡片
Toaster
```

移动端：省略 in-flow 侧栏，同一套 `Sidebar` 放进左侧 `Sheet`（始终 `collapsed={false}`）。不要自写 overlay 动画。普通壳不要 `SidebarProvider`（那是 peek / overlay / resize 用的）。

折叠态只显示图标（`SidebarIconItem`）。展开显示中文标签。

### 5.2 浮岛与四层亮度

Basalt `ContentIsland` 已是 L1 岛。不要再包一层自定义 card 当岛。页面在岛内按 [INTEGRATION §13–15](https://github.com/nocoo/basalt/blob/main/INTEGRATION.md) 嵌套。`AppHeader.title` 是顶栏当前页（`text-sm`）；`PageHeader.title` 是岛内内容标题（`text-2xl`）。二者可以同词，角色不同。禁止自写第二套页头。`AppHeader` 已有面包屑时，`PageHeader` 不要再传 `breadcrumbs`。禁止手写 `bg-card` / `bg-muted` 井。

| 层 | 何处 | 油漆 |
|---|---|---|
| L0 | `AppShell` | `bg-basalt-background` |
| L1 | `ContentIsland` | `--basalt-card` |
| L2 | 岛上第一张 `LayerCard` | `--basalt-secondary` |
| L3 | `LayerCard.Well`（`Primary` 是别名） | `--basalt-bright` |

配方：

- 每页先 `PageHeader`（flush，不包卡）。短筛选放 `actions`（刷新/创建最后）；两个及以上筛选放 `filters`。
- 分区用 `SectionRule`。卡片标题留在 `LayerCard.Header`。
- 非结构砖（网格仓卡、KPI）：岛上裸 `LayerCard padding="md"`，不要 Header/Body。
- 表单 / 身份：`Header` + `Body`（控件留在 L2）。`Secondary` 是 `Header` 别名。
- 列表 / 表：表只进 `LayerCard.Well className="p-0"`。`SegmentControl` 的 `legend` 只给读屏（`sr-only`）。
- 空态用 `LayerCard.Empty`，仍在 `Well` 里。
- `Table`、列表、图表 **不得** 直接做 `ContentIsland` 的子节点。
- `StatStrip` 自己已是 muted 砖，不要再套一层 `LayerCard`。

### 5.3 控件映射（强制）

| 用途 | 控件 | 导入 |
|------|------|------|
| 壳 | `AppShell` `AppMain` `AppSkipLink` | `@nocoo/basalt/components/app-shell` |
| 侧栏 / 岛 | `Sidebar*` `ContentIsland` | `@nocoo/basalt` |
| 顶栏 | `AppHeader` | `@nocoo/basalt/components/app-header` |
| 岛内页头 | `PageHeader` | `@nocoo/basalt/components/page-header` |
| 分区 | `SectionRule` | `@nocoo/basalt/components/section-rule` |
| 按钮 / 输入 / 字段 | `Button` `Input` `Field` `Label` | `@nocoo/basalt`。页级主操作（刷新、提交、激活、全部已读）用默认变体 `bg-basalt-primary`；危险操作用 `destructive`；壳层 / 表头排序用 `ghost`；行内次要用 `secondary` |
| PAT | `SensitiveInput` | `@nocoo/basalt/components/sensitive-input` |
| 列表 | `Table` `TableHeader` `TableBody` `TableRow` `TableCell` | `@nocoo/basalt/components/table`。表头可点排序；行内用 `SlotBarChart` meter、彩色 Badge、GitHub label 色片。不用 `DataTable` |
| 空态 | `Empty` | `@nocoo/basalt/components/empty` |
| 统计 | `StatStrip` | `@nocoo/basalt` |
| 卡片 | `LayerCard` | `@nocoo/basalt/components/layer-card` |
| 分段（列表/网格、筛选） | `SegmentControl` | `@nocoo/basalt` |
| 页级 tab（单仓） | `Tabs*` | `@nocoo/basalt` |
| 工具条 | `Toolbar` | `@nocoo/basalt` |
| 徽章（health / severity） | `Badge` | `@nocoo/basalt` |
| 头像 | `Avatar*` | `@nocoo/basalt` |
| 确认删除账号 | `ConfirmDialog` / `useConfirm` | `@nocoo/basalt` |
| Toast | `toast` `Toaster` | `@nocoo/basalt` |
| 主题 | `ThemeProvider` `ThemeToggle` | `@nocoo/basalt`。实心底叠白字。primary 取 logo 叶子 `#5a8228` → `--basalt-primary: 87 53% 33%`（白字 4.5:1）；`--basalt-heatmap-green-3` 30% 给 success |
| Router 链接 | `Link` + `LinkProvider` | `@nocoo/basalt` |
| ⌘K | `CommandPalette*` | `@nocoo/basalt` |
| 复制 digest | `ClipboardText` | `@nocoo/basalt/components/clipboard-text` |
| Traffic | `AreaChart` 或 `LineChart` | `@nocoo/basalt/charts/area` / `line` |
| Languages | `DonutChart` | `@nocoo/basalt/charts/donut` |
| Insights | `StackedBarChart` `DonutChart` `LineChart` `BarChart` | `@nocoo/basalt/charts/stacked-bar` / `donut` / `line` / `bar` |
| 加载 | `Button loading` | `@nocoo/basalt` |
| 骨架 | 文字用 `SkeletonLine`；行/卡/图/头像用圆角 `SkeletonBlock`（同 Basalt shimmer） | `@nocoo/basalt/components/skeleton-line` + `layout/page-skeleton` |

禁止：再引入 shadcn、再包一层 `src/client/components/ui/button.tsx`、用 kusto 的 `cn.ts` / `sidebar-context.tsx`、用 Basalt `DataTable`。

品牌标记：不要用 `BasaltMark`。侧栏用 `src/client/components/layout/mark.tsx` 读 `/logo-24.png`（源文件根目录 `logo.png`，派生 `public/logo-24.png`）。Favicon 用 `/logo-32.png`。仅此一个非 Basalt 图形。

---

## 6. MVVM 与 API 客户端

### 6.1 ViewModel

每个 `src/client/viewmodels/*.ts`：

- 导出纯函数：把 03 JSON + UI 状态（query、sort、view）变成渲染用的 plain object。
- 可导出 `useXViewModel()`：只依赖 `react`（`useState` / `useCallback` / `useMemo` / `useEffect` / `useRef`）、`../lib/api.ts`、`./refresh.ts`、`./session.ts`。初次 GET 必须先 `ensureSession()`。取消、账号变化后的重载都在这个 hook 的 `useEffect` 里，不进 route、不进 layout。
- **禁止** import：`react-dom`、`@nocoo/basalt`、`*.tsx`、`document` / `window`（clipboard 纯函数只返回字符串，真正写剪贴板在 route 里用 Basalt `ClipboardText`）。
- L1 测纯函数与 `refresh.ts` 锁；hook 用 mock 掉的 `api.ts`。不启 Worker。

### 6.2 `api.ts`

G1 约束下，每个 `fetch` 的 URL 参数必须是 `/api/` 字面量或模板。推荐形态：

```ts
async function send(resource: string, init?: RequestInit): Promise<Response> {
  return fetch(`/api/${resource}`, { credentials: "same-origin", ...init });
}
```

`resource` 不含前导 `/api/`，例如 `repos`、`accounts/${id}/activate`。`` fetch(`/api/${resource}`) `` 的第一段 quasi 为 `/api/`，能过 `gate:client-fetch`。

- GET：无 body。
- POST：有 body 时 `Content-Type: application/json`。Origin 由浏览器设，代码不得手写 `Origin`。
- DELETE：无 body。
- 4xx/5xx：解析 04 信封 `{ error: { code, message } }`，抛 `ApiError`。`code` 联合类型列出 04 的 code。
- 204：无 JSON。
- 成功 JSON 不得假设存在 `error` 字段。

`src/client/lib/errors.ts` 与 server 信封对齐，**不要** import `src/server`。不要为共享而把 Worker 类型拉进 Client。

### 6.3 错误 → UI

| code / HTTP | UI |
|-------------|----|
| `access_unauthorized` 401 | 整页说明「未通过 Access」，不跳应用内登录 |
| `github_unauthorized` 401 | toast「GitHub 认证失败」，设置页可再贴 PAT |
| `github_forbidden` 403 | toast |
| `origin_forbidden` 403 | toast；检查页源 |
| `not_found` 404 | 岛内「未找到」（GitHub 无此仓等）。Client 侧非法 `owner`/`name` 不发请求，展示校验文案，不是 404 |
| `validation_failed` 400 | 设置页或其它字段错；服务端非法 owner 也是这个 code |
| `method_not_allowed` 405 | toast（不应被 UI 走到） |
| `account_missing` 409 | 横幅 + 链到 `/settings` |
| `account_conflict` 409 | toast「账号已切换」+ `ensureSession()`；**不**自动重放该写 |
| `snapshot_missing` 409 | 该页 `Empty` +「刷新」按钮（§7 对应 kind） |
| `capability_missing` 409 | toast，缺 notifications scope |
| `scopes_missing` 400 | 设置页字段错 |
| `github_rate_limited` 503 | toast |
| `github_error` 502 | toast |
| `encryption_misconfigured` / `access_misconfigured` / `db_error` / `internal_error` 500 | toast `message` |
| 其它 | toast `message`（已 sanitize）；未知 code 当 `internal_error` |

成功写操作：`toast.success` 短中文（「已添加账号」「已刷新」）。失败：`toast.error`（`catchLoad` 注入）。刷新钮用 Basalt `Button loading`，不用手写 Loader。

截断成功（HTTP 200 且 `truncated` 或 `truncated_kinds.length > 0`）**不是**错误：Badge「已截断」。再读规则见 §7。

---

## 7. 刷新时机

Server 不调度。Client 只经 `viewmodels/refresh.ts` 调 `POST /api/refresh`。该模块持有**进程内单例**：

- 锁在模块而非 hook。路由卸载不清空锁。
- Client 持有 `activeAccountId`。`ensureSession()`（`viewmodels/session.ts`）在任何快照 GET/refresh **之前每次**调用：`GET /api/accounts`，取 `is_active` 行的 `id`（没有则 `account_missing`）。同一事件循环内可复用这次结果（禁止跨请求长缓存）。若返回的 id 与本地不同：更新 stamp、清空该旧 id 缓存。这样另一 Tab activate 后本 Tab 下一次读不会把新账号数据写入旧缓存。
- `POST /api/accounts` 201：用响应体 `id` **先**写入 `activeAccountId`（若 `is_active`），再入队 refresh。禁止还没 stamp 就刷 repos。
- `POST /api/refresh`、`/api/notifications/read`、`read-all` 的 JSON **必带** `account_id`（当前 stamp）。缺字段 → 400。与 active 不符 → 409 `account_conflict`：只 `ensureSession()` + toast，**不得**自动重放该写操作（避免把原账号的已读施加到新账号）。
- 快照缓存按该 id 隔离；id 变化则清空缓存。
- 入队时盖上当时的 `activeAccountId`，发出的 body 带同一 id。
- **发出前**、**应用 payload 前**、**补读 GET 前**：stamp 必须等于此刻 `activeAccountId`，否则丢弃（含 A 在途切到 B：A 的 body 不得写入 B 缓存，也不得用 B 的身份去补读）。快照 GET / 单 kind refresh 的 body 含 `account_id`（03）：若 ≠ stamp，丢弃并再 `ensureSession()`。这关掉 ensureSession 与随后 GET 之间的 TOCTOU。
- **等价**（同一 stamp + 规范化相同 kinds）合并为同一 in-flight Promise。
- **不等价**且 stamp 仍是当前账号：FIFO 排队。
- activate / 删除当前账号成功后：更新 `activeAccountId`、清空旧 stamp 队列、按 §7 为新账号入队 `["repos"]`（删除导致无 active 则不入队）。
- L1 覆盖：201 先 stamp 再 refresh；合并等价；排队不等价；发出后切换则丢弃 payload 且不补读；activate 清空并补跑。

禁止各页 hook 各自 `useState(refreshing)` 当全局真相。页面只读 `refresh.ts` 的 `inFlight` 标记。

| 触发 | `kinds` | 随后 |
|------|---------|------|
| 设置页 **成功** `POST /api/accounts` 且响应 `is_active === true` | `["repos"]` | 输入已空；再 `GET /api/repos`。`is_active === false`（第二账号）**不** refresh |
| 设置页 **成功** activate | `["repos"]` | 切到新账号后再 GET |
| 跨仓页工具条「刷新」 | 该页 GitHub kind：repos / issues / prs / alerts / notifications。**Insights 页** `["repos","issues","prs","alerts"]`（insights **隐式**派生）。**Digest 页** `["repos"]`（digest **隐式**） | 200 后按 `kinds` 再 GET；见下「派生」 |
| 单仓页工具条「刷新」 | 当前 tab 的 `repo:{owner}/{name}:…` | 同上 |
| 进入单仓且该 tab 409 | 自动一次该 kind。同一 tab 同一 session 不连打 | |
| 路由切换到跨仓页且 409 | **不**自动刷新。Empty + 按钮 | |
| 轮询 / focus / interval | **不做** | |
| 设置页「刷新全部」按钮 | `"all"`（展开为 5 个 GitHub kind，insights/digest 隐式） | 200 后按返回 `kinds` GET |

**禁止**在 Insights/Digest 工具条里**显式**请求 `insights` / `digest`。04：insights 源不足只看 repos/issues 缺失或 truncated；alerts 截断仍写入 insights。digest 仍要未截断 repos。显式派生遇源不足 → 409 且本请求不落库，所以 UI 只用隐式。

HTTP **硬失败**（4xx/5xx，含 409 显式派生）→ 04 零写入；Client 不得把内存里的部分收集当成功。

HTTP **200** 体有两种（04）：

1. **单 kind**（请求数组恰好一项 GitHub 或派生名）：body = 该 kind 的 GET 快照，无 `kinds` 字段。
2. **`"all"` 或多 kind**：`{ fetched_at, kinds, truncated_kinds }`。

`refresh.ts` 归一：

- 单 kind：该 kind 已写入；用 body 更新缓存，不必再 GET 同一 kind。
- 多 kind / all：对 `kinds` 里每一项再 GET。
- 隐式派生补读：**仅当**该派生名没有出现在本轮已写入集合里。已写入集合 = 单 kind 的那一项，或多 kind 的 `kinds`。`insights`：仅当本轮写入含 `issues` 或 `alerts`，或内存已有 issues 快照时才 `GET /api/insights`（04 隐式派生需要 repos+issues；源不足时不 GET，避免必 409）。`digest`：未在集合中且本轮写入含 `repos` 则 `GET /api/digest`（409 保留旧值或 Empty）。单独刷 `alerts` 仍补 GET insights，避免仓库页 health 过期。
- Digest 页请求 `["repos"]`：按单 kind 更新 repos，再因 digest 不在集合中而 GET digest。

`truncated` / `truncated_kinds`：Badge「已截断」，仍是成功。未出现的 kind 保持刷新前快照。不得把 200 当成失败。

单次 `githubFetch` ≤ 40（04）。锁保证不同时两个 refresh。进行中按钮 disabled + `Loader`。

---

## 8. 页面

中文。侧栏顺序固定。

| 路由 | 侧栏 | 图标（lucide） | 读 | 刷新 kind |
|------|------|----------------|----|-----------|
| `/insights` | Insights | `Activity` | `GET /api/insights`，并读已有 `issues` / `prs` 快照 | `["repos","issues","prs","alerts"]` 隐式 insights |
| `/` | 仓库 | `Box` | `GET /api/repos` | `repos` |
| `/issues` | Issues | `CircleDot` | `GET /api/issues` | `issues` |
| `/pulls` | Pull Requests | `GitPullRequest` | `GET /api/prs` | `prs` |
| `/alerts` | 安全告警 | `ShieldAlert` | `GET /api/alerts` | `alerts` |
| `/inbox` | 通知 | `Inbox` | `GET /api/notifications` | `notifications` |
| `/digest` | 日报 | `Newspaper` | `GET /api/digest` | `["repos"]` 隐式 digest |
| `/repos/:owner/:name` | （钻取，侧栏「仓库」高亮） | — | 按 tab GET 单仓 | 该 tab kind |
| `/settings` | 设置 | `Settings` | `GET /api/accounts`、`GET /api/me` | 见 §7 |

未知路径：岛内 404 文案，不调用 API。

### 8.1 `/` 仓库

`PageHeader` 标题「仓库」+ 副标题。`actions`：截断/不完整 Badge 与刷新。`filters`：搜索、`SegmentControl` 排序与列表|网格。排序状态在 VM，点表头调用 VM，不靠 Table 内置排序。

列表：`Table` 列 = 仓库、语言、★、fork、open issues、最近 push、可见性、health（若 insights 已在内存则显示，没有则不加列；只读内存，不 GET、不为此自动刷 insights）。`insights.alerts_incomplete === true` 时 health 旁 Badge「告警不完整」，不得把 `strong` 理解成已扫完全部安全告警。不另 GET alerts 来推断该标记。

网格：`LayerCard` 卡，点整卡进 `/repos/:owner/:name`。

字段用 03 `repos[]`。`truncated: true` 时 PageHeader 下 `Badge`「已截断」。

空数组且有快照：`Empty`「没有仓库」，不是 409。

### 8.2 `/issues` `/pulls`

跨仓表。列：仓、编号、标题（外链 `url`，`target=_blank`）、作者、更新时间；PR 另加 draft、review、+add/−del。Client 侧按仓 / 标题过滤。不改 GET query。

### 8.3 `/insights`

浏览组第一项。不重复仓库全表。用 `SectionRule` 分「工作量 / 审查与节奏 / 健康与活跃」。每区：最多四张 KPI（裸 `LayerCard padding="md"`，主题色 icon，无 Header）+ 两张图卡（一卡一图，无 Header 横线）。不用 `StatStrip`、不用 `LayerCard.Header`。

图表由 ViewModel 从 insights + issues + prs 快照聚合。issues 快照缺失时 Issue 计数回退 `open_issue_count`；prs 缺失时 PR 为 0。空 issues 快照不当回退。Client 仍不算 health。`alerts_incomplete` 时页头 Badge「告警不完整」。GET 409 时 Empty，刷新走 §7。仍 409 仅当 repos 或 issues 不足；不循环自动刷。

### 8.4 `/alerts`

`unavailable: true` → Empty「无权限」。否则 `StatStrip`（Dependabot / code scanning open）+ 表（仓、source、severity、summary 外链）。

### 8.5 `/inbox`

表：未读、仓、title、reason、时间。行内「已读」→ `POST /api/notifications/read` `{ id, account_id }`（id 为数字字符串）。工具条「全部已读」→ `POST /api/notifications/read-all` `{ account_id }`。无快照 409 不打 GitHub（04）。成功后 body 即新 notifications 快照，ViewModel 替换。

### 8.6 `/digest`

`StatStrip`：stars / forks / open issues 的 delta。`baseline_missing` → 文案「没有昨天的基线」，delta 显示「—」不得显示 0。`ClipboardText` 复制 Markdown。Markdown 由 `viewmodels/digest.ts` 纯函数生成（仓表 + 合计），**无** LLM。GET 409 时 Empty；刷新只刷 `repos`。

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

`PageHeader`「设置」。`SectionRule` 分「身份」与「GitHub 账号」。`GET /api/me` 展示 Access 身份与 lizheng.blog 头像（非 GitHub）。

账号表：login、avatar、`token_last4`、scopes、是否当前。无 token 列。

添加：`SensitiveInput`（`revealLabel`/`hideLabel` 中文），提交 `POST /api/accounts` `{ token }`。**无论成功失败都清空输入**。提交中 `Button loading`、输入禁用，防重复提交；文案「正在添加…」（校验并保存）→ 若该账号 `is_active` 再「正在同步…」（§7 刷 `repos`）。成功 201 且 `is_active === true` 才刷 `repos`。第二账号默认非 active，只出现在表里，需用户 activate。

`POST /api/accounts/:id/activate` 切换当前，成功后刷 `repos`。`DELETE` 经 `ConfirmDialog`。删除当前账号后快照页将 409 `account_missing`。

classic PAT 形态提示；缺 scope 的 `scopes_missing` 展示在字段下。

---

## 9. 导航数据

`src/client/lib/navigation.ts` 只导出数据：

```ts
export type NavItem = { href: string; label: string; icon: string /* lucide name */ };
export const NAV_ITEMS: readonly NavItem[];
export function breadcrumbsFor(pathname: string): { href: string; label: string }[];
```

图标组件在 layout 里用 `ICON_MAP` 映射。`navigation.ts` 不 import `lucide-react`。

⌘K：`CommandPalette` 列出 `NAV_ITEMS` + 当前账号仓库名（若 repos 快照已在内存）。没有快照则只有静态路由。

---

## 10. L1 / L3

### 10.1 L1

覆盖率四项 ≥ 95%。`include` 含 `src/client/**`。`exclude`：`src/client/routes/*.tsx`、`src/client/components/layout/**/*.tsx`、`src/client/main.tsx`、`src/client/app.tsx`、`**/*.test.ts(x)`。

必测纯函数（mock `api.ts`，L1 默认 fetch 仍 throw；`api.ts` 自己的测试注入 fake fetch）：

| 模块 | 例子 |
|------|------|
| `api.ts` | 注入 fetch：模板 URL 以 `/api/` 开头、信封抛 `ApiError`、204、成功无 error 字段；refresh/read/read-all 的 body 含 `account_id`；`account_conflict` 不自动重放 |
| `refresh.ts` | 合并等价；排队不等价；账号切换丢弃并补跑；单 kind 200 用 payload；多 kind 再 GET；`["repos"]` 之后 GET digest；硬失败不更新缓存；默认 kinds 不含显式 insights/digest |
| `accounts` | 提交后 token 空串；列表不含 ciphertext；`is_active === false` 不 refresh；activate / delete 归约 |
| `me` | 短路身份字段映射 |
| `repos` | 搜索/排序/列表|网格；truncated 标记 |
| `issues` / `pulls` | 过滤 |
| `insights` | 按 health 分组 |
| `alerts` | unavailable |
| `inbox` | 已读与 **read-all** 后 unread false（对返回体归约） |
| `digest` | `baseline_missing` → markdown 不含假 0 |
| `repo-detail` | 非法 owner 不请求；九个 tab 各绑定正确 GET path；forbidden traffic；unavailable security；languages 排序 |
| `navigation.ts` | breadcrumbsFor `/`、`/repos/o/n`、未知路径 |
| `routes.ts` | 01 §9 九条路径全部在表中；与 NAV_ITEMS href 一致 |
| 命令面板数据 | 静态 NAV_ITEMS；有 repos 缓存时含仓库项 |
| health 展示 | `alerts_incomplete` →「告警不完整」 |
| `session.ts` | 每次 ensureSession 都 GET accounts；201 先 stamp；in-flight 切换丢弃；body.account_id 不匹配则丢弃 |

Client 单测：文件顶 `// @vitest-environment happy-dom` 或 vitest 对 `src/client/**` 设 environment。不得 `import` `src/server`。

`vitest.config.ts` 的 coverage.exclude 必须同步本节豁免，否则步骤 2 的薄壳会把分支覆盖率打穿。

### 10.2 L3

02 §6 最低三条，本文不可减：

1. 打开 `/settings`，在 PAT 框填 L2 同款 fixture PAT，提交。输入框为空。响应不得在 DOM 留下 PAT。
2. 随后 `/` 仓库列表 **有至少一行**（首个账号 201 + `is_active` → 刷 `repos`；GitHub stub 与 L2 套件 A 相同，`octocat/hello-world`）。
3. 点进该仓详情，概览可见描述或名称。

Runner：`scripts/run-e2e-bdd.ts`。先 `vite build`，persist `.wrangler/e2e-pw/`，端口 27045，schema + `_test_marker`，`GET /api/live` 且 `d1_marker=test`，GitHub stub 不得占用 17045。套件 **只 A**。Playwright Chromium。`baseURL = http://127.0.0.1:27045`。

L3 依赖步骤 1 的 Origin 补丁。未补丁前不算 L3 绿。L3 **不是** pre-push 门。

---

## 11. 04 / 02 补丁（步骤 1）

编号文档已与本文对齐的部分（Origin 表、insights 源不足、L1 豁免、L3 Origin）在 Sign Off 前写入 01/02/04。步骤 1 只补实现：

1. `origin.ts`：development Access 短路时允许同源 Origin。L1：短路同源 通过；生产拒绝 `http://127.0.0.1:27045`。L2 A/B 仍绿。
2. insights 派生：alerts 截断/缺失不是源不足；写入 `alerts_incomplete`（03）。仓 403 跳过 → alerts `truncated: true`。改 `collect`/`refresh`/`insights` 并补 L1。
3. 快照外层 `account_id`；refresh/read/read-all **必填** `account_id`：缺 → 400，错 → 409 且零 GitHub、零 D1。

提交拆开，都在 Client 脚手架之前。信息：`fix: allow same-origin posts in dev`、`fix: derive insights when alerts truncated`、`fix: return snapshot account_id`。

---

## 12. 原子提交步骤

每步：工作区红测 → 最小实现 → pre-commit 绿 → **一次** commit。禁止整阶段一次 commit。禁止 `--no-verify`。

本文 Sign Off 之前只允许步骤 0。

| # | 提交 | 内容 | 证明 |
|---|------|------|------|
| 0 | `docs: add client design document` | 本文 + 01/02/04 对齐 | Codex Sign Off |
| 1a | `fix: allow same-origin posts in dev` | `origin.ts` | L1；L2 A/B 绿 |
| 1b | `fix: derive insights when alerts truncated` | refresh/collect 派生 + `alerts_incomplete` + 仓跳过 truncated | L1 |
| 1c | `fix: return snapshot account_id` | GET/单 kind 体含 `account_id`；写请求缺 id → 400、错 id → 409 且零 GitHub 零 D1 | L1+L2 |
| 2 | `feat: scaffold vite client toolchain` | 根 `index.html`、Vite、`@tailwindcss/vite`、React 插件、Basalt 依赖、`tsconfig.client.json`、coverage exclude 同步 02、空 `main.tsx`/`app.tsx`/layout 壳、无业务页 | `bun run build`；G1 client-fetch 绿 |
| 3 | `feat: add same-origin api client` | `api.ts` + errors；`` fetch(`/api/${resource}`) `` | L1 注入 fetch；gate 绿 |
| 4 | `feat: add refresh coordinator` | `session.ts` + `refresh.ts` 单例、stamp、排队、归一 04 两种 200 | L1 互斥/排队/201 stamp/切换丢弃 |
| 5 | `feat: add app shell layout` | layout 组合 Basalt；`navigation.ts`；`routes.ts`；`me.ts`；Router 空岛；`LinkProvider`；`AppMain tabIndex={-1}` | L1 navigation + routes 九路径 + me |
| 6 | `feat: add settings accounts page` | settings + accounts VM；PAT 清空；仅 active/activate 经 refresh.ts 刷 repos | L1 activate/delete |
| 7 | `feat: add repos list page` | `/` | L1 筛选排序 |
| 8 | `feat: add issues page` | `/issues` | L1 |
| 9 | `feat: add pulls page` | `/pulls` | L1 |
| 10 | `feat: add insights page` | 隐式 insights GET | L1 health 分组 |
| 11 | `feat: add alerts page` | `/alerts` 含 unavailable | L1 |
| 12 | `feat: add inbox write-through page` | GET + 已读 + **read-all** | L1 归约 |
| 13 | `feat: add digest page` | markdown 纯函数；刷 repos 后再 GET digest | L1 baseline_missing |
| 14 | `feat: add repo details tab` | 概览 GET | L1 非法 owner |
| 15 | `feat: add repo security and traffic` | security + traffic 空态 | L1 unavailable/forbidden |
| 16 | `feat: add repo actions and releases` | actions + releases 表 | L1 |
| 17 | `feat: add repo issues and pulls` | 单仓 issues/prs | L1 |
| 18 | `feat: add repo languages and contributors` | Donut + 列表 | L1 |
| 19 | `feat: add command palette` | ⌘K 静态项 **与** 内存仓库项 | L1 |
| 20 | `test: add l3 three-path suite` | Playwright + `run-e2e-bdd.ts` | `bun run test:e2e:bdd` 三条；不改 pre-push |

步骤 2 不得出现业务 route 的数据逻辑。步骤 6 未绿之前不要做仓库页。步骤 4 的 refresh.ts 必须先于设置页。步骤 20 未绿不得宣称阶段 2 完成。

阶段 2 完成线见 02 §10：本文页面有 L1，三条 L3 绿，覆盖率四项 ≥ 95%，阶段 1 的 L2/G1/G2 仍绿，无平行控件库。

---

## 13. 禁止

- 在 `api.ts` 以外 `fetch`；`fetch(path)` 变量形式
- 绝对 URL、`api.github.com`、把 PAT 写入 storage
- import `src/server` 进 Client；Server 测试 import Client
- 复制 Basalt 或 kusto 源码当本仓控件；使用 `DataTable`
- GET 触发 refresh（必须用户动作或 §7 写明的 201-active / activate / 单仓 409）
- 显式 refresh `insights` / `digest`（工具条与 bootstrap）
- 应用内 `/login`
- Vite `:5173` 打 Worker 写接口
- 用 `Host` 做 Origin；生产放行 loopback
- L3 打远程 `giraffe-db` 或真实 GitHub
- 把 L3 加进 pre-push
- 提交红测试、`--no-verify`
- 本文未 Sign Off 就开始步骤 1 及之后
