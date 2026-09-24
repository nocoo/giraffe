# 09 — 持久化工厂刷新

## 调查与约束

2026-09-16 生产 D1 备份：471 条 factory 记录，13,077,011 UTF-8 字节（SQL 按 BLOB 长度统计）。总览 run 停在清单第 6 页（60/114，纳入 37 仓库），259 个流均 pending；旧的 469 条资源仍在。旧实现重启即覆盖总览、资源 runId 与总览强绑定，浏览器离开后没有执行者。备份保存在忽略目录，禁止提交账号信封或私有事件。

依据 Cloudflare 官方 [Worker limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)：isolate 128 MB；waitUntil 在 HTTP 返回后最多 30 秒；队列/cron 每次最多 15 分钟 wall time；D1 行最大 2 MB、batch 为原子事务。项目仍限制 GitHub 40 次、D1 80 statements，每页超时 15 秒。不能靠一个超长 HTTP 或 waitUntil 承担完整调查。

## 计划与执行

- D1 is the source of truth. The software factory remains the only collection entry point. Each run freezes its statistics repositories (`repos`), detail targets (`siteRepos`), order, window and steps. Only `scope=all` uses the complete accessible site catalog, including repositories excluded from factory statistics. Selected, filtered, stale and failed scopes use their resolved statistics repositories for both statistics and detail pages.
- A full refresh has `10N + 9M + 7` logical steps: contributions, nine statistics steps per statistics repository, the site catalog, nine detail tabs per accessible repository, four account-wide lists, one AI assessment checkpoint per statistics repository, and publication. A scoped refresh has `19N + 1` steps: statistics, detail tabs, AI assessment and publication. One selected repository therefore has 20 steps, including exactly nine detail pages, independent of site size. Pagination is counted separately and never expands the logical denominator. Cooldowns skip statistics and AI steps while retaining planned detail work. Existing runs keep their frozen plans.
- Catalog runs retain four steps: inventory, site catalog, restore and publication. Full refresh requires complete statistics and site catalogs; non-selected scoped runs require a complete statistics catalog. A selected known repository does not require a complete site catalog. Full refresh still reports `catalog_changed` when discovery finds repositories outside its frozen site targets; synchronize the catalog explicitly before including them.
- 每个队列消息执行一页/一个有界动作并提交，再安排下一条。全站 Issues/PRs/告警每次最多处理 10 个仓库，中间结果与 cursor 一起保存在既有 staging，全部完成后才替换列表。cron 每分钟扫描到期任务，修复 enqueue 与数据库之间不可原子的问题。队列消息只有 run ID，没有令牌或事件。
- 90 秒租约；提交事务中的每一条写入都受 run ID、lease token、版本、未过期租约和 running 状态保护。最后 CAS 更新 checkpoint 并释放租约。控制操作使旧租约失效；已在途的 GitHub 请求可能结束，但不能再写。
- 每页心跳与 checkpoint 同时落库。崩溃最多重取未提交页；去重以事件 ID，统计只在流结束时计算。队列重复投递不会重复发布。
- 临时失败按 30/60/120 秒退避，最多 3 次重试；GitHub 限流遵循 Retry-After/reset，未知时至少 15 分钟，任务保持可恢复。401 暂停等待更新凭据。统计仓库失败只跳过后续统计步骤；页面数据失败不会阻断其他页面。权限不足、来源缺失/截断、清单变化不无效重试；保留旧快照及原时间，不伪装成功零值。
- 账户启动冷却 60 秒；每个统计仓库尝试后冷却 15 分钟。服务器时钟决定下次允许时间；客户端仅显示倒计时。全站刷新允许统计仓库为空或都在冷却，仍更新页面数据。暂停保留唯一活动 run，取消释放活动槽并保留已提交数据；新 run 不会与旧执行者竞争。

## 数据发布与兼容

迁移 0001 新增 factory_runs、factory_state、factory_resources、factory_repo_versions、factory_repo_state；0002 新增 factory_version_refs 和 factory_storage（含资源字节计量触发器）；0003 的 factory_budget 与触发器计量运行、资源、仓库状态/版本、所有 factory 快照及引用清单，均外键级联至账号。迁移只 CREATE IF NOT EXISTS，不改写/删除旧 snapshots。初始化 schema 包含同样 DDL；部署运行 migrations apply。

