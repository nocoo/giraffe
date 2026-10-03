# 09 — 持久化工厂刷新

## 调查与约束

2026-09-16 生产 D1 备份：471 条 factory 记录，13,077,011 UTF-8 字节（SQL 按 BLOB 长度统计）。总览 run 停在清单第 6 页（60/114，纳入 37 仓库），259 个流均 pending；旧的 469 条资源仍在。旧实现重启即覆盖总览、资源 runId 与总览强绑定，浏览器离开后没有执行者。备份保存在忽略目录，禁止提交账号信封或私有事件。

依据 Cloudflare 官方 [Worker limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)：isolate 128 MB；waitUntil 在 HTTP 返回后最多 30 秒；队列/cron 每次最多 15 分钟 wall time；D1 行最大 2 MB、batch 为原子事务。项目仍限制 GitHub 40 次、D1 80 statements，每页超时 15 秒。不能靠一个超长 HTTP 或 waitUntil 承担完整调查。

## 计划与执行

- D1 is the source of truth. The refresh center at `/refresh` is the only collection entry point. Each run freezes its statistics repositories (`repos`), detail targets (`siteRepos`), order, window and steps. Only `scope=all` uses the complete accessible site catalog, including repositories excluded from factory statistics. Selected scopes can include known repositories excluded from statistics for detail-only refresh. Filtered, stale and failed scopes use their resolved statistics repositories for both statistics and detail pages.
- A full refresh has `9N + 9M + 8` logical steps: six site snapshots including Insights, contributions, nine statistics steps per statistics repository, nine detail tabs per accessible repository, and publication. A scoped refresh has `9N + 9P + 1` steps, where P is the resolved page-repository count; when P=N this is `18N + 1`. One selected repository has 19 steps. Daily scoped refresh adds repos, notifications and Insights (`9N + 9P + 4`, or 22 for one repository). Catalog discovery has four steps. New plans contain no AI checkpoints; frozen old AI stages retire without provider calls while other collection work continues.
- Catalog runs retain four steps: inventory, site catalog, restore and publication. Full refresh requires complete statistics and site catalogs; non-selected scoped runs require a complete statistics catalog. A selected known repository does not require a complete site catalog. Full refresh still reports `catalog_changed` when discovery finds repositories outside its frozen site targets; synchronize the catalog explicitly before including them.
- Dependabot REST alerts use the `after` cursor from GitHub's next Link header; the endpoint rejects numeric `page` pagination. Resume checkpoints preserve the cursor, repository and original filters. Other REST streams retain sequential page validation.
- 每个队列消息执行一页/一个有界动作并提交，再安排下一条。全站 Issues/PRs/告警每次最多处理 10 个仓库，中间结果与 cursor 一起保存在既有 staging，全部完成后才替换列表。cron 每分钟扫描到期任务，修复 enqueue 与数据库之间不可原子的问题。队列消息只有 run ID，没有令牌或事件。
- 90 秒租约；提交事务中的每一条写入都受 run ID、lease token、版本、未过期租约和 running 状态保护。最后 CAS 更新 checkpoint 并释放租约。控制操作使旧租约失效；已在途的 GitHub 请求可能结束，但不能再写。
- 每页心跳与 checkpoint 同时落库。崩溃最多重取未提交页；去重以事件 ID，统计只在流结束时计算。队列重复投递不会重复发布。
- 临时失败按 30/60/120 秒退避，最多 3 次重试；GitHub 限流遵循 Retry-After/reset，未知时至少 15 分钟，任务保持可恢复。401 暂停等待更新凭据。统计仓库失败只跳过后续统计步骤；页面数据失败不会阻断其他页面。权限不足、来源缺失/截断、清单变化不无效重试；保留旧快照及原时间，不伪装成功零值。
- 账户启动冷却 60 秒；每个统计仓库尝试后冷却 15 分钟。服务器时钟决定下次允许时间；客户端仅显示倒计时。全站刷新允许统计仓库为空或都在冷却，仍更新页面数据。暂停保留唯一活动 run，取消释放活动槽并保留已提交数据；新 run 不会与旧执行者竞争。

