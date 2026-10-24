# 09 — 持久化工厂刷新

## 调查与约束

2026-09-16 生产 D1 备份：471 条 factory 记录，13,077,011 UTF-8 字节（SQL 按 BLOB 长度统计）。总览 run 停在清单第 6 页（60/114，纳入 37 仓库），259 个流均 pending；旧的 469 条资源仍在。旧实现重启即覆盖总览、资源 runId 与总览强绑定，浏览器离开后没有执行者。备份保存在忽略目录，禁止提交账号信封或私有事件。

依据 Cloudflare 官方 [Worker limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)：isolate 128 MB；waitUntil 在 HTTP 返回后最多 30 秒；队列/cron 每次最多 15 分钟 wall time；D1 行最大 2 MB、batch 为原子事务。项目仍限制 GitHub 40 次、D1 80 statements，每页超时 15 秒。不能靠一个超长 HTTP 或 waitUntil 承担完整调查。

## 计划与执行

- D1 is the source of truth. The refresh center at `/refresh` is the only collection entry point. Each run freezes its factory repositories (`repos`), detail targets (`siteRepos`), order, window and steps. New plans use the same resolved account-owned members for factory streams and detail pages: all includes owned archives and forks, daily uses starred-owned members, and selected/filter/stale/failed scopes stay within ownership. There is no statistics override, mirror exception or excluded-member detail-only lane. Previously frozen active and historical plans remain unchanged.
- For N resolved owned repositories, a deep full refresh has `18N + 8` logical steps: six site snapshots including Insights, contributions, nine factory steps and nine detail tabs per repository, and publication. A manual scoped refresh has `18N + 1` steps; one selected repository has 19. Quick full/daily refresh also adds one activity step per repository and one activity-contributions step: daily has `19N + 6`, or 1,146 steps for 60 repositories. Catalog discovery has four steps. Historical frozen plans can retain different factory/detail counts. New plans contain no AI checkpoints; frozen old AI stages retire without provider calls while other collection work continues.
- Catalog runs retain four steps: inventory, site catalog, restore and publication. Full refresh requires complete statistics and site catalogs; non-selected scoped runs require a complete statistics catalog. A selected known repository does not require a complete site catalog. Full refresh still reports `catalog_changed` when discovery finds repositories outside its frozen site targets; synchronize the catalog explicitly before including them.
- Dependabot REST alerts use the `after` cursor from GitHub's next Link header; the endpoint rejects numeric `page` pagination. Resume checkpoints preserve the cursor, repository and original filters. Other REST streams retain sequential page validation.
- Each queue message claims once, checkpoints every accepted step/page, then schedules a continuation. Site Issues/PRs/alerts retain their ten-repository chunks and staging cursors; lists become visible only at publication. The minute cron repairs missed dispatch. Queue messages contain only the run ID, never tokens or events.
- A 40-second lease fences every write by run ID, token, version, unexpired lease and running status. Intermediate saves atomically advance the version while retaining ownership; the final save releases it. Controls invalidate ownership without undoing prior checkpoints.
- A dead invocation can lose at most one in-flight step per parallel repository, never an accepted step/page checkpoint. Request accounting can omit requests only from those in-flight steps. Event-ID deduplication and fenced publication prevent duplicate results.
- 临时失败按 30/60/120 秒退避，最多 3 次重试；GitHub 限流遵循 Retry-After/reset，未知时至少 15 分钟，任务保持可恢复。401 暂停等待更新凭据。统计仓库失败只跳过后续统计步骤；页面数据失败不会阻断其他页面。权限不足、来源缺失/截断、清单变化不无效重试；保留旧快照及原时间，不伪装成功零值。
- 账户启动冷却 60 秒；每个统计仓库尝试后冷却 15 分钟。服务器时钟决定下次允许时间；客户端仅显示倒计时。全站刷新允许统计仓库为空或都在冷却，仍更新页面数据。暂停保留唯一活动 run，取消释放活动槽并保留已提交数据；新 run 不会与旧执行者竞争。

## v0.23 invocation budgets and persistence

The earlier 80-statement investigation figure is historical; these factory-only
limits supersede it without changing other API paths.

New work starts before 25 seconds of invocation wall time, below 40 GitHub
requests and 600 executed D1 statements plus staged writes across every lane.
Request slots are reserved before asynchronous admission; wall, stop and statement
budgets are rechecked after waiting for the shared heartbeat lock. Pending writes
waiting for acceptance count toward admission, and concurrent reads are counted
even while a D1 batch is running. Every request checks the wall budget,
reserving five seconds for checkpointing; individual fetches
retain their 15-second timeout. Step boundaries and requests renew the 40-second
lease when at most half remains, never beyond the absolute run deadline.
The factory-only D1 hard cap is 800 statements, leaving 200 for checkpoint/error
handling after admission closes and another 200 below D1's paid-plan limit of
1,000 queries per invocation. Other API paths keep their 80-statement cap.
Budget yields preserve cursors, keep errors null and do not spend retry failures.
No queue, cron, deployment or Cloudflare configuration changes are required.

The in-code `FACTORY_REPO_CONCURRENCY = 4` pool runs up to four different repositories
inside one invocation. Each repository keeps its planned metadata, stream, commit,
snapshot and activity order. A lane saves each accepted step/page before starting
another, then immediately takes the next eligible repository instead of waiting
for the slowest member of a fixed batch. One request/statement/wall budget belongs to
the invocation, not to each lane. Four GitHub fetches can overlap, while journal,
heartbeat and checkpoint writes are serialized. The 40-request ceiling and the
800-statement hard cap are not multiplied by pool width.

Stream pages share an invocation resource cache, with an atomic fenced save after
each accepted page. Publication, global snapshots and Insights remain serial
boundaries. Repository activity shares the pool and can consume several pages
per invocation; it follows its own repository's planned prerequisites instead
of waiting for unrelated repositories. Drained repository work can continue to
the next eligible global step in the same invocation when budgets permit. Snapshot collection
replays already staged responses locally and saves each newly fetched page in
bounded, run-owned resources. This splits slow Actions and other paged snapshots
without changing list results or fetching accepted pages again. Lost ownership
rejects the in-flight writes, not earlier committed checkpoints. Missing repository
payloads are fetched before taking the projection lock; shared global snapshot
read/modify/write projection holds that lock through atomic acceptance so one
repository cannot overwrite another's accepted rows. Newly fetched replay pages
renew the lease after the response and before processing/projection; replaying
an accepted page adds no heartbeat. This prevents a slow response plus local
processing from consuming the remaining lease before its page can be saved.