采集流存于 run staging；仓库全部流结束后，在同一 fenced batch 发布不可变仓库版本和当前指针及健康元数据。失败仓库保留当前指针，更新错误/耗时/重试状态。全局发布从已提交仓库版本构建，持久化完整版本后原子切换 factory_state.published_id。运行期间保留上个全局版本，仓库进度可独立显示新 refreshedAt。详情按所展示的版本定位资源，不因新 run 开始失效。

每仓库携带数据源窗口/版本，混合时间的 last-known-good 必须明确标识；不得把不同时间窗口当作同次全量调查。catalog restore 仅在缺少新全局版本时，从旧资源恢复旧指标、覆盖度、原始时间，保留 legacy 数据，不能把恢复标成刚采集成功。无法恢复的旧资源注明缺失。

普通页面复用 `prepareRefresh` 和既有 snapshots/snapshot_days 格式，Insights/日报继续由已保存来源派生。每类页面独立成功后更新，不等待工厂全局发布；不是跨页面原子快照。写入与 run 的游标一起进入 fenced batch，取消后的在途结果不能覆盖快照。旧 `POST /api/refresh` 仅为兼容 API，前端不再调用；没有新增数据库表或迁移。

## 迁移与回滚

部署前：导出 D1；记录旧表逐行摘要；运行 `bun scripts/verify-factory-migration.ts <local-export.sql>` 在本地 SQLite 备份副本上应用迁移两次，核验所有旧行完全一致。通过本地并发/崩溃测试后才启用 release workflow 的 D1 migrations。部署后再查旧行摘要、表结构、run/publication 一致性。回滚 Worker 到前版本无需逆向删表；停止队列/cron 后旧程序仍可读原 legacy snapshots。新表与版本保留供修复，禁止为回滚清空数据。

## UI 与验证

页面右上角「刷新控制台」打开大对话框，使用 Basalt Dialog 的焦点约束、Esc 关闭与焦点恢复。主页面只保留一条数据健康与刷新进度提示，随后进入筛选和提交指标；关闭对话框不会停止只读轮询或服务端任务。主页面始终展示当前任务或最近一次任务，切换历史记录不会替换主页面的进度。

The console has progress and start tabs. Progress separates success, failure and skipped work; 100% processed does not imply complete data. Full refresh shows contributions, statistics, site pages, AI analysis and publication. Scoped refresh omits contributions and labels the page phase as repository pages. Empty stages are omitted. AI checkpoints display Jev judgment or report generation and wait for the version-bound background job before final publication. They honor the AI retry deadline without making model calls. Unconfigured AI is an explicit skip, excluded from warning groups and incomplete-run status; terminal AI failure retains collected repository data and the last valid report. Repository rows expose their own statistics and detail steps; repositories outside factory statistics have detail steps only. Catalog discovery retains three visual phases and four logical steps. Problems are grouped by step and diagnostic code, with their possible causes, data impact and recovery actions. Raw codes, timestamps, page counts and storage diagnostics remain collapsed. Permission causes are not assumed; truncated sources do not promise recovery on retry, rate limits explain automatic continuation, and pause/failure states explain retention of saved data.

The default scope is full-site refresh. Selection, filtering, stale-data refresh and failed-repository retry restrict both statistics and detail work to the resolved repositories. They do not fetch contributions, the site catalog, account-wide Issues/PRs/alerts, notifications, Insights or digest; those snapshots keep their prior contents and timestamps. Factory publication merges the accepted repository versions with existing observations and retains contribution provenance. AI assessments still follow accepted repository updates when configured. Manual selection searches the statistics catalog; page filters apply only to the explicit filter scope. Priority changes order, not membership. Frozen active and historical plans are never rewritten; cancel an old broad plan and start a new scoped run to use this behavior. Missing snapshots still link to `/factory?refresh=1`; other pages remain read-only. Polls remain serial, slow down while hidden, back off on errors, and keep operation errors separate from polling errors.

范围和历史记录选择使用带标签的 Basalt Select，仓库勾选与优先级使用 Basalt Checkbox/Input；标题、正文、辅助文字遵循全站 16/14/13px 层级。移动端对话框内部滚动，保持关闭和返回操作可达。

Tests cover scoped plans against a 161-repository site catalog, all four scoped selectors, unchanged full-site coverage, upstream request isolation, preservation of unrelated snapshots and timestamps, contribution provenance, publication, cooldowns, retries, leases and controls. Browser coverage verifies that one selected repository shows 20 total steps, nine detail pages and only one repository row. AI checks cover pending judgment, summary, completion, retry deadlines, optional configuration, terminal failures and source-version isolation. Automated checks use local GitHub fixtures only.

## 实现边界与审查处理

