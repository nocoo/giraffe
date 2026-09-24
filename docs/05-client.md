# 05 — Client 设计

仓库页将“数据更新于”放在页头右侧；列表首列为“参与统计”开关，可见性和归档状态独立成列。开关保存到服务端，作用于所有跨仓统计和软件工厂；管理清单保留禁用仓库以便重新开启。语言圆点、语言分布图、工厂规模地图统一使用 `chart-theme.ts` 的多色色板，已知语言固定映射，其他分类按规范化名称稳定映射，排序和筛选不会改变颜色。

Vite SPA 契约。页面、MVVM、控件复用、刷新时机与 L1/L3 以本文为准；§11–12 保留阶段 2 的历史实施记录。当前全站刷新以 §7 和 [09](09-factory-runs.md) 为准。01 第 9 节只是信息架构摘要。HTTP 以 [04](04-server.md) 为准，JSON 以 [03](03-schema.md) 为准，测试分层以 [02](02-quality.md) 为准。

> 返回 [文档目录](README.md)

本文不评估工作量。阶段 2 不改 04 的路径、状态码或快照形状，除非评审强制先改编号文档。不写 Server 新 `/api`。无应用内登录页。

Codex Sign Off 本文之前，禁止第 12 节步骤 1 及之后（含 Vite 脚手架与任何 `src/client` 功能代码）。步骤 0 仅本文与索引。

---

## 1. 范围

做：`src/client` Vite + React 19 SPA；只打同源 `/api/*`；用 `@nocoo/basalt@2.1.8` 控件拼界面；L1 ViewModel 测试 + 02 §6 三条 L3；产物进 `dist/client`，由已落地 Worker `[assets]` 托管。

不做：平行控件库、本地 vendoring Basalt 源码、shadcn 再拷一份、Next.js、`@cloudflare/vite-plugin`、独立 Vite 开发服务器打 Worker API、GitLab、Device Flow、fine-grained PAT、LLM digest、Kanban、Mentions、Dependents、顶层 CI Health、应用内登录 / OAuth / session cookie。

权威冲突时：质量 → 02，表与 JSON → 03，HTTP → 04，页面与刷新时机 → 本文。01 与本文冲突时以本文为准（01 是方向）。L3 时机以 02 为准：CI / 按需，**不**进 pre-push。

---

## 2. 锁定决策

