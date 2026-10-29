# Machine API v1: saved data and external resources

Version 0.26.0 removes collection execution and the analysis product surface.
The machine API remains an authenticated boundary for saved observations,
application settings and externally owned resources. No endpoint executes local
code, schedules analysis or starts a GitHub collector.

The complete payload and endpoint reference is [api.md](api.md). Retired endpoint
responses and post-deploy checks are in [Phase 1 retirement](14-phase1-retirement.md).

## Authentication

Every `/api/v1/*` request requires an expiring bearer token. The Worker validates
its hash, fixed account and scopes; Cloudflare Access bypass is restricted to
this path and does not make machine endpoints public. Browser token management
remains Access protected and writes require same-origin.

Tokens are returned raw only when minted, expire within 90 days and require
rotation before expiry. Never place them in URLs, logs, reports or browser
persistence. D1 stores hashes, not raw bearer tokens. GitHub PATs use the separate
AES-GCM encrypted account boundary and are never returned through the machine API.

| Scope               | Capability                                                             |
| ------------------- | ---------------------------------------------------------------------- |
| `observations:read` | Read saved GitHub observations and sources                             |
| `agent:read`        | Read external records, reports and jobs                                |
| `agent:write`       | Create/update/delete external resources with revision checks           |
| `app:read`          | Read saved local settings, repository metadata/state and run skeletons |
| `app:write`         | Write supported local settings and repository metadata/state           |

Legacy collection mutations still check `app:write` but then return
`410 collection_unavailable`; that scope cannot enable collection. Invalid,
expired, revoked, wrong-account or insufficient-scope credentials fail before
reading data or returning an unavailable capability response.

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
attribution and nullable type counts; no new daily observations are produced in
phase 1. Clients must not infer a newer source window from today's date.

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

## Retired collection management

- `GET /refresh-runs`: empty `items`, `collectionAvailable: false`.
- `GET /refresh-runs/latest`: `410 collection_unavailable`.
- `POST /refresh-runs` and `POST /refresh-runs/:id/control`: the same 410 code.
- `PUT|DELETE /schedules/:kind`: the same 410 code.
- `GET /settings`: `schedules: []`, `collectionAvailable: false` alongside saved
  stars and the existing deprecated statistics fields.

These requests neither resume old runs nor mutate historical schedules. There
is no data migration and no phase-2 A+B collector in this release.
