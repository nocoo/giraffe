# Phase 2: unified refresh (v0.27.3)

This is the authorized replacement for the collection stack retired in v0.26.0.
There is one task type, not quick/deep/full modes. The Dashboard keeps its saved
observation views; reads never collect upstream, repair data or renew timestamps.

## Execution and scheduling

One account-scoped Durable Object persists wakeups and a D1 run history. A run
collects **A** (account metadata, contribution calendar, paginated repository
catalogue and GraphQL rate limit) before **B** (repositories, serially). Each alarm
drains persisted steps within a 25-second work budget, at most 30 steps. Each step
has its own bounded D1 handle. The next recovery wakeup is recorded before work;
interrupted steps resume idempotently. Successful steps have no fixed sleep or
one-second alarm delay. Transient failures retry after 2, 5 and 15 seconds;
rate-limit failures wait at least 60 seconds and honor any later `retry-after` or
reset deadline. After the bounded retries, repository failures remain partial,
while fatal account/authentication failures stop the run.
There is no queue consumer and no HTTP `waitUntil`-only collection task.

POST arms the first durable alarm at the current time. Before persisting a step
start, the runner records a recovery alarm five seconds ahead, not five minutes.
Healthy steps continue in the same handler; budget/step-cap yields leave an alarm
due immediately. These bounds describe requested scheduling delays, not a
Cloudflare alarm-delivery SLA. A crash may replay the interrupted step; rate-limit
and transient retry deadlines still take precedence once the failure is recorded.

The v0.27.1 acceptance recorded `running/account` with zero requests for about
five minutes. Both v0.27.1 and v0.27.2 armed a 300-second recovery alarm before
collection, and only successful settlement replaced it. Fault-injection tests
reproduce that recovery gap. The incident has no trace proving what interrupted
the original handler; deployment eviction versus a failed/stalled handler cannot
be distinguished from its final run payload. v0.27.2 already removed one-second
successful-step sleeps and added bounded draining; v0.27.3 fixes the remaining
recovery interval rather than attributing an unobserved production failure.

New run status includes `timings: {queuedAt,a,repos}`. `a` is initially null, then
contains `startedAt`, nullable `finishedAt`, `attempts` and `reused`. `repos` holds
the started repositories in serial order, each with `repo`, `startedAt`, nullable
`finishedAt` and `attempts`. `attempts` counts settled collection attempts, not
crashes before settlement; `startedAt` remains the first observed start across
retries. Finish stays null until the step completes, fails permanently or is
cancelled. Queued cancellation creates no step timings. All execution times are
UTC and remain distinct from cached observation timestamps. Historical runs are
not backfilled.

Cloudflare cron `0 19 * * *` starts the default refresh at **03:00 Asia/Shanghai**.
Scheduled requests are deduplicated by account and Shanghai day; a daily request
queues behind existing work. GitHub管家 consumes stored results at **04:30
Asia/Shanghai**. Its scheduler, digest generation and delivery are external to
Giraffe. No weekly report or model execution is implemented.

Default B includes **all locally starred repositories, regardless of owner**:
starring is explicit user intent. An additional unstarred repository qualifies
as new only when GitHub `owner.login` matches the account login case-insensitively,
`isFork` is false, no repository publication exists, and GitHub `createdAt` is
within the current **Asia/Shanghai** day (`00:00` inclusive to next `00:00`
exclusive), evaluated at the A step. This rule is independent of the requested
observation timezone/window and does not treat an empty DB or first discovery as
proof of recent creation. Missing ownership/creation data fails closed for this
new-repository exception. Unstarred foreign repositories never enter automatic B.
No refresh changes stars. After its first publication, an unstarred repository
is excluded from later default runs. An explicit `repo` can select any current
catalogue repository after A, including another owner's repository. Stars remain
independent local owner or agent preferences, not GitHub stars.

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
Published coverage preserves the selected day observations' actual source;
windows combining REST and GraphQL evidence report `mixed`, never relabel cached
REST releases as newly collected GraphQL data.
- Daily commits use one GraphQL `history(since,until) { totalCount }` alias per
  uncached day. They are default-branch counts, not owner-only/all-branch counts.
  No REST commit pagination or reconciliation against contribution totals occurs.