| 主题 | 决定 |
|------|------|
| 包 | `@nocoo/basalt@2.1.8`。从 npm 安装（临时允许的 registry）。禁止把 `../basalt` 源码拷进本仓，禁止 `file:` 依赖，禁止把镜像 URL 写进 `bun.lock`。岛内表面嵌套见 §5.2 |
| 控件 | 只用该包已发布的控件。根 barrel 没有的走 granular：`@nocoo/basalt/components/*`、`@nocoo/basalt/charts/*`。缺的用 HTML + 已有 Basalt 叶子，不自研第二套 widget |
| 布局语言 | 参考 `/Users/nocoo/workspace/work/whiteboard/intentional-kusto-queries` 的 **壳**，不是拷它的组件。侧栏展开 260px / 收起 68px，`transition-all duration-300 ease-in-out`，sticky flex 子项（不是 `fixed` + spacer）。主区 **ContentIsland** 浮岛。跳过链接。顶栏高 14（`h-14`）面包屑。中文 UI |
| 壳实现 | giraffe 的 `src/client/components/layout/*` **只组合** Basalt：`AppShell` / `AppMain` / `AppSkipLink`、`AppHeader`、`PageHeader`、`SectionRule`（均不在根 barrel）、`Sidebar*` + `ContentIsland`（根 barrel）、`ThemeProvider` / `ThemeToggle` / `LinkProvider`。`AccentProvider` 挂在 `app.tsx`（granular `@nocoo/basalt/providers/accent`）。禁止 `SidebarProvider`、禁止再写一套 `sidebar-context`。`AppMain` 必须传 `tabIndex={-1}`，否则 skip link 无法聚焦 |
| 路由 | React Router SPA。路径与 01 §9 一致，见第 8 节。无 `/login` |
| 分层 | MVVM。ViewModel 无 View/DOM/`@nocoo/basalt`/`react-dom` import。L1 覆盖率豁免：`src/client/routes/*.tsx` 与 `src/client/components/layout/**/*.tsx`（薄壳组合）。`main.tsx` / `app.tsx` 同样豁免（只挂 provider 与路由表） |
| 出站 | 唯一 `fetch` 在 `src/client/lib/api.ts`。G1 `gate:client-fetch` 只接受**字面量**或以 `/api/` 开头的**模板字面量**。因此必须写成 `` fetch(`/api/${resource}`) `` 或 `` fetch(`/api/accounts/${id}/activate`) ``，禁止 `fetch(path)` 变量 |
| 刷新 | GET 只读。唯一入口是软件工厂的持久刷新控制台；其他页面无独立刷新及缺快照自动采集。见 §7 / 09 |
| PAT | 只出现在设置页输入（提交后清空）、该次请求体。禁止 `localStorage` / `sessionStorage` / 前端包 / 日志 |
| 筛选 | 04 GET 无 filter/sort。搜索、排序、网格/列表切换全在 Client ViewModel。列表用 Basalt `Table`（`@nocoo/basalt/components/table`），**不用** `DataTable`（其内部自带不可关闭的列头排序，会与 VM 双真相） |
| Origin | 以 04 §5.3 与 02 §6 为准：生产/test 不含 loopback；development Access 短路允许同源 `url.origin`（L3 `:27045`）。步骤 1 实现 `origin.ts`，L1+L2 绿 |
| 构建 | Vite 8 + `@vitejs/plugin-react` + `@tailwindcss/vite`。仓库根 `index.html`（Vite 入口，`src/client/main.tsx`）。`outDir = dist/client`。Tailwind CSS v4，按 Basalt README：`@source` + `@import "@nocoo/basalt/styles/tailwind"` + `@import "tailwindcss"`。不使用 `@cloudflare/vite-plugin` |
| 开发拓扑 | 日常 `bun run dev`：Vite `:7045`（Caddy 域名、HMR），`/api` proxy 到 wrangler sidecar `:37045`。不把 Vite 当无 Worker 的可写 API，无 mock。L2/L3 仍 `vite build` + wrangler 托管 `dist/client` |
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
  main.tsx                         # createRoot；主题预水合；ThemeProvider + AccentProvider + LinkProvider + Router + Toaster
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
    repo-detail.ts
    me.ts
    session.ts                     # activeAccountId + ensureSession
    factory-runs.ts                 # 持久 run 的启动、控制、只读轮询
    snapshot.ts                     # 带账号校验的只读 GET，无长期快照缓存
  routes/
    repos.tsx
    issues.tsx
    pulls.tsx
    insights.tsx
    alerts.tsx
    inbox.tsx
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
| 控件 | `@nocoo/basalt@2.1.8` |
| 图标 | `lucide-react`（Basalt peer） |
| 图表 | Basalt charts + peer `recharts@^3`（软件工厂、Insights、Traffic、Languages） |
| Toast | Basalt `toast` / `Toaster`（根 barrel；底层 sonner） |
| 命令面板 | Basalt `CommandPalette`（⌘K 跳路由） |
| 测试 | Vitest L1（`src/client/**` 用 happy-dom）；Playwright L3 Chromium |

peers：`react` / `react-dom` ^19、`lucide-react`、`recharts` ^3。不用 `DataTable`，因此 **不安** `@tanstack/react-table`。

`package.json` 脚本：

- `dev` — Vite `:7045` HMR + wrangler `:37045`（`/api` proxy）
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

- 每页先 `PageHeader`（flush，不包卡）。短筛选放 `actions`（刷新/创建最后）；两个及以上筛选放 `filters`。页头右侧按钮与搜索用 `size="sm"`（`h-8`），与标题行、`SegmentControl` 同高。
- 分区用 `SectionRule`。卡片标题留在 `LayerCard.Header`。
- 网格仓卡：岛上裸 `LayerCard padding="md"`，不要 Header/Body。
- 表单 / 身份：`Header` + `Body`（控件留在 L2）。`Secondary` 是 `Header` 别名。
- 列表 / 表：表放进无二次内边距的 `LayerCard.Well` 或 `Body`（`className="p-0"`）。`SegmentControl` 的 `legend` 只给读屏（`sr-only`）。
- 空态用 `LayerCard.Empty`，仍在 `Well` 里。
- `Table`、列表、图表 **不得** 直接做 `ContentIsland` 的子节点。
- KPI 由 `layout/kpi` 统一组合 Basalt `StatCard`，不再手写指标卡。`StatStrip` 只用于已有卡片内部的并列阶段计数，不替代页级 KPI。

### 5.3 控件映射（强制）