When resuming an accepted Actions stream, its persisted source owns its cursor.
A v0.22 filtered `created=...` stream continues from its saved `next` and pending
split-window ranges, retaining accepted events and page counts. Its filtered page
number is never treated as an index into the unfiltered `actions-source` cache.
Shared raw history can still be collected independently for later snapshots.
The cross-version fixtures come from the real `12d4612` collector, including both
a page-2 checkpoint and a split-window checkpoint with a queued range.

Issues/PRs with a saved partial resource continue its original `next` rather than
starting the new incremental strategy. Legacy baseline events without audited
update timestamps do not qualify for incremental collection. Site Issues/PRs/
alerts keep their existing `snapshot:{resource}` chunks and `snapshotCursor`;
new replay keys are separate. Cross-version fixtures from `12d4612` verify that
accepted ten-repository chunks survive and only the remaining repositories are
queried before staged snapshot publication, without recollecting accepted groups.

Each repository's executor checkpoint uses the existing run-owned
`factory_resources` stream `executor:checkpoint`. Acceptance copies all of that
repository's step statuses, including deferred activity skips, into the central
run and preserves other lanes' in-flight journal entries. Staged SQL is rebound
to the latest central version only for the same run and lease token; the original
token/version/expiry/status fences still gate the complete transaction. A failing
lane stops new admission, and late results cannot overwrite accepted checkpoints.
Failure logs include progress accepted before the failure.

Before parallel checkpoint reads, the pool freezes the invocation's startup run.
An older single-repository root is identified by its run/repository IDs and
successful metadata, not by a cursor that may already be past its repository.
The first accepting lane atomically seeds that root into `executor:checkpoint`
alongside its own save, without replacing an existing per-repository checkpoint.
This protects the old repository even if its lane yields before its first save,
another lane returns first, or the commit acknowledgement is lost. Invalid or
global roots are not seeded; pending protection writes share the statement budget.

Uncaught executor errors release only their own fenced lease. Queue retries use
5/10/15 seconds based on delivery attempts. A live-lease collision returns its
deadline for delayed redelivery instead of silently dropping the message.
Queue 10250/429 sends retry after 0.5/1/2 seconds, recomputing delay against the
original target; exhausted sends remain observable and cron remains a fallback.

A platform cancellation does not run catch/release or request an explicit retry.
Only already accepted atomic checkpoints survive; each pool lane has at most one
unfinished step. The remaining lease is at most 40 seconds after cancellation.
A prompt duplicate delivery schedules against that expiry (less than one second
of queue-delay rounding). With no redelivery, healthy minute-cron recovery takes
less than 40 + 60 = 100 seconds to enqueue eligible work in the worst phase,
plus queue delivery and execution latency. It cannot promise sub-90-second
cron-only recovery without changing scheduling configuration. Queue overload or
platform delivery delays prevent a hard production wall-time ceiling. Leases
created by an older deployed version retain their stored expiry.

Migration `0025_factory_run_journal.sql` adds an account-cascaded, run-owned table
for invocation counts and small audit JSON. Claim reads the payload once, takes a
version-CAS lease without `RETURNING payload`, and increments `invocations`. The
executor journals attempt/start metadata before work and completed durations
before starting subsequent work and before final save. Request counts accumulate
in memory and flush with the existing step audit/checkpoint, not once per fetch.
Cancellation or abrupt death can omit requests only from the one in-flight step
per active repository (at most four in the pool).
A crash during an unfinished fetch
cannot reconstruct elapsed time after its last checkpoint. Completed audited
durations survive replay. Retry high-water marks survive unsaved successes, so
repeated final-save crashes cannot reset the retry limit indefinitely. Pages,
business status, activity contributions and cursors stay in each checkpoint transaction,
not the audit journal. Pause/cancel materialize audits while invalidating ownership.
Controls compare both the run version and the journal in a transaction preflight;
a concurrent audit update returns `account_conflict` rather than dropping counters.
Pause/cancel apply repository cooldowns to every metric repository attempted in
the unsaved batch, not only the repository at the durable cursor. Journal-overlay
running steps identify those attempts before controls change their statuses;
completed work from earlier batches and untouched repositories are not extended.

### Observability

Each executor emits one `console.log` JSON line with
`event:"factory_invocation"`, `runId`, `cursorStart`, `cursorEnd`, `stepsDone`,
`requests`, `statements`, `stagedWrites`, `elapsedMs`, and `endReason`.
`operation` locates the failure in `claim`, `heartbeat`, `step`, or `save` without
exposing SQL or upstream payloads.
Reasons are `wall`, `requests`, `statements`, `snapshot_boundary`,
`publish_boundary`, `yield`, `completed`, `lost_lease`, `save_failed`, `error`,
or `run_end`. Filter Workers Observability on this event and the run ID.
Separate `factory_consume_error`, `factory_queue_send_error`,
`factory_continue_error`, `factory_prune_error` and `factory_lease_release_error`
events expose dispatch/recovery failures. Error objects contain safe normalized
`name`, `code`, and `message`; raw upstream bodies, SQL, stacks, tokens and arbitrary
exception text are never logged. A platform cancellation may prevent the final
log; durable step checkpoints and the journal still establish its last progress.

