# 06 — 软件工厂

本次演进扩展 01/03/04/05 的初版范围：新增工厂采集与视图，沿用 Worker、D1、Access、加密 PAT、React MVVM 和 Basalt。旧仓库与待办页面仍可用。

## 采集契约

- 归属范围：GitHub GraphQL `viewer.repositories(affiliations:[OWNER], ownerAffiliations:[OWNER])`，按名称排序，每页 10 个，遍历 `pageInfo`。按 node ID 去重。排除 archived，再排除 fork，再排除已知 effective mirror `nocoo/rsshub`；三类互斥。扫描数与 `totalCount` 不符时报错，不宣称清单完整。只能证明当前令牌的可见范围，不能证明没有不可见的私有仓库。
- 仓库规模：`diskUsage` 为 GitHub 仓库磁盘 KiB，不是代码行数；语言为 Linguist 字节数，不含被 Linguist 排除的生成文件等。每仓前 100 种语言，超出则标记语言覆盖不完整。主题前 20 个仅作可重叠筛选标签，不能相加当互斥领域。
- 采样窗口：从采集启动时 UTC 当日零点往前 89 日至启动时刻，左闭右开。包含当前不完整日。提交按 committer timestamp，固定清单时的默认分支 SHA，包含所有作者及 merge commit；不是所有分支提交，不是 nocoo 个人贡献。跨仓同 SHA 按 repo+SHA 计数；账号贡献热力单独来自 `contributionsCollection`，可能包括排除仓库、外部仓库与受限贡献，不与仓库提交相加。
- Issue/PR：从各仓资源端点按 updated 降序完整分页，容量截断时优先保留最近更新记录；不按 created_at 提前停止，避免遗漏旧创建、窗口内合并的工作。Issue 显式排除 REST 返回的 `pull_request`。生命周期按 `created_at`、最后 `closed_at`、`merged_at`；不重建 reopen 的多次历史转换。清单的 open/closed 计数是清单取样时状态，明细是分页观察时状态；GitHub 不提供跨 API 原子快照，持续变化的状态可能略有差异。
- PR 吞吐：窗口内 merged；closed 指未合并关闭。耗时是窗口内合并队列的 created→merged 小时，P50/P90 用 nearest rank，明确样本数。没有样本为 null。WIP 长龄信号：open PR ≥7 天、open issue ≥14 天；这是需检查的规则，不证明实际被阻塞。
- CI：按窗口内 `created_at` 的 workflow run ID 去重，使用 API 返回的最新 attempt。成功率 = success / (success + failure + timed_out + action_required + startup_failure)。cancelled/skipped/neutral/stale 等单列，pending 单列。不是 job 成功率，不重建所有重试，不包含被删除/过期保留策略清理的 runs。超过 1,000 条的查询自动二分时间范围（边界重叠、按 run ID 去重，无时间缝隙），最终按左闭右开窗口过滤；无法细分时明确 limited。
- Release：`published_at` 在窗口内且非 draft，含 prerelease；清单同时保留全部可见 release 数，两个口径分开。
- 依赖维护：Dependabot 开放告警独立采集，403/404 = unavailable，绝不能解释为零。机器人 PR 仅匹配 dependabot/renovate 身份。依赖关系取固定 SHA 的根 package.json 四个依赖段、`.github/workflows/ci.yml` 和 `release.yml` 的 literal `uses:`，以及 `.github/dependabot.yml` / `renovate.json` 是否存在。展示原版本声明与文件链接。这不是全仓依赖图，不扫描 monorepo 子目录、传递依赖或动态 workflow，不判断版本是否最新。当前图展示“已观察到的直接引用”。

## API、成本与存储

持久刷新设计、迁移与回滚见 [09 — 持久化工厂刷新](09-factory-runs.md)。

`GET /api/factory` 只读已发布的当前账号全局快照。`GET /api/factory/runs` 只读当前 run、最近 20 个历史 run、仓库状态和清单。`POST /api/factory/runs`（`/api/factory/refresh` 为同一契约别名）接收 `{account_id, requestKey: UUID, mode: "catalog" | "refresh", scope, repos?, order?, language?, topic?, query?, repo?}`，202 返回持久 run ID。`requestKey` 每次明确新建操作生成，网络重试复用；重复键返回原 run，不能当作新的刷新。`scope` 支持 all/selected/filter/stale/failed，selected 使用 repos 指定成员和顺序；其他范围由服务端解析成员，order 单独指定优先级。旧 `{restart:true}` 请求拒绝，不能隐式触发全仓刷新。