## 数据发布与兼容

迁移 0001 新增 factory_runs、factory_state、factory_resources、factory_repo_versions、factory_repo_state；0002 新增 factory_version_refs 和 factory_storage（含资源字节计量触发器）；0003 的 factory_budget 与触发器计量运行、资源、仓库状态/版本、所有 factory 快照及引用清单，均外键级联至账号。迁移只 CREATE IF NOT EXISTS，不改写/删除旧 snapshots。初始化 schema 包含同样 DDL；部署运行 migrations apply。

采集流存于 run staging；仓库全部流结束后，在同一 fenced batch 发布不可变仓库版本和当前指针及健康元数据。失败仓库保留当前指针，更新错误/耗时/重试状态。全局发布从已提交仓库版本构建，持久化完整版本后原子切换 factory_state.published_id。运行期间保留上个全局版本，仓库进度可独立显示新 refreshedAt。详情按所展示的版本定位资源，不因新 run 开始失效。

每仓库携带数据源窗口/版本，混合时间的 last-known-good 必须明确标识；不得把不同时间窗口当作同次全量调查。catalog restore 仅在缺少新全局版本时，从旧资源恢复旧指标、覆盖度、原始时间，保留 legacy 数据，不能把恢复标成刚采集成功。无法恢复的旧资源注明缺失。

Ordinary pages reuse `prepareRefresh` and the existing snapshot format. New full-site plans refresh the catalog, Issues, PRs, alerts, notifications and Insights before repository statistics. Insights is an explicit local derivation step: this run's catalog and Issues must succeed; optional alerts and notifications never block it. Plans with explicit Insights do not derive it as a side effect of other page writes. Existing frozen plans retain their implicit derivation. Each page commits independently with the run cursor in the fenced batch; publication is not an atomic cross-page snapshot, and cancellation prevents stale writes. The browser uses only the refresh console; it does not call the existing `POST /api/refresh` endpoint. The scheduling schema is described below.

The console lists this run's result for each page, distinguishing updated, partially updated, pending, retained and unplanned data. Factory publication cannot imply success for the repository catalog or other pages. CI reads the saved repository details, Actions and releases. Settings and project identity remain configuration/reference reads, not GitHub collection snapshots. Optional security collection diagnostics appear only in the refresh console. Other pages show available alerts or a neutral empty state; missing security data is not presented as a verified zero and does not add a coverage warning to repository, Insights or factory pages.

## 迁移与回滚

部署前：导出 D1；记录旧表逐行摘要；运行 `bun scripts/verify-factory-migration.ts <local-export.sql>` 在本地 SQLite 备份副本上应用迁移两次，核验所有旧行完全一致。通过本地并发/崩溃测试后才启用 release workflow 的 D1 migrations。部署后再查旧行摘要、表结构、run/publication 一致性。回滚 Worker 到前版本无需逆向删表；停止队列/cron 后旧程序仍可读原 legacy snapshots。新表与版本保留供修复，禁止为回滚清空数据。

## UI 与验证

The factory links to `/refresh`. The dedicated page contains manual plans, automatic schedules, execution progress and history. Navigating away stops browser polling but never stops the persisted server task.

The center has progress, start and automatic-refresh tabs. Progress separates success, failure and skipped work; 100% processed does not imply complete data. Full refresh processes global lists and Insights first, then contributions, statistics, repository pages and publication. Scoped refresh omits contributions and labels the page phase as repository pages. Empty stages are omitted. Local Agent analysis is independent of collection completion. Old pending/running cloud AI stages are skipped with `cloud_ai_retired`; later non-AI collection and publication continue. Repository rows expose their own statistics and detail steps; repositories outside factory statistics have detail steps only. Catalog discovery retains three visual phases and four logical steps. Problems are grouped by step and diagnostic code, with their possible causes, data impact and recovery actions. Raw codes, timestamps, page counts and storage diagnostics remain collapsed. Permission causes are not assumed; truncated sources do not promise recovery on retry, rate limits explain automatic continuation, and pause/failure states explain retention of saved data.