资源继续使用既有有界 JSON collector：每流 5,000 项 / 1.2 MB，事件 ID 去重和 next/ranges 与 run checkpoint 在同一 fenced batch 保存。因此不依赖 JSON 之外的无界事件列表；重复页不改变已提交进度。完整 run payload 在每次保存前检查 1.8 MB 上限，最多 500 仓库。超过规模时失败保留旧版本，而不悄悄截断计划。

publication 实体复用 snapshots 分页容器：`factory:v:<run-id>` 是不可变全局组合，repo.observation 明确引用资源版本；`factory:catalog:<run-id>` 是清单实体。factory_state 的两个指针与对应实体在同一 fenced batch 提交。这里不再重复建另一套 JSON 分页表。schema 的字符串指针由事务和一致性测试保护。

Grok、Pi 的第一轮架构审查均指出体积、fencing、publication 映射、catalog 完整性与混合窗口语义需要落成代码。这些边界已有实现和测试。公开进度排除内部 checkpoint；历史只返回最近 20 次。引用中的历史版本保留，避免恢复或回滚时删除唯一事件副本。0002 引入显式 publication→资源版本引用清单。每分钟维护事务最多删除 50 条过期快照、100 条已失去 publication 的引用、50 条无引用仓库版本、50 条无引用资源与 50 条无引用 run；仅处理 7 天前且不属于最近 20 次运行的数据。当前仓库指针、当前全局/清单指针、最近两个全局版本和所有保留 publication 引用均为保留根。legacy snapshots 永不进入清理条件。工厂数据计量由既有触发器维护，普通页面快照和日报基线的 UTF-8 字节一并纳入每账号 256 MB 预算（不含 D1 索引/空页）。执行器累计本页所有替换增量，在提交前检查预算；全站分批列表额外限制 1.5 MB，不有损发布。预留 2 MB 供暂停/取消等控制操作；达到采集预算后暂停并保留旧数据与游标。


## 发布审查后的边界

启动 run 与账户冷却在同一个 D1 batch 内完成。claim 只取得租约；执行器先归一化 cursor，再 fenced 保存实际阶段/开始时间，之后才发 GitHub 请求，不能把已完成步骤复活。凭据暂停不消耗网络重试预算；每页网络错误独立最多重试 3 次，实际 attempts/requests 继续如实计数。

队列最多并行 2 个消费者；每账号唯一 run 与租约仍使同一令牌串行执行。单页执行后把下一页送入队尾，不让单个账号一次投递整仓队列。

API 的 `repos` 只表示 selected 成员；`order` 是独立的优先级顺序。filter 的 language/topic/query/repo 由服务端解析，run.selection 保存原条件，run.repos/repoIds 固定解析结果。stale/failed 明确覆盖全清单，不偷偷叠加页面筛选。表格末列「数据时间」打开对话框，按需展示 metadataAt、活动窗口、快照时间和旧资源来源，完整时间明确本地时区，距今逐秒更新；混合快照不显示统一的 90 天调查窗口，也不计算统一同比趋势。

迁移验证在备份副本上开启外键，检查新表/唯一活动索引/外键、JSON 条件更新、重复插入、资源字节计量和 publication 引用写入，随后回滚探针并再验证旧表摘要。数据库备份不进入版本库。


贡献日历单独保存来源 run、窗口与观测时间。本次无法采集时仍保留旧日历，明确标为本次 unavailable，且全局 mixed 标志纳入日历来源。混合仓库的日历/吞吐轴为各自窗口并集，最多展示一年；每一天按仓库/流检查覆盖，不把未观测的零画成成功零值，正的部分观测为下界。单仓下钻使用自己的窗口。

暂停/取消已开始的仓库统计步骤时，在控制事务中保留/延长该仓库 15 分钟冷却；页面快照步骤不修改统计冷却。同一个冻结 run 可以续跑。selected 的 order 同样由服务端执行，selection.order 保存解析后的顺序。complete 数据与有记录的 limited 数据均受覆盖回退保护。

工厂 GitHub 响应在流式读取时限制为 4 MB，超过即停止读取，避免在大 manifest 解码后才限容；其他旧 API 保持独立的 20 MB 响应边界。

保存事务入口会验证本批所有 fence 时间的最大值；若租约已失效则整批回滚，避免前面的写入通过而最后 CAS 失败。已记录 requests 包括成功记账的错误/重试调用；崩溃或取消后的未提交在途调用可能额外消耗 GitHub 配额，不能据此反推出精确计费。