- A GraphQL contribution calendar spans the preceding calendar year through the
  A collection timestamp, independently of the repository observation window.
  Leap-day arithmetic stays inside GitHub's one-year limit. The saved date range
  can include 367 dates across a leap year when both endpoints are included.
  The Dashboard's all-repository view defaults to this account-wide green grid,
  labeled with GitHub/UTC dates; it can switch to windowed repository commits.
  The calendar remains reachable before any repository B observation exists.
  Starred scope still excludes account-wide contribution statistics and shows
  repository commits instead. Missing type breakdowns are unavailable, not zero.
- PR/Issue collection starts with one page in the main repository query, then
  consumes that page before applying a proven cache/lower-bound stop. A known ID
  with a changed update timestamp is not a safe cache boundary; force bypasses
  cache stops. Daily lifecycle coverage and current open-inventory completeness
  are distinct. Unknown older open items keep the inbox truncated and refresh
  partial, even when a requested day's lifecycle counts are complete.
- Releases share the main GraphQL query (first 100, creation-time descending).
  Another page means `releases:latest_page_only`; missing pagination metadata
  means `releases:incomplete_pagination`. Publication dates cannot prove a stop
  boundary for a creation-ordered connection. Saved release fields keep their
  existing shape, with numeric IDs from GraphQL `databaseId`.
- Actions and security alerts use bounded REST samples. CI represents
  the latest/short-window sample, not exhaustive historical execution.
  Alerts are truncated only for a nonempty sample with a next-page link. An empty
  sample is complete. Security HTTP 404 and explicitly feature-disabled 403
  responses are terminal unavailable observations: complete for daily caching,
  unavailable for display, and not a partial run. Mixed available/terminal-unavailable
  features are cacheable without replacing unavailable null counts with zero.
  Permission-restricted or unrecognized 403 responses remain unavailable and
  uncached; authentication, rate limits and transient failures remain failures.
  Force, a missing day or a different observation day probes terminal unavailable
  features again. A non-forced repeat of the same complete day does not.
- Dependency analysis is unsupported and displayed as missing. Dependency alerts
  can be collected. Traffic, author-event ledgers and other uncollected dimensions
  remain explicit empty/unavailable observations, never legacy fallbacks.
  Both browser and machine repository dependency endpoints return HTTP 200 with
  empty items and `coverage.status: "unavailable"`, reason
  `dependency_analysis_unavailable`, and no invented source timestamp.

An ad-hoc, non-forced request reuses a complete A saved during the same
Asia/Shanghai day, even when repository observation dates/timezone differ.
`aReused: true` records this choice; A makes zero upstream requests and keeps its
original calendar/catalogue source timestamps. Default/scheduled runs still
collect A. Missing, partial, previous-day or forced A is collected again. A
repository absent from the current cached catalogue returns `not_found`; force
can explicitly rediscover it. No historical observation migration is involved.
The new publication uses the current request's repository window, not the reused
A's old window; saved calendar provenance remains unchanged.

Reuse also verifies the saved calendar evidence, not only its status flag. The
claimed source window must match the preceding calendar year derived from A's
own fetch timestamp, and every inclusive UTC date must be present once, in
contiguous order, with finite non-negative counts. Short historical calendars,
missing dates and malformed evidence require a fresh A. New incomplete calendar
responses are unavailable/partial and cannot become reusable complete A records.
This rejects pre-v0.27.2 window-only calendars without migrating or backfilling
their evidence.

## Request budget and partial reasons

The following counts are actual HTTP requests with empty caches, all six
dimensions, no retry and no extra issue/PR pages. A is per account, not per repo.

| Step                                                                    | GraphQL | REST | Total |
| ----------------------------------------------------------------------- | ------- | ---- | ----- |
| A account + first 100 catalogue repositories + calendar/rate limit      | 1       | 0    | 1     |
| Each additional A catalogue page (maximum 35 pages overall)             | +1      | 0    | +1    |
| A reused for a same-day non-forced ad-hoc request                       | 0       | 0    | 0     |
| B per repository: metadata, daily commit aliases, issues, PRs, releases | 1       | 0    | 1     |
| B CI: latest actions runs                                               | 0       | 1    | 1     |
| B alerts: Dependabot + code scanning                                    | 0       | 2    | 2     |
| B total per uncached repository                                         | 1       | 3    | 4     |
| B complete cache hit for all requested days/dimensions                  | 0       | 0    | 0     |

