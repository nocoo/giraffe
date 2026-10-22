# 03 — 数据 Schema

抓取、落库、展示共用的数据形状。建表与 JSON 载荷以本文为准。01 第 7 节只是方向摘要。

> 返回 [文档目录](README.md)

首版用原生 SQL：`src/server/lib/db/schema.sql`。不引入 ORM。

GitHub 字段名跟 REST/GraphQL 对齐（`login`、`nameWithOwner`、`stargazerCount` 等），在 Worker 边界一次性映射进下文类型。浏览器只看到这些 JSON，看不到 token。

---

## 1. 约定

- 时间一律 UTC ISO-8601，以 `Z` 结尾。
- ID：`accounts.id` 用 nanoid（21）。
- JSON 列存 TEXT。读写用 `JSON.parse` / `JSON.stringify`。
- 单行总大小必须 < 2,000,000 字节。`payload` 最大 **1,500,000** UTF-8 字节。
- 超限：同一逻辑 kind 拆成 `kind` 与 `kind#2`。每页 ≤ 1,500,000。再多丢弃并 `truncated: true`。API 组装后对客户端只暴露逻辑 kind。
- FK：`snapshots.account_id`、`snapshot_days.account_id` → `accounts.id`，`ON DELETE CASCADE`。
- 生产库名 `giraffe-db`。测试只用 wrangler `--local --persist-to`，不建远程测试库。

---

## 2. 表

### Immutable current-run activity

Migration `0018_activity.sql` adds `activity_publications` and `activity_pages`.
Publication identity is `(account_id, run_id)`; the run foreign key preserves
account cleanup and bounded run retention. Header columns are `previous_run_id`,
`until_at`, `fetched_at`, `payload` and `content_version`. The header payload is
the complete `ActivitySnapshot` with `repos:[]`, including frozen totals,
contributions, coverage, window and frozen `membership` names. The source index reads this stored header,
not SQL-reconstructed event arrays.

Pages use `(account_id, run_id, page)` with a composite foreign key to the
publication. Page numbers start at zero; each payload is a plain `ActivityRepo[]`.
Both header and page payloads enforce at most 1,500,000 UTF-8 bytes. A publication
has at most 16 repository pages; any data cut is explicitly truncated with
nullable counts where completeness is unknown. Publication writes are leased,
fenced and immutable; reads use the saved header/pages without contacting GitHub.
Each repository is projected immediately after its current-run collection into
an `activity-snapshot` factory resource, so final publication does not load every
repository's 90-day streams together. Before fetching projected payloads, the
publisher reads only byte-length metadata for the frozen membership (at most 500
repositories), then selects at most 4,000,000 UTF-8 input bytes in frozen order.
The payload read rechecks those lengths. Omitted members remain in `membership`,
with partial/truncated input coverage and null account totals; the output page
cap is an independent limit, not a bound on input memory. Activity header/page bytes participate in
the existing account storage budget. Retention preserves the latest two usable
activity publications even when newer failed runs fill the normal history limit.

No historical activity is fabricated or backfilled. Reliable prior successful
quick/daily run metadata can establish the next window boundary, but an old run
without an activity publication does not acquire a fabricated body. Apply the
additive migration before deploying the reader/writer; retain these tables on
code rollback. Existing observations, reports and publication payloads stay intact.

### Star provenance

Apply `0017_star_provenance.sql` after the membership cleanup. It additively extends
`repo_stars` with `starred` (0 or 1, default 1), `source` (`owner|agent`, default
owner), non-null `updated_at`, and nullable `reason` (at most 200 characters).
The existing account/repository primary key remains case-insensitive. Surviving
stars become owner records; their timestamp is seeded from the account's stored
update time, or the Unix epoch when unavailable, not claimed as historical star
event time. R2-removed rows remain absent and create no owner tombstone.

Owner unstars retain `starred=0` rows. Every membership reader selects only
`starred=1`; provenance reads include tombstones. Atomic conditional writes allow
owners to replace any record and agents to replace only agent records or create
absent records. Same-direction agent writes preserve an owner record unchanged;
opposite-direction writes return 409. The migration verifier recognizes all four
added columns, skips a fully applied migration, and rejects partial application.

Do not roll application code back to a version that treats every `repo_stars` row
as starred: it would misread tombstones and could erase owner protection. Preserve
the new columns and rows during a rollback; use a provenance-aware code revision
or restore an explicitly approved pre-migration backup. No automated destructive
rollback is provided.

### Star membership consolidation