The default scope is full-site refresh. Selection, filtering, stale-data refresh and failed-repository retry restrict both statistics and detail work to the resolved repositories. They do not fetch unrelated repositories, account contributions or notifications. Successful detail snapshots merge their repository into existing catalogue, Issues, PR and alert snapshots. Unrelated rows and the original full-scan timestamp are retained; `repository_fetched_at` records partial updates. Insights reads derive from the updated saved sources. Missing global baselines require a full refresh; a partial run cannot invent full coverage. Factory publication merges the accepted repository versions with existing observations and retains contribution provenance. The local Agent watches accepted source versions separately. Manual selection searches the statistics catalog; page filters apply only to the explicit filter scope. Priority changes order, not membership. Frozen active and historical plans are never rewritten; cancel an old broad plan and start a new scoped run to use this behavior. Missing required snapshots still link to `/refresh`; missing optional security snapshots use a neutral empty state. All page reads remain read-only. Polls remain serial, slow down while hidden, back off on errors, and keep operation errors separate from polling errors.

范围和历史记录选择使用带标签的 Basalt Select，仓库勾选与优先级使用 Basalt Checkbox/Input；标题、正文、辅助文字遵循全站 16/14/13px 层级。移动端对话框内部滚动，保持关闭和返回操作可达。

Tests verify refreshed data through 17 page API reads without upstream calls or writes, explicit Insights success/failure, optional alert failures, and per-page console results. Tests cover scoped plans against a 161-repository site catalog, all four scoped selectors, unchanged full-site coverage, upstream request isolation, preservation of unrelated snapshots and timestamps, contribution provenance, publication, cooldowns, retries, leases and controls. Browser coverage verifies that one selected repository shows 19 total steps, nine detail pages and only one repository row. Tests verify that retired cloud AI stages cannot invoke providers or block non-AI collection. Automated checks use local GitHub fixtures only.

## 实现边界与审查处理

资源继续使用既有有界 JSON collector：每流 5,000 项 / 1.2 MB，事件 ID 去重和 next/ranges 与 run checkpoint 在同一 fenced batch 保存。因此不依赖 JSON 之外的无界事件列表；重复页不改变已提交进度。完整 run payload 在每次保存前检查 1.8 MB 上限，最多 500 仓库。超过规模时失败保留旧版本，而不悄悄截断计划。

publication 实体复用 snapshots 分页容器：`factory:v:<run-id>` 是不可变全局组合，repo.observation 明确引用资源版本；`factory:catalog:<run-id>` 是清单实体。factory_state 的两个指针与对应实体在同一 fenced batch 提交。这里不再重复建另一套 JSON 分页表。schema 的字符串指针由事务和一致性测试保护。

Grok、Pi 的第一轮架构审查均指出体积、fencing、publication 映射、catalog 完整性与混合窗口语义需要落成代码。这些边界已有实现和测试。公开进度排除内部 checkpoint；历史只返回最近 20 次。引用中的历史版本保留，避免恢复或回滚时删除唯一事件副本。0002 引入显式 publication→资源版本引用清单。刷新调度与到期任务派发仍每分钟执行；每小时清理事务最多删除 50 条过期快照、100 条已失去 publication 的引用、50 条无引用仓库版本、50 条无引用资源与 50 条无引用 run；仅处理 7 天前且不属于最近 20 次运行的数据。当前仓库指针、当前全局/清单指针、最近两个全局版本和所有保留 publication 引用均为保留根。legacy snapshots 永不进入清理条件。Storage telemetry is maintained by existing triggers and includes ordinary pages, legacy daily baselines and AI records (excluding D1 index/free-page overhead). It does not impose an account-wide storage quota or block refresh/AI work. Per-resource, per-record and request limits remain enforced; full-site batches still reject lossy publication above 1.5 MB. Reference-safe retention remains unchanged. Cron attempts cleanup in a `finally` block only when the controller's scheduled time has UTC minute zero, even if scheduling or queue dispatch fails. Delayed events retain their scheduled-time eligibility; cleanup cutoffs and lease/schedule calculations use current processing time. This hourly gate does not guarantee exactly-once delivery.


