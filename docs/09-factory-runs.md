# 09 — 持久化工厂刷新

## 调查与约束

2026-09-16 生产 D1 备份：471 条 factory 记录，13,012,055 字节。总览 run 停在清单第 6 页（60/114，纳入 37 仓库），259 个流均 pending；旧的 469 条资源仍在。旧实现重启即覆盖总览、资源 runId 与总览强绑定，浏览器离开后没有执行者。备份保存在忽略目录，禁止提交账号信封或私有事件。

依据 Cloudflare 官方 [Worker limits](https://developers.cloudflare.com/workers/platform/limits/)、[D1 limits](https://developers.cloudflare.com/d1/platform/limits/)、[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)：isolate 128 MB；waitUntil 在 HTTP 返回后最多 30 秒；队列/cron 每次最多 15 分钟 wall time；D1 行最大 2 MB、batch 为原子事务。项目仍限制 GitHub 40 次、D1 80 statements，每页超时 15 秒。不能靠一个超长 HTTP 或 waitUntil 承担完整调查。

## 计划与执行

- D1 是任务真相源。启动事务冻结仓库名称、顺序、窗口、逻辑步骤；所有浏览器只提交控制动作和读取状态。
- 数据刷新总步骤 = 1 次贡献日历 + 每仓库（metadata + 7 streams + commit）+ 1 次全局发布，即 9N+2。分页次数不可预知，单列 pages/requests，不改变分母。冷却仓库的 9 步预先标 skipped。
- 清单发现是独立的 catalog run：inventory、restore、publish 共 3 步。inventory 完整分页但不读取全仓资源。发现完成后用户选择刷新范围，因此首次发现不虚构仓库数量。只有完整清单可用于“全部”；选定范围可以使用已有部分清单。
- 每个队列消息执行至多一页/一个逻辑动作并提交，再安排下一条；cron 每分钟扫描到期任务，修复 enqueue 与数据库之间不可原子的问题。队列消息只有 run ID，没有令牌或事件。
- 90 秒租约；提交事务中的每一条写入都受 run ID、lease token、版本、未过期租约和 running 状态保护。最后 CAS 更新 checkpoint 并释放租约。控制操作使旧租约失效；已在途的 GitHub 请求可能结束，但不能再写。
- 每页心跳与 checkpoint 同时落库。崩溃最多重取未提交页；去重以事件 ID，统计只在流结束时计算。队列重复投递不会重复发布。
- 失败按 30/60/120 秒退避，最多 3 次重试；GitHub 限流遵循 Retry-After/reset，未知时至少 15 分钟，任务保持可恢复。401 暂停以等待更新凭据。仓库失败跳过其后续步骤并保留旧版本。权限不可用/截断显示覆盖不足，不能伪装成功零值。
- 账户启动冷却 60 秒；每仓库尝试后冷却 15 分钟。服务器时钟决定下次允许时间；客户端仅显示倒计时。暂停保留唯一活动 run，取消释放活动槽并保留已提交仓库版本；新 run 不会与旧执行者竞争。

## 数据发布与兼容

迁移 0001 新增 factory_runs、factory_state、factory_resources、factory_repo_versions、factory_repo_state；0002 新增 factory_version_refs 和 factory_storage（含资源字节计量触发器），均外键级联至账号。迁移只 CREATE IF NOT EXISTS，不改写/删除旧 snapshots。初始化 schema 包含同样 DDL；部署运行 migrations apply。

采集流存于 run staging；仓库全部流结束后，在同一 fenced batch 发布不可变仓库版本和当前指针及健康元数据。失败仓库保留当前指针，更新错误/耗时/重试状态。全局发布从已提交仓库版本构建，持久化完整版本后原子切换 factory_state.published_id。运行期间保留上个全局版本，仓库进度可独立显示新 refreshedAt。详情按所展示的版本定位资源，不因新 run 开始失效。

每仓库携带数据源窗口/版本，混合时间的 last-known-good 必须明确标识；不得把不同时间窗口当作同次全量调查。catalog restore 仅在缺少新全局版本时，从旧资源恢复旧指标、覆盖度、原始时间，保留 legacy 数据，不能把恢复标成刚采集成功。无法恢复的旧资源注明缺失。

## 迁移与回滚

部署前：导出 D1；记录旧表逐行摘要；运行 `bun scripts/verify-factory-migration.ts <local-export.sql>` 在本地 SQLite 备份副本上应用迁移两次，核验所有旧行完全一致。通过本地并发/崩溃测试后才启用 release workflow 的 D1 migrations。部署后再查旧行摘要、表结构、run/publication 一致性。回滚 Worker 到前版本无需逆向删表；停止队列/cron 后旧程序仍可读原 legacy snapshots。新表与版本保留供修复，禁止为回滚清空数据。

## UI 与验证

进度线程包括固定分母、成功/失败/跳过、阶段、队列、重试、真实页数、开始/更新时间、估算剩余（采样不足显示未知）、冷却、历史 run。范围选择支持明确优先级以及当前筛选结果；提交后不可更改本次顺序。只读轮询一次完成后再安排下一次，页面隐藏降低频率，错误退避；重载从服务端恢复。

测试覆盖计划、范围/顺序冻结、冷却、并发启动、租约接管、陈旧提交拒绝、重复页、失败保留、暂停/取消、限流、重载读取、原子仓库/全局发布、迁移重复执行/旧行不变、API 鉴权/Origin 和 UI。生产 smoke 仅选一个仓库，先重载观察未完成状态，再验证完成后旧数据仍在；不触发全仓刷新。

## 实现边界与审查处理

资源继续使用既有有界 JSON collector：每流 5,000 项 / 1.2 MB，事件 ID 去重和 next/ranges 与 run checkpoint 在同一 fenced batch 保存。因此不依赖 JSON 之外的无界事件列表；重复页不改变已提交进度。完整 run payload 在每次保存前检查 1.8 MB 上限，最多 500 仓库。超过规模时失败保留旧版本，而不悄悄截断计划。

publication 实体复用 snapshots 分页容器：`factory:v:<run-id>` 是不可变全局组合，repo.observation 明确引用资源版本；`factory:catalog:<run-id>` 是清单实体。factory_state 的两个指针与对应实体在同一 fenced batch 提交。这里不再重复建另一套 JSON 分页表。schema 的字符串指针由事务和一致性测试保护。

Grok、Pi 的第一轮架构审查均指出体积、fencing、publication 映射、catalog 完整性与混合窗口语义需要落成代码。这些边界已有实现和测试。公开进度排除内部 checkpoint；历史只返回最近 20 次。引用中的历史版本保留，避免恢复或回滚时删除唯一事件副本。0002 引入显式 publication→资源版本引用清单。每分钟维护事务最多删除 50 条过期快照、100 条已失去 publication 的引用、50 条无引用仓库版本、50 条无引用资源与 50 条无引用 run；仅处理 7 天前且不属于最近 20 次运行的数据。当前仓库指针、当前全局/清单指针、最近两个全局版本和所有保留 publication 引用均为保留根。legacy snapshots 永不进入清理条件。资源计量由触发器维护，执行器在写入前检查每账号 256 MB 资源预算；达到上限明确失败并保留旧数据。


## 发布审查后的边界

启动 run 与账户冷却在同一个 D1 batch 内完成。claim 只取得租约；执行器先归一化 cursor，再 fenced 保存实际阶段/开始时间，之后才发 GitHub 请求，不能把已完成步骤复活。凭据暂停不消耗网络重试预算；每页网络错误独立最多重试 3 次，实际 attempts/requests 继续如实计数。

队列最多并行 2 个消费者；每账号唯一 run 与租约仍使同一令牌串行执行。单页执行后把下一页送入队尾，不让单个账号一次投递整仓队列。

API 的 `repos` 只表示 selected 成员；`order` 是独立的优先级顺序。filter 的 language/topic/query/repo 由服务端解析，run.selection 保存原条件，run.repos/repoIds 固定解析结果。stale/failed 明确覆盖全清单，不偷偷叠加页面筛选。表格直接显示 metadataAt、事件窗口、事件快照时间和旧资源来源；混合快照不显示统一的 90 天调查窗口，也不计算统一同比趋势。

迁移验证在备份副本上开启外键，检查新表/唯一活动索引/外键、JSON 条件更新、重复插入、资源字节计量和 publication 引用写入，随后回滚探针并再验证旧表摘要。数据库备份不进入版本库。
