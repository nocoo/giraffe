# Phase 2: unified refresh (v0.27.0)

This is the authorized replacement for the collection stack retired in v0.26.0.
There is one task type, not quick/deep/full modes. The Dashboard keeps its saved
observation views; reads never collect upstream, repair data or renew timestamps.

## Execution and scheduling

One account-scoped Durable Object persists wakeups and a D1 run history. A run
collects **A** (account metadata, contribution calendar, paginated repository
catalogue and GraphQL rate limit) before **B** (repositories, serially). Each alarm
advances one stage/repository. The next wakeup is recorded before work; interrupted
steps resume idempotently. Transient failures have bounded backoff, while fatal
account/authentication failures stop the run. Repository failures remain partial.
There is no queue consumer and no HTTP `waitUntil`-only collection task.

Cloudflare cron `0 19 * * *` starts the default refresh at **03:00 Asia/Shanghai**.
Scheduled requests are deduplicated by account and Shanghai day; a daily request
queues behind existing work. GitHub管家 consumes stored results at **04:30
Asia/Shanghai**. Its scheduler, digest generation and delivery are external to
Giraffe. No weekly report or model execution is implemented.

Default B membership is the starred set. A genuinely new repository without
observations is included once on its discovery day, without changing its star.
Subsequent default runs exclude unstarred repositories. An explicit `repo` selects
one current catalogue repository after A. Stars remain independent local owner
or agent preferences, not GitHub stars.

## Parameters and observation limits

```json
{
	"since": "2026-10-28",
	"until": "2026-10-28",
	"timezone": "Asia/Shanghai",
	"dimensions": ["commits", "issues", "prs", "actions", "releases", "alerts"],
	"force": false
}
```

All fields are optional. Dates are inclusive calendar dates in the selected IANA
timezone, defaulting to yesterday. Only 1–31 **closed** days are accepted; current
or future days cannot be cached as complete. UTC boundaries account for daylight
saving changes. Timestamps and wakeups persist in UTC; display/report defaults are
UTC+8. `repo: "owner/name"` requests an ad-hoc repository; unknown parameters,
legacy modes and duplicate/empty dimensions are rejected.

The cache key is account × immutable repository ID × timezone × day × dimension.
Complete cached days skip upstream work unless `force` is true. Cache reuse keeps
source timestamps, and a newly published run/window does not make old evidence
fresh. Identity replacements cannot inherit observations by repository name.
- Daily commits use one GraphQL `history(since,until) { totalCount }` alias per
  uncached day. They are default-branch counts, not owner-only/all-branch counts.
  No REST commit pagination or reconciliation against contribution totals occurs.
- A single GraphQL contribution calendar supplies the green-square trend. Missing
  type breakdowns are unavailable, not zero.
- PR/Issue collection starts with one page in the main repository query, then
  consumes that page before applying a proven cache/lower-bound stop. A known ID
  with a changed update timestamp is not a safe cache boundary; force bypasses
  cache stops. Daily lifecycle coverage and current open-inventory completeness
  are distinct. Unknown older open items keep the inbox truncated and refresh
  partial, even when a requested day's lifecycle counts are complete.
- Actions, releases and security alerts use bounded REST samples. CI represents
  the latest/short-window sample, not exhaustive historical execution.
- Dependency analysis is unsupported and displayed as missing. Dependency alerts
  can be collected. Traffic, author-event ledgers and other uncollected dimensions
  remain explicit empty/unavailable observations, never legacy fallbacks.

## HTTP contract

Browser paths use `/api/refresh-runs`, the active account, Access and same-origin
writes. Machine paths use `/api/v1/accounts/:account/refresh-runs`, fixed-account
hash-only bearer tokens and `app:read` / `app:write` scopes.

| Method/path                | Result                                              |
| -------------------------- | --------------------------------------------------- |
| `POST /refresh-runs`       | `202` run; accepts the parameters above             |
| `GET /refresh-runs`        | Up to 50 latest runs, `collectionAvailable: true`   |
| `GET /refresh-runs/latest` | Latest run; `409 snapshot_missing` before first run |
| `GET /refresh-runs/:id`    | Account-fenced run; `404` for unknown IDs           |

Run states are `queued`, `running`, `completed`, `partial`, `failed`. Responses
include phase, ordered repositories, completed count, actual upstream request
count and safe error code. Matching active manual requests return the same run;
a different active request returns `409 refresh_conflict`. Machine settings expose
the fixed daily schedule. Legacy run controls and quick/deep/full schedules stay
removed; no alias or fallback is provided.

Existing `PUT|DELETE /accounts/:account/stars/:owner/:name` and browser
`POST /api/repos/:owner/:name/star` manage B membership. Current observation,
factory-stream and contribution GET endpoints retain their response formats and
read only newly saved data. Tokens/PATs never enter run payloads, URLs or logs.

Local repository metadata and agent state use the immutable IDs in the new
catalogue. Retired catalogue rows cannot supply current identities. The old
catalogue-change ledger is not imported: valid history reads return
`409 catalog_unpublished` until a new history source exists. Activity projects
available lifecycle observations from the new publication; unsupported
author-specific commits remain null/unavailable rather than becoming repository
totals or a false zero. Before a new publication exists, Activity returns
`409 activity_unpublished`. These missing states preserve the meaning of the
existing displays rather than serving stale legacy observations.

## Storage, verification and rollback

`0028_refresh_observations.sql` adds `refresh_catalog`, `refresh_accounts`,
`refresh_day_observations`, `refresh_items`, `refresh_repository_publications`,
`refresh_snapshots`, `refresh_publications` and `refresh_resources`.
`0029_refresh_runs.sql` adds account-fenced runs, a single running-task constraint
and scheduled-day uniqueness. Both are additive/idempotent; there is **no legacy
data migration**. New tables begin empty. Legacy factory, activity and snapshot
tables can remain inert. Durable Object migration `v1-refresh` creates
`RefreshRunner` using SQLite storage.

Run root typecheck, lint, structural gates, all four coverage metrics, real-local
HTTP L2, built Chromium L3 and security gates before publication. Tests use local
SQLite/Wrangler and fake GitHub/JWKS services, never production credentials or D1.
The deployment workflow applies D1 migrations before code. Its guard verifies
that the retired queue consumer stays absent and exactly the authorized cron is
present. No laptop deployment is authorized.

Before release, validate migrations on a local backup copy with
`bun scripts/verify-factory-migration.ts <backup.sql>`; keep any real backup outside
the repository and never use it in automated tests. After an owner-approved merge,
verify `/api/live` version/database health, refresh status, star selection, saved
results and missingness. Roll back through the release workflow to an approved
revision, leaving additive tables intact; never resume retired runs or import
legacy rows as a rollback shortcut.