| 用途 | 控件 | 导入 |
|------|------|------|
| 壳 | `AppShell` `AppMain` `AppSkipLink` | `@nocoo/basalt/components/app-shell` |
| 侧栏 / 岛 | `Sidebar*` `ContentIsland` | `@nocoo/basalt` |
| 顶栏 | `AppHeader` | `@nocoo/basalt/components/app-header` |
| 岛内页头 | `PageHeader` | `@nocoo/basalt/components/page-header` |
| 分区 | `SectionRule` | `@nocoo/basalt/components/section-rule` |
| 按钮 / 输入 / 字段 | `Button` `Input` `Field` `Label` | `@nocoo/basalt`。页级主操作（刷新、提交、激活、全部已读）用默认变体 `bg-basalt-primary`；危险操作用 `destructive`；壳层 / 表头排序用 `ghost`；行内次要用 `secondary` |
| 搜索 / 筛选 | `InputGroup` / `FilterBar` | granular `components/input-group` / `components/filter-bar`。搜索图标、清空按钮和输入框由共享控件组合；清空后焦点回到输入框 |
| PAT | `SensitiveInput` | `@nocoo/basalt/components/sensitive-input` |
| 列表 | `Table` `TableHeader` `TableBody` `TableRow` `TableCell` | `@nocoo/basalt/components/table`。表头可点排序；行内用 `SlotBarChart` meter、绿色/中性徽章，标签保留文字、不套用上游杂色。不用 `DataTable` |
| 横向内容 | `ScrollArea` | `@nocoo/basalt/components/scroll-area`，`orientation="horizontal"`。宽表放在 Well 内滚动；单仓标签也使用共享滚动区，均有中文可访问名称 |
| 空态 | `Empty` | `@nocoo/basalt/components/empty` |
| 统计 | `StatCard` KPI（主题色 icon）；卡片内阶段计数用 `StatStrip` | `layout/kpi` → `@nocoo/basalt/charts/stat-card`；`@nocoo/basalt/components/stat-strip` |
| 卡片 | `LayerCard` | `@nocoo/basalt/components/layer-card` |
| 分段（列表/网格、筛选） | `SegmentControl` | `@nocoo/basalt` |
| 页级 tab（单仓） | `Tabs*` | `@nocoo/basalt` |
| 工具条 | `Toolbar` | `@nocoo/basalt` |
| 徽章（health / severity） | `CandyBadge` (Basalt `Badge` composition) | Colored candy badges use white labels in both themes. Neutral gray badges retain dark labels; arbitrary GitHub labels use tinted category fills with semantic foreground text. White labels on bright candy fills are an owner-selected visual preference, not a 4.5:1 contrast guarantee. |
| 头像 | `Avatar*` | `@nocoo/basalt` |
| 确认删除账号 | `ConfirmDialog` / `useConfirm` | `@nocoo/basalt` |
| Toast | `toast` `Toaster` | `@nocoo/basalt` |
| 主题 | `ThemeProvider` `ThemeToggle` `AccentProvider` | `ThemeProvider` from the root barrel; `AccentProvider` from `@nocoo/basalt/providers/accent`, with `persist={false}` and `defaultAccent="green"`. Do not override `--basalt-*`. Charts use the package Blue/Pink/Green/Yellow/Gray cycle via `lib/chart-theme`, independently of the control accent. The amber swatch uses `paletteOverrides` (`43 92% 48%` light / `43 92% 60%` dark); yellow chart marks share it through `--color-giraffe-yellow`. Other palette colors stay unchanged. Semantic primary text, actions and focus retain Basalt contrast handling. |
| Router 链接 | `Link` + `LinkProvider` | `@nocoo/basalt` |
| ⌘K | `CommandPalette*` | `@nocoo/basalt` |
| Traffic | `AreaChart` 或 `LineChart` | `@nocoo/basalt/charts/area` / `line` |
| Languages | `layout/donut-chart` | Recharts `Pie` + Basalt `ChartShell` / `ChartLegend` / tooltip；圆环按可用绘图区缩放，避免包默认 48px 半径造成留白 |
| Insights | `StackedBarChart` `LineChart` `BarChart` + 共享环形图组合 | `@nocoo/basalt/charts/stacked-bar` / `line` / `bar`；`layout/donut-chart` |
| 软件工厂 | `Sparkline`、堆叠 `AreaChart`；散点图和树图组合 `ChartFrame` + Recharts | 沿用 Basalt `config`、`tooltip`，显式使用站点绿色图表配色；日历选择和缺失态见 [06](06-software-factory.md) |
| 加载 | `Button loading` | `@nocoo/basalt` |
| 骨架 | 只用 Basalt `SkeletonLine` 铺在 L2 `LayerCard` 上，不进 Well、不自绘深色块。200ms 内加载完成则不展示 | `@nocoo/basalt/components/skeleton-line` + `layout/page-skeleton` |

禁止：再引入 shadcn、再包一层 `src/client/components/ui/button.tsx`、用 kusto 的 `cn.ts` / `sidebar-context.tsx`、用 Basalt `DataTable`。