Migration `0016_star_membership.sql` preserves explicit daily-exclusion intent:
delete a local star if and only if a matching statistics row has `enabled=0` for
the same account and case-insensitive repository name. It then deletes every
`repo_statistics` row, including entries whose repositories left the catalog.
Explicit true overrides on unstarred repositories do not create stars. No production
repository names are hard-coded. Reapplying the migration is a no-op.

Before applying, the affected-star count is computed by this rule (not by assumed
production counts):

```sql
SELECT count(*) AS stars_removed
FROM repo_stars AS stars
WHERE EXISTS (
  SELECT 1 FROM repo_statistics AS statistics
  WHERE statistics.account_id = stars.account_id
    AND lower(statistics.repo) = lower(stars.repo)
    AND statistics.enabled = 0
);
SELECT count(*) AS overrides_removed FROM repo_statistics;
```

Keep the emptied table for schema rollback; do not drop or rebuild it. This does
not authorize running pre-provenance code against tombstones.
This authorized cleanup changes configuration intent, not observations, publication
history or agent resources. Rollback retains the resulting stars and the empty
table; restoring pre-cleanup preferences requires a separately retained backup.
The fixture migration covers starred false overrides, unstarred true overrides,
archived entries, departed-repository residue and a non-owned repository. No remote
database is accessed for this verification. Removed stars create no owner tombstones,
so a future agent can star those catalog repositories again.

### Analysis report read index (v0.17.1)