Sparse step encoding omits only zero/null defaults for attempts, pages, duration,
timestamps and errors. API decoding restores every required field; kind, repo,
status and non-default audits remain stored. This avoids a per-step table join and
preserves existing SQL progress projections, at the cost of still serializing a
single bounded payload once per save. Large checkpoint/contribution data remains
bounded in that payload rather than adding another persistence subsystem. The
codec fixture reduces its default plan below 80% of the original JSON size.
Journal bytes are included in storage telemetry and cascade with retained runs.
Public refresh/factory shapes remain unchanged except the additive run field
`invocations`, counting successful lease claims, including recovery invocations.
The field is omitted when no positive count exists, including runs predating
v0.22.0 unless a later recovery starts recording claims. Missing is not measured
zero. Compare positive counts with executed steps/pages, `requests` and measured
`finishedAt - startedAt` for matching execution kind, depth, scope and workload;
wall time per claim includes scheduling/backoff and is not Worker CPU time.
The machine `/refresh-runs` list exposes this optional field; its separate compact
`/refresh-runs/latest` summary does not. See the [consumer measurement contract](api.md#get-refresh-runs).

Historical v0.22 local fixture measurements (no real network latency): a 19-step selected run uses
5 invocations; a 60-repository quick daily plan preserves all 1,146 steps and
publishes in 320 invocations with 1,270 fixture GitHub requests. Compared with at
least 1,146 one-step invocations, the latter removes 72% of handoffs. The observed
production baseline of about 1,570 invocations / 1,845 requests is a different
workload, not a paired benchmark. More pages, slow requests and D1 latency can
raise the new count. This is not evidence of a 15–20 minute production duration;
measure `invocations`, requests and wall duration on the next authorized scheduled
run before making a speed claim.

The v0.23 deterministic warm 60-repository benchmark (`bun run
scripts/factory-benchmark.ts --selection selected`) executes the real runner,
SQLite and the existing fake-GitHub response model with a virtual clock. Fixed
brief-derived page latencies, prior-day warmup, zero D1/CPU/queue-delivery latency,
and no injected production stalls are explicit assumptions. Baseline `12d4612`
publishes 1,146 steps in 426 invocations / 1,651 requests / 41.678 simulated minutes;
P1 `e8a8372` uses 274 / 1,669 / 42.004; the pushed serial-repository candidate uses
166 / 1,221 / 23.898. The four-repository pool publishes all 1,146 steps in
173 invocations / 1,213 requests / 7.158 simulated minutes (429,453 ms).
Two identical replays confirm deterministic results. Peak request concurrency
is four; summed request service time is 1,425,170 ms, while request wall time is
429,453 ms. Including warmup, no invocation exceeds 40 requests or 619 executed
D1 statements. This is below the twenty-minute simulation target, not a production
finish-time guarantee. Configuration and migrations are unchanged.

The B16A `b16a-60-repo-v2` harness adds real account collectors (including nine
notification pages), 205 activity pages with 299 seconds of request service,
and a declared 2.3-second continuation delay. A warm selected daily executes
all 1,146 steps through the actual runner and SQLite on both frozen sources.

| Daily measurement             | v0.23 source | B16A candidate |
| ----------------------------- | -----------: | -------------: |
| Simulated minutes             |       24.594 |          9.356 |
| Invocations                   |          326 |             50 |
| Requests                      |        1,366 |          1,356 |
| Average busy repository lanes |        1.193 |          3.226 |
| Four lanes busy               |       18.63% |         78.80% |
| Account span, seconds         |       42.500 |         42.500 |
| Factory span, seconds         |      329.509 |        407.485 |
| Snapshot span, seconds        |      188.244 |        494.161 |
| Activity span, seconds        |      906.200 |        113.017 |

The after spans overlap and must not be summed. Exclusive wall allocation
(equally dividing phase overlap and assigning idle gaps to the preceding phase)
is account 42.500, factory 209.722, snapshots 246.419, activity 60.391,
Insights 2.300 and publish 0 seconds. Zero CPU/D1 cost makes Insights/publication
service zero; this is a declared simulation limitation, not a production claim.
An earlier frozen all-scope 1,149-step fixture improves from 31.881 to 16.869 minutes.
Its 515.463-second account prelude is a different workload, not the selected
daily's prelude. Neither fixture reproduces the production startup interruption
or real D1/CPU/queue latency, and Actions age distribution is synthetic. The
real daily under-twenty-minute target remains unverified; no production refresh
is triggered for these measurements.

Pool regressions kill work after four accepted metadata steps and during a later
save, then assert byte-equivalent accepted step records, one retried in-flight
step per repository and complete publication. A separate test holds all four
commit requests across the actual 40-second lease expiry, lets a replacement
invocation finish, and rejects every late result from the former lease. Rate-limit,
shared snapshot projection and budget-admission tests cover cross-lane state.

The `22a88190` ellie incident (October 23, 2026, steps 826–828) also has a
snapshot-specific regression. Four real SQLite-backed pool lanes accept consecutive
details/actions snapshots and a traffic-view replay page before all clone fetches
are suspended. The old consumer remains suspended without catch/release, ack or
retry until the replacement publishes. Real dispatch/claim code rejects an early
takeover, preserves accepted payloads and audits, retries only the unfinished
traffic step per lane, and never refetches an accepted view page. A delayed
redelivery resumes at 40.001 seconds; the deliberately worst-phase cron resumes
at 99.999 seconds. Late responses are released only for fixture cleanup after
publication and cannot change the final run. These are deterministic scheduling
bounds with immediate queue delivery, not a simulation of Cloudflare's scheduler.

Tests that previously assumed one step per call now stop explicitly at metadata
admission boundaries or follow persisted `nextAttemptAt` for retries. Metadata
call assertions count that operation rather than unrelated later streams. Existing
publication, retained-source, window, cooldown and terminal-status assertions remain.

### Downgrade preparation

v0.23 recovery and the repository pool use the existing `0025` schema; no migration
or old-row rewrite is required. Earlier in-flight leases remain valid until their
stored expiry. Before downgrading to a pre-pool v0.23 build or v0.22, drain active
runs under separately authorized maintenance. If work must be paused, retain it
without resuming it on the old executor: that executor cannot restore several
unfinished repository checkpoints safely. v0.22 also lacks page replay. Immutable
publications remain intact; pausing alone does not make old-executor resume safe.

Do not deploy a v0.21.x reader directly over compact v0.22 rows: missing numeric
fields otherwise become `NaN` on old executor arithmetic. The additive table can
remain, but payloads must be expanded before old code resumes. This is an offline
rollback operation, not a runtime compatibility path or automatic migration.
1. Under a separately authorized maintenance window, stop new manual/scheduled
   run creation and queue/cron execution. First use v0.22 controls to pause active
   runs or drain them to terminal state; wait for in-flight requests to settle.
   Do not rely only on stopping the browser. Prove no running rows or leases remain
   and no paused row has an unmaterialized journal. Take and retain a fresh export.
2. Rehearse the following projection on a local copy of that quiescent export.
   Record account, snapshot, resource and publication digests and preserve all
   additive tables. Do not delete historical runs, publications or journal rows.
3. Apply the tested projection to the quiescent database only through separately
   authorized rollback operations; this implementation/test task never runs it on
   remote D1. Keep all writers stopped during projection and reader replacement.

```sql
SELECT COUNT(*) FROM factory_runs
WHERE status='running' OR lease_token IS NOT NULL OR lease_until IS NOT NULL;
SELECT COUNT(*) FROM factory_run_journal AS journal
JOIN factory_runs AS run ON run.id=journal.run_id
WHERE run.status='paused' AND journal.journal<>'{}';
-- Both preconditions must return zero before projecting any rows.
UPDATE factory_runs SET payload=json_set(payload,'$.steps',json((
 SELECT json_group_array(json_set(value,
 '$.attempts',coalesce(json_extract(value,'$.attempts'),0),
 '$.startedAt',json_extract(value,'$.startedAt'),
 '$.finishedAt',json_extract(value,'$.finishedAt'),
 '$.durationMs',coalesce(json_extract(value,'$.durationMs'),0),
 '$.pages',coalesce(json_extract(value,'$.pages'),0),
 '$.error',json_extract(value,'$.error')))
 FROM json_each(factory_runs.payload,'$.steps'))))
 WHERE json_type(payload,'$.steps')='array';
```

4. Verify all expanded step fields exist, numeric audits remain finite, row counts
   and unrelated digests match, and old `JSON.parse` readers can read every run.
   `factory-run-codec.test.ts` executes this SQLite projection twice, preserves
   non-default audits and verifies old-reader increment arithmetic. Run migration
   verification and old-version local suites against the backup before deploying
   that reader, then restore scheduling/dispatch and resume paused runs. Retain the
   export until the rollback is accepted. Journal-only invocation telemetry is
   retained in the additive table even though old code does not update it.

## 数据发布与兼容

迁移 0001 新增 factory_runs、factory_state、factory_resources、factory_repo_versions、factory_repo_state；0002 新增 factory_version_refs 和 factory_storage（含资源字节计量触发器）；0003 的 factory_budget 与触发器计量运行、资源、仓库状态/版本、所有 factory 快照及引用清单，均外键级联至账号。迁移只 CREATE IF NOT EXISTS，不改写/删除旧 snapshots。初始化 schema 包含同样 DDL；部署运行 migrations apply。

采集流存于 run staging；仓库全部流结束后，在同一 fenced batch 发布不可变仓库版本和当前指针及健康元数据。失败仓库保留当前指针，更新错误/耗时/重试状态。全局发布从已提交仓库版本构建，持久化完整版本后原子切换 factory_state.published_id。运行期间保留上个全局版本，仓库进度可独立显示新 refreshedAt。详情按所展示的版本定位资源，不因新 run 开始失效。

每仓库携带数据源窗口/版本，混合时间的 last-known-good 必须明确标识；不得把不同时间窗口当作同次全量调查。catalog restore 仅在缺少新全局版本时，从旧资源恢复旧指标、覆盖度、原始时间，保留 legacy 数据，不能把恢复标成刚采集成功。无法恢复的旧资源注明缺失。

Ordinary pages reuse `prepareRefresh` and the existing snapshot format. New full-site plans refresh the catalog, Issues, PRs, alerts, notifications and Insights before repository statistics. Insights is an explicit local derivation step: this run's catalog and Issues must succeed; optional alerts and notifications never block it. Plans with explicit Insights do not derive it as a side effect of other page writes. Existing frozen plans retain their implicit derivation.

Each invocation commits its staged pages together with the run cursor in a fenced batch, leaving prior visible snapshots unchanged. For new runs, final publication atomically promotes the accepted staged pages, activity and source heads together with `publishedAt` in one fenced transaction. Completed or partial runs can publish; retained or untouched sources keep their original run and timestamps. Resumed pre-upgrade runs may already have exposed independent page writes, so they keep `publishedAt: null` and do not claim this cross-page atomicity guarantee. Cancellation fencing prevents stale writes. Separate reader requests can still straddle a later publication; pin a run ID when reading immutable history.

Coverage retention is per stream, not per repository. Repeated dependency parse
limits, complete-to-incomplete regressions and shrinking observed limited streams
retain only the affected stream's items, metrics and coverage. Other streams and
repository metadata advance to the current run. Any retention sets repository
state to `partial` with `coverage_regression_retained`, and marks the publication
as mixed. Dependency parse diagnostics still use the publication's
`dependencyLimit` overlay; a fully recovered dependency stream clears it.

Retained coverage has `retained: true` and an `observation` carrying its original
run, window, observation/publication timestamps and source head. `/sources` and
stream reads preserve that stream's original version, `observedAt` and freshness;
they never borrow the enclosing repository's new observation. Both endpoints
derive stream freshness from the served coverage: `total:1`, `missing:1` for
non-complete coverage or an absent/invalid evidence timestamp, otherwise zero.
Valid original timestamps remain the freshness bounds even for limited evidence.
Thus retained limited streams have missing coverage, while retained complete
streams have complete but potentially old evidence; neither acquires the new
publication's age. This does not change account-level repository freshness or ETA.
The current run
stores an immutable `retained:<stream>` evidence copy alongside, not over, its
original collected resource. This keeps retention bounded by existing run and
publication roots, preserves original content metadata, and leaves current-run
activity inputs intact. Quick baselines use the retained stream's original head
and window. Missing or mismatched retained payloads are explicitly unavailable,
never complete coverage with an unresolved source reference. Both scheduled daily quick and deep/manual runs use this same commit
path: an included repository with parse-limited dependencies advances its healthy
factory sources on the next successful run, without a separate backfill.

No schema migration or historical-row rewrite is needed. After mixed stream
versions have been written, any rollback build must retain the stream observation
and `retained:<stream>` reader contract; an older whole-repository reader cannot
safely interpret these versions. Preserve saved evidence and publication roots.

The browser uses only the refresh console; it does not call the existing `POST /api/refresh` endpoint. The scheduling schema is described below.

The console lists this run's result for each page, distinguishing updated, partially updated, pending, retained and unplanned data. Factory publication cannot imply success for the repository catalog or other pages. CI reads the saved repository details, Actions and releases. Settings and project identity remain configuration/reference reads, not GitHub collection snapshots. Optional security collection diagnostics appear only in the refresh console. Other pages show available alerts or a neutral empty state; missing security data is not presented as a verified zero and does not add a coverage warning to repository, Insights or factory pages.

## 迁移与回滚

Before an authorized deployment, export D1 and record row digests. Run
`bun scripts/verify-factory-migration.ts <local-export.sql>` against a local backup
copy; the verifier checks preserved account/snapshot rows and repeat application.
Observation, run and publication history must remain intact. Configuration rows
have explicit exceptions: `0016` removes existing stars matching false statistics
overrides and empties all overrides; `0017` adds owner provenance and deterministic
timestamps to surviving stars. Verify those exact expected changes, not a blanket
claim that every old row remains identical. See the affected-row query and full
[migration contract](03-schema.md#star-membership-consolidation). After separately
authorized deployment, compare preserved-row digests, schema and publication
consistency. This batch performs no production export, migration or deployment.

Do not roll back to a pre-provenance Worker: it would treat owner-unstar tombstones
as stars and could erase their protection. Use provenance-aware rollback code, or
an explicitly approved pre-migration backup restoration procedure. Retain additive
tables, columns, tombstones and versions; stopping queues/cron does not make old
star semantics safe. Never clear data merely to roll back. Follow the
[star provenance rollback requirements](03-schema.md#star-provenance).

## UI 与验证

The factory links to `/refresh`. The dedicated page contains manual plans, automatic schedules, execution progress and history. Navigating away stops browser polling but never stops the persisted server task.

The center has progress, start and automatic-refresh tabs. Progress separates success, failure and skipped work; 100% processed does not imply complete data. Full refresh processes global lists and Insights first, then contributions, factory streams, repository pages and publication. Manual scoped refresh omits contributions and labels the page phase as repository pages; scheduled daily refresh includes contributions. Empty stages are omitted. External analysis is independent of collection completion and publishes reports through the machine API. Old pending/running cloud AI stages are skipped with `cloud_ai_retired`; later non-AI collection and publication continue. New repository rows expose factory and detail steps for the same resolved owned members; historical frozen plans may retain a different split. Catalog discovery retains three visual phases and four logical steps. Problems are grouped by step and diagnostic code, with their possible causes, data impact and recovery actions. Raw codes, timestamps, page counts and storage diagnostics remain collapsed. Permission causes are not assumed; truncated sources do not promise recovery on retry, rate limits explain automatic continuation, and pause/failure states explain retention of saved data.

The default scope is full-site refresh. Manual selection, filtering, stale-data refresh and failed-repository retry restrict both statistics and detail work to the resolved repositories. They do not fetch unrelated repositories, account contributions or notifications. Successful detail snapshots merge their repository into existing catalogue, Issues, PR and alert snapshots. Unrelated rows and the original full-scan timestamp are retained; `repository_fetched_at` records partial updates. Insights reads derive from the updated saved sources. Missing global baselines require a full refresh; a partial run cannot invent full coverage. Factory publication merges the accepted repository versions with existing observations and retains contribution provenance. External consumers read accepted source versions separately. Manual selection searches the statistics catalog; page filters apply only to the explicit filter scope. Priority changes order, not membership. Frozen active and historical plans are never rewritten; cancel an old broad plan and start a new scoped run to use this behavior. Missing required snapshots still link to `/refresh`; missing optional security snapshots use a neutral empty state. All page reads remain read-only. Polls remain serial, slow down while hidden, back off on errors, and keep operation errors separate from polling errors.

范围和历史记录选择使用带标签的 Basalt Select，仓库勾选与优先级使用 Basalt Checkbox/Input；标题、正文、辅助文字遵循全站 16/14/13px 层级。移动端对话框内部滚动，保持关闭和返回操作可达。

Tests verify refreshed data through 17 page API reads without upstream calls or writes, explicit Insights success/failure, optional alert failures, and per-page console results. Tests cover scoped plans against a 161-repository site catalog, all four scoped selectors, unchanged full-site coverage, upstream request isolation, preservation of unrelated snapshots and timestamps, contribution provenance, publication, cooldowns, retries, leases and controls. Browser coverage verifies that one selected repository shows 19 total steps, nine detail pages and only one repository row. Tests verify that retired cloud AI stages cannot invoke providers or block non-AI collection. Automated checks use local GitHub fixtures only.

## 实现边界与审查处理

资源继续使用既有有界 JSON collector：每流 5,000 项 / 1.2 MB，事件 ID 去重和 next/ranges 与 run checkpoint 在同一 fenced batch 保存。因此不依赖 JSON 之外的无界事件列表；重复页不改变已提交进度。完整 run payload 在每次保存前检查 1.8 MB 上限，最多 500 仓库。超过规模时失败保留旧版本，而不悄悄截断计划。

publication 实体复用 snapshots 分页容器：`factory:v:<run-id>` 是不可变全局组合，repo.observation 明确引用资源版本；`factory:catalog:<run-id>` 是清单实体。factory_state 的两个指针与对应实体在同一 fenced batch 提交。这里不再重复建另一套 JSON 分页表。schema 的字符串指针由事务和一致性测试保护。

Grok、Pi 的第一轮架构审查均指出体积、fencing、publication 映射、catalog 完整性与混合窗口语义需要落成代码。这些边界已有实现和测试。公开进度排除内部 checkpoint；历史只返回最近 20 次。引用中的历史版本保留，避免恢复或回滚时删除唯一事件副本。0002 引入显式 publication→资源版本引用清单。刷新调度与到期任务派发仍每分钟执行；每小时清理事务最多删除 50 条过期快照、100 条已失去 publication 的引用、50 条无引用仓库版本、50 条无引用资源与 50 条无引用 run；仅处理 7 天前且不属于最近 20 次运行的数据。当前仓库指针、当前全局/清单指针、最近两个全局版本和所有保留 publication 引用均为保留根。legacy snapshots 永不进入清理条件。Storage telemetry is maintained by existing triggers and includes ordinary pages, legacy daily baselines and AI records (excluding D1 index/free-page overhead). It does not impose an account-wide storage quota or block refresh/AI work. Per-resource, per-record and request limits remain enforced; full-site batches still reject lossy publication above 1.5 MB. Reference-safe retention remains unchanged. Cron attempts cleanup in a `finally` block only when the controller's scheduled time has UTC minute zero, even if scheduling or queue dispatch fails. Delayed events retain their scheduled-time eligibility; cleanup cutoffs and lease/schedule calculations use current processing time. This hourly gate does not guarantee exactly-once delivery.


## 发布审查后的边界

Starting a run and account cooldown remains one D1 batch. Claim acquires the lease and increments invocation telemetry without rewriting the payload. The executor normalizes the cursor and journals attempt/start audits before GitHub, never reviving completed steps. Credential pauses consume no network retry budget; each page retains at most three transient retries and honest attempts/requests.

Queue concurrency remains unchanged at two consumers; the unique active run and lease keep each account serial. After a bounded batch, continuation returns to the queue tail rather than enqueueing the entire repository plan.

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
New quick runs freeze 30 UTC calendar dates for collection; deep runs freeze 90.
Existing runs keep their persisted collection window through upgrade/resume.
Stream filtering, event summarization and contribution collection use that frozen
window. At repository commit, prior published day buckets outside the new window
are retained, capped at 90 UTC calendar dates ending at `run.window.until`.
Buckets inside the new window come only from the new run: missing new buckets are
not filled from old data, and overlapping dates are never summed twice. The dated
metric totals follow those buckets; non-daily measurements (authors, cycle samples,
current backlog and other status counters) retain their collection semantics.
The repository observation window is the union of that retained evidence and the
collection window, subject to the cap. A first quick publication remains 30 dates;
a narrower prior observation does not invent 90 dates of coverage.
When the display span differs, `observation.collectionWindow` preserves the actual
collection range used by raw stream APIs and incremental baselines. Expanded daily
summaries carry per-stream `coverage.completeWindows`: bounded, coalesced intervals
of complete historical evidence plus the new complete collection interval. Missing
or limited old evidence and gaps between runs are not certified as complete zeroes.
Stream retention keeps these daily coverage intervals while its raw source
observation continues to identify the original collection range.
The global snapshot window unions the included observation windows, rather than
unconditionally adopting the new run window. Factory and repository chart labels
follow the displayed UTC span: a quick collection can display up to 90 retained
dates. The default seven-day period comparison does not shorten that chart window.
Failed-stream `retained: true` paths and untouched repositories keep their original
source windows/timestamps and mixed-publication semantics; their older provenance
is not rewritten to satisfy a fresh-history cap.
Scheduled daily refresh also plans the account-wide contribution step, even for
starred selection. Manual selected refresh does not add that account-wide work.
The quick calendar uses one calendar request and two 15-day type batches; deep
uses one calendar request and six batches. Each batch has its own checkpoint;
checkpoint progress, request/rate accounting and publication remain fenced.
An interrupted or unavailable collection retains the previous good calendar and
its original provenance. Type details are optional/null where GitHub lacks them;
calendar totals are never reconstructed from a possibly mismatched type sum.
Successful contribution recollection applies the same outside-window union and
90-date cap, preserving retained per-day metadata and replacing new-window days.
Its total is the sum of calendar counts. Restricted totals include retained daily
attribution, or are `null` when that attribution is unavailable; optional type
coverage remains partial when retained breakdowns are incomplete. Without a new
calendar, both the saved calendar and its provenance window remain unchanged.
Merged calendar days retain their own `fetchedAt` and `observedAt`, filling absent
legacy timestamps from the original calendar rather than the new collection.
Date-filtered contribution reads compute freshness and latest timestamps from
the selected days; retaining a day never refreshes its evidence age.
Quick mode reuses complete pinned commit/manifests evidence only when the verified
head and rolling window permit it. Immutable commit history can stop at a verified
baseline intersection. Mutable Issues, PRs, Actions, releases and contributor lists
must not stop merely because an old ID appears: old records can change, disappear,
or move between pages. Current open Issue/PR lists are fully reconciled within the
existing request, pagination and storage limits. Deep mode rebuilds pinned code
evidence even at an unchanged head; mutable stream reconciliation is available
at either depth.

### Incremental mutable streams

Issues use REST `since`; PRs use updated-descending pagination and a timestamp
cutoff, not an unsupported `since` parameter. The watermark is the earlier of
the prior complete stream's fetched time and its frozen observation start, with
a one-second overlap. This includes updates made while the prior run was paging.
Only matching repository identities and complete, non-retained baselines qualify;
missing timestamps, limited/unavailable coverage and invalid baselines trigger a
full traversal. Additive event `updatedAt` records the REST update timestamp.

Delta items replace matching IDs in the baseline. Final open/closed/merged counts
must match current repository metadata; a mismatch or detected deletion restarts
a full collection instead of certifying a stale union. PR GraphQL state is refreshed
in bounded batches for retained items as well as changed REST items, since check
reruns need not move REST `updated_at`. Coverage remains partial during collection
and reconciliation, then becomes `complete` with `strategy:"incremental"` only
after validation. It describes the reconciled full stream, not merely the delta;
`sourceFetchedAt` identifies the baseline observation. Limits and failures retain
the prior good stream with its original source window and timestamps.

### Shared Actions observations

One run-owned, paginated unfiltered Actions source normally serves the factory
window, full Actions detail snapshot and successful-deployment history. Its
allowlisted rows contain the fields needed by both existing projections; page
and source writes commit with the run cursor. Complete history can also prove
that no successful deployment exists without a third GitHub traversal.

A new run can reconcile a complete same-identity prior source incrementally.
It probes the unfiltered total, refreshes the 30-day rerun horizon before the
baseline observation (extended to include any older nonterminal run), deduplicates
IDs, and checks the combined count against the probe before materializing complete
unfiltered shared pages. Stream metrics, snapshots and deployment history all
consume those same reconciled pages. Intermediate probes/delta pages retain
`partial` coverage, never an executor-terminal `pending` result. Missing/corrupt
baselines, historical-ID collisions, count drift and the filtered 1,000-run limit
restart full collection; an incomplete delta never becomes a complete snapshot.
Existing v0.23 unfiltered checkpoints continue their saved pages. A v0.23 Worker
that resumes a new probe can start normal full collection; later code recognizes
accepted unfiltered pages rather than resuming obsolete delta bookkeeping.

Large reconciliations stage pages under a run-owned temporary prefix in batches
of at most 20 source-write statements, leaving room for the shared four-lane
journal budget. An intermediate fenced checkpoint records materialization
progress with partial coverage; continuation reads the accepted delta rather
than requesting it again. The final fenced save promotes all staged pages to
the canonical prefix and marks the source complete atomically. Temporary pages
are never exposed as a complete history, and canonical v0.23 page keys and
payloads remain unchanged.

A complete full source is required for snapshot/cache reuse. If full history hits
the existing page/byte limits, the old snapshot is retained and the metric stream
uses bounded created-window collection, including the existing 1,000-run range
splitting. That explicitly limited case can require additional filtered requests;
it must not turn truncated history into successful zero or claim universal
single-pass completeness. Malformed shared pages are remembered as safe failures;
genuine transient errors keep the existing bounded retry policy.

Source provenance remains distinct from the last successful check. Reused code
evidence records its original `sourceFetchedAt`; missing/incomplete evidence causes
normal collection. A failed or limited read never refreshes the age of retained data.

### One-time history backfill after v0.24.2

Only after this fix is deployed, GitHub Guan Jia can request **one deep refresh**
to refill day buckets already overwritten by earlier quick publications. No
one-shot code flag or permanent daily-depth change is needed. A successful deep
publish reloads 90 UTC dates of event history; subsequent quick publications keep
days 31-90 through outside-window retention, with the oldest dates aging out.
This is an operator handoff, not an instruction for the implementation/review
agent to write production or hand-trigger a refresh.

Use the existing machine API with an account-bound token carrying `app:write`:
`POST /api/v1/accounts/<account-id>/refresh-runs`, `Content-Type: application/json`.
The exact full-refresh body is:

```json
{
	"requestKey": "6a8a64b0-164b-45bb-a7f5-dc441edcddca",
	"mode": "refresh",
	"depth": "deep",
	"scope": "all"
}
```

Generate a fresh UUID once for the logical backfill; preserve that same key/body
when retrying an uncertain submission. Do not send `account_id` in the body.
Full scope includes account contributions and every owned catalog repository.
For repository-only backfill, use `"scope": "selected"` plus
`"repos": ["nocoo/giraffe"]` (replace with the intended saved-catalog names);
manual selected scope does **not** recollect the account contribution calendar.
The catalog must already exist; full scope requires complete inventory. Wait for
any running/paused account run and cooldown rather than creating competing work.
Do not submit during the daily Beijing blackout, 00:50 through the end of 01:00.

HTTP 202 is admission, not backfill success. Poll the returned run via
`GET /api/v1/accounts/<account-id>/refresh-runs`, verify its published version and
per-stream coverage, then read saved factory observations to confirm the expected
90-date window and daily buckets. Failed/limited streams can retain older evidence
instead of refilling gaps. No schedule PUT, queue operation, migration or direct
deployment is part of this handoff. See the exact validation and idempotency rules
in [POST /refresh-runs](api.md#post-refresh-runs).

## Stars and automatic refresh

Giraffe stars belong to `(account_id, repository name)` and never modify GitHub
stars. `POST /api/repos/:owner/:name/star` accepts `account_id` and `enabled`.
The first star initializes daily 08:00 quick and Sunday 04:00 deep schedules;
existing settings, including disabled schedules, are preserved. Times use the
fixed Asia/Shanghai offset. Names are case insensitive; a renamed repository must
be starred again after catalogue synchronization.

`GET /api/refresh/settings` reads stars and schedule status without side effects.
`POST /api/refresh/schedules/:kind` saves `account_id`, `enabled`, `times` (1-6
HH:MM values, deduplicated/sorted), `weekday` (Sunday=0), and `scope` (`starred`
for daily; `all` or `starred` weekly; `all` for catalog). All kinds allow multiple
times; weekly uses one weekday, catalog requires weekday 0. Legacy `time`-only
writes set one slot; `time` reads as the earliest slot and must match it when both
fields are written. Fixed UTC+08:00 semantics are unchanged.
Settings are per account and remain active when another account is selected.
Daily membership is starred-owned; full membership is every owned catalog
repository, including archives and forks. There is no statistics participation
override. Non-owned repositories enter neither refresh plans nor denominators.

The minute cron writes ordinary leased runs through the same planner as manual
refresh. `nextAt` is the earliest unresolved occurrence and may remain in the
past while blocked. A due occurrence is accepted or receives a safe `lastError`
on the next healthy tick, within the five-minute requirement. Canonical occurrence
keys and transactional schedule guards prevent duplicate execution or a competing
missed audit. Advance from the settled due time, never from recovery time.

An active weekly, catalog or manual run is never cancelled for a daily. The daily
waits and is scheduled directly after terminal publication/save, without waiting
for another cron tick or the manual cooldown. Current-day deferred daily work
has priority over other not-yet-started work, except a weekly with the exact same
due instant: weekly wins that tie, then daily, then standalone catalog. Scheduled
admission still respects active-account exclusion, leases/fences and real upstream
backoff; only the manual account/repository cooldown is bypassed.

A daily must start before the next Beijing midnight of its due date. An expired
occurrence produces its own failed run with `scheduled_slot_missed` and
`missedSlots:{firstDueAt:dueAt,lastDueAt:dueAt,count:1}`; it is never silently
discarded or started on a later day. Multiple configured slots remain distinct.
A started daily may finish after midnight under its absolute deadline. Failed
catalog preparation produces an explicit failed target run rather than an
invisible cursor advance. Empty selections also produce explicit failed records.
Historical grouped missed audits remain readable and unchanged. Bounded recovery
leaves remaining cursors pending for subsequent ticks. Disabling or saving a
schedule explicitly replaces future pending configuration, without cancelling
an already accepted run. Queue outage recovery keeps the durable outbox.

Migration `0007_refresh_schedules.sql` adds account-cascaded stars and schedules.
Apply it before the new Worker. Rollback the Worker without dropping these tables;
previous snapshots, immutable evidence and run rows are retained.

Migration `0013_refresh_schedule_times.sql` adds/backfills one-element time lists
without changing existing schedule rows or due times. Its triggers preserve
legacy single-time writes and deletion behavior on rollback. It enables no extra
production slots; the owner chooses them separately. See the
[schema and backup verification](03-schema.md#refresh_schedule_times-v0160).

Every run has an absolute wall deadline: catalog 30 minutes, quick refresh 6 hours,
deep refresh (including missing legacy depth) 12 hours. Pauses and retries do not
extend it. Old payloads derive the deadline from `startedAt`; new runs store
`deadlineAt`. Expiration changes active runs to failed with `error:run_timed_out`,
revokes their lease, increments their fence version and releases the account lock.
The owning schedule records `lastError`; scheduler and mutating operations perform
recovery, never GET. All fenced writes also enforce the hard deadline, independently
of the renewable 40-second page lease. No schema migration or old-row rewrite is
needed for these JSON payload fields.
Timeout/missed-slot schedule warnings are sticky until an explicit schedule save,
so successful recovery in the same tick cannot erase the incident.

### Historical incident and run estimates

The supplied October 16-18 incident had healthy minute cron invocations but a
catalog active until October 18 20:08 Beijing. At historical revision `ac2d1e3`,
the single-active-account constraint blocked other kinds, and catalog preparation
left the original daily cursor pending. Once the old daily was accepted at
20:09, advancing from recovery time jumped directly to October 19, explaining
the absent October 17/18 daily records. That old daily then held the weekly back.

A renewable 90-second page lease was not an absolute run deadline. Successful
page commits release it; ordinary retries are bounded and backed off. Repeated
rate waits, queue retries or failed fenced progress could prolong the active run,
but the supplied evidence contains no historical cursor/Queue/CAS trace that
identifies the exact reason run `7c676d29` stalled. Healthy cron and its wall time
alone do not prove consumer progress. Synthetic stall replay demonstrates the
scheduling consequence, not an invented diagnosis of the original stalled step.

Run `bun run tests/bench/schedule-history.ts` to load the complete historical
`ac2d1e3e0131442b91f168861f6fa2640ef9535b` source tree and replay those supplied
times against local SQLite with networking denied and a fake clock. The injected
catalog release yields the October 16 daily starting October 18 20:09, weekly
starting 20:49, and no October 17/18 daily records. Current scheduler tests cover
the counterfactual individual outcomes, same-day admission, seven healthy daily
slots, deadline recovery, terminal handoff and SQL race guards. The synthetic
seven-day test is not a production runtime/SLA measurement.

Revision `300b609` (v0.15.14) added catalog/quick/deep absolute deadlines. Under
continued healthy processing, a catalog cannot retain the active lock for 48 hours.
Those bounds do not ensure successful collection and did not by themselves fix
coalesced slots, failed preparation audit gaps or immediate daily handoff.

Every exposed run adds `expectedFinishAt` and `expectedFinishAtReason`. Read-time
calibration uses the latest five valid completed/partial same-account,
same-execution-kind runs, including audited zero-duration work. Recorded timings
calibrate step-kind medians and account/factory/snapshot/activity/Insights/publish
phase overhead separately, so queue gaps in a serial activity tail are not spread
across already completed factory steps. Plans distinguish Insights from other
snapshots even in compact history. Running/paused estimates anchor remaining work
at the latest of now, start and outstanding backoff. Legacy incomplete timing
records retain the conservative wall-only estimate. Terminal runs have no future
estimate (`expectedFinishAt:null`, reason `terminal`), regardless of history or
missing timestamps. Missing history, invalid active starts and zero-work audits
retain their explicit reasons. See the precise [API contract](api.md#get-refresh-runs).
Terminal precedence applies to completed, failed, partial and cancelled runs on
browser history/detail, machine lists and every latest-readiness kind; use
`finishedAt` for the actual end. Pending schedules are not run statuses and are
unchanged. Calibration reads retained history, not only the 21 displayed rows.
GET never writes estimates or fetches upstream; no schema migration is needed.

Expected feature/access absence finishes a step as `unavailable`, counted separately
from `failed` and visible in the console. Dependency safe-parse limitations finish
as terminal `limited` with `error:dependency_parse_unsupported`, counted separately
in progress and compact history without making the run partial. This exception
does not include capacity truncation, interrupted pagination/access loss or other
malformed upstream data. Truncation and exhausted
upstream failures still make a run partial. For a matching run ID, a publication's
`status` is complete exactly when its run is completed, otherwise partial. New failed
attempts retain the old publication under its old run ID. Coverage remains a separate
data-quality signal: a completed run can contain unavailable sources and retained
older evidence. Historical outcomes and publications remain immutable.

When dependency parsing regresses, the fenced repository commit retains its prior
resource/version pointer and stores only the safe diagnostic for the next
publication. Publication freezes `coverage.dependencies` as limited with its safe
reason/code and `retained:true`; items/manifests, observed count, original window,
version and timestamps remain unchanged, including an empty prior limited source.
Browser/machine streams and metadata-only source indexes share this published
coverage, never mutable run-state overlays. Their conservative content hash
composes the retained stored hash with semantic coverage and stays null if the
stored hash is absent/mismatched. Repeated identical limits do not change the hash
or refresh evidence age. Failed later attempts cannot erase the frozen diagnostic;
successful accepted publication clears it. Existing version references continue
protecting retained resources from bounded cleanup. Job/step multiline workflow
conditions support plain continuations and literal/folded block scalars without
extracting dependencies from condition bodies. Block bodies may contain key-like
text. Plain headers and every continuation are checked: collection starts,
mapping/sequence-like lines and continuations after a comment-ended scalar remain
unsupported and fail closed, even after an earlier valid plain line. Empty or
comment-only headers can still lead to plain conditions. No schema migration or
historical row rewrite is required.

## Page scope and daily collection

Cross-repository business pages default to the account's Giraffe stars and expose a
Starred / All filter. Apply the scope before aggregating tables, totals, charts and
rankings. Starred scope selects starred-owned repositories; all scope selects all
owned repositories, including archives and forks. An empty star set
stays empty and offers the complete catalogue rather than silently switching scopes.
Repository URLs identify a specific repository and are not hidden by this filter.
Settings, automatic schedules and run history are account-level control surfaces.

Business snapshot GETs accept `scope=starred|all`; omitted scope reads the ordinary
saved projection. GET remains local, read-only and never starts collection. Scope
changes cannot change the schedule or issue upstream writes. Notification bulk-read
in starred scope affects only that scope's saved unread threads; the account-wide
GitHub bulk endpoint is reserved for an explicitly all-scope action. Read-through
updates preserve notification collection time.

New daily starred plans include the repository list, notifications and contributions,
the existing selected statistics/detail work, explicit selected Insights derivation
and publication. A single repository has 23 logical steps in a daily plan, versus 19 for a
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

## Catalog discovery cost

Discovery reuses the existing catalog listing and stable repository IDs. A normal
single-page rediscovery adds zero GitHub requests and zero leased steps. Each
eligible public missing member below the mass-removal guard adds one stable-ID
GraphQL node lookup. Previously private candidates and accounts without a
previously known private-owned identity still visible in the complete listing
add no confirmation request and report `unconfirmed`. Four eligible public
missing members out of 40 owned members therefore add four requests. Four
missing out of 31 owned members exceed the exact ten-percent threshold, so all
removals and confirmation calls are suppressed. Archived and forked owned members
count in that denominator; non-owned, departed and displaced identities do not.
The candidate count includes all missing, not-yet-removed identities, including
quarantined identities from multiple replacement generations. Four quarantined
identities with five current owned members therefore trigger the guard: zero
lookups/removals, unchanged mutable state and `mass_removal_guard` for every
candidate. Three such identities are exactly the threshold and still require
the normal identity/privacy checks before deletion.

The listing fixture uses one GraphQL request; the factory path also has its
existing inventory request. Confirmations execute inside the existing repository
snapshot lease, sharing that execution's `MAX_FETCHES=40` budget with listing
requests. Budget exhaustion retains unconfirmed membership and original
`last_seen_at`, with `catalog_removal_unconfirmed`; it never bypasses the client
limit. This is a per-execution bound, not a whole-run request total. No extra
scheduler tick or measured production latency improvement is claimed.
When mutable state is missing, legacy restoration can make at most two additional
bounded local reads to verify identity against a saved root or exact immutable
version. It does not scan the historical publication set or call GitHub.

## Dashboard time presentation

Dashboard timestamps use the browser's local timezone, including refresh history,
CI runs, assessment windows and scheduled next-run times. Storage and API instants
remain UTC. Preaggregated days retain their original bucket boundaries; charts,
ledger rows and detail filters show those boundaries as local intervals, inclusive
of the start and exclusive of the end. Local dates on axes identify the interval
start, not a regrouping of observations. Schedule wall-clock configuration remains
explicitly labelled Beijing time; changing the viewing timezone does not reschedule jobs.

## Landed activity ledger

[Landed activity](13-landed-activity.md) separates sampled-head attribution from
exact push-time claims. Additive migration `0026_activity_commit_ledger.sql`
retains account/repository-ID/SHA identities and pinned reconciliation checkpoints
independently of run retention. Each activity step accepts at most one 100-commit
page; the four-lane pool can accept several pages per invocation under its shared
budgets. Empty or malformed pinned histories fail closed. Only fully accepted
reconciliation advances the baseline, and publication compacts only serialized
identities in the same fenced batch. Delayed evidence retains the original window.

No GitHub backfill occurs during migration. A 60-repository first catch-up with
1,000 commits per repository needs about 600 history requests and 60,000 permanent
identities; unchanged warm heads require no commit request. At 100,000 identities,
64 MB ledger/head bytes or the existing 512 MB account ceiling, admission fails
closed without advancing the page or evicting identities. Rollback to v0.23.1
needs no down-migration; re-upgrade resumes the ledger. Force-pushed-away commits
between snapshots remain invisible; configuration and schedules do not change.