品牌标记：不要用 `BasaltMark`。侧栏用 `src/client/components/layout/mark.tsx` 读 `/logo-24.png`（源文件根目录 `logo.png`，派生 `public/logo-24.png`）。Favicon 用 `/logo-32.png`。仅此一个非 Basalt 图形。

### 5.4 页面细节

- `PageHeader` 的说明下展示数据更新时间，取当前页面（单仓为当前标签）的 `fetched_at`。不把加载中的其他标签时间当成本标签时间。
- 窄屏顶栏保留导航按钮与祖先面包屑的宽度，面包屑不换行；长的当前页标题沿用 `AppHeader` 的截断行为。
- 统计卡按实际数量均分桌面行，窄屏排两列；奇数张时最后一张占满行。表格标题与描述分主次；Issue / PR 的编号、仓库放在标题下，仓库名可跳到单仓页。
- 搜索与排序放在 `FilterBar`；列表 / 网格切换放在仓库分区。分区显示结果数，搜索无结果与真正无数据使用不同空态，前者有「清除搜索」操作。
- `Table` 保持必要列宽，通过共享 `ScrollArea` 查看完整数据，禁止由卡片裁掉右侧列。数字右对齐且等宽，状态徽章不拆行。
- 图表卡使用 `LayerCard.Header` / `Body`，指标口径收进标题旁的问号。绘图区通过公开 `className` 设置基础高度；同排图卡与文字卡等高拉伸，卡片 Body 填满剩余高度，不在较短卡片下方留空。PR 状态图保留五种可区分的绿色层次、图例和读屏摘要。
- 设置页的 PAT 表单、Access 身份并列展示，窄屏上下排列；已连接账号独立成区。账号删除确认带账号名。
- 通知标记已读时显示 `Button loading`，同一页面的已读操作暂时禁用，成功后应用服务端返回的状态。
- `layout/collection-chrome` 只组合 Basalt 输入和滚动控件，并展示计数与更新时间；`table-chrome` 只组合表格叶子；`kpi` / `chart-brick` 只组合卡片。它们不维护第二套控件样式、API 或筛选逻辑。

### 5.5 字号与可视化规范

卡片标题统一为 Basalt `Text variant="heading"`（16px），正文 14px，说明与辅助文字 13px，KPI 数值 28px，坐标轴最小 12px。`index.css` 的 `--text-xs` 统一辅助字号，不逐卡硬编码 9–11px；页标题和大对话框标题保留各自层级。

优先使用 Basalt 已发布图表。没有等价封装的 Recharts 图必须放进 Basalt `ChartFrame` / `ChartShell`，使用共享坐标轴、网格与 tooltip 配置，不另写布局算法。站点 `chartColor` 从 primary 与中性表面混合出五级绿色，在浅色/深色中都跟随主题；健康风险图、失败与删除变更仍保留有实际意义的警示色。保留可访问摘要、键盘下钻或表格替代；未知值保持为空，不补成已观测的零。筛选组合使用带标签的 Basalt Select，选择和输入使用 Checkbox/Input。

表格单元格桌面为上下 12px / 左右 16px，≤480px 为 10px / 12px。选中行使用 `TableRow variant="selected"` 的 `aria-selected` 与浅绿色底色，行标题与单元格一同高亮。图表鼠标点击不显示浏览器默认蓝框，规则覆盖坐标标签、图例及 Recharts 内层 SVG；键盘 `:focus-visible` 保留 2px 内描绿色轮廓。日历选中/焦点轮廓同样向内，边缘单元格不越界裁切。

`layout/help-tooltip` 只组合 Basalt Button / Tooltip 与问号图标，支持悬停、键盘聚焦、触屏点击、Escape 和外部点击关闭。长指标定义与重复说明放入提示；异常、数据缺失和可执行操作保留在卡片或健康 banner 中，不藏进 hover。图表已有图例/指标时，冗余摘要保留为读屏文字。

Snapshot headers show the saved data timestamp and compact elapsed age, updated locally each minute without fetching data. The factory health strip uses a compact Basalt Banner and wraps on narrow screens; only an active run adds a progress row. Its timestamp comes from the displayed snapshot, never a failed attempt or history record. Mixed publications label it as the snapshot update and retain the notice that repository times differ. Missing optional security coverage is a neutral tip, including on repositories and insights; it remains unknown rather than zero, and detailed collection diagnostics remain available in the refresh console. Required data failures still receive warning feedback. New collection runs remain manual; polling reads saved state and the scheduled Worker resumes existing runs.