## 发布审查后的边界

启动 run 与账户冷却在同一个 D1 batch 内完成。claim 只取得租约；执行器先归一化 cursor，再 fenced 保存实际阶段/开始时间，之后才发 GitHub 请求，不能把已完成步骤复活。凭据暂停不消耗网络重试预算；每页网络错误独立最多重试 3 次，实际 attempts/requests 继续如实计数。

队列最多并行 2 个消费者；每账号唯一 run 与租约仍使同一令牌串行执行。单页执行后把下一页送入队尾，不让单个账号一次投递整仓队列。

API 的 `repos` 只表示 selected 成员；`order` 是独立的优先级顺序。filter 的 language/topic/query/repo 由服务端解析，run.selection 保存原条件，run.repos/repoIds 固定解析结果。stale/failed 明确覆盖全清单，不偷偷叠加页面筛选。表格末列「数据时间」打开对话框，按需展示 metadataAt、活动窗口、快照时间和旧资源来源，完整时间明确本地时区，距今逐秒更新；混合快照不显示统一的 90 天调查窗口，也不计算统一同比趋势。

迁移验证在备份副本上开启外键，检查新表/唯一活动索引/外键、JSON 条件更新、重复插入、资源字节计量和 publication 引用写入，随后回滚探针并再验证旧表摘要。数据库备份不进入版本库。


贡献日历单独保存来源 run、窗口与观测时间。本次无法采集时仍保留旧日历，明确标为本次 unavailable，且全局 mixed 标志纳入日历来源。混合仓库的日历/吞吐轴为各自窗口并集，最多展示一年；每一天按仓库/流检查覆盖，不把未观测的零画成成功零值，正的部分观测为下界。单仓下钻使用自己的窗口。

暂停/取消已开始的仓库统计步骤时，在控制事务中保留/延长该仓库 15 分钟冷却；页面快照步骤不修改统计冷却。同一个冻结 run 可以续跑。selected 的 order 同样由服务端执行，selection.order 保存解析后的顺序。complete 数据与有记录的 limited 数据均受覆盖回退保护。

工厂 GitHub 响应在流式读取时限制为 4 MB，超过即停止读取，避免在大 manifest 解码后才限容；其他旧 API 保持独立的 20 MB 响应边界。

保存事务入口会验证本批所有 fence 时间的最大值；若租约已失效则整批回滚，避免前面的写入通过而最后 CAS 失败。已记录 requests 包括成功记账的错误/重试调用；崩溃或取消后的未提交在途调用可能额外消耗 GitHub 配额，不能据此反推出精确计费。

## Refresh depth

Daily quick refresh updates the current starred view. Weekly deep refresh calibrates
history across its configured scope. Depth and repository membership are separate;
both modes publish the same snapshots and preserve prior good data on failed reads.
Quick mode reuses complete pinned commit/manifests evidence only when the verified
head and rolling window permit it. Immutable commit history can stop at a verified
baseline intersection. Mutable Issues, PRs, Actions, releases and contributor lists
must not stop merely because an old ID appears: old records can change, disappear,
or move between pages. Current open Issue/PR lists are fully reconciled within the
existing request, pagination and storage limits. Deep mode rebuilds all bounded
source evidence, including unchanged-head resources.

Source provenance remains distinct from the last successful check. Reused code
evidence records its original `sourceFetchedAt`; missing/incomplete evidence causes
normal collection. A failed or limited read never refreshes the age of retained data.

## Stars and automatic refresh

Giraffe stars belong to `(account_id, repository name)` and never modify GitHub
stars. `POST /api/repos/:owner/:name/star` accepts `account_id` and `enabled`.
The first star initializes daily 08:00 quick and Sunday 04:00 deep schedules;
existing settings, including disabled schedules, are preserved. Times use the
fixed Asia/Shanghai offset. Names are case insensitive; a renamed repository must
be starred again after catalogue synchronization.

