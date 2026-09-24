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

### `repo_statistics`

仓库参与统计的手动覆盖值，主键 `(account_id, repo)`，仓库名不区分大小写，`enabled` 为 0/1。无覆盖值时，Fork 或已归档仓库默认不参与，其余默认参与。设置独立于 GitHub 快照保存，重新同步不会重置；删除账号时级联删除。增量迁移为 `migrations/0004_repo_statistics.sql`，可重复执行；回滚代码时保留该表即可，无需删除原始快照或设置。

`POST /api/repos/:owner/:name/statistics` 接收 `{account_id, enabled: boolean}`，验证活动账号与仓库存在。读取时统一过滤工厂、Issues、PR、Insights、告警和通知，仓库管理页始终返回完整清单及有效 `statistics_enabled`。

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