软件工厂仓库行不展开多个来源时间戳。末列「数据时间」按钮打开 Basalt Dialog，展示仓库信息/活动数据的准确时间、原统计范围及旧版来源。绝对时间按设备时区格式化到秒，明确时区；距今时长按 `Date.now()` 每秒重算，跨天不丢秒，缺失不补当前时间。计时只随打开的弹窗挂载，关闭后停止，不让表格或图表跟着每秒重绘。日历仍按 UTC 日期汇总。

---

## 6. MVVM 与 API 客户端

### 6.1 ViewModel

每个 `src/client/viewmodels/*.ts`：

- 导出纯函数：把 03 JSON + UI 状态（query、sort、view）变成渲染用的 plain object。
- 可导出 `useXViewModel()`：只依赖 `react`（`useState` / `useCallback` / `useMemo` / `useEffect` / `useRef`）、`../lib/api.ts` 与其他 ViewModel。初次 GET 必须先 `ensureSession()`，响应再校验账号。路由/layout 不直接请求 API。
- **禁止** import：`react-dom`、`@nocoo/basalt`、`*.tsx`、`document` / `window`（clipboard 纯函数只返回字符串，真正写剪贴板在 route 里用 Basalt `ClipboardText`）。
- L1 测纯函数、账号隔离与工厂轮询/操作；hook 用 mock 掉的 `api.ts`。不启 Worker。

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

### Project identity presentation

`viewmodels/project-identity.ts` requests one relative `/api/projects/owner/repo`
endpoint through `api.ts`, deduplicates pending lookups and caches successful
projected metadata in memory for at most one hour. No browser storage or polling
is used. An unavailable identity preserves the repository name and original
snapshot description without a global error banner.

Shared project components display unmasked, unaltered CDN images with fixed
layout dimensions and `object-fit: contain`: 64px icons for 24–32px references,
512px icons for 48px cards/detail headings, and suitable transparent
`project-identity` navigation PNGs for the application mark/favicon. Missing
navigation variants use supplied icons. Campaign artwork is never selected.
Repository cards/details show title, English description, GitHub, optional website,
Hexly detail links and explicit archive status. Secondary repository references
retain owner/repository identity and their existing navigation/selection behavior.
Only `nocoo/giraffe` supplies the application's own mark/title/favicon; navigating
to another repository never changes the application's identity.

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
| `snapshot_missing` 409 | 共享空态「等待统一刷新」+ 前往工厂控制台，不执行采集 |
| `capability_missing` 409 | toast，缺 notifications scope |
| `scopes_missing` 400 | 设置页字段错 |
| `github_rate_limited` 503 | toast |
| `github_error` 502 | toast |
| `encryption_misconfigured` / `access_misconfigured` / `db_error` / `internal_error` 500 | toast `message` |
| 其它 | toast `message`（已 sanitize）；未知 code 当 `internal_error` |

成功写操作：`toast.success` 短中文（「已添加账号」等）。失败：`toast.error`（`catchLoad` 注入）。采集任务的结果统一在工厂控制台显示，不在普通页面另设刷新钮。

读取旧快照的 `truncated: true` 仍显示「已截断」。新工厂刷新若来源截断则保留旧值并报告未完成，不用不完整结果覆盖已有页面快照。

---

## 7. 全站统一刷新

软件工厂是唯一的前端采集入口。`viewmodels/factory-runs.ts` 提交持久 run 与暂停/继续/取消动作，服务端队列执行，D1 保存进度；详细契约见 [09](09-factory-runs.md)。旧 `POST /api/refresh` 仅保留 API 兼容，前端已删除 `refresh.ts` 协调器与独立 RefreshButton。

- Full refresh updates the site catalog, Issues, PRs, security alerts, notifications, Insights and all accessible repository detail tabs. Selected, filtered, stale and failed scopes update only the resolved repositories: nine statistics steps, nine detail tabs and one AI analysis checkpoint each, plus publication. One selected repository is 20 steps; unrelated site snapshots retain their original contents and timestamps. The console labels this phase as repository pages and omits the account-contribution phase. Known manual selections remain available when the full site catalog is incomplete. The AI phase follows the existing background job through Jev judgment and report generation. Unconfigured AI is shown as skipped without a warning; failed analysis does not label collected repository data as lost.
- 首次使用或旧数据升级时先「同步仓库列表」，再「开始刷新」。清单不完整时禁止在界面启动刷新，不能把未扫描的数据当空数组。
- 各页面仅 GET；缺少快照统一使用 `SnapshotPending` 导航至 `/factory?refresh=1`，到达后打开同一个控制台。缺账号则前往设置，不混同于缺数据。
- 添加、激活、删除账号只更新账号状态与本地 stamp，不自动采集。通知标记已读仍是独立的业务写操作，不属于刷新。
- 每次快照读取前 `ensureSession()` 获取当前账号；同一轮并发可复用 in-flight 查询，但不跨请求长期缓存。读取前后及应用响应时都核对 `account_id`，不匹配即丢弃。
- 路由重新挂载时重新 GET 保存的快照，避免后台刷新完成后一直显示旧的内存数据。仓库命令面板缓存仍按账号隔离，不用于代替页面读取。
- 工厂创建/控制、通知 read/read-all 的 body 必带当前 `account_id`。`account_conflict` 只恢复会话并提示，不自动重放任何写操作。
- 工厂只读轮询一次结束后才安排下一次；关闭对话框继续显示页面进度，离开页面不停止服务端任务。其他页面不轮询 GitHub、不在 focus 或缺数据时自动发起刷新。

