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
- 超限：同一逻辑 kind 拆成 `kind`、`kind#2`、`kind#3`… 每页仍 ≤ 1,500,000。API 组装后对客户端只暴露逻辑 kind。
- FK：`snapshots.account_id`、`snapshot_days.account_id` → `accounts.id`，`ON DELETE CASCADE`。
- 生产库名 `giraffe-db`。测试只用 wrangler `--local --persist-to`，不建远程测试库。

---

## 2. 表

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

`day` 为 `fetched_at` 的 UTC `YYYY-MM-DD`。`payload`：

```json
{
  "stars": 0,
  "forks": 0,
  "open_issues": 0,
  "repos": 0,
  "by_repo": [
    {
      "name_with_owner": "owner/name",
      "stars": 0,
      "forks": 0,
      "open_issues": 0
    }
  ]
}
```

合计数字来自当日 `repos` 快照：`stargazer_count`、`fork_count`、`open_issue_count`、仓库数。`by_repo` 与当日 `repos` 数组一一对应，供 digest 的每仓 delta。刷新时按**当天**写入或覆盖该日行，不改写成昨天。差量只对比 `day = today-1`（合计与 `by_repo` 均按 `name_with_owner` 对齐；昨天没有的仓 delta 为 `null`）。没有昨天的行则业务层 `baseline_missing`。保留 30 天，删除更早行。

---

## 3. 分页 kind

逻辑 kind 为 `repos`。物理行：

| 条件 | 物理 kind |
|------|-----------|
| 整包 ≤ 1,500,000 字节 | `repos` |
| 需第 2 页 | `repos#2` |
| 第 n 页 | `repos#n`（n≥2） |

第 1 页 kind **不加** `#1`。读取时：取 `kind` 与所有 `kind#n`，按 n 排序拼接数组字段。写入时先删该逻辑 kind 的全部物理行再插入。

切分页：在数组根字段上切（`repos` / `issues` / `pull_requests` 等），单元素超过 1,500,000 则拒绝该元素并记 `truncated: true`。

---

## 4. 快照 JSON

每份快照外层：

```json
{
  "fetched_at": "2026-09-01T00:00:00.000Z",
  "truncated": false
}
```

另加 kind 自己的数据字段。字段用 snake_case 存库；与 GitHub 原名字冲突时在映射层处理。

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

`health`：`strong` | `watch` | `risky`。

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

### `digest`

当前副本。差量来自 `snapshot_days` 的 today 与 today-1。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "day": "2026-09-01",
  "baseline_missing": false,
  "stars_delta": 0,
  "forks_delta": 0,
  "open_issues_delta": 0,
  "repos": [
    {
      "name_with_owner": "owner/name",
      "stars_delta": 0,
      "forks_delta": 0,
      "open_issues_delta": 0
    }
  ]
}
```

`baseline_missing: true` 时 delta 全为 `null`，不得填 0 装成没变化。

### 单仓 `repo:{owner}/{name}:details`

来源：`GET /repos/{owner}/{name}`。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "description": null,
  "homepage": null,
  "default_branch": "main",
  "license": null,
  "is_archived": false,
  "open_issue_count": 0,
  "stargazer_count": 0,
  "fork_count": 0,
  "pushed_at": "",
  "url": ""
}
```

### `repo:{owner}/{name}:actions`

来源：`GET /repos/{owner}/{name}/actions/runs`。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "runs": [
    {
      "id": 1,
      "name": "",
      "html_url": "",
      "status": "",
      "conclusion": null,
      "event": "",
      "head_branch": null,
      "created_at": "",
      "updated_at": ""
    }
  ]
}
```

### `repo:{owner}/{name}:traffic`

来源：views/clones REST。403 时 `forbidden: true`，计数为空。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "forbidden": false,
  "views": { "count": 0, "uniques": 0, "points": [] },
  "clones": { "count": 0, "uniques": 0, "points": [] }
}
```

`points[]`：`{ "timestamp": "", "count": 0, "uniques": 0 }`。

### `repo:{owner}/{name}:security`

```json
{
  "fetched_at": "...",
  "truncated": false,
  "unavailable": false,
  "dependabot_open": 0,
  "code_scanning_open": 0
}
```

### `repo:{owner}/{name}:issues` / `:prs`

形状分别与跨仓 `issues` / `prs` 相同，但只含该仓，且可省略 `name_with_owner`（仍建议带上）。

### `repo:{owner}/{name}:releases`

```json
{
  "fetched_at": "...",
  "truncated": false,
  "releases": [
    {
      "id": 1,
      "tag_name": "",
      "name": null,
      "html_url": "",
      "draft": false,
      "prerelease": false,
      "published_at": null
    }
  ]
}
```

### `repo:{owner}/{name}:languages`

来源：`GET /repos/{owner}/{name}/languages`。

```json
{
  "fetched_at": "...",
  "truncated": false,
  "languages": { "TypeScript": 1000 }
}
```

值为字节数。

### `repo:{owner}/{name}:contributors`

```json
{
  "fetched_at": "...",
  "truncated": false,
  "contributors": [
    { "login": "", "avatar_url": "", "html_url": "", "contributions": 0 }
  ]
}
```

---

## 5. 刷新与删除

`POST /api/refresh`：

1. 用当前 active account 的 PAT 拉 GitHub（经 `githubFetch`）。
2. 写成对应 snapshots 行（含分页）。
3. 若刷新了 `repos`，按 `fetched_at` 的 UTC 日 upsert `snapshot_days`。
4. 重算 `insights` 与 `digest` 当前副本。
5. 删掉 30 天前的 `snapshot_days`。

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