On non-forced runs with a saved repository publication, B skips GraphQL when all
requested GraphQL dimensions are cached, even if actions or alerts still need
REST collection. It uses the account catalogue's immutable repository identity
and retains saved detail metadata. A first REST-only publication still needs one
GraphQL metadata query; force also refreshes metadata. Fully cached B needs none.

For a same-Shanghai-day, single-repository non-forced repeat: A costs zero, fully
cached B costs zero, and a run missing only both security features costs two REST
requests with no GraphQL. Terminal unavailable security days count as cached.
With no rate limit/retry and typical network/D1 latency, plan for seconds rather
than minutes (roughly 1–5 seconds fully cached, 2–10 seconds with two REST calls).
These are planning estimates, not production measurements or latency guarantees;
there is no intentional healthy-path scheduling wait.

Retry not-before deadlines are persisted with their run/step identity and checked
before collection after every wakeup. A failed final alarm write cannot turn a
five-second recovery into an early rate-limit retry. Cancellation is evaluated
first and does not wait for the retry deadline.

Before v0.27.1, B used one GraphQL and four REST requests, including a redundant
REST release sample. Releases now share the main query, reducing the normal B
budget from five to four requests (20%). For 61 selected repositories and a
single A catalogue page this is 245 requests (62 GraphQL, 183 REST), not 306.
If A needs two pages, add one GraphQL request. These are budget scenarios, not
production measurements or throughput guarantees. Each additional issue/PR page
adds one GraphQL request; retries count again in their actual transport/phase.
GraphQL point cost is not the same as HTTP request count. Existing account
snapshots expose observed GraphQL remaining/reset values; the run API does not
invent a before/after cost measurement.

For the acceptance report's 127-entry catalogue and approximately 61 stars,
normal A is two GraphQL requests and B is 61 × (one GraphQL + three REST):
**246 requests, 63 GraphQL and 183 REST**. A reused single-repository request
costs four requests with an empty B cache; forcing it costs six. Fully cached B
costs zero. Extra pages, new same-day repositories and retries increase these
budgets.

The v0.27.0 observation was 28m34s for 127 repositories, approximately 13.5s per
repository, or about 14 minutes projected for 61. The former fixed successful
alarm delay alone contributed at least about 62 seconds to a 61-repository run;
non-rate-limit retries previously added 60 + 120 + 240 seconds per failed step.
The new transient retry total is 22 seconds. The report cannot distinguish all
GitHub latency from alarm delivery or prove the tail's cause. With 246 sequential
HTTP requests averaging 0.5–1 second, a no-retry run is estimated at 2–4 minutes
plus D1/publication and alarm overhead; allow roughly **3–6 minutes** for planning.
This is an explicit latency assumption, not a production measurement or SLA.
Rate limits and extra pagination can extend it substantially. No production
refresh or cancellation was used to validate this change.

`requests` remains the numeric total for existing consumers. New runs also have
`requestBreakdown: {total,graphql,rest,a:{graphql,rest},b:{graphql,rest}}`. Each
transport total equals A+B and `requestBreakdown.total === requests`.
`partialReasons: [{repo,codes}]` identifies missing/partial repositories, with
`repo: null` for A. Examples include `catalog:incomplete`,
`contributions:unavailable`, `issues:inventory_incomplete`,
`actions:github_error`, `alerts:permission_denied`, and
`releases:latest_page_only`. Exhausted repository retries use safe error codes.
New diagnostic entries can also include
`failures: [{dimension,code,httpStatus,graphqlType,graphqlPath}]`. Unknown metadata
is null; GraphQL types and path fields are allowlisted. No HTTP response means
`httpStatus: null`; an HTTP 200 parsing failure retains 200, not a local 502.
REST failures never inherit
an earlier GraphQL error. Retry exhaustion and cancellation keep the original
step's repository identity, while recovered transient errors clear `errorCode`.
Historical run payloads are not rewritten to fabricate these new diagnostics.
Every new `partial: true` run has reasons, including cached incomplete inventory;
unsupported, unrequested dimensions do not turn a selected complete window into
a partial run. Processed repositories can be partial: `completedRepos` is progress,
not a completeness count.