失败、权限不足、截断在控制台按数据源说明影响和处理方式。每类页面成功后独立替换；失败保留上次保存内容及时间，没有旧数据则继续等待统一刷新。不得用伪造的零值清掉数据。工厂统计的不可变版本、限流等待、冷却和租约防陈旧写入规则见 09。

---

## 8. 页面

中文。侧栏按用途分四组，顺序固定：总览（软件工厂、Insights）、仓库健康（仓库、CI 与发布、安全告警）、待办（Issues、Pull Requests、通知）、系统（设置）。分组与顺序只在 `src/client/lib/navigation.ts` 的 `NAV_GROUPS` 定义，命令面板沿用同一顺序。

| 路由 | 侧栏 | 图标（lucide） | 读 |
|------|------|----------------|----|
| `/factory` | 软件工厂 | `Factory` | `GET /api/factory`、`GET /api/factory/runs`；唯一刷新入口 |
| `/insights` | Insights | `Activity` | `GET /api/insights`，并读已有 `issues` / `prs` / `ci` 与 `insights/assessments` |
| `/` | 仓库 | `Box` | `GET /api/repos` |
| `/issues` | Issues | `CircleDot` | `GET /api/issues` |
| `/pulls` | Pull Requests | `GitPullRequest` | `GET /api/prs` |
| `/ci` | CI 与发布 | `Workflow` | `GET /api/ci` |
| `/alerts` | 安全告警 | `ShieldAlert` | `GET /api/alerts` |
| `/inbox` | 通知 | `Inbox` | `GET /api/notifications` |
| `/repos/:owner/:name` | （钻取，侧栏「仓库」高亮） | — | 按 tab GET 单仓 |
| `/settings` | 设置 | `Settings` | `GET /api/accounts`、`GET /api/me` |

未知路径：岛内 404 文案，不调用 API。

### 8.1 `/` 仓库

`PageHeader` 标题「仓库」+ 副标题和更新时间。`actions` 仅展示截断/不完整 Badge。`filters`：`FilterBar` 内的搜索与 `SegmentControl` 排序。列表 / 网格切换和结果数放在仓库 `SectionRule.actions`。排序通过 VM 完成，不靠 Table 内置排序。

KPI（共享 `StatCard`，主题色 icon）：仓库数 / Stars / Forks / Issues，由 `repoMetrics` 从快照合计。其下 `SectionRule`「仓库」。

列表：`Table` 列 = 仓库、语言、Stars、Fork、Issues、最近推送、health。首列包含描述、可见性、归档和 Fork 标记；推送时间下显示活跃 meter。health 通过只读 GET 获取已有 insights，没有则不加列；不为此触发采集。`insights.alerts_incomplete === true` 时页头 Badge「告警不完整」，不得把 `strong` 理解成已扫完全部安全告警。不另 GET alerts 来推断该标记。

网格：`LayerCard padding="md"` 卡，标题与 health 同行，描述最多两行，底部显示语言、Stars、可见性与推送时间。点整卡进 `/repos/:owner/:name`。

字段用 03 `repos[]`。`truncated: true` 时 PageHeader 下 `Badge`「已截断」。

空数组且有快照：`Empty`「还没有仓库」，不是 409。搜索无结果时显示「没有匹配结果」与清除搜索操作。

### 8.2 `/issues` `/pulls`

跨仓表。首列是标题（外链 `url`，`target=_blank`），下方显示编号与可进入单仓页的仓库链接；其余列是作者、更新时间，Issues 另有标签和评论数，PR 另有 draft、review、+add/−del。`FilterBar` 提供搜索和最近更新 / 按仓库排序。Client 侧按仓 / 标题过滤，不改 GET query。