Migration `0015_analysis_reports.sql` adds only the repeatable partial expression
index `agent_analysis_recent` on existing `agent_resources` rows where
`collection='reports' AND type='github-analysis'`. Its columns are account ID,
the JSON-encoded scope/repository/domain tuple, guarded UTC whole-second epoch
descending, normalized fractional digits descending, and `id DESC`. Epoch
conversion consumes only the first 19 datetime characters, then subtracts the
signed `HH:MM` offset explicitly (including Zod's full +/-23:59 range). Fractions
never enter SQLite date conversion, avoiding rounding carry at `.9999`. Fraction
digits remain text with trailing zeros trimmed, leading zeros retained and empty
text for zero/no fraction; binary order preserves arbitrary fractional precision.
Timezone/fraction shape checks keep malformed values null without constraining
generic writes. Every JSON extraction uses
`CASE WHEN json_valid(payload) THEN payload END` as its input, including key seeks
and final ordering. JSON1-uninspectable payloads (such as schema-accepted deeply
nested extensions) keep their rows and generic CRUD support; their scope/domain/
time index components become null. The date guard excludes relative/nondeterministic time keywords without
rejecting generic JSON writes; full report validation remains client-side. The encoded
key preserves the exact scope/repository/domain tuple, including nulls, without
delimiter collisions. Valid generation timestamps compare as exact instants;
ties use binary descending IDs, and missing/nonmatching/unparseable times sort last.

The browser's dedicated projection seeks each successive key and its newest three
row IDs in one statement, then hydrates only those payloads. It does not scan or
rank the full history, rebuild tables, rewrite payloads or remove resources.
Statuses are not filtered. Generic machine lists keep their existing cursor and
ID ordering. See [the projection contract](api.md#analysis-report-projection-and-retention).

Apply the index before deploying the reader. Code rollback leaves the index in
place; old-column CRUD continues to work. Regression coverage checks repeated
application, exact row preservation, old CRUD writes, foreign keys/integrity, and
the real SQLite plan/bytecode with 6,001 and 60,001 historical report rows. The prior content-metadata
migration's local backup/rollback verifier also applies this migration.

### `refresh_schedule_times` (v0.16.0)

Migration `0013_refresh_schedule_times.sql` adds an account-cascaded side table
with primary key `(account_id,kind)` and `times TEXT`, a JSON array of 1-6 clock
values. It backfills `[time]` from both `refresh_schedules` and
`catalog_refresh_schedules`, without rebuilding tables or modifying their rows.
API validation sorts/deduplicates valid `HH:MM` values. Daily/catalog recur daily;
weekly slots share the legacy weekday. Clock values remain fixed UTC+08:00.

The original `time` column remains the first-slot alias. New saves update it and
the list atomically. Insert/update/delete triggers keep old-code writes usable:
writing `time` resets the list to one slot, and deleting a schedule removes its
list. Reapplying the migration does not overwrite existing multi-slot lists.
Rollback keeps the new table/triggers and runs old code against its original
columns; no data deletion is necessary. If extra slots were subsequently enabled,
save the desired single time through the old API to recompute its `next_at`.

The migration regression creates a synthetic SQLite source, copies it using
`VACUUM INTO`, and applies migration only to the local backup. It proves exact
legacy-row preservation (daily 19:30/starred, Sunday 04:00/all, catalog fixture),
source-byte preservation, foreign keys/integrity, repeat application and old-column
writes. It also runs `scripts/verify-factory-migration.ts` on pre/post-migration
SQL backups, including operational probes and rollback checks. No production
backup, PAT or remote D1 is involved; production settings are not changed.

### Additive contribution and PR payloads (v0.16.0)

No observation table migration is needed. Factory contribution JSON keeps
`days[].date/count`, `total`, `restricted` and `fetchedAt`. New observations add
`observedAt`, `partial`, `timezone:"github"`, `typeWindowTimezone:"UTC"`,
`typesStatus`, and nullable per-day `types` plus `breakdown`/observation metadata.
Calendar provenance remains the existing immutable `contributionObservation`.
Pending type batches remain fenced run checkpoints; a failed run does not publish
them over prior good data. Existing publication/retention references remain intact.

PR snapshot items and factory PR events add `mergeable:boolean|null`,
`mergeStateStatus:string|null` and `checks:{state:string|null}`. Legacy rows remain
stored unchanged; machine reads project explicit nulls. See the
[API reference](api.md#pr-merge-and-checks-state) for enum and date semantics.

### `repo_statistics`

Retired. Migration `0016_star_membership.sql` preserves explicit exclusions by
removing matching existing stars, then deletes every statistics override. The
empty table is retained for schema rollback only; application selection and
projection never read it, and retired mutation routes never write it. Keeping
this table does not make pre-provenance code safe to run against owner tombstones;
follow the migration and rollback requirements above.

Browser `POST /api/repos/:owner/:name/statistics` and machine
`PUT/DELETE /api/v1/accounts/:account/statistics/:owner/:name` return `410 deprecated`.
Machine settings expose an empty overrides array with a deprecation marker;
the deprecated repository `statistics_enabled` field is only an alias for
`starred`, not an independent participation setting. Daily membership is the
starred, account-owned set; full membership is every account-owned catalog
repository, including forks and archived repositories. Non-owned repositories
never enter refresh or coverage denominators.

### `_test_marker`

仅 L2/L3 本地库。生产 **不得** 有此表。

```sql
CREATE TABLE IF NOT EXISTS _test_marker (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR REPLACE INTO _test_marker (key, value) VALUES ('env', 'test');
```

Worker `GET /api/live` 在能读到 `value=test` 时返回 `d1_marker=test`。

### `accounts`

```sql
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  token_ciphertext TEXT NOT NULL,
  token_last4 TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  scopes TEXT NOT NULL DEFAULT '',
  capabilities TEXT NOT NULL DEFAULT '{}',
  is_active INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE UNIQUE INDEX accounts_login ON accounts (login);
CREATE UNIQUE INDEX accounts_one_active ON accounts (is_active) WHERE is_active = 1;
```

`token_ciphertext` 信封：

```json
{ "v": 1, "iv": "<b64>", "ct": "<b64>", "tag": "<b64>" }
```

`capabilities` 只表示 token 级 scope，例如：

```json
{ "repo": true, "read:org": true, "read:user": true, "notifications": true }
```

同一时刻最多一行 `is_active=1`。切换账号时先把全部置 0 再置目标为 1。

### `snapshots`

```sql
CREATE TABLE snapshots (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (account_id, kind)
);
```

### `snapshot_days`

```sql
CREATE TABLE snapshot_days (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (account_id, day)
);
```

已停用的历史日报基线表。应用不再写入或读取，只在每次刷新时删除 30 天前的行，使旧数据自然过期；表本身按增量迁移原则保留，账号删除时级联删除。

---

## 3. 分页 kind

逻辑 kind 为 `repos`。物理行：

| 条件 | 物理 kind |
|------|-----------|
| 整包 ≤ 1,500,000 字节 | `repos` |
| 需第 2 页 | `repos#2` |
| 第 n 页 | `repos#n`（仅 n=2） |

第 1 页 kind **不加** `#1`。最多 **2** 页。第 3 页起丢弃并 `truncated: true`。读取时：一条 SELECT 取 `kind` 与 `kind#2`。写入时一条 `DELETE … kind IN (logical, logical#2)` 加一条多行 `INSERT … VALUES`。禁止 `LIKE`，禁止每页一条 INSERT。

切分页：在数组根字段上切（`repos` / `issues` / `pull_requests` 等），单元素超过 1,500,000 则拒绝该元素并记 `truncated: true`。

---

## 4. 快照 JSON

每份快照外层：

```json
{
  "account_id": "<accounts.id>",
  "fetched_at": "2026-09-01T00:00:00.000Z",
  "truncated": false
}
```

`account_id` 为写入该快照的账号。Client 用来丢弃跨 Tab 切换后的错账本响应。另加 kind 自己的数据字段。字段用 snake_case 存库；与 GitHub 原名字冲突时在映射层处理。

### `repos`

来源：GitHub GraphQL `viewer.repositories` / REST `GET /user/repos`。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "repos": [
    {
      "name_with_owner": "owner/name",
      "name": "name",
      "owner_login": "owner",
      "description": null,
      "stargazer_count": 0,
      "fork_count": 0,
      "open_issue_count": 0,
      "primary_language": "TypeScript",
      "pushed_at": "2026-09-01T00:00:00.000Z",
      "visibility": "PUBLIC",
      "is_private": false,
      "is_archived": false,
      "is_fork": false,
      "url": "https://github.com/owner/name"
    }
  ]
}
```

### `issues`

来源：跨仓 search 或 GraphQL issues。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "issues": [
    {
      "name_with_owner": "owner/name",
      "number": 1,
      "title": "",
      "url": "",
      "created_at": "",
      "updated_at": "",
      "author_login": null,
      "labels": [{ "name": "", "color": "ededed" }],
      "comments_count": 0
    }
  ]
}
```

### `prs`

```json
{
  "fetched_at": "...",
  "truncated": false,
  "pull_requests": [
    {
      "name_with_owner": "owner/name",
      "number": 1,
      "title": "",
      "url": "",
      "created_at": "",
      "updated_at": "",
      "author_login": null,
      "is_draft": false,
      "review_decision": null,
      "additions": 0,
      "deletions": 0,
      "base_ref": "main",
      "head_ref": "feat"
    }
  ]
}
```

`review_decision`：`APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED` | `null`。

### `insights`

由 `repos` + `issues` + `alerts` 算出，不另打 GitHub。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "alerts_incomplete": false,
  "insights": [
    {
      "name_with_owner": "owner/name",
      "open_issue_count": 0,
      "days_since_push": 0,
      "health": "strong",
      "alerts": [],
      "opportunities": []
    }
  ]
}
```

`health`：`strong` | `watch` | `risky`。`alerts_incomplete: true` 当派生时 alerts 快照缺失、`unavailable: true` 或 `truncated: true`（04：仓 403/404/FORBIDDEN 跳过也把 alerts 标 truncated，故能持久化）。UI 必须展示「告警不完整」，不得把 `strong` 当成已扫完全部安全告警。

### `alerts`

来源：Dependabot + code scanning REST。无权限则 `unavailable: true`，数组为空。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "unavailable": false,
  "dependabot_open": 0,
  "code_scanning_open": 0,
  "items": [
    {
      "name_with_owner": "owner/name",
      "source": "dependabot",
      "severity": "high",
      "summary": "",
      "url": ""
    }
  ]
}
```

### `notifications`

来源：`GET /notifications`。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "notifications": [
    {
      "id": "",
      "unread": true,
      "reason": "",
      "updated_at": "",
      "title": "",
      "url": "",
      "name_with_owner": "owner/name"
    }
  ]
}
```


---

## 5. 刷新与删除

`POST /api/refresh`：

1. 对请求里的 **GitHub kind** 用当前 active account 的 PAT 出站（经 `githubFetch`）。仅 `insights` 的刷新不打 GitHub。
2. 写成对应 snapshots 行（含分页）。
3. 重算 `insights`。显式请求且源不足/truncated → 409。显式且 2 页仍超 → 截断写入。隐式且源不足或 2 页仍超 → 跳过。完整规则见 04。
4. **每次**成功 refresh 都删掉 30 天前的遗留 `snapshot_days`。

`DELETE /api/accounts/:id`：依赖 CASCADE 删掉该账号全部 snapshots 与 snapshot_days。

---

## 6. schema.sql 顺序

1. `accounts`
2. `snapshots`
3. `snapshot_days`
4. 本地测试再执行 `_test_marker`

L2/L3 runner 用**绝对路径**：

`wrangler d1 execute giraffe-db --local --persist-to=<persist 绝对路径> --file=<schema.sql 绝对路径>`

`schema.sql` 位于仓库内 `src/server/lib/db/schema.sql`，`--file` 必须是该文件的绝对路径，不得写成相对路径。