`POST /api/factory/runs/:id/control` 接收 `{account_id, action: "pause" | "resume" | "cancel"}`。状态从 D1 恢复；队列每次处理一页，cron 每分钟恢复到期任务。冷却由服务端执行，暂停不绕过限流等待。GET 永不调 GitHub、不写库；所有 mutation 仍经过 Access JWT 与 Origin 验证。

`GET /api/factory/repos/:owner/:name/:stream?page=1` 按当前全局快照指向的仓库版本读取明细，每页 100、最多 50 页。新 run 的 staging 不可见。失败保留旧成功仓库版本，覆盖回退时保留更完整的旧版本。全局发布版本明确 mixed 状态，每仓库附原始采样窗口与 refreshedAt。

每账号资源预算 256 MB，界面显示 D1 实测用量；保留根保护的历史按 09 的有界维护规则清理。单资源仍最多 5,000 项 / 1.2 MB；每个 run/control 记录上限 1.8 MB、单次选择上限 500 仓库，超过边界明确报错并保留旧数据。全局快照按两页拆分，拒绝有损发布。新表与版本键均为增量存储，不覆盖 legacy `factory` / `factory:{repo}:{stream}`，使旧数据恢复与回滚可核验。错误只存安全代码，不保存上游原始报错或令牌。

每条来源记录 status、pages、observed、fetchedAt、source、reason；complete 表示当前端点范围分页完成，不等同于整个软件工厂的业务事实完整。未完成/限流/权限不足与观测到的零分开。UI 不计算无依据的综合健康分数。

## 使用与本地复核

导航「软件工厂」进入 `/factory`。语言群按 GitHub primaryLanguage 互斥分组；topic 允许重叠。仓库搜索、领域筛选、仓库/记录类型/状态/日期/页码保存在 URL。图表点击可下钻，仓库表每页 25 行，明细先按状态或 UTC 日期过滤再每页 100 行；merged 按 mergedAt、closed 按 closedAt，其余按记录时间。提供完整每日账本、语言字节表和来源文件链接作为图形替代；键盘可聚焦图表按钮与表格链接。缺失、限流、权限不足、采集中、无匹配结果分别呈现。

额外只读调查工具沿用同一采集器与聚合代码：

```bash
bun run factory:audit .factory-cache/my-survey
# 中断后用相同目录续传；需要新窗口时用一个新目录。
bun run factory:preview .factory-cache/my-survey
```

`factory:audit` 由本机已认证的 `gh` CLI 发出请求，不读取/输出明文 GitHub 凭证。原始响应按请求摘要缓存，紧凑明细按资源保存；目录已被 Git/Biome 忽略。CLI 的 requests 表示经过采集器的逻辑请求数，缓存命中不产生新的 GitHub 调用。不要把含私有仓库信息的调查目录作为公共 fixture。

`factory:preview` 先让 Wrangler 初始化 `.wrangler/factory-preview`，再在 Worker 停止时用参数化 SQLite 导入真实调查，构建前端并由单个本地 Worker `7045` 托管产物。它不使用日常开发或远程 D1；预览账号仅持有加密的非凭证占位文本。仅预览读操作可用，要采集新数据请在正常应用设置中连接真实账号。先停止占用 `7045` 的开发进程。固定入口为 `http://localhost:7045/factory`，已有 Caddy 时也可用 `https://giraffe.dev.hexly.ai/factory`。

每份资源带 runId，仓库 observation 指向对应版本。无效 package.json 标为依赖证据不可用；其他资源继续执行。清单漂移等不能续传的错误保留原有数据，可取消后重新发现清单。

图表不把尚未采集的提交画成零；CI 指标旁展示完成覆盖仓数。仓库覆盖短码 C/I/PR/CI/R/A/D 唯一对应各资源。包名同时属于多个仓库时，引用边不强行指向任何一个。页面模块按路由懒加载，重型图表共享独立 chunk。

已知性能边界：单次明细仍会在 Worker 内解析最多 1.2 MB / 5,000 条，再筛选分页；这是有界读取，未实现按日期索引的明细表。前端聚合使用 memo，仓库表仅渲染 25 行；采集期间保留已发布总览，后台发布新版本后更新一次。未来规模超出这一级时可以改为按日物理分片，当前不会隐藏容量截断。

若分页中途失去权限而已取得部分记录，资源标为 limited（不完整子集），清空待取范围并明确原因；完全未取得记录时才是 unavailable。提交/合并/发布计数在覆盖不完整时用 `≥` 标出已观测下界；完整的零仍显示 0，没有可用观测显示 `—`。CI 比率只代表观测样本，不把不完整比率误标为下界。