Issues KPI：打开 Issues / 涉及仓库（`issueMetrics`）。PRs KPI：草稿 / 待审查 / 需修改 / 已批准（`pullMetrics`，草稿优先）。表在 `SectionRule` 内。

### 8.3 `/insights`

总览组第二项。不重复仓库全表。首区「最值得关注的仓库」给出 Top 10 与跨仓发现，其后用 `SectionRule` 分「工作量 / 审查与节奏 / 健康与活跃」。

Top 10 由 `viewmodels/focus.ts` 纯函数计算，读取已保存的 insights、issues、prs、`GET /api/ci` 与 `GET /api/insights/assessments`；CI 与 AI 缺失只缩小证据，不阻塞页面。每条加权原因都可读：AI 总评与 `now` 行动、Jev `urgent`/`review` 判断、AI 分域状态与交付放缓、默认分支持续失败或反复失败、发布流水线失败、高危告警与安全标签 Issue、外部贡献者 PR、待审查或停滞 PR、陈旧 Issue 积压、长期未推送但仍有待办。报告不再对应当前仓库版本时按 60% 计入并标「旧版」；低置信 Jev 判断降权。分数只用于排序，界面显示等级（优先处理 / 需要关注 / 持续观察）、主要方面、AI 总评、待办与推送天数，前三条原因可见，其余在提示中。跨仓发现汇总阻塞交付、高危告警、AI 优先项、依赖更新占比、新增 Issue 加速、Issue 集中度、外部 PR、长期未推送与 AI 覆盖缺口，只在证据达到阈值时出现。

每区：最多四张 KPI（共享 `StatCard`，主题色 icon）+ 两张图卡（一卡一图，使用 `LayerCard.Header` 放标题与指标说明，`Body` 放图表）。

图表由 ViewModel 从 insights + issues + prs 快照聚合。issues 快照缺失时 Issue 计数回退 `open_issue_count`；prs 缺失时 PR 为 0。空 issues 快照不当回退。Client 仍不算 health。`alerts_incomplete` 时页头 Badge「告警不完整」。GET 409 时 Empty，刷新走 §7。仍 409 仅当 repos 或 issues 不足；不循环自动刷。

### 8.3a `/ci`

仓库健康组第二项。页头说明判定口径与数据更新时间；截断与未采集仓库以 Badge 标出。汇总条按连续失败 / 偶发失败 / 稳定 / 无近期运行分段，四个计数各带规则说明。「需要处理」逐张卡片列出 `broken` 流：最近 10 次运行方块、失败始于或成功率、最后成功，以及 GitHub Actions 过滤链接。「继续观察」分反复失败与偶发一次两组，旁边为近 30 天每日运行结果堆叠柱。「全部工作流」表可按判定与文本筛选；「发布」表按发布流水线状态与距今时间排序，超过 3 个典型间隔（或无间隔时 90 天）标「久未发布」。只读 GET，缺数据时统一引导到工厂刷新。

### 8.4 `/alerts`

`unavailable: true` → Empty「无权限」，附检查账号权限的设置链接。否则 KPI（Dependabot / code scanning）+ `SectionRule` 告警表（首列摘要外链与仓库链接，其余列 source、severity）。

### 8.5 `/inbox`

KPI（未读 / 全部）+ `SectionRule` 通知表：状态、标题与仓库链接、原因、时间、操作。未读行的「标为已读」→ `POST /api/notifications/read` `{ id, account_id }`（id 为数字字符串）。页头「全部已读」→ `POST /api/notifications/read-all` `{ account_id }`。请求中显示加载状态并禁用其他已读操作。无快照 409 不打 GitHub（04）。成功后 body 即新 notifications 快照，ViewModel 替换。

### 8.6 `/repos/:owner/:name`

`owner`/`name` 校验同 04（`^[A-Za-z0-9_.-]+$`，不是 `.`/`..`），非法 → 岛内校验错误，不请求。

`Tabs`：概览、安全、Actions、PRs、Issues、发布、流量、语言、贡献者。默认概览。使用共享 `ScrollArea` 保持窄屏标签可达；页头更新时间取当前标签快照，缺数据时不显示其他标签的时间。

标签只读保存的快照，首次加载失败后结束骨架状态。缺数据时展示统一工厂入口，不自动补刷；重新进入页面会重新读取最新保存内容。