`GET /api/refresh/settings` reads stars and schedule status without side effects.
`POST /api/refresh/schedules/:kind` saves `account_id`, `enabled`, `time` (HH:mm),
`weekday` (Sunday=0), and `scope` (`starred` for daily; `all` or `starred` weekly).
Settings are per account and remain active when another account is selected.
A starred repository excluded from statistics still receives detail snapshots.

The existing minute cron checks at most ten due schedules and writes normal
leased runs through the same planner as manual refresh. Occurrence request keys
make restart/duplicate dispatch idempotent. The insert also verifies that the
schedule is still enabled at its original due time. Active runs, cooldowns and
missing catalogues defer the occurrence; safe status codes appear in settings.
A missed occurrence runs once when service recovers, then advances to the next
future wall-clock time. Empty starred sets record a skip and advance. Weekly deep
wins equal-time ties; daily waits for it to finish. Queue outage recovery uses the
existing durable outbox. Disabling a schedule stops future occurrences, not an
already accepted run; pause/cancel controls remain available for that run.

Migration `0007_refresh_schedules.sql` adds account-cascaded stars and schedules.
Apply it before the new Worker. Rollback the Worker without dropping these tables;
previous snapshots, immutable evidence and run rows are retained.

## Page scope and daily collection

Cross-repository business pages default to the account's Giraffe stars and expose a
Starred / All filter. Apply the scope before aggregating tables, totals, charts and
rankings. Statistics participation remains an independent policy; a starred repository
excluded from statistics still has its detail snapshots refreshed. An empty star set
stays empty and offers the complete catalogue rather than silently switching scopes.
Repository URLs identify a specific repository and are not hidden by this filter.
Settings, automatic schedules and run history are account-level control surfaces.

Business snapshot GETs accept `scope=starred|all`; omitted scope reads the ordinary
saved projection. GET remains local, read-only and never starts collection. Scope
changes cannot change the schedule or issue upstream writes. Notification bulk-read
in starred scope affects only that scope's saved unread threads; the account-wide
GitHub bulk endpoint is reserved for an explicitly all-scope action. Read-through
updates preserve notification collection time.

New daily starred plans include the repository list and notifications, the existing
selected statistics/detail work, explicit selected Insights derivation and publication.
A single repository therefore has 22 logical steps in a daily plan, versus 19 for a
manual selected run. Missing or day-old factory catalogues are refreshed through an
idempotent persisted preparation run before accepting the scheduled refresh. The
original occurrence stays due while preparation is active. A terminal preparation
failure records `catalog_incomplete` and advances to the next occurrence so one
failed idempotency key cannot block future days; accepted plans remain frozen.
Successful repository detail reads merge into account snapshots and record
`repository_fetched_at`. Missing global baselines can retain scoped evidence with an
explicit incomplete global flag; they never invent complete account coverage.

Page freshness describes the selected primary data, not the latest task, unrelated
repository, derived GET time or content edit time. Mixed source times and missing
coverage remain visible. Issues/PRs include successfully checked zero-row repositories
in scope freshness. CI derives its scope before totals and considers saved dependencies.
Insights uses refreshed selected sources; optional unavailable security does not prevent
core derivation. Assessment source time and report-generation time remain separate.
The browser re-reads saved data while visible and on focus; background tabs pause.

## Dashboard time presentation

Dashboard timestamps use the browser's local timezone, including refresh history,
CI runs, assessment windows and scheduled next-run times. Storage and API instants
remain UTC. Preaggregated days retain their original bucket boundaries; charts,
ledger rows and detail filters show those boundaries as local intervals, inclusive
of the start and exclusive of the end. Local dates on axes identify the interval
start, not a regrouping of observations. Schedule wall-clock configuration remains
explicitly labelled Beijing time; changing the viewing timezone does not reschedule jobs.
