# Machine API v1: saved data and external resources

Version 0.27.1 provides scoped unified-refresh creation/history/status/cancellation and keeps
the analysis product surface removed. The machine API remains an authenticated
boundary for saved observations, application settings and externally owned
resources. No endpoint executes local code or schedules analysis.

The complete payload and endpoint reference is [api.md](api.md). Retired endpoint
history is in [Phase 1 retirement](14-phase1-retirement.md); current refresh
parameters, scheduling and post-deploy checks are in [Phase 2](15-unified-refresh.md).

## Authentication

Every `/api/v1/*` request requires an expiring bearer token. The Worker validates
its hash, fixed account and scopes; Cloudflare Access bypass is restricted to
this path and does not make machine endpoints public. Browser token management
remains Access protected and writes require same-origin.

Tokens are returned raw only when minted, expire within 90 days and require
rotation before expiry. Never place them in URLs, logs, reports or browser
persistence. D1 stores hashes, not raw bearer tokens. GitHub PATs use the separate
AES-GCM encrypted account boundary and are never returned through the machine API.

| Scope               | Capability                                                           |
| ------------------- | -------------------------------------------------------------------- |
| `observations:read` | Read saved GitHub observations and sources                           |
| `agent:read`        | Read external records, reports and jobs                              |
| `agent:write`       | Create/update/delete external resources with revision checks         |
| `app:read`          | Read saved settings, repository metadata/state and refresh runs      |
| `app:write`         | Write local settings/state, start refreshes and request cancellation |

Unified refresh mutations require `app:write`. Invalid,
expired, revoked, wrong-account or insufficient-scope credentials fail before
reading data or changing a run. Removed quick/deep/full controls and mutable
schedule-kind routes are not aliases for the current refresh API.

## Saved observations

Account and repository observations, `/sources`, factory streams, contributions,
catalog changes and activity are local saved reads. GET never collects GitHub,
records token activity, updates metadata or rewrites legacy observations.

Preserve each source's account, version/contentVersion, timestamps, window and
coverage. Null/missing means unavailable, not observed zero; partial evidence
cannot become complete because it was read. Conditional requests retain their
authentication, account fences, query validation and private response headers.
Scope filters describe saved membership only, not separate refresh plans.

`/activity` reads a saved account-wide publication. Historical run references are
provenance, not runnable tasks. `/contributions` retains GitHub-native date
attribution and nullable type counts. Only new refresh tables feed current
observations; legacy publications are not migrated or used as a fallback.
Clients must not infer a newer source window from today's date or a cache hit.

Repository `agent-state` and `meta` resources remain separate, revisioned local
state. Their dedicated write endpoints do not change GitHub. Existing local
stars remain configuration, not an upstream GitHub star API.

## External records, reports and jobs

`/api/v1/accounts/:account/agent/{records,reports,jobs}` retains collection
GET/POST and item GET/PATCH/DELETE. Ordinary duplicate IDs return
`409 resource_exists`; updates/deletes require revision checks. Payloads remain
bounded JSON objects. Creating a job stores data only and never executes it.

The existing canonical `github-daily` report validation and same-date revision
rules remain machine API behavior, not a Dashboard feature. Latest-report reads
support exact source timestamps, invalid legacy-row accounting and ETag/304.
Other externally published reports retain their resource contracts. See the
[reference](api.md#records-reports-and-jobs) for limits and examples.

There is no `/analysis` page, daily-report picker, bot-status display, analysis
navigation item or analysis-only browser API. Historical resources and AI tables
can remain untouched. This release adds no weekly report or analysis generator.

## Unified refresh management

Paths below are relative to `/api/v1/accounts/:account`. Run reads require
`app:read`; start/cancel require `app:write` and the same fixed-account fence.

| Method/path                     | Result                                                           |
| ------------------------------- | ---------------------------------------------------------------- |
| `POST /refresh-runs`            | `202`, durable account A followed by serial repository B         |
| `GET /refresh-runs`             | `200`, up to 50 runs and `collectionAvailable: true`             |
| `GET /refresh-runs/latest`      | `200` latest run, or `409 snapshot_missing`                      |
| `GET /refresh-runs/:id`         | `200` run, or `404 not_found`                                    |
| `POST /refresh-runs/:id/cancel` | Cooperative, idempotent cancellation; retains saved observations |

Start accepts optional `since`, `until`, `timezone`, `dimensions`, `force` and
explicit `repo`. Date windows contain 1–31 closed days. Matching active manual
requests deduplicate; different parameters return `409 refresh_conflict`.
Automatic B selects all locally starred repositories regardless of owner, plus
unobserved, non-fork repositories owned by the account and created during the
current Asia/Shanghai day. Owner filtering applies only to that new-repository
exception, not to explicit stars. Empty storage does not qualify
historical repositories as new. Explicit single-repository refresh can select
any current catalogue repository and never changes stars.

Cancellation stops after the current repository (or current A step), not midway
through its writes. A queued run can be cancelled without collecting. Responses
return the run: `202` while cancellation is pending, `200` once cancelled or if
already terminal; unknown/account-mismatched IDs are `404`. Repeating cancellation
does not reopen completed, partial, failed or cancelled runs. `cancelRequested`
distinguishes an accepted request from the terminal `cancelled` state.

`requests` remains the numeric total. `requestBreakdown` contains
`{total,graphql,rest,a:{graphql,rest},b:{graphql,rest}}`, including actual retries
and pagination. `partialReasons` contains `{repo,codes}` entries (`repo: null`
for account-level missingness); every partial result has safe reason codes.
Never treat `completedRepos` as the count of complete repositories: partial
repositories can also have finished processing.

Detailed request/reason/cancellation fields apply to new v0.27.1 runs. Historical
terminal payloads remain unchanged; schema cutover fails old active payloads
with `refresh_schema_cutover` rather than inventing transport counts or silently
resuming incompatible state. It preserves already-saved observations.

`GET /settings` exposes `collectionAvailable: true` and the fixed
`03:00 Asia/Shanghai` starred schedule (`cron: "0 19 * * *"`). GET never starts
that schedule. Legacy `/:id/control` and `/schedules/:kind` return authenticated
`404 not_found`; they cannot resume historical runs or schedules. See the
[refresh contract](15-unified-refresh.md) for request budgets and missingness.