| Tab | GET | 要点 |
|-----|-----|------|
| 概览 | `.../:owner/:name` | Stars/Forks/Issues KPI；`SectionRule` 概览 + `DescriptionList`（无 `LayerCard.Header`） |
| 安全 | `/security` | `unavailable` 空态（ShieldAlert），说明账号权限；否则 Dependabot / Code scanning KPI |
| Actions | `/actions` | runs 表，conclusion Badge；空态 Play icon |
| PRs / Issues | `/prs` `/issues` | 同跨仓列，无仓列 |
| 发布 | `/releases` | tag、时间、prerelease |
| 流量 | `/traffic` | `forbidden` → Empty「无法查看流量」，说明需要推送权限；否则浏览/独立访客/克隆/独立克隆 KPI + 两张图卡（日期轴、数值轴、统计摘要） |
| 语言 | `/languages` | 图卡 Donut，字节数 |
| 贡献者 | `/contributors` | `Table` 内的 Avatar + login + 提交次数 |

侧栏「仓库」在钻取时保持祖先高亮。

### 8.7 `/settings`

`PageHeader`「设置」。`SectionRule` 分「账号连接」与「已连接的账号」。连接区并列 PAT 表单与访问身份，窄屏上下排列。`GET /api/me` 展示 Access 身份与 lizheng.blog 头像（非 GitHub）。

账号表：login、avatar、令牌末四位（`•••• token_last4`）、权限范围、是否当前、操作。不显示完整 token。删除确认说明具体账号名及影响范围。

添加：`SensitiveInput`（`revealLabel`/`hideLabel` 中文），提交 `POST /api/accounts` `{ token }`。**无论成功失败都清空输入**。提交中 `Button loading`、输入禁用，防重复提交；文案「正在添加…」（校验并保存），成功后提示前往工厂统一刷新，不自动采集。第二账号默认非 active，只出现在表里，需用户 activate。

`POST /api/accounts/:id/activate` 切换当前，成功后页面读取该账号已有数据，不自动采集。`DELETE` 经 `ConfirmDialog`。删除当前账号后快照页将 409 `account_missing`。

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
| `factory-runs.ts` / `snapshot.ts` | 持久任务启动/控制与轮询；账号切换丢弃在途数据；页面重新加载读取最新保存快照；缺数据不采集 |
| `accounts` | 提交后 token 空串；列表不含 ciphertext；添加/切换账号不自动 refresh；activate / delete 归约 |
| `me` | 短路身份字段映射 |
| `repos` | 搜索/排序/列表|网格；truncated 标记 |
| `issues` / `pulls` | 过滤 |
| `insights` | 按 health 分组；健康地图单行说明 |
| `focus` | Top 10 加权原因、旧版报告折算、可选来源缺失、跨仓发现阈值 |
| `alerts` | unavailable |
| `inbox` | 已读与 **read-all** 后 unread false（对返回体归约） |
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
2. 在工厂同步清单并全站刷新，随后 `/` 仓库列表 **有至少一行**（GitHub stub 仓库为 `octocat/hello-world`）；创建账号本身不触发采集。
3. 点进该仓详情，概览可见描述或名称。

Runner：`scripts/run-e2e-bdd.ts`。先 `vite build`，persist `.wrangler/e2e-pw/`，端口 27045，schema + `_test_marker`，`GET /api/live` 且 `d1_marker=test`，GitHub stub 不得占用 17045。套件 **只 A**。Playwright Chromium。`baseURL = http://127.0.0.1:27045`。

`tests/e2e/ui.spec.ts` 在同一真实构建上拦截同源 API 为固定展示数据，补充验证搜索恢复、网格导航、通知操作进度、空态与权限提示、表格键盘横向滚动、单仓全部标签的数据与更新时间、浅色 / 深色 / 移动端全部页面及失败 PAT 清空。图表必须实际绘制且具有可用尺寸，PR 状态必须有五种不同的实际填充色。`ui-fixtures.ts` 只属于测试，不进入客户端。原有不拦截 API 的 PAT → 仓库列表 → 单仓路径仍必须通过。

`tests/e2e/basalt.spec.ts` 验证跨页字号、浅深主题绿色实际绘制、键盘下钻/焦点、问号的悬停/键盘/触屏操作、卡片底部留白、圆环占用比例、表格边距与选中语义，以及移动端深色控件布局和数据时间弹窗。时间格式的跨分、跨小时、跨天和未来时钟边界由 `lib/format.test.ts` 覆盖。

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
- GET、添加/切换账号或缺快照触发自动采集；软件工厂以外提供独立刷新操作
- 显式 refresh `insights`（工具条与 bootstrap）
- 应用内 `/login`
- Vite `:5173` 打 Worker 写接口
- 用 `Host` 做 Origin；生产放行 loopback
- L3 打远程 `giraffe-db` 或真实 GitHub
- 把 L3 加进 pre-push
- 提交红测试、`--no-verify`
- 本文未 Sign Off 就开始步骤 1 及之后