## HTTP contract

Browser paths use `/api/refresh-runs`, the active account, Access and same-origin
writes. Machine paths use `/api/v1/accounts/:account/refresh-runs`, fixed-account
hash-only bearer tokens and `app:read` / `app:write` scopes.

| Method/path                     | Result                                              |
| ------------------------------- | --------------------------------------------------- |
| `POST /refresh-runs`            | `202` run; accepts the parameters above             |
| `GET /refresh-runs`             | Up to 50 latest runs, `collectionAvailable: true`   |
| `GET /refresh-runs/latest`      | Latest run; `409 snapshot_missing` before first run |
| `GET /refresh-runs/:id`         | Account-fenced run; `404` for unknown IDs           |
| `POST /refresh-runs/:id/cancel` | `202` pending cancellation; `200` terminal run      |

Run states are `queued`, `running`, `completed`, `partial`, `failed`, `cancelled`. Responses
include phase, ordered repositories, completed count, actual upstream request
count and safe error code. A manual POST matching any active run's normalized
parameters returns that run, including an active scheduled run;
a different active request returns `409 refresh_conflict`. Machine settings expose
the fixed daily schedule. Legacy run controls and quick/deep/full schedules stay
removed; no alias or fallback is provided.

The POST body does not accept `requestKey` or any other unknown field (HTTP 400
`validation_failed`). There is no client-supplied idempotency key, including an
`Idempotency-Key` header contract. A manual POST with equal normalized parameters
deduplicates against any active run, returning it with HTTP 202 regardless of
whether it was started manually or scheduled. After it reaches a
terminal state, submitting the same parameters creates a new run; cached
observations may still avoid upstream work. Concurrent different parameters
return HTTP 409 rather than queueing another manual run.

Existing `PUT|DELETE /accounts/:account/stars/:owner/:name` and browser
`POST /api/repos/:owner/:name/star` manage B membership. Current observation,
factory-stream and contribution GET endpoints retain their response formats and
read only newly saved data. Tokens/PATs never enter run payloads, URLs or logs.

Cancel accepts no parameters. It records durable intent, stops after the current
A step or repository finishes, and preserves all already-written observations.
Queued runs cancel without collecting. Pending cancellation returns the run with
`cancelRequested: true` and HTTP 202; immediate cancellation and already-terminal
runs return HTTP 200. Terminal states never reopen, and repeated cancellation
returns the same terminal payload. Unknown/cross-account IDs are 404. Browser
Access/same-origin and machine fixed-account `app:write` checks apply. The browser
recognizes externally cancelled runs and releases its refresh lock.

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

`0030_refresh_run_cancel.sql` rebuilds only `refresh_runs` to permit `cancelled`,
preserving its indexes/history and all observation tables. Active v0.27.0 payloads
lack transport/reason fields and are explicitly failed with
`refresh_schema_cutover`, rather than resumed using invented counts. Their last
source timestamp and numeric request total remain intact. Historical terminal
payloads cannot be overwritten by a stale legacy writer: database triggers reject
legacy active inserts/updates and prevent terminal-to-active transitions. A legacy
Worker write during cutover fails rather than resurrecting a run or reserving its
active/scheduled slot. New run requests must reach the upgraded Worker.
Every update must advance the internal database `writer_revision`; the new save
path does so atomically. Old SQL is rejected even when an old Worker reads and
spreads a modern payload during rollback, before it can collect or corrupt counts.
Rolling back to v0.27.0 does not restore refresh functionality against this schema;
use a compatible approved revision or roll forward. Stored observations remain readable.
Historical terminal
payloads stay unchanged; `requestBreakdown`, `partialReasons` and
`cancelRequested` are produced for new runs since v0.27.1. This is not a migration
of legacy observations or a runtime compatibility fallback. The migration is
idempotent and verified against a local SQLite backup copy with rollback checks.
After a future authorized deployment, explicitly start a new run if a prior run
was cut over; this acceptance task performs no production mutation or deployment.

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
