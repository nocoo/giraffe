# Machine API v1 Reference

The machine API reads saved GitHub observations, stores reports/records/jobs, and
optionally manages refresh settings. It is not a live GitHub proxy or a model
inference service. Only `https://giraffe.hexly.ai/api/v1/*` has an Access bypass;
the Worker authenticates resource requests. The dashboard and credential-management
endpoints remain Access protected. Accounts/snapshots are deployment-shared, not
per-user tenants. See [the boundary contract](11-agent-api.md).

## Daily reports and latest report

POST `/accounts/:account/agent/reports` with `agent:write` accepts the new
`github-daily` type. The resource is global: `repository` must be null or omitted,
`status` must be `completed`, and `source_version` remains optional opaque metadata.
The payload is strict at every nesting level:

```json
{
	"date": "2026-10-22",
	"window": { "since": "2026-10-22T00:00:00+08:00", "until": "2026-10-22T06:00:00+08:00" },
	"refreshRunId": "daily-run-id",
	"headline": "Delivery review",
	"sections": [
		{
			"title": "CI",
			"markdown": "One run needs review.",
			"items": [
				{
					"repo": "nocoo/giraffe",
					"kind": "ci",
					"url": "https://github.com/nocoo/giraffe/actions",
					"severity": "review"
				}
			]
		}
	],
	"comparisons": { "vsYesterday": "One fewer failure", "vs7d": "Stable" },
	"links": { "xray": "https://example.com/daily" },
	"generatedAt": "2026-10-22T06:10:00+08:00",
	"sources": [
		{
			"resource": "account:ci",
			"version": "saved-version",
			"fetchedAt": "2026-10-22T05:30:00+08:00",
			"complete": true,
			"stale": false
		}
	]
}
```

The calendar-valid `date` is the producer's Beijing reporting date, not a UTC-day
slice. Backfills and next-day regeneration are allowed; it need not equal the
window, generation date or server date. Window endpoints must be ISO timestamps
with timezone and `since <= until`; all daily timestamps are at most 128 characters.
`refreshRunId` uses the existing 1–80-character resource ID syntax, without a
foreign key because retained runs can expire. Giraffe computes no comparisons.

| Field                        | Limit                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Whole payload                | 65,536 serialized UTF-8 bytes; existing 70,000-byte request-envelope cap                                                     |
| Headline / section title     | Nonblank, 300 / 200 characters                                                                                               |
| Sections / items per section | At most 12 / 50; empty arrays allowed                                                                                        |
| Markdown / each comparison   | 12,000 /4,000 characters; empty text allowed                                                                                 |
| Item repo                    | Valid owner/name≤200 characters, or null for global evidence                                                                 |
| Item kind / severity         | Nonblank producer labels≤40 characters; no inferred severity taxonomy                                                        |
| Item URL / Xray URL          | Absolute HTTPS≤2048 characters, any host, no credentials                                                                     |
| Sources                      | At most 500 strict source records                                                                                            |
| Source fields                | Nonblank resource≤240; nullable version≤200; optional SHA-256 contentVersion; nullable ISO fetchedAt; boolean complete/stale |

The canonical ID is `github-daily-YYYY-MM-DD`; omit `id` or supply that exact value.
The first POST returns 201/revision 1. A subsequent POST for the same account/date
atomically replaces the same row, preserves created_at, increments revision and
returns 200, even if the content is identical. This is mutable revisioning, not an
immutable report-version archive. An ID collision with another resource or an
untrustworthy legacy date returns 409 `resource_exists`, never overwrites it.
PATCH retains the existing revision CAS contract; type, global scope and date are
immutable, and any supplied payload is a full replacement. Invalid bodies return
400 `validation_failed`; stale PATCH returns 409. Other generic resource types keep
their existing create/list/detail/PATCH/DELETE contracts.

GET `/accounts/:account/agent/reports/latest?type=<type>` requires `agent:read`.
Browser equivalent: `/api/agent/accounts/:account/reports/latest?type=<type>`,
protected by Access and the active account. Exactly one valid type query is
required for this operation; unknown/repeated parameters return 400. Without a
type query, the bare `reports/latest` path retains its existing meaning as the
resource whose ID is `latest`, including its PATCH/DELETE operations.

The response is `{account_id,item}` (null when absent); for daily it also includes
`invalidCount`. Selection uses the exact generatedAt instant descending, including
sub-millisecond fractions and timezone offsets, then binary ID descending. It
does not use updated_at, insertion order or the generic list's first page. Generic
types only require a valid generatedAt; no new status or analysis-schema filter is
applied. Daily selection additionally requires the strict canonical/global/completed
contract. Invalid or noncanonical legacy daily rows are hidden and counted, not
deleted or repaired; their generic list/detail access remains unchanged. Repair
requires explicit deletion and canonical POST, not an identity-changing PATCH.

Latest supports strong response ETags and standard If-None-Match/304, including
empty results. Authentication, account fencing and query validation precede
conditional matching. Both 200 and 304 retain private/no-store, no-referrer and
reader-specific Vary headers. GET never fetches GitHub or records token activity.

Browser GET `/api/agent/accounts/:account/analysis/daily` accepts no query and returns
`{account_id,items,invalidCount}` with the newest seven valid reporting dates through
the same selector; its first item equals daily latest. The analysis page starts
there, supports date browsing, and shows a notice for hidden reports. Markdown is
displayed as escaped plain text with preserved whitespace, consistently with the
existing report renderer; raw HTML and Markdown-generated links never execute.
Explicit HTTPS evidence/Xray links open with noopener/noreferrer. Four existing
domain cards remain available. The new readers scan only the selected account/type's
retained reports; no indexed O(1) latest claim is made. Existing optimized analysis
projection and `/sources` reads remain unchanged. No migration is required.

## Run readiness

`GET /accounts/:account/refresh-runs/latest?kind=daily|weekly|catalog|manual|quick|deep`
requires `app:read`. Browser equivalent: `GET /api/factory/runs/latest` with the
same query, Access protection and active account. The required kind selects the
latest retained matching run, not merely the latest 21 entries. Unknown or repeated
filters return 400; an absent match returns 404. Daily/weekly select trigger,
catalog selects mode, manual includes legacy unspecified trigger, and quick/deep
select refresh depth across **all triggers and scopes**, including manual
selected-scope refreshes (legacy unspecified depth is deep). Use `kind=daily`
for scheduled daily refreshes; `kind=quick` is not a scheduled-daily filter.
Ties use stored creation time then ID descending. The response includes `account_id`, `id`, canonical
`kind`, `depth`, `status`, `window`, `startedAt`, `expectedFinishAt`,
`expectedFinishAtReason`, `finishedAt`, `counts`, `failedSteps`, `lastError`,
`trigger`, `previousActivityRunId`, and `publishedAt` and `publishedAtReason`.
The returned `kind` is
`catalog|daily|weekly|manual`, determined by mode/trigger, **not** necessarily the
query selector: `?kind=quick` can return `kind:"daily",depth:"quick"` or
`kind:"manual",depth:"quick"`, for example when the latest matching run is a
manual selected-scope quick refresh.
`depth` is `quick|deep|null`, null for catalog and deep for historical refreshes
without a saved depth. Activity-eligible runs expose their activity window. ETA uses
the plan-scaled, same-execution-kind calibration described under
[GET /refresh-runs](#get-refresh-runs), not a deadline.
For every selector, terminal runs (`completed`, `failed`, `partial`, `cancelled`)
return `expectedFinishAt: null` with `expectedFinishAtReason: "terminal"`.
Use `finishedAt` for the actual end; it is not an estimate.
SQLite projects the needed scalar/window fields, step counts and failed-step
summaries; the reader does not transfer or parse the complete run payload,
successful-step details or checkpoints. Failed steps retain their stored order.

`publishedAt` is also present on run list/detail views. Completed **or partial**
runs set it in the same fenced transaction as site snapshots, catalog changes,
factory head and eligible activity. Running, failed and cancelled runs have null.
Readiness is not completeness: inspect counts, failed steps and source coverage.
Historical markers remain null when atomic publication is unprovable (0022).
Runs created before the staging protocol also keep null when resumed to completion;
only newly created runs carry the internal atomic-publication capability marker.

Latest-readiness `publishedAtReason` is null when `publishedAt` is present.
Otherwise it is `in_progress` for running/paused, `failed` or `cancelled` for those
terminal statuses, `legacy_unprovable` for completed/partial runs without atomic
publication capability or a historical timestamp field, and `not_published` for
atomic-capable completed/partial runs with an explicit null timestamp. Migration
0022 wrote null timestamps to old runs; the capability marker, not merely the
presence of that null field, distinguishes those legacy runs. This is read-time
metadata only: no backfill, migration or publication is performed by GET.

`/sources` adds `runId` and `observedAt`. Sources touched by a new publication use
its run ID and common publication time as `fetchedAt`; `observedAt` and `freshness`
preserve collection times. Untouched/retained streams keep their original run/time;
legacy snapshot sources have null runId. Derived CI uses its newest published
input, without claiming every component is fresh.
`since` compares visibility time, including sources collected before the cutoff
but published afterwards. Publication provenance does not change CI source versions.
For eligible runs, `/activity?run=latest` and `account:activity` share the published run ID/time.
Catalog/deep/selected runs do not replace the account activity head. Separate GETs
can straddle a subsequent publication; compare IDs or pin `/activity?run=<id>`.
GET never starts work, records token use or changes run state.

## Repository metadata

GET `/accounts/:account/repos/:owner/:name/meta` requires `app:read`; the
Access-protected browser reads `/api/repos/:owner/:name/meta` for its active account.
The result includes account/repository/removal context and
`{created_at,first_seen_at,archived_at,deleted_at,category,exclusion_reason,updated_at,field_sources}`.
Known catalog identities return null for unset values; unknown identities are 404.
`/repos.meta` exposes the same metadata fields without account/repository context.
Legacy rows without a known catalog identity have null meta.

PUT on the machine route requires `app:write` and at least one field from the
strict body `{created_at?,archived_at?,category?,exclusion_reason?}`. Dates must be
ISO timestamps with a timezone; category is `app|docs-vault|profile|repro|derivative`;
exclusion reason is a string of at most 200 characters. Empty bodies, null clearing,
unknown fields, invalid dates and unknown categories return 400. The request body
is limited to 4096 UTF-8 bytes; malformed or oversized bodies return 400
`invalid_payload`. Each supplied field
is patched atomically with `field_sources[field]="agent"`; omitted fields are retained.
Metadata has no revision precondition: concurrent disjoint-field patches compose,
and the last committed patch wins for the same field.

Catalog collection may fill an empty created_at from GitHub createdAt with
`field_sources.created_at="catalog"`, but never replaces a previously saved value.
Creation-date fills stamp their publication write time without regressing a newer
metadata update time; already-populated rows remain unchanged.
Agent-written fields survive refreshes, renames and removals. Metadata is keyed by
stable account/catalog identity. Retained removed identities may be read and written;
their first_seen_at/deleted_at always come from catalog history, never caller input
or duplicate metadata columns. GET does not initialize or update metadata. Browser
details display creation time and category read-only. Metadata does not change
the saved GitHub source fingerprint or add `/sources` queries.

## Repository agent state

`GET /accounts/:account/repos/:owner/:name/agent-state` requires `app:read`.
The Access-protected browser equivalent is `/api/repos/:owner/:name/agent-state`
for the active account; the browser has no write endpoint. GET returns
`{account_id,repo,repo_removed,payload,revision,updated_at,updated_by}`. A known
repository with no state returns null state fields, revision null and ETag `"0"`;
an unknown identity is 404. The ETag is a revision concurrency token. GET is
uncached and always returns the current representation (not 304), because catalog
rename/removal can change context without changing the state revision.

`PUT` on the machine route requires `app:write` and a strict body
`{revision?,payload}`. Payload must be a JSON object; serialized UTF-8 JSON must
not exceed 16,384 bytes, with at most 64 nested object/array containers (the root
object is depth 1). Own JSON keys, including `__proto__`, remain opaque and are
preserved without changing prototypes. Invalid/deeper bodies return 400 `invalid_payload`; oversized
payloads return 400 `payload_too_large`. Giraffe stores other fields opaquely.
The complete request body has a 100,000-byte transport cap, independent of the
serialized-payload cap; excess whitespace/escaping does not bypass it.
- Create without a revision or with `If-Match: "0"` (the ETag of missing state).
  The zero header is create-only: existing state, including a concurrent create,
  returns 409 `revision_conflict` without overwriting it. It takes precedence over
  a valid body revision; body `revision:0` remains invalid. The repository must currently belong to the saved
  catalog. Revisions are allocated monotonically across the account, not per
  repository; clients must use the returned value, never assume 1 or increment it.
  A removed/replaced identity cannot reuse another identity's old revision.
- On update, supply the current positive revision or `If-Match: "<revision>"`.
  The header takes precedence when both are present. Missing revision is 428;
  a stale/nonexistent revision is 409 `revision_conflict`. Weak tags, wildcard
  tags and malformed tags are rejected with 400.
- GET's ETag is the quoted revision. PUT returns the saved representation.
- State is account-scoped and keyed by stable catalog identity, not name.
  Catalog refreshes, renames, removal and factory publication do not modify it.
  A removed repository remains readable with `repo_removed:true`; existing state
  may still be updated with its current revision, but no first write is allowed.
- `/repos` adds nullable `agent_state:{revision,updated_at,summary,status}`.
  A string summary of at most 200 characters is exposed; otherwise it is null.
  Status is `ok|attention|blocked`, or null for any other payload value. No other
  payload fields are projected into the list. The read-only detail panel also
  displays a valid `last_reviewed_at` supplied in the payload.

State is not a GitHub observation. These contextual `/repos` additions do not
change its saved source version/content fingerprint or add `/sources` queries.
Reusing a repository name for a different GitHub identity never transfers notes.

## Authentication and examples

Examples use Bash, curl and jq; the identity/UUID examples also use Node.js. These
helpers only abbreviate curl headers and do not retry requests automatically:

```bash
BASE='https://giraffe.hexly.ai'
read -r -s -p 'Giraffe API token: ' TOKEN; printf '\n'
api() { curl --fail-with-body -sS -H "Authorization: Bearer $TOKEN" "$@"; }
json() { api -H 'Content-Type: application/json' "$@"; }
ACCOUNT="$(api "$BASE/api/v1/me" | jq -er '.account_id')"
API="$BASE/api/v1/accounts/$ACCOUNT"
OWNER='nocoo'; NAME='giraffe'; REPOSITORY="$OWNER/$NAME"
```

Use Giraffe's account ID and API token, not a GitHub login, PAT or model key.
Use HTTPS, disable shell tracing and keep the bot token in private configuration.
Never put credentials in URLs, logs, report payloads or persisted browser state.
- Tokens are hash-only, fixed-account, revocable and expiring: **1-90 days,
  default 30**. Raw tokens are returned once, when minted. Revocation applies
  on the next request. Tokens cannot change the dashboard's active account.
- Scopes are independent: write does not imply read. Mint requires at least one
  unique known scope. An analysis bot needs only `observations:read`, `agent:read`,
  `agent:write`; it does not need `app:write` or model configuration in Giraffe.
- GET never collects GitHub or updates token activity. Successful mutations update
  `last_used_at`. Every `/api/v1/*` response, including authentication 401/403,
  validation 400, not-found 404, unexpected errors and 304, uses
  `Cache-Control: private, no-store`, `Vary: Authorization` and
  `Referrer-Policy: no-referrer`. Other `Vary` dimensions are preserved.
- JSON writes require `Content-Type: application/json`, UTF-8 if charset is given.
  Strict schemas reject extra fields. No body/query is defined unless listed.
- Reads/updates return 200, resource creation 201, refresh start/control 202,
  deletions 204 with no body except star deletion, which returns its 200 record.
  Separate reads are not a transaction; verify versions.

| Scope               | Allowed operations                                                          |
| ------------------- | --------------------------------------------------------------------------- |
| `observations:read` | GET sources, catalog, account/repository observations and published streams |
| `agent:read`        | GET records/reports/jobs                                                    |
| `agent:write`       | POST/PATCH/DELETE records/reports/jobs                                      |
| `app:read`          | GET settings and refresh runs                                               |
| `app:write`         | PUT/DELETE settings; POST refresh start/control                             |

**Rotation:** before `expires_at`, mint a replacement through the Access-protected
dashboard for the same account/minimal scopes, replace the bot's private credential,
verify `/me` and a source read, then revoke the old token. PATCH only renames or
reduces scopes; it cannot extend expiry, add scopes or change account. An expired
token cannot renew itself; there is no refresh token. Monitor expiry out of band.

### GET /api/v1/me

Requires a valid bearer, no particular scope, query or body:

```bash
api "$BASE/api/v1/me"
```

```json
{
	"account_id": "AAAAAAAAAAAAAAAAAAAAA",
	"login": "nocoo",
	"token": {
		"id": "token-id",
		"scopes": ["observations:read", "agent:read", "agent:write"],
		"expires_at": "2026-11-18T08:00:00.000Z"
	},
	"capabilities": {
		"observations": true,
		"agentRead": true,
		"agentWrite": true,
		"appRead": false,
		"appWrite": false
	}
}
```

## Saved observations

All methods here are GET with `observations:read`, no body. Paths below are relative
to `/api/v1/accounts/A`; `A` must equal the token account. Repository lookup is
case-insensitive against the saved catalog and resolves to canonical `owner/name`.
A repository outside that catalog is 404, even if it exists on GitHub.

Account observation lists, aggregates and source indexes also exclude repositories
outside the current saved catalog, case-insensitively, including retained factory
publications. Filtering happens at read time: historical snapshots and publications
remain stored. Account lists and browser views select account-owned repositories:
`all` includes every owned catalog entry and `starred` intersects it with local stars.
Archived and forked owned repositories remain eligible. Generic records/reports/jobs are
application resources, not GitHub observations, and retain their independent CRUD
contract.

### GET /accounts/A/sources

Shares saved-source assembly with the browser's `/api/agent/accounts/A/sources`.
Machine `repositories` is the sorted **owned saved catalog**, including unstarred,
forked and archived repositories. Non-owned entries never enter refresh membership
or freshness/coverage denominators.
It does not depend on the dashboard active account or browser activation filter.

| Query        | Validation / meaning                                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `since`      | Optional strict ISO datetime with `Z` or explicit offset; e.g. `2026-10-18T08:00:00Z` or `2026-10-18T16:00:00+08:00`. Empty, offset-less and invalid calendar values fail with 400. |
| `repository` | Optional `owner/name`, at most 200 characters, matching `[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+`; resolve to canonical catalog name, or 404.                                               |

Unknown query keys fail with 400; there is no scope, pagination or cursor.
This strict-key rule applies to every documented machine GET: only that endpoint's
listed query keys are accepted; endpoints without query parameters reject all
keys. Errors use `{error:{code:"validation_failed",message}}`, after bearer,
account and scope checks. Do not append cache-busters or a repository-level `scope`.
Use URL encoding so `+` in offsets is not interpreted as a space:

```bash
api "$API/sources"
api -G "$API/sources" --data-urlencode 'since=2026-10-18T16:00:00+08:00' \
  --data-urlencode "repository=$REPOSITORY"
```

```json
{
	"account_id": "AAAAAAAAAAAAAAAAAAAAA",
	"repositories": ["nocoo/giraffe"],
	"sources": [
		{
			"resource": "repo:nocoo/giraffe:issues",
			"version": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			"contentVersion": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
			"fetchedAt": "2026-10-19T00:10:00Z",
			"freshness": {
				"oldestAt": "2026-10-19T00:10:00Z",
				"latestAt": "2026-10-19T00:10:00Z",
				"total": 1,
				"missing": 0
			},
			"coverage": null,
			"truncated": false,
			"unavailable": false
		}
	]
}
```

Each source has all eight fields shown. `contentVersion` is nullable: rows saved
before content metadata was introduced have no stored hash. Account list
projections (including issues/PRs/repos) and CI compose deterministic hashes even
with legacy inputs: each saved input uses its content hash, or `unhashed:` plus
its full stored version (computed from the frozen saved JSON when absent).
Absent snapshots use the distinct `missing` marker. Thus an unstarred, archived
or fork repository's legacy page cannot null the entire account hash. Legacy
inputs remain sensitive to full-version changes, including collection time,
until an ordinary refresh saves their content metadata. Factory streams require stored metadata for
the advertised immutable version; missing/mismatched metadata returns null while
the existing version/coverage remains. Null is not a content proof: fall back to
full-version equality. Hashes fill in after the source's next ordinary refresh;
GET never backfills them. Source identities map to data endpoints:

| Resource identity                                                                                    | Data endpoint                       |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `repo:owner/name:details`, `:issues`, `:prs`, `:actions`, `:releases`                                | `/repos/owner/name/:resource`       |
| `account:repos`, `account:issues`, `account:prs`, `account:ci`, `account:factory`                    | Corresponding account endpoint      |
| `account:activity`                                                                                   | `/activity?run=latest`              |
| `factory:owner/name:commits`, `:issues`, `:prs`, `:actions`, `:releases`, `:alerts`, `:dependencies` | `/factory/repos/owner/name/:stream` |

Only saved repository pages appear. Missing account snapshots/publications are
omitted, not successful zeroes; `account:ci` can describe missing inputs. Factory
entries refer to published repository versions, not in-progress attempts. Traffic,
security, languages and contributors are readable but not indexed here. Source
ordering is unspecified. Factory repository filtering is case-insensitive even
when a newer catalog spelling differs from a retained publication; source
identities and versions retain their original published spelling.
Retained repository-page keys can also differ from current catalog capitalization.
The source index and page/CI readers resolve these keys case-insensitively, assemble
each stored page group separately, and select the newest valid saved timestamp.
The selected original resource spelling and content version are shared by the index
and corresponding endpoint; older case variants remain stored, not indexed twice.

`repository` narrows repository-page/factory entries but retains account/global
entries and the full `repositories` array. `since` filters only `sources`: discard
invalid/missing timestamps, take the **maximum valid time** of `fetchedAt` and
`freshness.latestAt`, and retain the source only if that time is **strictly greater**
than `since`. With no valid time, retain it conservatively. Equality is excluded.
This matters for merged global issues/PRs/repos: `fetched_at` may remain old while
changed `repository_fetched_at` advances `freshness.latestAt`.

**Not a durable change cursor:** versions can change without newer timestamps,
retained old evidence keeps its original time, and failed/budget-deferred analysis
can remain pending. Retry pending/failed older work before advancing a local cutoff,
retain pending identity/full-version state, and reconcile periodic unfiltered full
scans. An empty filtered result is not proof that all analysis is complete.

#### Conditional source polling

Successful machine `/sources` responses include a strong, quoted `ETag` derived
from the exact response content. Send the received validator in `If-None-Match`
on the same query variant: a match returns 304 with no body; a mismatch returns
200 with the current JSON and validator. Weak validators and comma-separated
validator lists are accepted for GET comparison. `*` tests representation existence,
not whether your previous source index is unchanged; do not use it as a poll cursor.
Treat validators as opaque, including any weak prefix added by the edge.

Bearer authentication, expiry/revocation, account/scope authorization and query
validation still run before a 304. Both 200 and 304 retain `Cache-Control: private,
no-store`, `Vary: Authorization` and `Referrer-Policy: no-referrer`. This supports
explicit validator polling, not shared caching or automatic browser body caching.
GET/304 never records token activity or writes source metadata. Content/catalog/
coverage changes can invalidate the tag even without newer observation timestamps;
304 is not evidence that pending analysis has finished.

The reader reuses saved inputs within the request. Factory stream hashes come
only from small persisted metadata: `/sources` never reads stream payload bytes
to produce them. Conditional responses avoid body transfer, not all
database/projection work. Cloudflare negotiates production response compression;
the Worker does not manually gzip JSON. See the measured
[source performance and compression notes](12-source-performance.md), including
the distinction between the strong application tag and possible edge transforms.

#### Source request timing

Authenticated sources, account observations, repository details/tabs, factory
streams, contributions, settings and run-list GET responses (200/304) include
`Server-Timing` with fixed
names, millisecond durations and safe numeric work counters. It contains no SQL, IDs, token material,
repository names or upstream diagnostics. Timings are request-local headers;
they do not enter the JSON body, source versions or ETag input.
- `auth`: bearer hashing, token lookup and token validation.
- `d1_1`, `d1_2`, ...: each actual D1 round trip in execution order, including
  authentication. A batch is one round trip, not one per SQL statement.
- `sql_1`, `sql_2`, ...: D1-reported statement execution time when available;
  absent metadata is omitted, never fabricated as zero. Indices include the
  authentication query even when its `first()` result lacks execution metadata.
- `build`: complete source-reader wall time, including its D1 waits.
- `decode`: instrumented saved-JSON decoding; `hash`: hash-producing source
  projections and ETag digest work, including their input preparation;
  `serialize`: response JSON construction; `total`: measured machine-route duration
  through ETag/304 processing, before network delivery.
- `decoded_rows`, `decoded_bytes`, `hash_ops`, `serialized_bytes`: nonnegative
  integer counts in `desc`, not durations. Bytes are UTF-8 JSON input/output
  bytes, before response compression; decoding includes saved content metadata.

Phases can overlap (`build` contains reader phases); do not sum them to estimate
CPU time. Overlapping operations in one phase are timed once. Worker clocks
freeze during pure CPU work, so honest durations can be zero; no fake minimum
or artificial I/O is used. Whole-request CPU comes from Workers Observability
`cpuTimeMs`; local high-resolution measurements prove CPU-phase costs. Compare D1
round-trip wall time with available SQL execution time to separate transport
latency from query cost. Header values vary even when the body and ETag do not.
No timing header is returned for denied requests or unrelated endpoints.

### Observation envelope

The following data endpoints return this envelope; `/sources` does not:

```json
{
	"account_id": "AAAAAAAAAAAAAAAAAAAAA",
	"data": { "issues": [], "fetched_at": "2026-10-19T00:10:00Z", "truncated": false },
	"sourceVersion": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	"contentVersion": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
	"fetchedAt": "2026-10-19T00:10:00Z",
	"freshness": {
		"oldestAt": "2026-10-19T00:10:00Z",
		"latestAt": "2026-10-19T00:10:00Z",
		"total": 1,
		"missing": 0
	},
	"coverage": null,
	"truncated": false,
	"unavailable": false,
	"source": { "kind": "snapshot", "resource": "repo:nocoo/giraffe:issues", "publicationId": null },
	"selection": { "scope": "all", "statisticsFilter": false }
}
```

Compare the full opaque `sourceVersion`: saved snapshots use `sha256:` plus hex;
factory versions/publications need not be hashes. `fetchedAt` is saved source time
or null, not response time. Preserve raw `repository_fetched_at`, original windows,
coverage and per-repository unavailable/forbidden flags. `coverage` is null when
absent. Top-level flags alone do not establish completeness; inspect freshness,
raw source flags, coverage and CI missing inputs. Unknown is never an observed zero.

For account repos/issues/PRs, `freshness.total` counts the selected catalog repositories,
including repositories with no open items (`all` is the owned catalog; `starred` is its
intersection with local stars). Each repository contributes the saved time of the
data actually served: a newer complete per-repository page when available, otherwise
its recorded aggregate time or the baseline time supplying its retained rows. An
empty baseline proves coverage only when its complete snapshot covered the catalog
at that time; repositories added later without observations count as `missing`.
Invalid/absent times also count as missing. `oldestAt` includes old baseline data,
not just the recently refreshed subset. `latestAt` and top-level `fetchedAt` identify
the newest selected observation; neither implies that all data is that fresh. Check
`oldestAt` and `missing` before treating the response as current. This projection is
shared with account entries in `/sources` and never refreshes data on GET.

Factory freshness counts the selected owned catalog: all owned repositories for
`all`, and starred-owned repositories for `starred`. Archived and forked repositories
are included. A selected repository absent from the publication or without a valid
`observation.refreshedAt` counts as missing; non-owned repositories never count.
This rule is shared by browser factory freshness, machine `/factory` and
`/sources`'s `account:factory`. Statistics overrides have no selection effect.
Projected factory data includes `selectedRepos`, an explicit read-time list of
`{name,description,language,topics}` members. Nullable metadata stays unknown;
`repos` contains real publications only. Browser filters apply to membership
before joining observations, so two selected repositories with only one complete
publication produce 7/14 stream coverage, one missing repository and warning
health. A missing-only selection has 0/7 coverage and unknown metrics/times, not
invented zero observations. Unknown catalog topics cannot exclude a member from
a topic filter. This metadata is not persisted into immutable publications.

Individual factory streams use the same freshness calculation in `/sources` and
`/factory/repos/:owner/:name/:stream`: `total:1`, with `missing:1` whenever coverage
is not `complete` or its saved `coverage.fetchedAt` is absent/invalid. Otherwise
`missing:0`. A valid saved timestamp remains both `oldestAt` and `latestAt`, even
when coverage is missing; invalid timestamps yield null bounds. Missing measures
coverage, not merely the presence of dated rows. In particular, retained limited
dependencies correctly report `missing:1` on both endpoints, not `0` just because
old evidence has a timestamp. Retained complete evidence reports `missing:0` but
keeps its original timestamp: completeness does not establish recency. Current
limited evidence also reports `missing:1`; only complete, dated evidence reports
zero. Consumers must check both coverage and age before treating a stream as fresh.
Machine `/factory` and `account:factory` expose `truncated:true` when
`publication.inventory.complete !== true`, even when `freshness.missing` is zero.
An existing saved `truncated:true` is also preserved, even with complete inventory;
the same combined rule enters the account factory content hash.
`fetchedAt` is the latest eligible immutable observation, never the publication
clock. Inventory `total`, `scanned` and `pages` remain historical collection
metadata, not projected repository counts.
Default/`scope=all` factory reads preserve the saved account-wide contribution
calendar exactly: all saved `contribution.days[]` entries, totals, status and
`contributionObservation` provenance. Repository/catalog filtering does
not rewrite this account-wide evidence. Only `scope=starred` returns
`contribution:null`, `contributionExcluded:true` and `contributionStatus:"unavailable"`
without `contributionObservation`: the calendar has no repository breakdown and
cannot be attributed to that subset. Original publication windows and repository
versions are retained; GET neither recollects nor rewrites the calendar.
Newly recollected calendars retain outside-window dates up to a 90-date display
span. `contribution.total` sums calendar counts across that span;
`contribution.restricted` is `null` if retained daily restricted attribution is
unavailable, rather than reporting an incomplete sum as a complete total.
Expanded repository `observation.window` is the daily-chart display range;
`observation.collectionWindow`, when present, is the actual raw-stream collection
range. Stream endpoints keep their `ranges` and observation window tied to that
collection range, including after a later failed refresh retains the stream.
`coverage.completeWindows` records complete daily-metric intervals inside an
expanded display span. Consumers must not certify gaps or previously unavailable
dates from the latest stream status alone.
CI freshness `total` counts selected owned repositories. A repository counts once
as `missing` if any required Actions/releases/details dependency lacks a valid
available timestamp. `oldestAt` and `latestAt` still inspect all three dependencies;
they never collapse a partly missing repository into complete coverage.

### Content version recipe

Historical/direct snapshot `version` in `/sources` and `sourceVersion` in
observation envelopes retain their existing full JSON digest, including
`fetched_at`, so a new saved refresh timestamp changes them. New staged site
snapshots instead use the publication-bound composite rule below; do not derive
their full version by hashing response JSON alone. Account projections still
derive full versions from their projected JSON. Factory/publication/stream/calendar
versions instead use their original run IDs. The additive, nullable
`contentVersion` uses saved hashes and read-time account compositions; legacy
account inputs use the full-version marker described above. Factory stream
payloads are never decoded and hashed on GET. It is not an ETag; `/sources` ETags still describe the full
response, so refresh metadata can change an ETag while content versions stay equal.

The exact recipe in [content-version.ts](../apps/web/src/server/lib/content-version.ts):
1. At write time, start with the saved logical snapshot after page splitting and
   size limits, reassemble its pages, and apply `prSnapshot` to normalize a root
   `pull_requests` list. Factory stream writes start with saved raw
   `FactoryStreamData`, not the later machine response wrapper or its dependency/PR
   projections. For content hashing only, replace `ranges` with
   `[checkpoint.window]`: raw stream ranges are a drainable pagination queue, not
   reliable evidence of the original observation window. The persisted payload
   and its full-version digest are not changed by this substitution.
   Factory publications use the same snapshot-write recipe. No row is rewritten
   merely to introduce a hash.
2. Remove only these paths (never recursively remove similarly named GitHub keys):

| Context                                                          | Removed fields                                                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Every snapshot root                                              | `fetched_at`, `repository_fetched_at`, `source_fetched_at`, `publication`                                         |
| Root `freshness` object                                          | `oldestAt`, `latestAt`; retain `total` and `missing`                                                              |
| Factory root/stream root                                         | `runId`, `revision`, `leaseUntil`, `startedAt`, `requests`, `rate`, `rateLimits`, `cursor`, `publication`, `next` |
| Factory stream `coverage` and factory `repos[].coverage[stream]` | `fetchedAt`, `sourceFetchedAt`, `pages`, `strategy`, `source`                                                     |
| Factory stream `observation` and factory `repos[].observation`   | `version`, `refreshedAt`, `publishedAt`, `metadataAt`, `source`, `repo`; retain the original `window`             |
| Factory `repos[]`; `inventory`                                   | `metadataAt`; `pages`, `after`, respectively                                                                      |
| Factory `contribution`; its `days[]`; `contributionObservation`  | `fetchedAt`, `observedAt`; `observedAt`; `version`, `fetchedAt`, respectively                                     |
3. Preserve all other fields, including GitHub `created_at`, `updated_at`,
   `published_at`, `pushedAt`, `source_head`, dependency `version`,
   titles/bodies/checks, coverage status/reason/counts, partial flags and semantic
   observation windows. Coverage `source` is excluded request-URL metadata whose
   query can vary with pagination/window selection; the original stream window
   is bound separately through the write-time `ranges` substitution.
   Window or coverage changes can invalidate a hash even with unchanged item lists.
4. Serialize canonical JSON: recursively sort object keys by ascending JavaScript
   UTF-16 code-unit order, retain array order, use `JSON.stringify` string/primitive
   encoding, no whitespace or Unicode normalization. Omit undefined object values;
   undefined array entries become null. Hash UTF-8 bytes using SHA-256; encode all
   32 bytes as 64 lowercase hex characters prefixed with `sha256:` (71 characters).

The hash is stored atomically alongside the payload in nullable TEXT
`snapshots.content_meta` or `factory_resources.content_meta`. This small JSON is
`{hash,version?,fullVersion?}`; `version` records the saved `runId` when present.
For direct writes and factory streams, `fullVersion` is the existing `sha256:` plus lowercase hex digest of UTF-8
`JSON.stringify(prSnapshot(finalSavedData))`, with no canonical key sorting or
timestamp removal. Saving it avoids rehashing raw snapshots on each read without
changing any full-version bytes. Account projections still hash their projected
JSON as before. All physical pages of a snapshot carry the same logical hashes.

New staged site snapshots use a publication-bound composite `fullVersion`.
Staging computes the exact digest above for the bounded logical snapshot,
including its reserved
`publication:{runId,publishedAt:"0000-01-01T00:00:00.000Z"}` metadata. This private
24-character placeholder reserves the final timestamp width even when a retained
collection time omits milliseconds; it is replaced before publication is visible.
At promotion, hash the UTF-8 bytes of compact
`JSON.stringify({snapshot:staged.fullVersion,publication:{runId,publishedAt}})`
with SHA-256, preserving the shown object insertion order, and encode as
`sha256:` plus 64 lowercase hex characters. The final `publishedAt` is the
publication timestamp, not the staging time. This is intentionally not the
digest of response data alone; consumers compare the complete opaque version.
The canonical `hash`/`contentVersion` remains unchanged. Historical snapshots,
direct-write hashes, factory stream versions and account projections are not
rewritten. Publication reads only small per-page hash metadata and hashes one
composite at a time; no staged payload is loaded into JavaScript. Both physical
pages must agree on valid staged hashes before the two fenced promotion writes
can be included in the atomic readiness transaction. Missing, malformed or
inconsistent staged metadata fails safely with `snapshot_metadata_invalid`.

A factory stream's stored version
must match the publication's advertised observation version. Stream hashes cover
actual saved items, not just coverage summaries. The index reads only their
metadata through covering indexes, never their payloads; the data endpoint uses
the same stored hash while decoding the payload needed for its response.

A newly published dependency coverage diagnostic can retain an older raw resource
whose coverage was complete. With `coverage.retained:true`, both the stream and
`/sources` compose the retained resource hash as `{inputs:{evidence:storedHash},
selection:{coverage:publishedCoverage}}`, using the same canonical encoding and
removing the coverage collection fields listed above. Status, safe reason/code,
observed count and `retained` remain semantic inputs. A missing/mismatched stored
hash yields null, not an invented proof. Other stream hashes are unchanged.
Repeated attempts with unchanged retained evidence/diagnostic keep this hash;
collection times do not affect it. Full `sourceVersion` remains the retained
evidence version; `source.publicationId` identifies the new frozen publication.
Always check current coverage even when the full evidence version is unchanged.

Account projections compose existing hashes cheaply rather than hash full lists
on each request. The composite uses the same canonical SHA-256 encoding over
`{inputs,selection}`. Input keys identify the saved dependencies, values are their
stored content hashes, and an absent required saved row is the literal `"missing"`.
For account lists and CI, an existing input without a stored hash is
`"unhashed:" + fullVersion`; reuse its saved full version or hash
`JSON.stringify(prSnapshot(savedData))` when that metadata is also absent.
This fallback describes the actual frozen legacy input, not successful coverage.
Account factory composition still returns null when an existing input lacks a
stored content hash. None of these readers writes metadata or backfills rows.

| Projection                                         | Composite inputs and selection                                                                                                                                                                                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account repos/issues/PRs and other projected lists | Catalog and aggregate snapshot hashes, plus hashes of the complete repository pages actually selected to replace aggregate rows; selected repository names, completeness, freshness `total`/`missing` and truncation. Repo catalogs also include local starred/statistics-enabled flags. |
| Account CI                                         | Catalog hash and selected repositories' latest saved `actions`, `releases`, `details` hashes, keyed by lowercase repository source identity; missing rows use `"missing"`; derived freshness `total`/`missing`. Refresh-clock-dependent verdicts, ages and histograms are not hashed.    |
| Account factory                                    | Saved publication and catalog hashes, selected catalog repository names, enabled published repository identities (`observed`), scope, derived freshness `total`/`missing` and combined saved/inventory `truncated`.                                                                      |
| Contributions                                      | Saved publication hash and resolved inclusive `since`/`until` dates.                                                                                                                                                                                                                     |
| Derived insights                                   | Null; use the unchanged full `sourceVersion`.                                                                                                                                                                                                                                            |

These composites conservatively invalidate on dependency changes, even if a
particular projected list or calendar is unchanged. For example, another part of
the publication can change the contributions hash. Scope/date selections matter;
compare the same resource and selection. `/sources` account hashes agree with the
corresponding default/all observation endpoints.

Migration `0014_source_content.sql` adds the two nullable columns and covering
indexes `snapshots_content(account_id,kind,content_meta)` and
`factory_resources_content(run_id,repo,stream,content_meta)`, without rebuilding
tables or backfilling legacy payloads. Pre-release rows return null until their
next normal save; account factory composition remains null while any existing
dependency lacks a hash. Do not refresh upstream or decode old payloads to repair
hashes on GET.
See [migration and performance evidence](12-source-performance.md#persisted-content-versions-v0170).

### Account endpoints

| GET path   | `data` shape                                                                                                                                                                                                                           |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/repos`   | `{ repos: Repo[], fetched_at, truncated, ...savedMetadata }`; owned saved catalog repositories by default, with `starred` and its deprecated alias `statistics_enabled`                                                                |
| `/issues`  | `{ issues: Issue[], fetched_at, truncated, repository_fetched_at?, freshness?, ...savedMetadata }`; saved open issues                                                                                                                  |
| `/prs`     | `{ pull_requests: PullRequest[], fetched_at, truncated, repository_fetched_at?, freshness?, ...savedMetadata }`; saved open PRs                                                                                                        |
| `/ci`      | `{ streams, repos, daily, totals, fetched_at, freshness, unsaved }`; deterministic saved Actions/releases/details summaries; `unsaved` lists repos without an available saved Actions input                                            |
| `/factory` | Published `FactorySnapshot`: `{ schema:1, account_id, owner, runId, revision, leaseUntil, startedAt, fetched_at, window, status, inventory, repos, cursor, requests, rate, contribution, contributionStatus, ...publicationMetadata }` |

Both `/repos` items and `/factory`'s `data.repos[]` include the additive summary
`retained:{any:boolean,streams:FactoryStreamName[]}`. It is derived from the same
immutable published `coverage[stream].retained` flags served by the stream rows,
never from a mutable latest run or repository execution state. Stream names follow
the documented factory stream order. For example, a repository retaining only old
dependency evidence appears as:

```json
{
	"name_with_owner": "nocoo/lizheng.dev",
	"retained": { "any": true, "streams": ["dependencies"] }
}
```

The corresponding `/factory` entry uses `name` instead of `name_with_owner` and
has the identical summary. A published repository with no retained streams has
`retained:{any:false,streams:[]}`. A catalog repository without factory data has
`retained:null` in `/repos` and no fabricated `/factory` repository entry. False
means no retained streams, not complete coverage: current limited/unavailable
streams still require inspecting coverage. True describes retention, not an ETA
or a new status for the whole run. No standalone machine per-repository factory
summary endpoint exists; the per-stream endpoints remain unchanged apart from
their corrected freshness.

Rows included through `include=removed` have `retained:null`: they cannot inherit
a same-name replacement's current publication. Published observations are matched
through the existing catalog identity rules before summaries are joined.

The `/repos` summary is a read-time enrichment, like `agent_state` and `meta`;
its catalog `sourceVersion`, `contentVersion` and freshness remain catalog-only.
Poll the summary or the published `/factory`/`/sources` state independently of
catalog version changes. No stored rows, publication windows or timestamps are
rewritten. Existing fields retain their shapes.

Retention enrichment first resolves the selected current catalog, then uses at
most one additional SQL query to project only matching repository IDs, names and
retained flags from the immutable publication. Dependency/manifests payloads are
not transferred to or normalized by the Worker for `/repos`. Empty selections
(including empty `starred`) and removed-only selections skip this query entirely.
The publication query handles both physical pages together and requires the root
page; an orphan second page cannot supply evidence. Identity/rename handling and
catalog source/content versions remain unchanged.

Each accepts only the documented selector `scope=all|starred`, default `all`;
invalid/repeated scope returns 400. `starred` means local Giraffe stars, not GitHub
stars. Both scopes exclude non-owned repositories and include eligible archives/forks.
`/repos` additionally accepts `include=removed`; other account resources do not.
`statistics_enabled` equals `starred` and is deprecated; it is not a selection policy.
No statistics override or HTTP pagination is applied. Open-item
lists are not closed-event history; use factory streams for that.

```bash
for resource in repos issues prs ci factory; do api "$API/$resource?scope=all"; done
```

Item fields (saved metadata can add fields; do not reject unknown observation data):
- `Repo`: `name_with_owner`, `name`, `owner_login`, `description`, `stargazer_count`,
  `fork_count`, `open_issue_count`, `primary_language`, `pushed_at`, `visibility`,
  `is_private`, `is_archived`, `is_fork`, `url`, `statistics_enabled`, `starred`,
  `star_source`, `star_updated_at`, `first_seen_at`, `last_seen_at`, `removed_at`,
  `archived_changed_at`. The four discovery timestamps are nullable.
- `Issue`: `name_with_owner`, `number`, `title`, `url`, `created_at`, `updated_at`,
  `author_login`, `labels: [{ name, color }]`, `comments_count`.
- `PullRequest`: `name_with_owner`, `number`, `title`, `url`, `created_at`,
  `updated_at`, `author_login`, `is_draft`, `review_decision`, `additions`,
  `deletions`, `base_ref`, `head_ref`, `state`, `mergeable`, `mergeStateStatus`, `checks`.
- CI `totals`: explicit workflow and repository counts documented below;
  `daily` entries: `{ x, success, failure, other }`, with date string `x`.
  Full nested summaries: [`ci-health.ts`](../apps/web/src/lib/ci-health.ts).
- Full factory repository metrics, observation versions/windows, coverage and
  publication fields: [`factory-types.ts`](../apps/web/src/lib/factory-types.ts).

#### PR merge and checks state

PR lifecycle `state` is `open|closed|merged|null` on account, repository and
factory PR reads. Newly collected GraphQL states are normalized to lowercase;
REST closed PRs with a saved merge timestamp are `merged`, not `closed`.
Legacy snapshots whose collector omitted lifecycle state return null until an
ordinary refresh records it. Missing/invalid state is never inferred to be open.
Read normalization does not rewrite rows or change saved immutable versions.
Lifecycle presentation is separate from version inputs: unchanged legacy PR rows
retain their 0.17.1 `version`, `sourceVersion`, `contentVersion` and `/sources`
ETag, including rows without `content_meta`. A response-only `state:null` or
normalized lifecycle value does not enter the legacy digest. Treat versions as
opaque evidence identifiers, not hashes to recompute from presentation fields.

Every PR on `/prs`, `/repos/:owner/:name/prs` and
`/factory/repos/:owner/:name/prs` includes the same additive fields:

```json
{ "mergeable": true, "mergeStateStatus": "CLEAN", "checks": { "state": "SUCCESS" } }
```

`mergeable` is `true` for GitHub `MERGEABLE`, `false` for `CONFLICTING`, and
`null` for `UNKNOWN`, unavailable or not-yet-collected evidence.
`mergeStateStatus` is the saved GitHub enum string (`CLEAN`, `DIRTY`, `BEHIND`,
`BLOCKED`, `UNSTABLE`, `DRAFT`, `HAS_HOOKS`, `UNKNOWN`, or future GitHub values),
or null. `checks.state` is `SUCCESS|FAILURE|PENDING|ERROR|EXPECTED|null`, taken
directly from the latest head commit's `statusCheckRollup`, not inferred from
review decisions, Actions history or mergeability. No rollup is null, not success.
These are observations at collection time, not a guarantee that a PR can merge now.

Account and repository searches collect these fields in their existing GraphQL
request. Factory REST PR pages add one GraphQL node batch (at most 100 IDs per
page), under the existing request/rate budgets. Core and GraphQL reserves remain
separate across pages, metadata transitions and evidence rollback; the public
`rate` field still describes the latest observation rather than a combined quota.
Inaccessible nodes retain null
details; retryable failures retain the prior good publication. Old saved items
read with explicit null fields without database rewrites or upstream requests.
The additions can change content-derived snapshot hashes but do not change
immutable factory publication/observation IDs.

`/factory` exposes `data.rate` as null or
`{remaining,resetAt,resource,observedAt}` for GitHub's last saved rate observation.
It compares the publication's dated evidence with retained run checkpoints,
including newer catalog/active runs. `observedAt` records when the upstream rate
was observed, not the later publication or control-update time. Undated, invalid,
future-observed or expired-reset evidence is not advertised as current; the latest
dated observation is validated before returning it, rather than falling back to an
older unexpired bucket when the newest has expired. Missing usable evidence returns
null, without contacting GitHub.

Rate is account-wide request metadata, independent of the selected repository
scope and immutable factory `sourceVersion`; it can change without a new factory
publication. It is not a Giraffe machine-request quota. Saved historical rows stay
unchanged; subsequent ordinary collection records dated rate evidence.

### Saved CI verdicts and units

CI uses only saved Actions, releases and details. The evaluation clock is the newest
valid saved input time, not the request's wall clock. A report can therefore be stale
even when a verdict is healthy; inspect its freshness separately.

Non-default (`scope:"branch"`) streams are included only if a saved run was created
within the last 30 days, inclusive of the exact cutoff relative to that saved
evaluation clock. Older branch-only streams are omitted, not deleted from saved
history. Default-branch and grouped bot streams remain unchanged, including idle
default workflows. This applies to both all and starred scope; no `branches` query
parameter is supported.

`streams[].verdict` (workflow-level) is exactly `broken | flaky | healthy | idle`.
`repos[].verdict` is exactly `broken | flaky | healthy | idle | unknown`: take the
first available default-workflow verdict in that order; `unknown` means no
default-workflow evidence exists. It is not a successful zero. `unknown` replaces
the former repository sentinel `none` (breaking change in 0.15.14).
`repos[].release.pipeline` independently remains `broken | flaky | healthy | idle |
none`; its `none` means no default-branch release workflow, not repository health.
- Project verdicts use only runs on the **known default branch**
  from saved repository details. Missing/empty default branch, null run branch,
  feature/PR branches and tag refs are not assumed to be default-branch evidence.
  No branch-existence or open-PR lookup is performed. Branch and bot streams remain
  observational and never make project workflow/repository verdicts broken or flaky.
  All `pull_request*` events are observational even when `head_branch` matches the
  default branch name: a fork PR can also have a source branch named `main`.
- Classify the latest 10 decisive completed runs in the 30-day history. A latest
  successful result cannot be `broken`: prior failures make it `flaky` (and recurring
  when more than one failed); without failures it is `healthy`. A currently failing
  stream is `broken` after two consecutive failures or at least 50% failures in a
  sample of at least four decisive runs. Otherwise it is `flaky`.
- With no runs in the last **14 days**, a workflow is `idle`, not broken, including
  manually dispatched workflows. No decisive result also yields idle. In-progress
  runs do not supply a completed verdict.
- `totals.brokenWorkflows`, `flakyWorkflows`, `healthyWorkflows`, `idleWorkflows` and
  `recurringWorkflows` count default-branch workflow streams. `totalWorkflows` is
  their total, not all branch/bot streams.
- `totals.brokenRepos`, `flakyRepos`, `healthyRepos`, `idleRepos`, `unknownRepos` and
  `totalRepos` count repository summaries. Missing Actions inputs remain explicit
  in `unsaved`; absence is not a healthy verdict.
- `nonDefaultBranchStreams` counts observational non-default streams;
  `nonDefaultBranchFailures` counts their failed runs in the last 30 days, not
  workflows or repositories, including PR-event contexts with matching branch names.
  `botStreams` counts bot streams; `truncatedRepos`
  counts repository summaries whose saved inputs are truncated.
- `daily` remains an all-branch, non-bot completed-run histogram, not a health
  verdict; its success/failure/other values are run counts.

Per-repository summaries likewise expose `brokenWorkflows`, `flakyWorkflows`,
`healthyWorkflows`, `idleWorkflows`, `totalWorkflows`, `nonDefaultBranchStreams`,
`nonDefaultBranchFailures` and `botStreams`. The ambiguous legacy totals and
per-repository count names are removed; consumers must use the explicit-unit names.

### GET /contributions

`GET /api/v1/accounts/A/contributions` requires `observations:read` and reads the
saved account-wide calendar, independent of repository stars/statistics. It never
collects GitHub data or updates token activity. Optional `since` and `until` are
inclusive, real `YYYY-MM-DD` dates; omitted bounds use the saved earliest/latest
dates. Both bounds must lie inside the saved calendar and cover at most 90 days.
Reversed ranges, invalid dates, repeated parameters and unknown keys (including
`scope`) return 400 `validation_failed`. The endpoint does not extend missing
history with zeroes. No saved publication/calendar returns 409 `snapshot_missing`;
401/403 account/scope checks and unknown-path 404 follow the other machine reads.

The standard observation envelope contains this `data` shape:

```text
{
  since, until, total: number|null, observedAt, fetched_at,
  timezone: "github", typeWindowTimezone: "UTC", partial: boolean,
  window: {since,until}, collectionStatus: "complete"|"pending"|"unavailable",
  days: [{date,count:number|null,partial,fetchedAt,observedAt,unavailable,
    types:{commits,issues,pullRequests,pullRequestReviews,restricted,repositories},
    breakdown:"complete"|"unavailable"|"mismatch"}],
  freshness, coverage, unavailable
}
```

Each type count is a nonnegative integer or null, never a fabricated zero.
`count` retains GitHub's authoritative calendar count; selected `total` sums
these counts, not type aggregates. A missing/invalid saved day returns null count,
`unavailable:true`, and null selected total. Calendar `coverage` reports selected
`total` and `observed` days, status `complete|unavailable`, and independent
`typesStatus:complete|partial|pending|unavailable`. Freshness uses original
calendar observation times per selected day, with missing days counted explicitly.
Known calendar counts remain usable when type details are unavailable.
Day `fetchedAt` records the calendar count's original collection; `observedAt`
preserves its type observation when present. Top-level `fetched_at`/`observedAt`
are the latest applicable times among the selected days, not a later quick merge.

`sourceVersion` identifies the original calendar observation run, not necessarily
the newest global publication. `source.publicationId` identifies that publication;
`data.window` is the calendar's published display window: a successful quick merge
can include retained older dates, while an untouched calendar keeps its original
window. A newer failed
collection keeps the prior calendar, version, window and timestamps, while
`collectionStatus` reports the latest attempt's unavailable status. GET never
advances freshness. Legacy calendars gain null type fields in this endpoint,
without rewriting stored rows. `/factory` retains its original contribution
shape and adds only optional fields on newly collected calendars.

Strong content-derived ETags and authenticated `If-None-Match` 304 responses work
as on `/sources`. Authentication and query validation still run; 304 has no body
and retains `Cache-Control: private, no-store`, `Vary: Authorization` and
`Referrer-Policy: no-referrer`. Keep validators per date-range query.

#### Contribution dates, types and partial days

Calendar `date` keys are GitHub's native `contributionCalendar` dates, unchanged.
They are **not converted to Asia/Shanghai** and must not be assumed to match a
consumer's Shanghai buckets. GitHub documents that commits use the timestamp's
time zone (profile attribution uses author date), while issues/PRs use the browser
or API creation time zone. GraphQL defines `ContributionCalendarDay.date` as the
day represented by the square; it does not promise a uniform Shanghai/UTC re-bucket
of every underlying event. Hence the explicit `timezone:"github"` label.

Typed aggregates query `contributionsCollection` for each date's explicit UTC
interval `00:00:00.000Z` through `23:59:59.999Z` (GitHub's `to` is inclusive),
clipping the last day at the frozen run `window.until`. They include commit,
issue, PR, PR-review, restricted/private and repository-creation counts; first
and popular contributions are not excluded. Different attribution boundaries,
permission visibility and GitHub counting rules can prevent their sum from
matching the calendar count. `breakdown:"mismatch"` exposes that discrepancy;
there is no inferred residual/private type and totals are never adjusted to fit.

`partial` marks the final incomplete day of the frozen observation window, not
the current GET date. Top-level `observedAt` is the calendar request observation
time; each day's `observedAt` is its type-batch observation time, or the calendar
time for legacy/missing type details. The day flag remains partial even tomorrow
until a newer successful run observes it again. For digest-style daily reporting,
treat a calendar day `D` as complete when the pinned activity publication has
`contributions.days[D].partial=false`; prefer that activity day over live
`GET /contributions` for the same `D`, which can still expose `partial:true` on
an otherwise finished day. Normal daily scheduled refreshes
now collect contributions as well as weekly/full runs; manual selected runs do
not silently broaden to account-wide collection. New quick runs use 30 UTC dates
(one calendar request plus two 15-day batches); deep runs use 90 dates (one plus
six batches). Persisted old run windows do not change on resume. Collection uses
with the existing request/rate reserve, fencing, publication and retention rules.

Sources: [GitHub contribution time attribution](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference#how-contribution-event-times-are-calculated),
[GraphQL calendar dates](https://docs.github.com/en/graphql/reference/users#contributioncalendarday),
[GraphQL collection bounds](https://docs.github.com/en/graphql/reference/users#user).

```bash
api "$API/contributions"
api -G "$API/contributions" --data-urlencode 'since=2026-10-01' --data-urlencode 'until=2026-10-21'
```

### GET /activity

All activity responses, including 400/404/409 and 304, carry
`Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.
Machine responses vary on `Authorization`; browser responses vary on
`Cookie, Cf-Access-Jwt-Assertion`. Error responses do not receive an ETag.

`GET /api/v1/accounts/:account/activity?run=latest&repository=owner/name`
requires `observations:read`. `run` defaults to `latest`; an explicit saved run ID
selects that immutable publication. A short ID prefix resolves like refresh-run
pinning: when exactly one retained run ID starts with the token, that run is
selected; zero matches return 404 `not_found` and multiple matches return 400
`validation_failed` (`Ambiguous run reference`). `repository` is optional. Unknown
query keys are rejected. The Access-protected browser reads the active account
through `GET /api/activity` with the same selectors. Neither endpoint collects
GitHub or updates token activity. Both support private, authenticated ETag/304
polling. Duplicate filters also return 400 `validation_failed`. Unknown run IDs
return 404 `not_found`; a known run without a successful publication (including a running,
failed or historical pre-migration run) returns 409 `activity_unpublished`.
`latest` returns the latest usable publication despite newer failed runs; without
one it returns 409. A repository in the frozen publication remains readable even
if later removed from the catalog. A current catalog repo outside that frozen
membership returns empty `repos`, zero member totals and null contributions;
a repo in neither set returns 404. Repository filtering never invents a per-repo
contribution calendar. A member omitted by storage capacity is not an unselected
repository: its filtered response retains truncation and unknown totals.

The response is an `ActivitySnapshot`, not the generic observation envelope:

```text
{ account_id, runId, previousRunId, fetchedAt, membership?,
  window: { since, until, gap, first },
  repos: [{ repo, ci_runs, prs: { opened, merged, closed },
    issues: { opened, closed }, releases, commits: { default, other, items },
    deploy: { last_success_at, runs }, snapshot, coverage }],
  totals, totals_partial, totals_coverage: { missing: [{ repo, metrics, reason }] },
  contributions, coverage, truncated }
```

The interval is `(since, until]`, ending at the run's frozen collection cutoff,
not its completion time. The last published account-wide quick refresh whose
terminal status is `completed` or `partial` supplies `since`. A completed run
without an activity publication (including pre-activity history) does not advance
the window. Eligible runs are quick refreshes triggered by daily scheduling or a
manual `scope:all` request, not weekly/deep, catalog or selected-repository work.
Daily membership remains starred-owned even when it contains zero or one repo.
The first run uses a bounded 24-hour lookback and sets `first:true,gap:true`.
Failed/cancelled or unpublished terminal eligible runs, or a missing Beijing
calendar day, set `gap:true`; the window still starts at the last eligible
publication. A published partial run advances the window without itself creating
a gap. Collection-time jitter alone does not create a gap. Adjacent publications
share the exact boundary timestamp. `latest`, `/sources` discovery and retention
use the same completed-or-partial publication eligibility; failed/cancelled runs
remain excluded. A finished partial publication is readable, not a 409.

Lists distinguish known empty (`[]`) from unavailable (`null`). Coverage entries
are `{status:complete|partial|unavailable,truncated,reason}`. A bounded pagination
or storage cut marks the affected list and the whole response truncated; nullable
totals must not be interpreted as zero. Old good observations are not relabeled
as newly collected evidence. The source index registers `account:activity` with
its publication version and saved `fetchedAt`. Its content version hashes canonical
`{input:<stored-publication-content-version>,derivation:"metric-totals-v1"}` with
SHA-256, binding the frozen publication to this read-time totals contract.
Activity ETags hash the full derived response bytes, so old pre-derivation ETags
cannot incorrectly produce 304. Repeated reads of the same publication and query
are deterministic; no stored publication, page, timestamp or run ID is rewritten.

Account totals are derived at read time from frozen per-repository evidence,
including publications created before 0.21.0. Each metric sums only repositories
with complete evidence for that metric. `red_default_branch` concatenates only
fully classified repository lists. A metric with no available repository is null,
not zero; a known empty membership (including an unselected repository filter)
still has zero counts and an empty red list. `coverage.run:partial` alone does not
exclude otherwise complete metric streams; unavailable security/alerts do not
erase CI, PR, issue or release evidence.

`totals_partial` is true when at least one repository/metric is excluded.
`totals_coverage.missing` groups metric names by repository and reason:
`partial` or `unavailable` describes the relevant source coverage,
`missing_evidence` means a missing list/coverage or unclassifiable red workflow,
and `omitted` identifies frozen members lost to storage capacity. An old truncated
publication without membership uses `repo:null` for unattributable omissions.
This flag describes totals only, not overall run completeness or contributions.
Retained available subtotals remain useful when membership was truncated, while
the omitted repositories and metrics stay explicit. Neither catalog changes nor
unrelated newer snapshots enter this calculation.
Activity freezes only streams carrying this run's ID. Repository evidence is
current when its observation version matches the run or its repository commit
step succeeded in this run, with the repository ID matching the frozen run ID
when available. A retained dependency evidence version therefore does not discard
successfully collected activity streams; absent successful commit evidence,
stale observations remain unavailable.
The metadata step saves the current run's default branch separately from retained
repository observations. Activity supplement collection and freezing use only
that successful same-repository metadata with matching identity when recorded.
Without verifiable branch evidence, workflow `is_default_branch` and default
commit branch labels are null, `coverage.default_branch` is unavailable and red
that repository's default-branch total remains null. A retained branch is never used as a fallback.
This also applies to in-flight runs whose metadata completed before branch
evidence was recorded: supplemental branch histories are not classified as
other branches. `coverage.other_commits` stays unavailable and `commits.other`
stays null; saved unverified classifications are discarded. Tag and deployment
collection remain independent and continue normally.
Repositories with failed, unavailable or limited steps have `coverage.run.status`
`partial`, except that `limited` with `error:dependency_parse_unsupported` alone
does not mark run coverage partial or truncated. Dependency diagnostics retain
their own limited coverage independently. Other limited steps still mark run
coverage truncated; failed/unavailable steps alone do not. Per-source missing
evidence remains unavailable/null; partial or unavailable repository metrics are
excluded from account subtotals, never counted as fabricated zeroes.
`membership` freezes repository names independently of stored pages, so capacity
cuts cannot make a selected member look unselected. An unclassifiable failed
workflow leaves that repository's red default-branch contribution null and `default_branch` coverage
partial rather than claiming no red workflows.
Publication first profiles frozen repository payload lengths and loads at most
4,000,000 UTF-8 bytes in frozen membership order, independently of the 16-page
output limit. Input-budget omissions retain membership, partial/truncated
coverage and explicit missing-total entries, never complete zero results.

Every CI run exposes `id`, `workflow_id`, `workflow_name`, `event`, `head_branch`,
`head_sha`, `is_default_branch`, `status`, `conclusion`, `run_attempt`, `created_at`,
`updated_at`, `run_started_at`, `duration_s`, `html_url`, `actor` and workflow `path`.
PR events include `merged_at`, `merged_by`, `base_ref`, `bot` and `dependency`;
issue events include `closed_by`, `state_reason` and labels. Lifecycle lists are
independent timestamp slices, not disjoint partitions: a PR opened and merged in
the same window appears in both, and a merge with `closed_at` also appears closed.
Commits include SHA,
author, first message line, time, branch and default-branch identity. The current
snapshot includes open PR lifecycle/merge/check/review/draft fields, open issues
classified as dependency/security/other and independent nullable Dependabot and
code-scanning counts. Deploy runs are a classified subset of CI; the last known
successful deployment may precede the activity window or finish after its frozen
cutoff during collection; it describes current observed state, not a window event.
Deployment classification matches standalone name/path terms `deploy`,
`deployment`, `release`, `publish` or `pages`, case-insensitively; it has no
repository-specific exceptions. The classifier is centralized for future policy
changes, not exposed as a new settings API. Dependency PRs match Dependabot or
Renovate author identities or dependency labels; bot identity also recognizes the
GitHub Bot actor type and `[bot]` suffix. Security issue labels take precedence
over dependency labels, with the remaining issues in `other`. Release totals
count releases, not additional tag events; matching release tag names are deduped.
Annotated tags use the tagger timestamp. Lightweight tags have no creation time
and therefore leave tag coverage partial, never use commit time as tag time.

Account totals include merged PRs split into dependency/other, opened/closed
issues, releases, CI runs and red default-branch workflow runs. Contributions
describe explicit `Asia/Shanghai` intervals, the previous full Beijing day and
today's partial interval, with independently nullable composition. This is a
separate bounded query, not a timezone relabeling of `/contributions`' GitHub-native
calendar. For Beijing date `D`, the query uses `D T00:00:00Z` through
`D T23:59:59Z`: GitHub truncates the query to UTC dates and its calendar cells
already use the account's timezone. Each day's `count` is GitHub's reported
`contributionCalendar.totalContributions`, accepted only when exactly one valid
native cell has date `D` and the same count. Optional
`nativeCalendar:{timezone:"github",total,days:[{date,count}]}` preserves returned
native date labels unchanged. Neither field promises a re-bucketing of GitHub's
native squares into Beijing days. Missing totals/types stay null. Multiple cells,
an incorrect date or inconsistent calendar total produce a null day count and
partial coverage, never a sum of cells. A type-composition mismatch keeps the
validated single-cell count but marks coverage partial. The current day remains
`partial:true`; day `since`/`until` describe Beijing boundaries, not query variables.
See `apps/web/src/lib/activity-types.ts` for the complete field contract.

The v0.24 default-branch observation contract is specified in
[landed activity](13-landed-activity.md). `commits.default` counts only new ledger
identities attributed to this reporting window, without a committer-date filter.
Each default commit carries `observation: {runId, window, at, bootstrap}`:
`observation.at` is first local observation, not GitHub push time, while the
commit's `at` remains committer date. First reconciliation includes old reachable
history and marks it `bootstrap:true`. Ledger admission requires successful
current-run metadata and an exact stable repository-ID match; a rolling commit
stream is never a substitute.

`commits.deferred` contains `{runId, window, items}` groups whose first observation
belongs to an earlier run/window but whose evidence is delivered now. These do
not contribute to this response's `commits.default`; consumers can group their
items by original window when aggregating delayed evidence. Only serialized
identities are marked published, atomically with the immutable publication.
Pending or packed-out evidence remains durable; the 500-item per-repository
selection and existing publication byte limits report partial coverage, never a
complete zero. Repeated GETs remain read-only. Old publications without these
fields retain their original date-based semantics and are not rewritten.

Migration `0026_activity_commit_ledger.sql` adds the permanent ledger/checkpoints,
without backfill. Downgrading to v0.23.1 leaves them unused and harmless;
re-upgrading resumes them. Commits pushed and force-pushed away between snapshots
are invisible. Rename/re-add preserves the stable repository-ID ledger, whereas
a replacement ID starts a new ledger; cancelled catch-up keeps its original window.

The supplementary collector normally adds one refs/tags GraphQL request per repo,
plus a successful-workflow REST request only when the complete saved action
stream cannot provide deployment success. Continuations are bounded at 20 requests
per repo and explicitly truncated. Account contribution intervals use one bounded
GraphQL request. The normal two-request fixture adds 85 leased pages for 42 repos
or 121 for 60; at the historical 48 min / 778 pages cadence this is about 5.2 or
7.5 minutes. A 60-repo nominal total extrapolates to about 76 minutes, not a tested
production SLA. Rate limits, unusually many branches/tags or deployment pages can
increase this cost. Existing PR/issue/action/release streams are reused.

The `/today` page shows the frozen interval, data timestamp, gap and truncation,
activity sections and contribution composition. Repository links lead to the
existing detail page, which embeds the repository's current-run activity.

### GET /catalog/changes

`GET /api/v1/accounts/A/catalog/changes?since=<ISO datetime>` requires
`observations:read`. It reads persisted discovery history only; it never queries
GitHub, updates token activity or changes stars. `since` is required, must include
a timezone, and is normalized to UTC. Unknown/duplicate query keys and a cursor
after the last complete publication return 400. Responses use authenticated
ETag/304 and `Cache-Control: private, no-store`.

The body contains `account_id`, normalized `since`, `until` (the last complete
catalog publication), `history_since`, nullable `warning_code`, and `added`, `removed`, `archived`, `unarchived`,
`visibility_changed`, `fork_changed`, `renamed` and `unconfirmed` arrays. Each event includes
`event_id`, `repo`, `at`, nullable `github_id`, and
`source: {kind: "factory" | "legacy", runId: string | null}`, with the relevant
before/after values. Renames also include `previous_repo`; unconfirmed observations
include a safe `reason`, never raw upstream diagnostics. Arrays sort ascending
by `(at, repo, event_id)`. Selection is inclusive (`at >= since`); retain event IDs
to deduplicate when polling from the previous `until`.

No completed discovery publication returns 409 `catalog_unpublished`. After the
first publication, `since < history_since` returns 410 `catalog_history_expired`
immediately, not only after retention eviction; it does not clamp the cursor or
return a partial 200. `since == history_since` is accepted. For migrated accounts,
0019 seeds this floor at migration application time (history initialization), not
the saved catalog's fetch time or the first later publication; that publication
preserves the floor. Resync from `/repos` after a 410, then poll from the published
history boundary. The saved 2026-10-21 catalog baseline already excludes `rsshub`
and `wiki`; their pre-history departures can never be reconstructed as `removed`
events. Initialization does not invent additions, removals or archive events.

Event retention is bounded to 90 days and 10,000 combined change/unconfirmed events per account. Eviction removes
whole timestamp cohorts and advances the history floor beyond the evicted time;
a request before that floor returns 410 `catalog_history_expired`, never a
silently incomplete success. Resynchronize the current catalog after expiry.

`GET /repos` adds nullable `first_seen_at`, `last_seen_at`, `removed_at` and
`archived_changed_at` to each row. Other existing row fields retain their meaning.
Removed repositories are excluded by default; `include=removed` includes retained
departed rows. This option applies only to `/repos`, alongside `scope=all|starred`.
Scope still selects owned repositories, and removal clears stars, so removed rows
do not reappear in starred scope. Removed row payloads have a separate 90-day,
1,000-row-per-account bound; they are not an unlimited archive.

Discovery runs at every successful complete catalog publication, including the
catalog preparation before quick refresh. Partial/error/truncated lists cannot
advance history or replace prior membership. Absence or a name-based 404 does not
prove deletion. Confirm against the previously saved stable GitHub ID with a
GraphQL node lookup. A matching ID at another name is a rename; a new ID at the
old name neither confirms deletion nor blocks the old identity's resolution.

A candidate last seen private is never auto-removed (`private_unverifiable`). A
public candidate is eligible only when this same complete listing still contains
at least one private owned repository with the same stable ID previously observed
as private (`scope_unverifiable` otherwise). Tokens without private access therefore
never auto-remove repositories. Only a recognized, unambiguous identity-not-found
response can then confirm removal. A missing/malformed response, 401/403, rate or
secondary limit, 5xx, network failure, or access/permission/SAML/SSO wording in a
404 retains all state and the original `last_seen_at`. The publication records a
warning and an `unconfirmed` event so consumers can distinguish uncertainty from
deletion. Other safe reasons are `mass_removal_guard`, `identity_unavailable`,
`budget_exhausted`, `permission_denied`, `github_unauthorized`,
`github_rate_limited`, `github_error` and `lookup_unverifiable`.

Count every missing, not-yet-removed identity as a candidate, including quarantined
identities displaced by earlier same-name replacements, even if another safety
guard would also block it. If their total exceeds `max(3, owned_before * 0.1)`
(no rounding), suppress all removals and confirmation calls, preserve current and
quarantined mutable state, set `catalog_mass_removal_guard`, and report every
candidate in `unconfirmed[]` with reason `mass_removal_guard`. This batch reason
takes precedence over individual private/scope reasons. Conservatively,
`owned_before` counts only previously current-name, non-removed owned identities,
including forks and archived repositories; non-owned, departed and quarantined
identities cannot inflate the denominator. Exactly the threshold is not blocked
by this guard; all other identity/privacy checks still apply.

Confirmed deletion atomically clears star records (including owner-unstar
tombstones), statistics residue and mutable factory participation. It does not
delete immutable observation/publication history or generic agent resources.
Reappearance emits `added` without restoring an old star. Stable GitHub repository
IDs identify renames: mutable names move with their star provenance, while frozen
historical names stay unchanged. Giraffe never auto-stars newly discovered repos;
the external bot owns automatic starring policy and applies it only when authorized.
Every accepted star write is last-write-wins across browser and agent writers;
`source` is informational provenance, never an owner lock or priority rule.

A name reused by a different GitHub repository ID is a distinct identity.
Current-name ownership follows the identity in the complete listing, even if the
old identity remains unconfirmed. Its catalog row retains `removed_at:null`;
mutable stars/statistics/factory state are preserved by old identity in isolated
storage, not inherited by the replacement. Recovery restores that preserved state
only to the same identity, never across IDs or after confirmed deletion. Repeated
catalogs cannot be blocked merely by this same-name replacement.

Retained factory evidence from the departed ID cannot become the replacement's current
observation or complete source. In `include=removed` responses, the departed row
stays unstarred with null star provenance even if the new owner of that name is
starred; only the current identity can enter starred scope. Same-ID reappearance
can retain original observation provenance, but never restores deleted stars.

Existing saved catalog rows seed their first/last-seen timestamps from the saved
fetch time without creating change events. This is observation provenance, not
the repository's creation time. No historical additions/deletions are invented.

### Repository endpoints

`GET /repos/:owner/:name` reads `details`; `GET /repos/:owner/:name/:resource`
accepts exactly these resources, without query/body and always with scope `all`:

| Resource       | `data` fields beyond saved `fetched_at`, `truncated`, metadata                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `details`      | `description`, `homepage`, `default_branch`, `license`, `is_archived`, `open_issue_count`, `stargazer_count`, `fork_count`, `pushed_at`, `url`         |
| `issues`       | `issues: Issue[]`, shape above                                                                                                                         |
| `prs`          | `pull_requests: PullRequest[]`, shape above                                                                                                            |
| `actions`      | `runs: [{ id, name, html_url, status, conclusion, event, head_branch, created_at, updated_at }]`                                                       |
| `releases`     | `releases: [{ id, tag_name, name, html_url, draft, prerelease, published_at }]`                                                                        |
| `traffic`      | `forbidden`, `views: { count, uniques, points }`, `clones: { count, uniques, points }`; points retain GitHub timestamp/count/uniques                   |
| `security`     | `features`, `unavailable`, nullable `dependabot_open` / `code_scanning_open`, alert-summary `items`; optional safe `reason`, `reason_code`, `retained` |
| `languages`    | `languages: { [languageName]: byteCount }`                                                                                                             |
| `contributors` | `contributors: [{ login, avatar_url, html_url, contributions }]`                                                                                       |

```bash
api "$API/repos/$OWNER/$NAME"
for resource in details issues prs actions releases traffic security languages contributors; do
  api "$API/repos/$OWNER/$NAME/$resource"
done
```

Unknown resource names are 404; absent saved pages are 409 `snapshot_missing`.

Security snapshots record independent `features.dependabot` and
`features.code_scanning`, each `{status,reason_code,reason}`. Status is `available`
for a complete feature, `unavailable` for expected feature/access absence, or
`partial` for incomplete collection. Available features have null reason fields;
unavailable features have fixed safe reasons and null counts, never zero.
Top-level `unavailable` is true only when **both** features are unavailable;
top-level reasons summarize that case only. One inaccessible feature cannot hide
the other's current items/counts. Example: six Dependabot alerts plus a generic
code-scanning 404 yields `dependabot_open:6`, `code_scanning_open:null`,
`features.dependabot.status:"available"`, code-scanning `reason_code:"not_found"`
and `unavailable:false`. Incomplete collection remains `truncated:true` and does
not publish a successful zero.
Final storage truncation also downgrades `available` features to `partial` before
serializing either physical page. Repository browser and machine reads apply the
same correction to older stored truncated pages, without rewriting their rows or
cached source/content versions. Unavailable siblings, safe reasons and observed
counts are preserved; the count is not evidence of complete retained items.

When a feature becomes unavailable, prior good evidence can appear separately in
`retained.<feature>:{open,fetched_at,items}` with its original timestamp. It is not
current evidence and never fills the current null count. A mixed available /
expected-unavailable snapshot is saved and its refresh step counts as
`unavailable`, not failed; a wholly unavailable snapshot is likewise saved, not
409 missing. Existing saved snapshots without `features` retain their historical
shape and hashes: per-feature availability is unknown until refreshed, and old
zeroes or contradictory top-level flags are not per-feature coverage proof.

Account alert/Insights projections apply the same completeness rules on GET.
An incomplete repository security page cannot replace a prior complete account
baseline and relabel its counts with a newer time. The baseline keeps its original
evidence time; a repository-detail response can legitimately be newer and mixed.
When complete repository pages replace account evidence, feature metadata comes
from the selected pages, not the superseded account snapshot. Legacy pages retain
unknown feature availability. A catalog member not covered by the older baseline
is missing coverage, never an available zero. Combining current and retained
security must fit the bounded physical pages; capacity truncation fails the step
and preserves the exact prior snapshot instead of saving contradictory totals.

Security snapshots and factory stream coverage share `reason_code` values:
`alerts_disabled` (explicit Dependabot disabled/not-enabled response),
`code_scanning_disabled` (explicit code-scanning disabled/not-enabled response),
`permission_denied` (documented
integration/PAT permission or insufficient-scope response), `not_found` (generic
404), and `unknown` (other access restriction). `reason` is fixed safe human text,
never raw upstream diagnostics. A plain 404 cannot distinguish a missing, hidden
or disabled resource and must not be called `alerts_disabled`. Pagination access
loss, malformed responses and byte/page limits remain incomplete/limited failures.

### Factory stream endpoints

`GET /factory/repos/:owner/:name/:stream` accepts exactly `commits`, `issues`,
`prs`, `actions`, `releases`, `alerts`, `dependencies`, without query/body:

```bash
for stream in commits issues prs actions releases alerts dependencies; do
  api "$API/factory/repos/$OWNER/$NAME/$stream"
done
```

Envelope `data` is `{ runId, items: FactoryEvent[], next: string|null, ranges:
[{ since, until }], coverage, fetched_at, freshness, observation?, manifests?, truncated,
unavailable }`.
`coverage` is `{ status, pages, fetchedAt, source, reason, reason_code?, retained?, observed, strategy?,
sourceFetchedAt? }`; status is `pending|partial|complete|unavailable|limited`,
strategy `full|incremental|reused`. An empty list proves zero only with complete
coverage. `next` is saved collection metadata, not a machine pagination URL.

New quick runs publish a 30-date window and deep runs a 90-date window; always
read `observation.window`, including the original window on retained evidence,
rather than inferring coverage from run depth or from the current date.

Issues and PRs can report `strategy:"incremental"` after merging changed rows with
a valid complete baseline and reconciling current state counts. `complete` means
the reconciled stream is complete, not that a delta alone covers all history.
`sourceFetchedAt` identifies the baseline; event `updatedAt?` is the REST update
timestamp. Retained/limited baselines and reconciliation mismatches require a full
fetch. PR GraphQL state is refreshed separately from the REST timestamp cursor.
Actions window metrics, detail snapshots and deployment history reuse one complete
run-owned source where available; incomplete full history remains explicit and
can require the existing bounded filtered-window collection.

The alerts stream is the current **open Dependabot set**, not alerts created or
updated inside the factory time window. It uses REST `state=open`; security
snapshots explicitly request GraphQL `states:[OPEN]`. Old open alerts remain
included regardless of creation/update time. The security snapshot additionally
collects code-scanning alerts, which are not part of the factory alerts stream.
The two steps observe GitHub separately: compare their saved `fetched_at` /
`coverage.fetchedAt`, not just run ID. A run does not provide an atomic upstream
snapshot; alerts can change between steps. Historical data is not rewritten.

`data.observation.window` is the immutable repository observation's time window.
`data.ranges` contains exactly that one `{since,until}` window; when a legacy
publication has no repository observation, it uses the saved publication window.
The response does not expose the collector's pending-range queue, which is often
empty after completion. In mixed publications, never substitute the newer global
`/factory` window for a repository's retained observation window.

Events have `id`, `title`, `url`, `at`, `createdAt`, `closedAt`, `mergedAt`, `author`,
`state`, and optional `body`, `severity`, `conclusion`, `draft`, `review`, `version`,
`path`, `job`. `observation` has `{ version, window, refreshedAt, source:"run"|"legacy",
repo?, metadataAt? }`. Envelope `source.kind` is `factory`, `source.publicationId`
identifies the publication, while `sourceVersion` identifies the immutable
repository observation; mixed publications can contain older repository versions.

#### Dependency metadata and summaries

For `dependencies`, unknown `at`, `createdAt` and `author` are `null`, not empty
strings. Observation time is not a package creation time. Own package identities
are not dependency items: `manifests:[{name,version,path,url}]` retains them
separately, with paths such as `package.json` or `packages/app/package.json`.
Published factory repository entries expose the same optional `manifests` array
alongside their normalized `dependencies` list.

Account `/factory` aggregate `repos[].dependencies` contains summaries shaped as
`{name, version, path, url}`, with no `id`. Summaries are unique per repository by
exact `(path, name, version, url)` equality, preserving first-seen order. Different
versions/refs, paths, names or URLs remain separate; summaries do not identify
individual workflow jobs. The browser aggregate and its dependency graph use the
same summary normalization. This is a non-breaking removal of identical duplicates
at read time, with no extra D1 reads, writer/schema changes or stored-row updates.
Job-level unique IDs (`#job=`) and legacy evidence IDs (`#ref=`) belong only to the
per-repository dependencies stream, not aggregate summaries.

Read-time normalization extracts saved root/workspace `package.json#name` evidence
and removes npm dependency declarations referring to those own package names.
Existing rows benefit without refresh or migration; new and reused collection
results also store normalized evidence. Config/workflow evidence is retained even
when its label matches an own package name. Names are never guessed from repository
names or workspace directory paths. Collection still reads only the pinned root
manifest and named workflow/config files; it does not newly discover workspace
manifests or transitive dependencies.

#### Workflow dependency parsing and identity

Workflow dependency IDs use `B = <workflow-path>:<uses-target>`, for example
`.github/workflows/ci.yml:nocoo/base-ci/.github/workflows/test-job.yml`.
Newly collected literal block-style `uses:` references carry the workflow job
mapping key as `job` (not its display name) and use `B#job=<encoded-job>` even
for a single job. Adding/removing other jobs, reordering jobs, changing the source
HEAD or updating a single job's ref does not rename that reference. The bounded
indentation scanner discovers the document's actual root indentation and supports
job-level reusable workflows and step actions,
quoted keys/references and comments, and ignores scalar script bodies.
Job/step `if:` values support plain multiline
continuations and `|`/`>` block scalars with chomping/indent indicators. Block
scalar bodies may contain key-like text and never supply dependency references.
Plain headers and every continuation are checked separately: collection/alias/tag
starts are unsupported as the first scalar content, and mapping-like `key: value`
or sequence-like lines fail closed, including after an earlier plain continuation.
Empty/comment-only headers may lead to a plain scalar, including after blank lines;
comments after scalar content end that scalar and cannot hide later continuations.
Expressions are not evaluated. It is not
a general YAML parser; flow-style objects, aliases and expression-valued `uses`
are not resolved. Present workflow files with missing/ambiguous job mappings or
unsupported job/step references produce `coverage.status: "limited"`, with reason
`"Dependency manifests cannot be parsed safely; evidence unavailable"` and safe
`reason_code:"dependency_parse_unsupported"`, not a
complete zero. Unrecognized non-scalar lines inside `jobs` also fail closed,
including flow values on a following line and explicit YAML mapping keys.
Null/empty job values, non-sequence steps, multiline quoted scalars and tagged or
anchored values are unsupported and yield limited coverage. This is intentionally
a conservative common-shape scanner, not a general YAML parser.
Only direct job or step `uses` positions are recognized; nested `env.uses` or
`with.uses` fields cause limited coverage rather than guessed dependency IDs.
Existing stronger repository evidence and its original version/window
remain published through the coverage-regression guard. New publications freeze
the latest dependency safe-parse limitation as `coverage.status:"limited"`, with
that safe reason/code and `retained:true`; older resource payloads and publications
are not modified. Browser/machine stream reads and `/sources` agree on that
coverage, with `truncated:true`, `unavailable:false` and `freshness.missing:1`
in both the source index and stream envelope. Items, manifests, `coverage.observed`, source URLs, original
window and evidence timestamps remain those of the retained data, not the failed
attempt. No retained empty list proves zero, including an empty limited baseline.
Without a prior stronger baseline, the new limited resource is published directly
without `retained`; its empty items are still not an observed zero. A successful
accepted refresh publishes its new evidence and clears the retained diagnostic.
Diagnostics are copied only at publication time, never overlaid from mutable run
or repository state during GET. Changed diagnostic/content hashes can retain old
timestamps, so `since` remains an optimization requiring unfiltered reconciliation.
Absent files and parsed
run-only jobs can still prove no workflow dependencies. No additional files or
upstream requests are introduced.

Historical rows have no recoverable job key. Read normalization deduplicates only
equal saved evidence (excluding generated `id`, recursively ignoring object-key
order and normalizing unknown metadata); this does not assert the original jobs
were identical. A single remaining legacy reference keeps its old ID. Distinct
references under the same base ID remain separate as `B#ref=<encoded-ref>`.
Multiple refs within a known job use `B#job=<encoded-job>&ref=<encoded-ref>`.
If same-ref records still differ, `&entry=<1-based-rank>` orders their canonical
full saved content, retaining all evidence rather than overwriting it. Encoding
uses `encodeURIComponent`. The normalization is deterministic under input
reordering and repeated reads, and idempotent; it never changes stored rows,
coverage, observation versions or windows. Legacy rank/ref IDs identify saved
evidence, not inferred job continuity across different evidence sets. The next
full collection supplies real job-qualified IDs; unchanged-head reuse retains
the legacy evidence. Non-workflow dependency IDs are unchanged.

Unknown streams are 400; catalog/publication repository misses are 404; missing
immutable source data is 409 `snapshot_missing`. No observation/publication writes
are available through this API.

### Legacy snapshot 409

Pre-observation format alone is not an error. A legacy stream is served when its
saved `runId` equals the publication's `runId` (or the repository observation's
`version`, if present); `data.ranges` then uses the window described above.
The publication summary is not a substitute for the saved stream payload.

When that payload is absent, the response is HTTP 409 with
`error.code: "snapshot_missing"` and
`error.message: "immutable source missing; refresh this repository"`. A different
or absent payload `runId` instead reports
`"immutable source version mismatch; refresh this repository"`. These are intended
immutability checks, not a reason to fabricate empty items or use another run's
window. GET does not repair, collect or write anything.

The conflict clears when a successful refresh of that repository publishes usable
matching evidence: normally the next weekly run, a daily run if the repository is
selected, or an explicitly requested repository refresh. A catalog-only refresh
or failed refresh retaining the old version does not guarantee recovery. Consumers
must retain pending work and retry after that publication, not treat 409 as zero.

## Records, reports and jobs

These three collections share one generic CRUD contract; creating a job does not
execute it. Let `C` be exactly `records`, `reports`, or `jobs`. IDs are immutable,
unique per account/collection and match `[A-Za-z0-9_-]{1,80}`.

| Method/path under `/accounts/A` | Scope         | Query/body                                                                 | Response                                            |
| ------------------------------- | ------------- | -------------------------------------------------------------------------- | --------------------------------------------------- |
| GET `/agent/C`                  | `agent:read`  | List filters below; no body                                                | `{ account_id, items: Resource[], nextCursor:string | null }` |
| GET `/agent/C/:id`              | `agent:read`  | None                                                                       | `{ account_id, item: Resource }`                    |
| POST `/agent/C`                 | `agent:write` | Create fields below; no query                                              | 201 `{ account_id, item }`                          |
| PATCH `/agent/C/:id`            | `agent:write` | Current positive integer `revision` plus supplied mutable fields; no query | `{ account_id, item }`                              |
| DELETE `/agent/C/:id`           | `agent:write` | Required query `revision`, positive safe integer; no body                  | 204                                                 |

Resource shape:

```json
{
	"id": "grok-bot-run",
	"account_id": "AAAAAAAAAAAAAAAAAAAAA",
	"repository": null,
	"type": "grok-bot-run",
	"status": "completed",
	"source_version": null,
	"payload": {
		"lastRunAt": "2026-10-19T01:30:00Z",
		"status": "completed",
		"analyzed": 4,
		"skipped": 0
	},
	"revision": 1,
	"created_at": "2026-10-19T01:30:00Z",
	"updated_at": "2026-10-19T01:30:00Z"
}
```

| Create field     | Constraint                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `id`             | Optional; omit for generated ID, supply stable ID for retry safety                                             |
| `repository`     | `owner/name` syntax above, maximum 200, or null; default null; generic store does not check catalog membership |
| `type`           | Required `[a-z][a-z0-9-]{0,79}`                                                                                |
| `status`         | Required `[a-z][a-z0-9_-]{0,39}`                                                                               |
| `source_version` | String maximum 200 or null; default null                                                                       |
| `payload`        | Required JSON object, not array/scalar; serialized UTF-8 maximum 65,536 bytes                                  |

List query is strict: `limit` integer 1-100 (default 50), `cursor` previous ID
(exclusive, ID syntax), exact `type`, `status`, `repository` filters (same field
syntax). Unknown filters fail. Results are ID ascending, not timestamp ordered;
follow `nextCursor` until null. Omit repository for all; there is no HTTP null-only
filter. Pagination is not a snapshot or updated-since feed.

POST is create-only: duplicates return 409 `resource_exists`, not an upsert. PATCH
allows only `revision` and mutable `repository`, `type`, `status`, `source_version`,
`payload`; supplied payload **replaces**, not deep-merges. ID/account/created time
cannot change. Creation starts revision 1; every PATCH, including revision-only,
increments it. Stale PATCH/DELETE revision is 409 `revision_conflict`; GET/PATCH
missing item is 404 `not_found`; missing DELETE target is 404 `revision_conflict`.

Grouped examples apply identically to all three collections. The job below is
illustrative generic storage only: no application producer creates it and no
application consumer executes it. It is not an analysis request workflow.

```bash
for collection in records reports jobs; do api "$API/agent/$collection?limit=100"; done
api -G "$API/agent/reports" --data-urlencode 'type=github-analysis' \
  --data-urlencode 'status=completed' --data-urlencode "repository=$REPOSITORY"
api -G "$API/agent/records" --data-urlencode 'limit=50' --data-urlencode 'cursor=grok-bot-run'

json -X POST "$API/agent/records" --data '{"id":"grok-bot-run","type":"grok-bot-run","status":"running","payload":{"lastRunAt":"2026-10-19T01:30:00Z","status":"running","analyzed":0,"skipped":0}}'
api "$API/agent/records/grok-bot-run"
REVISION="$(api "$API/agent/records/grok-bot-run" | jq -er '.item.revision')"
jq -n --argjson revision "$REVISION" \
  '{revision:$revision,status:"completed",payload:{lastRunAt:"2026-10-19T01:35:00Z",status:"completed",analyzed:4,skipped:0}}' |
  json -X PATCH "$API/agent/records/grok-bot-run" --data-binary @-

json -X POST "$API/agent/jobs" --data '{"id":"example-job-1","type":"example-job","status":"pending","payload":{"note":"Illustrative storage only"}}'
REVISION="$(api "$API/agent/jobs/example-job-1" | jq -er '.item.revision')"
api -X DELETE "$API/agent/jobs/example-job-1?revision=$REVISION"
```

Report POST is shown next. Payloads must never include secrets or raw
secret-bearing errors. The generic server validates storage structure, not the
analysis schema; successful persistence alone does not prove UI acceptance.

## Publishing analysis

The web owns [`analysis-contracts.ts`](../apps/web/src/lib/analysis-contracts.ts).
POST reports with `type:"github-analysis"`, `status:"completed"`. Row `repository`
must equal payload `repository`, and row `source_version` must equal payload
`sourceVersion`. Repo scope requires canonical repository; global scope uses null.
The default `/analysis` "all repositories" view displays only global reports
(`repository:null`); repository reports appear only after selecting that repository.
The recommended minimum is four completed global reports: `issues` using
`account:issues`, `prs` using `account:prs`, `ci` using `account:ci`, and `cd` using
`account:factory`; add `account:repos` where catalog evidence is needed. Copy source
`resource`, `version`, non-null `contentVersion` and `fetchedAt` from `/sources`.
Omit the report source's optional `contentVersion` when the index value is null.
Account observation `source.resource` is only `issues`/`prs`/etc., not
`account:issues`.

Validate every payload before writing `type:github-analysis`, even if its row status
is not completed. The page validates all returned rows before checking status:
an invalid draft/pending row still raises a page error and is ignored. Valid other
reports can still render; this is not an unconditional page crash. Keep drafts and
pending work outside that report type. Generic storage acceptance is not validation
of the strict analysis contract; unknown POST/PATCH envelope fields return 400,
while unknown report payload fields are rejected by the analysis reader.

### Report payload

Required unless marked optional; lengths are characters unless bytes are specified:

| Field                                            | Constraint                                                                                                                                                                                          |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`, `scope`, `repository`, `domain` | `1`; `repo                                                                                                                                                                                          | global`; `owner/name`or null;`issues           | prs                                                                                                             | ci                                                | cd` |
| `sourceVersion`                                  | Nonempty full report-source digest; deterministic recipe below                                                                                                                                      |
| `observedAt`, `generatedAt`                      | ISO datetimes with offsets; source observation time distinct from generation time                                                                                                                   |
| `verdict`, `summary`                             | `pass                                                                                                                                                                                               | attention                                      | fail                                                                                                            | unknown`; trimmed nonempty summary, maximum 4,000 |
| `findings`                                       | Maximum 8 `{ title, detail, evidenceIds }`; title 1-200, trimmed detail 1-4,000, maximum 20 evidence ID strings                                                                                     |
| `actions`                                        | Maximum 6 `{ title, reason, priority }`; title 1-200, trimmed reason 1-4,000, priority `now                                                                                                         | next                                           | later`                                                                                                          |
| `limitations`                                    | Maximum 20 strings, each 1-1,000                                                                                                                                                                    |
| `sources`                                        | Maximum 500 `{ resource:string, version:string                                                                                                                                                      | null, contentVersion?:string, fetchedAt:string | null, complete:boolean, stale:boolean }`; optional content version must match `^sha256:[0-9a-f]{64}$`, not null |
| `evidence`                                       | Maximum 24 `{ id, repository, kind, title, state, detail, url, at }`; id 1-256; repository `owner/name` or null; kind/title/state/detail maxima 40/300/60/900; valid URL or null; at string or null |
| `omitted`                                        | Nonnegative integer count of omitted evidence                                                                                                                                                       |
| `judgment`                                       | Required `{ model, choice, confidence?, probabilities? }`; nonempty model; choice `routine                                                                                                          | review                                         | urgent                                                                                                          | unknown`                                          |
| `producer`                                       | Optional; individual fields optional too: strings `orchestrator`, `executor`, `decision`, `jobId`; integer `conversationId`                                                                         |

Confidence, if present, is in [0,1]. Optional probabilities must include all four
keys `routine`, `review`, `urgent`, `unknown`, each in [0,1], sum to 1 (validator
tolerance 0.001), with the chosen option maximal (ties allowed). Omit probabilities
rather than invent them. Model/choice, evidence, sources, verdict and times remain
required. Report and nested source/evidence/judgment/producer/finding/action objects
are strict. Empty evidence/findings/actions arrays are permitted, not proof of health.

Repo sources cite source-index identities/full versions. Do not list repository
names as sources of the recommended direct global reports. That separate child-
report aggregation mode requires matching completed child reports for the browser's
entire expected repository set; machine catalog membership and browser activation
differ. Existing reports without `contentVersion` remain valid.

For direct sources, a report is current only when it has sources and every source's
`contentVersion` equals the current source's value when both hashes exist. If the
report omits it or the current source's hash is null, compare full `version`
instead; two present but unequal hashes never fall back. Evidence age and displayed
oldest time use current `/sources.fetchedAt`, not the report's old time or
`generatedAt`. More than 36 hours,
missing/invalid time or over one minute in the future is stale. Incomplete report
sources, missing current sources, truncation, unavailability or missing freshness
coverage prevent a passing verdict. Missing/stale/superseded/incomplete evidence
shows `unknown`. Child-report aggregation retains its own child-version/time checks.

### Stable IDs and publication

Before inference, skip only an existing `status:completed` report with a valid
payload, matching account/scope/repository/domain and a nonempty expected source
set whose **every full content version** matches the current index when both
hashes exist. If either hash is absent/null, require full-version equality instead.
Do not skip on a missing source or mismatching present hashes. The 12-character
prefix only names an ID, never proves equality. For global identity construction use
`/sources` entries such as `account:issues`, not envelope `source.resource`.

Use `analysis-{repo|global}-{domain}-{first12}`: `repo` is a literal scope word,
not a slash-containing repository. Report `sourceVersion` is hex SHA-256 of a
deterministic encoding of scope, canonical repository/null, domain, and **sorted
source identities plus full content versions (full version when absent)**. Include repository identity to avoid
collisions between repositories with identical data. Take `first12` from that
report digest, never from the raw observation's `sha256:` prefix or digest alone.
Exclude generation times/confidence so retries remain stable. Example recipe:

```bash
api "$API/repos/$OWNER/$NAME/issues" > observation.json
jq -n --arg repository "$REPOSITORY" --slurpfile observations observation.json \
  '{scope:"repo",repository:$repository,domain:"issues",sources:[
    $observations[0] | {resource:.source.resource,version:(.contentVersion // .sourceVersion)}
  ]}' > report-identity.json
SOURCE_VERSION="$(node --input-type=module -e '
  import {createHash} from "node:crypto";
  import {readFileSync} from "node:fs";
  const identity = JSON.parse(readFileSync("report-identity.json", "utf8"));
  const sources = identity.sources.map(({resource,version}) => ({resource,version}));
  const compare = (left,right) => left < right ? -1 : left > right ? 1 : 0;
  sources.sort((left,right) => compare(left.resource,right.resource) ||
    compare(JSON.stringify(left.version),JSON.stringify(right.version)));
  const canonical = JSON.stringify({scope:identity.scope,repository:identity.repository,domain:identity.domain,sources});
  process.stdout.write(createHash("sha256").update(canonical).digest("hex"));
')"
REPORT_ID="analysis-repo-issues-${SOURCE_VERSION:0:12}"
```

Prepare truthful `report-payload.json` using the required fields and actual
sources/evidence/times. For each source copy the observation's `sourceVersion`
into `sources[].version` and its non-null `contentVersion` into
`sources[].contentVersion`; omit that optional field when null. Keep both when
available, distinct from the report's composite `sourceVersion`. For globals use
the corresponding `/sources` entries. This minimal illustrative shape makes no passing claim;
replace its digest, source version and times with actual inputs:

```json
{
	"schemaVersion": 1,
	"scope": "repo",
	"repository": "nocoo/giraffe",
	"domain": "issues",
	"sourceVersion": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	"observedAt": "2026-10-19T00:10:00Z",
	"generatedAt": "2026-10-19T01:30:00Z",
	"verdict": "unknown",
	"summary": "Saved issue coverage is incomplete.",
	"findings": [],
	"actions": [],
	"limitations": ["The saved issue source is truncated."],
	"sources": [
		{
			"resource": "repo:nocoo/giraffe:issues",
			"version": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			"contentVersion": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
			"fetchedAt": "2026-10-19T00:10:00Z",
			"complete": false,
			"stale": false
		}
	],
	"evidence": [],
	"omitted": 0,
	"judgment": { "model": "external-bot-model", "choice": "unknown" }
}
```

```bash
jq --arg id "$REPORT_ID" --arg repository "$REPOSITORY" --arg version "$SOURCE_VERSION" \
  '{id:$id,repository:$repository,type:"github-analysis",status:"completed",
    source_version:$version,payload:(. + {scope:"repo",repository:$repository,
      domain:"issues",sourceVersion:$version})}' report-payload.json > report-create.json
json -X POST "$API/agent/reports" --data-binary @report-create.json
api "$API/agent/reports/$REPORT_ID"
```

On 409 `resource_exists` or uncertain POST, GET the ID and compare account, type,
completed status, repository, domain/scope, valid payload and **full row/payload
source version**. A matching 12-character prefix is insufficient. Mismatches,
incomplete rows or collisions need explicit reconciliation, not blind skipping,
overwriting or random replacement IDs. No `Idempotency-Key`, automatic upsert or
report-specific server deduplication exists beyond account/collection/ID uniqueness.

### Bot run record and analysis UI

Use record ID **and** type `grok-bot-run`, repository null, payload
exactly `{ lastRunAt, status, analyzed, skipped, error? }`: extra keys make the
run record invalid in the page. Require an offset ISO timestamp,
nonnegative counts, status `running|completed|failed`, matching row/payload status.
Error is a short safe code/message, never raw provider output. This is a producer
convention, not a server-enforced bot schema. Create once; then GET/PATCH with
current revision and complete replacement payload. Reconcile create/revision 409s.

The analysis page reads saved reports and the account-wide record with both ID
and type `grok-bot-run`. It shows `lastRunAt`, status and analyzed/skipped counts;
failed runs also show the safe error text. The browser requires an ISO datetime
with an offset, nonnegative integer counts, one of the three statuses and a
matching row status. Malformed payloads, non-null repository or times more than
one minute in the future are errors, not successful runs.

The default routine cadence is 24 hours. A run becomes overdue when `lastRunAt`
is more than 48 hours old, independently of the 36-hour report evidence age.
There is no schedule configuration or heartbeat dependency in this view. Legacy
`work-cron` records and Work jobs are not displayed or requested; their stored
data is retained. An absent valid record shows an empty state, not an offline
runner. Loading and visible polling are read-only and never invoke a model or
refresh GitHub. Do not synthesize fake Work heartbeats for an external bot.

### Analysis report projection and retention

The Access-protected browser endpoint
`GET /api/agent/accounts/A/analysis/reports` returns `{account_id, items: Resource[]}`
for the active account. It accepts no query parameters and performs no writes or
upstream calls. It is not a machine endpoint or an Access-bypass route.

It selects only `reports` of `type:github-analysis`, taking the newest **N=3 rows
per exact `(payload.scope, row.repository, payload.domain)`** across all statuses.
Repository matching is case-sensitive; global reports normally use null. Order
within each key is `(utcWholeSecond DESC, fractionDigits DESC, id DESC)` using
binary text order for fraction digits and IDs. Whole-second conversion removes
the fraction first, then subtracts the explicit signed offset in seconds; it never
rounds a `.9999` fraction into the next second. Fraction digits keep arbitrary
precision and leading zeros, trim trailing zeros, and use `""` for zero/no fraction.
Their lexicographic order exactly matches decimal order without floating-point
conversion. Equivalent offsets/trailing-zero spellings tie and use descending ID.
The accepted reader syntax stays Zod ISO datetime with required seconds, optional
arbitrary-length fractional seconds and `Z` or `+/-HH:MM` (hours 00-23, minutes
00-59). The index/query handle the same full offset range explicitly rather than
relying on SQLite's narrower offset parser. Parsing is guarded by the ISO-shaped
pattern `????-??-??T*`, timezone/fraction shape checks and whole-second conversion;
missing, nonmatching or SQLite-unparseable values sort last. This excludes relative
keywords such as `now`, which are unsafe in an expression index, without rejecting
generic storage writes. Full report/date validation remains in the client. `created_at`,
`updated_at`, revision and current source versions do not determine inclusion.
Malformed keys form their own groups; selected malformed or non-completed rows
still reach the existing strict reader validation and consume a slot. Only valid
completed candidates are displayed, preferring current sources within the selected
three and then exact generation instant and descending binary ID. The client uses
the same whole-second/fraction comparison for candidates and child-report
generation chronology, not millisecond `Date.parse` comparison. A current
historical report outside those three is no longer a display candidate.

Index/query JSON extraction first guards the entire payload with `json_valid`.
Schema-accepted payloads beyond JSON1's nesting depth remain stored and writable;
their extracted scope/domain/time components become null, while repository still
participates in the key. Selected rows retain their original payloads for client
validation. Migration, POST and PATCH do not reject or rewrite these resources.

Migration `0015_analysis_reports.sql` adds a partial expression index. One SQL
statement seeks distinct indexed keys, then at most three row IDs per key before
loading payloads. The final sort covers only selected rows, not report history.
For K distinct keys the response contains at most 3K resources; it is not a fixed
account-wide byte cap. Adding history to existing keys does not add queries,
returned payloads or a full historical scan. The SQLite regression uses 6,001
historical rows, asserts three returned payloads below 5 KB, and checks actual
`EXPLAIN QUERY PLAN` key-range/equality index seeks and rowid hydration. A second
60,001-row case has the same query/payload bounds; SQLite bytecode assertions
prove table columns are read only by the selected-row hydration cursor.

The generic machine `GET /api/v1/accounts/A/agent/reports` and generic browser
resource lists are unchanged: ID-ascending cursor pagination, all matching rows,
no newest-per-key filtering or 5,000-row total limit. The analysis page's separate
`grok-bot-run` record query still traverses at most 50 pages of 100 rows; excessive
matching run records can still fail the load. Use the single stable run-record ID.

There is no server-side automatic report cleanup. Report history no longer needs
deletion to avoid the old UI cap. Retention still requires explicit authorization:
GET the current revision then
`DELETE /accounts/A/agent/reports/:id?revision=N` (204 on success). Preserve needed
current/child reports and audit history; analysis permission is not deletion
permission. All old rows remain stored and individually/generically readable.

## Application management

An analysis bot does not need these permissions. All paths are under
`/api/v1/accounts/A`; repository paths resolve against the saved catalog.
Local stars are Giraffe configuration, not GitHub writes.

### Settings, stars and statistics

| Method/path                       | Scope       | Body                             | Response                                            |
| --------------------------------- | ----------- | -------------------------------- | --------------------------------------------------- |
| GET `/settings`                   | `app:read`  | None                             | Settings shape below                                |
| GET `/stars`                      | `app:read`  | None                             | `{items:[{repo,starred,source,updated_at,reason}]}` |
| PUT `/stars/:owner/:name`         | `app:write` | Optional `{reason}`; add star    | 200 star record                                     |
| DELETE `/stars/:owner/:name`      | `app:write` | Optional `{reason}`; remove star | 200 star record                                     |
| PUT `/statistics/:owner/:name`    | `app:write` | Ignored                          | 410 `deprecated`; never writes                      |
| DELETE `/statistics/:owner/:name` | `app:write` | Ignored                          | 410 `deprecated`; never writes                      |

No query parameters. Settings is `{ account_id, stars:string[], statistics:[],
statistics_deprecated:true, schedules:Schedule[] }`. The empty statistics field and
deprecated `/repos[].statistics_enabled` alias remain for one version. Browser
`POST /api/repos/:owner/:name/statistics` also returns 410 `deprecated` without writing.
Star records include unstarred tombstones. `source` is `owner|agent`, `updated_at`
is UTC ISO-8601, and `reason` is nullable text of at most 200 characters. Absent
bodies are allowed; present bodies must be strict JSON objects with only the
optional `reason`. Machine writes always record `agent`; browser Access writes
always record `owner`. Callers cannot supply provenance. Catalog membership is
the only repository eligibility requirement for writes.

Stars are one shared concept: every accepted browser or machine write is
last-write-wins, including writes over owner records and same-direction writes.
Each write replaces the state, source, timestamp and reason. Provenance is
informational only, never a priority or authorization rule; writes no longer
return 409 `owner_override`. Unstars persist as tombstones but may be replaced
by a later star. Settings `stars` includes only currently starred
names. `/repos` adds nullable `star_source` and `star_updated_at`, including owner
provenance on unstarred rows; the browser list shows a small source marker.
Browser `POST /api/repos/:owner/:name/star` accepts `{account_id,enabled}` and
returns `{account_id,name_with_owner,starred,star_source,star_updated_at}`. The
client applies these server-confirmed fields immediately, then refreshes its view.

Existing stored provenance remains intact; 0.20.0 adds no star-data migration and
does not reverse the 0.19.1 provenance correction. Bots must read the returned
star record instead of expecting a settings response or DELETE 204. Source fields
remain unchanged in GET responses, but consumers must not use them to infer an
owner lock or a separate star category.

```bash
api "$API/settings"
api -X PUT "$API/stars/$OWNER/$NAME"
api -X DELETE "$API/stars/$OWNER/$NAME"
```

### PUT / DELETE /schedules/:kind

Requires `app:write`; kind `daily|weekly|catalog`; no query. PUT requires
`enabled`, `weekday`, `scope`, and either `times` or the single-slot `time` alias
in a strict JSON object:

| Field     | Validation                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled` | Boolean                                                                                                                                        |
| `times`   | Array of 1-6 `HH:MM` values, `00:00`-`23:59`, fixed UTC+08:00 (Asia/Shanghai); deduplicated and sorted on save                                 |
| `time`    | Optional legacy single-slot alias. Writing it alone sets `times:[time]`; when both fields are supplied it must equal the earliest sorted slot. |
| `weekday` | Integer 0-6, Sunday 0. Weekly uses it; daily accepts but ignores it for timing; catalog requires 0.                                            |
| `scope`   | `all                                                                                                                                           | starred`; daily requires `starred`, catalog requires `all`, weekly permits either |

PUT returns Settings. Each Schedule is `{ kind, enabled, time, times, weekday, scope,
nextAt, lastRunId, lastError }`; last three can be null. PUT recalculates `nextAt`
and clears `lastError`, without resource revisions. DELETE has no body, returns
204, and restores a disabled default on reads: daily `08:00/starred`, weekly
`04:00/all`, catalog `07:00/all`, weekday 0. These are defaults, not a claim about
production configuration. This schedules cloud refresh, not a bot routine.

All three kinds support multiple slots. Weekly slots share one weekday; daily
and catalog slots recur each day. `time` always reads as `times[0]` and remains
supported, with no removal date; new consumers should write `times`. Invalid
times, empty/overlong lists and conflicting aliases return 400 `validation_failed`.
`nextAt` is the earliest unresolved slot, strictly after a save but potentially
in the past while deferred. Recovery advances from each settled due time, not
from recovery time. A due run starts or records a safe `lastError` on the next
healthy minute tick (within five minutes). An active run is never cancelled for
a daily; terminal completion immediately hands off pending daily work, bypassing
only manual cooldowns. Current-day daily work precedes unstarted weekly/catalog
work, except exact-slot ties where weekly precedes daily, then catalog.

A daily not admitted before its due date's next Beijing midnight receives its
own failed `scheduled_slot_missed` run and `missedSlots` count 1. It never starts
on a later day. Failed catalog preparation and empty selection also create
explicit target records. Old grouped audits remain readable. Occurrence request
keys, transactional guards and compare-and-swap updates prevent duplicate starts
or an audit racing with acceptance. Bounded backlog draining preserves unresolved
cursors. GETs remain read-only; no production schedule times are changed.
Migration 0013 preserves every existing setting and `next_at`; it does not add
morning runs. The owner must explicitly choose any additional times.

```bash
json -X PUT "$API/schedules/daily" --data '{"enabled":true,"time":"08:00","weekday":0,"scope":"starred"}'
json -X PUT "$API/schedules/daily" --data '{"enabled":true,"times":["05:30","19:30"],"weekday":0,"scope":"starred"}'
json -X PUT "$API/schedules/weekly" --data '{"enabled":true,"time":"04:00","weekday":0,"scope":"all"}'
json -X PUT "$API/schedules/catalog" --data '{"enabled":true,"time":"07:00","weekday":0,"scope":"all"}'
KIND='catalog'; api -X DELETE "$API/schedules/$KIND"
```

### GET /refresh-runs

Requires `app:read`; no body or supported query. Returns `{ account_id,
items:Run[] }`, at most 21 runs, running/paused first, then newest creation time.
No pagination or machine run-detail GET exists. Runs exclude `checkpoint`; older
non-active runs have `steps:[]`, not full history. Every row includes
`counts:{total,success,failed,unavailable,limited,skipped}` computed from the stored steps,
including compact history. No browser progress/lease summary is added.

Optional `invocations:number` counts successful execution lease claims, including
recovery claims after a crash or expired lease. It counts acquired leases, not
successful runs, executed steps, GitHub requests or rejected claim attempts. A
single lease can process multiple steps/pages. Runs predating v0.22.0 normally
omit the field; a later recovery under v0.22.0 or newer can begin recording it.
Zero claims also omit the field. Missing is not measured zero, so exclude missing
counts from invocation-based comparisons rather than substituting `0`.

From v0.23, completed steps/pages survive a later invocation failure. `requests`
is flushed at step/checkpoint boundaries and can undercount only one in-flight
step per parallel repository after abrupt death or cancellation (at most four
with the in-code pool); it is not a billing ledger. Every accepted checkpoint
is retained. Budget
yields preserve the pending cursor with null error and no retry-failure charge.
Lease collisions schedule continuation at the current lease expiry.

For speed measurements, record `invocations`, `requests`, executed step/page
counts and `finishedAt - startedAt` for comparable completed/partial runs with
the same execution kind, depth, scope and workload. Executed steps divided by
positive `invocations` measures batching; wall duration divided by positive
`invocations` measures effective time per claim, including queue/backoff overhead,
not isolated Worker execution time. Compare wall duration and request volume
alongside batching: fewer invocations alone does not prove a faster run. Recovery,
pagination, retention and upstream latency can change the ratios. Active-run
counts are provisional; do not substitute ETA for a measured finish time.
`GET /refresh-runs/latest` is a separate compact summary and does not include
`invocations`; use the matching `id` in this list for the count.

Every run also includes `expectedFinishAt:string|null` and
`expectedFinishAtReason:string|null`. Terminal runs (`completed`, `failed`,
`partial`, `cancelled`) always return `expectedFinishAt: null` and
`expectedFinishAtReason: "terminal"`; use `finishedAt` for the actual end.
This rule takes precedence even when work, valid timestamps or history are absent.
Calibration selects the latest five valid
completed or partial runs for the account and execution kind (`catalog`, `quick`,
`deep`), across retained history rather than just the displayed 21 rows. Samples
span every trigger and scope: manual selected runs use their own planned work,
not the full wall time of a much larger daily run. Catalog preparations remain
catalog samples regardless of trigger; missing legacy depth means deep.

For each step kind, calibration uses the median recorded `durationMs` of executed
terminal steps (`success`, `failed`, `unavailable`, `limited`, with positive
`attempts` and a numeric nonnegative duration). Unseen step kinds use the overall
median of those step durations within the same execution kind. Genuine zero
durations count; skipped, unattempted and missing/invalid timings do not. Fully
timed sample runs also supply per-step scheduling/backoff overhead:
`max(0, wallDuration - modeledStepWallDuration) / nonSkippedSteps`; the median
overhead is added to each remaining step without dividing it by concurrency.
When complete valid start/end intervals are available, calibration separates
account prelude, factory, snapshot, activity, Insights and publication overhead.
It unions overlapping intervals within each phase and assigns intervening gaps
to the following phase. Remaining activity therefore retains its measured tail
instead of receiving only the small average overhead of all 1,146 steps. Compact
plans distinguish Insights from other snapshots. Incomplete interval evidence
keeps the existing overall overhead rather than inventing a phase measurement.
The model assigns ordered repository work to four lanes, placing each next
repository on the earliest free lane, separately for metadata/streams/commit and
repository snapshots. The estimator conservatively retains activity service time;
the executor now pipelines repository activity in its four-lane pool, while
global snapshots and publication remain barriers. This is an idealized lane schedule: invocation-boundary replenishment,
scheduling and backoff remain in the learned overhead. Incomplete timing records never masquerade as
overhead. If no audited timings exist, calibration instead uses the median
`wallDuration / nonSkippedSteps`, which already includes overhead. Invalid-time,
failed/cancelled and zero-work/all-skipped sample runs are excluded.

Running/paused ETA is `max(now, startedAt, nextAttemptAt) + modeledRemainingWall + remainingSteps * perStepOverhead`. Repository-aware parallel modeling applies
only when audited step timings exist; wall-only calibration or a compact plan
without repository/order information stays serial to avoid double discounting.
Historical serial samples can conservatively retain serialization in learned
overhead until parallel samples arrive. All terminal step outcomes remove work, including
skipped future steps ahead of the cursor. Paused estimates assume resumption now
or after outstanding backoff, not a prediction of user action. Terminal history
has `expectedFinishAt:null` and `expectedFinishAtReason:"terminal"`; it uses the
recorded `finishedAt`, never a newly projected finish. Browser history/detail, compact
machine history and latest readiness share this contract; internal calibration
and grouped plans are not response fields. GET remains read-only and never fetches
GitHub. The estimate is neither the hard `deadlineAt` nor a completion guarantee.

Reasons are `terminal` for every terminal run. For non-terminal runs, reasons
are null for a present estimate, `no_completed_history` when no usable
completed-or-partial same-execution-kind history exists, `invalid_started_at` for
an invalid stored active start, and `not_executed` for a zero-step active audit record. A missing
history estimate remains null rather than borrowing another execution kind.

Run fields: `id`, `account_id`, `owner`, `requestKey`, `mode`, `repos`, `repoIds`,
`window:{since,until}`, `steps`, `cursor`, `status`, `startedAt`, `updatedAt`,
`finishedAt`, `nextAttemptAt`, `requests`, `version`, `restoreCursor`, plus optional
`invocations`, `selection`, `depth`, `trigger`, `schedule`, `siteRepos`, `deadlineAt`, `error`,
`missedSlots:{firstDueAt,lastDueAt,count}`. Status is
`running|paused|completed|partial|cancelled|failed`. Steps carry `kind`, `repo`,
`status`, `attempts`, `startedAt`, `finishedAt`, `durationMs`, `pages`, `error`, and
optional `resource`, `sourceHead`, `strategy`, `snapshotCursor`, `retryFailures`.
Nested types: [`factory-run.ts`](../apps/web/src/lib/factory-run.ts).

Step status is `pending|running|success|failed|unavailable|limited|skipped`. Expected
feature/access unavailability is terminal `unavailable`, not `failed`; it does
not by itself make a run `partial`. Dependency safe-parse failures alone finish
as terminal `limited` with `error:"dependency_parse_unsupported"`; the collector
uses that typed safe code for unsupported workflow structure or an unparseable
manifest, never classification by display text. This adds `counts.limited` and
completed browser progress without incrementing failed/unavailable counts or
making the run partial. Collector capacity truncation with no access-failure
reason code likewise increments `counts.limited`, not `counts.failed`; its
`coverage.status:"limited"` evidence remains limited, never complete. Interrupted
pagination/access loss, malformed upstream containers and exhausted
upstream retries remain failures. `completed` means the plan finished without
failures or skipped required work, not that every data source is available.
In particular, a limited observed subset with `permission_denied`, `not_found`,
disabled-feature or `unknown` access restriction remains a failed step/partial
run. Do not classify by the `coverage_limited` error string alone: older fallback
error mapping can also use it for an unknown mid-pagination restriction.
For paginated lists, only an explicit first-page access denial can represent
expected absence. A search response without `nodes` and without an access error
is malformed, not forbidden. A 403/404 after any accepted page (even an empty
page with a next cursor) is interrupted collection: the snapshot step fails with
`snapshot_incomplete`, retains the previous snapshot and its timestamp, and makes
the run/publication partial rather than complete.
The asynchronous POST still returns 202 on admission; a later collection failure
is recorded on the run, not retroactively returned as HTTP 422 by that POST.
`/refresh-runs` shows the failed step's `error:"snapshot_incomplete"` and increments
`counts.failed` (terminal compact history omits full steps). `/refresh-runs/latest`
keeps that entry in `failedSteps`; `lastError` prefers a run-level error, otherwise
the first nonempty failed-step error. A nonfatal snapshot failure can still finish
and publish as `partial`, with non-null `publishedAt` only when atomic publication
is proven. Fatal run failure instead has status `failed` and null `publishedAt`;
until completion it remains unpublished. Neither outcome relabels retained
snapshot evidence as freshly collected.
This includes global Issues/PR chunks resumed in another queue invocation: the
durable snapshot cursor, not just the current request's local page counter,
determines whether collection has already started.
Search and security GraphQL responses with field/node access errors and a surviving connection
are partial responses, not whole-connection unavailability, even if filtering the
denied nodes leaves an empty array.
Catalog pages advertising a continuation require a nonempty new string cursor;
missing, invalid or repeated cursors are incomplete, never a successful empty catalog.
Saved GraphQL connections require an explicit boolean `pageInfo.hasNextPage`;
missing pagination metadata is not proof of a terminal page. Search and security
continuations also require nonempty new string cursors.
Likewise, a declared REST next link that cannot be parsed is incomplete, not EOF;
only absence of a next relation proves the list has ended.
REST list containers must match the endpoint: Actions requires `workflow_runs`,
while releases, contributors and notifications require arrays. A different JSON
container is incomplete even when empty.
List elements must be records before filtering/mapping; invalid elements cannot
be silently dropped to manufacture a successful empty observation. Legitimate
empty lists and nullable optional record fields remain valid.
Legal GraphQL null nodes remain supported; this is not
full validation of optional metadata fields.
Whole-source first-page denial is classified identically for global and repository
Issues/PR search, whether returned as HTTP or GraphQL access errors. Derived
Insights retain prior data and become unavailable when every unsatisfied required
source is explicitly unavailable; a failed, absent or unfinished source still
makes Insights fail as incomplete.
For the **same run ID**, a published factory snapshot has `status:complete` for
a completed run and `status:partial` for a partial run. A newer failed, paused or
timed-out attempt can leave an older publication untouched; compare run IDs and
per-stream coverage, not status strings from different runs. Historical rows and
publications are not rewritten.

All runs have absolute wall-clock deadlines from `startedAt`: catalog **30 minutes**,
quick refresh **6 hours**, deep refresh (including legacy missing depth) **12 hours**.
Paused time and retry backoff count toward the same deadline. Legacy rows without
`deadlineAt` derive it from their original start. On the next scheduler tick or
mutating start/control/queue operation, expired running/paused rows become `failed`
with `error:run_timed_out`, release their lease/account lock, and update the owning
schedule's `lastError`. Lease fencing rejects writes after the deadline; GET never
performs this recovery.

`nextAt` identifies the earliest unresolved occurrence and may remain in the past
while other work is active. Recovery processes retained occurrences individually
in bounded normalization passes. A daily that cannot start before
the next Beijing midnight receives its own immutable failed audit with
`error:scheduled_slot_missed`, `schedule`, and `missedSlots.count:1`; it performs
no GitHub work. Advance from the settled due time, never from recovery time.
Existing plural `scheduled_slots_missed` records remain readable historical
audits, not the rule for newly missed dailies. Settings expose safe `lastError`
diagnostics for deferred, failed and missed work. Inspect run history for each
durable outcome; an explicit schedule save clears its diagnostic and replaces
the pending configuration without cancelling an active run.

```bash
api "$API/refresh-runs"
```

### POST /refresh-runs

Quick collection freezes 30 UTC dates, while successful publication retains older
saved daily history up to 90 dates. Display windows are not collection windows.
See the [v0.24.2 one-time deep backfill](09-factory-runs.md#one-time-history-backfill-after-v0242)
for the post-deploy operator request; do not change the daily quick depth to 90.

Requires `app:write`; explicitly schedules GitHub collection. No query; strict body:

A new request while this account has a `running` or `paused` run returns HTTP
409 `account_conflict`; it does not enqueue a second run. Read `/refresh-runs`
and wait or explicitly control that run rather than blindly retrying. Reusing
the same `requestKey` is idempotent and returns the already admitted run (202),
not a competing-run conflict. Other admission checks can independently return
validation, catalog or cooldown errors.

| Field                        | Validation/default                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `requestKey`                 | Required UUID; logical-request identity within account                                              |
| `mode`                       | Required `catalog                                                                                   | refresh`              |
| `depth`                      | `quick                                                                                              | deep`, default `deep` |
| `scope`                      | `all                                                                                                | selected              | filter | stale | failed`, default `selected` |
| `repos`                      | Optional membership array, maximum 500 strings of at most 200; refresh permits only with `selected` |
| `order`                      | Optional priority array, maximum 500 strings of at most 200; changes order, not membership          |
| `repo`                       | Optional exact repository filter, maximum 200                                                       |
| `language`, `topic`, `query` | Optional filters, maximum 100 each                                                                  |

Do not send `account_id`; token/path provide it. Refresh requires saved catalog;
non-selected scopes require complete inventory. Selection/priorities must be unique
and valid. Filter uses exact repo/language/topic and case-insensitive name/description
substring query. Stale selects missing, non-success or at-least-24-hour-old state;
failed selects failed state. All refresh scopes exclude non-owned repositories.
Refresh selection is bounded to 500 repositories
and must be nonempty except for existing `all` behavior.

Daily quick refresh selects starred-owned catalog repositories. Weekly full refresh
selects every owned catalog repository, including unstarred, archived and forked
entries. Statistics overrides no longer participate in selection. No repository
name has a special mirror rule, and non-owned repositories enter neither factory
streams nor detail-page plans. There is no eligibility cutoff based on size, empty
history or `pushed_at`; archived repositories receive the same streams and nine
detail tabs (details, issues, prs, actions, releases, traffic, security, languages,
contributors). `order` never changes membership; exceeding 500 is an error.
Inspect `/refresh-runs` for frozen `repos`, `siteRepos`, `selection` and step outcomes.
Older compact runs may lack full steps; a single changed snapshot is not a full plan.

A selected-scope manual refresh updates `/sources` entries and detail snapshots
only for its selected repositories. Account projections may change because they
compose those inputs, but untouched repositories keep their previous evidence.
It does **not** publish `/activity`; only an eligible account-wide quick refresh
advances that frozen publication.

For the analysis bot, replace statistics writes with local star writes. Migration
`0016_star_membership.sql` removes stars only where the same account/repository has
an explicit false statistics override, then empties (but retains) `repo_statistics`.
Unstarred explicit true overrides do not create stars. See the
[migration and rollback contract](03-schema.md#star-membership-consolidation).

```bash
REQUEST_KEY="$(node -p 'crypto.randomUUID()')"
jq -n --arg key "$REQUEST_KEY" '{requestKey:$key,mode:"catalog",depth:"quick",scope:"all"}' |
  json -X POST "$API/refresh-runs" --data-binary @-

REQUEST_KEY="$(node -p 'crypto.randomUUID()')"
jq -n --arg key "$REQUEST_KEY" --arg repo "$REPOSITORY" \
  '{requestKey:$key,mode:"refresh",depth:"deep",scope:"selected",repos:[$repo]}' > refresh-request.json
json -X POST "$API/refresh-runs" --data-binary @refresh-request.json
```

Returns 202 `{ account_id, id, status }`. Do not start catalog/refresh concurrently.
Retry uncertain submission with the **same key/body**: duplicate key returns the
existing run, even if a new body asks for different work. A new key means new work.
Acceptance is not successful collection/publication; poll runs and inspect coverage.

### POST /refresh-runs/:id/control

Requires `app:write`; no query; strict body `{ action:"pause"|"resume"|"cancel" }`.
Returns 202 `{ account_id, id, status }`. Missing run is 404. Terminal runs return
unchanged; resume preserves rate-limit/backoff deadlines. Concurrent control can
return 409 `account_conflict`.

```bash
RUN_ID='replace-with-returned-id'
ACTION='pause'
jq -n --arg action "$ACTION" '{action:$action}' |
  json -X POST "$API/refresh-runs/$RUN_ID/control" --data-binary @-
```

## Errors, limits and retries

Errors are `{ "error": { "code": "scope_forbidden", "message": "scope required" } }`.
Use status/code, not message text. Auth/scope checks may precede route validation.
Machine errors are JSON, not Access redirects; no standardized details array or
`retryAt` JSON field exists.

| HTTP | Code                                     | Meaning/action                                                                                                |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 400  | `validation_failed`                      | Invalid JSON/content type, oversized body, schema/query/revision error; fix input                             |
| 401  | `token_unauthorized`                     | Missing/malformed/expired/revoked bearer or unavailable account                                               |
| 403  | `account_forbidden`, `scope_forbidden`   | Wrong account or missing required scope                                                                       |
| 404  | `not_found`                              | Unknown endpoint/resource/repo, missing item/run/publication repository                                       |
| 404  | `revision_conflict`                      | DELETE target missing                                                                                         |
| 405  | `method_not_allowed`                     | Unsupported method/mutation; unregistered routes may instead be 404                                           |
| 409  | `snapshot_missing`                       | Saved/immutable source unavailable; not zero                                                                  |
| 409  | `resource_exists`                        | GET and compare full intended resource identity/version                                                       |
| 409  | `revision_conflict`                      | Reload current revision and reconcile                                                                         |
| 409  | `catalog_incomplete`, `refresh_cooldown` | Prepare catalog or defer refresh                                                                              |
| 409  | `account_conflict`                       | Existing running/paused run or concurrent run control                                                         |
| 422  | `factory_capacity`                       | Generated refresh record exceeds capacity; previous data retained                                             |
| 422  | `snapshot_incomplete`                    | Bounded/incomplete collection cannot replace a snapshot; retain previous evidence and inspect run diagnostics |
| 500  | `internal_error`, `db_error`             | Bounded backoff and operator diagnosis                                                                        |

Implemented application limits, not inferred Cloudflare/GitHub quotas:

| Surface                                     | Limit                                                                                                      |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Tokens                                      | 1-90 days; default 30                                                                                      |
| Resource payload / POST-PATCH body          | 65,536 / 70,000 UTF-8 bytes, respectively                                                                  |
| Resource ID / list page                     | 1-80 URL-safe ASCII characters / default 50, maximum 100                                                   |
| Statistics/schedule JSON body               | 2,048 bytes                                                                                                |
| Refresh start/control JSON body             | 120,000 bytes                                                                                              |
| Refresh selection/priority / generated plan | 500 entries each / 1,800,000 bytes                                                                         |
| Refresh concurrency/cooldown                | One running/paused run per account; 60-second run-start and 15-minute repository cooldown where applicable |
| Refresh run list                            | Maximum 21, no pagination                                                                                  |
| Browser token management JSON               | 8,192 bytes                                                                                                |

There is **no application requests-per-second/minute quota**, per-token throttle,
standard rate-limit headers, documented total resource-count limit, or source-index
pagination. A 25-repository bot batch is not an API quota. Cloudflare/edge policy
may still reject requests; GitHub limits affect explicit refresh, not saved GETs.
Use bounded exponential backoff/jitter for transport, edge 429 and 5xx failures;
honor `Retry-After` only when supplied. Reconcile uncertain POST/PATCH results;
handle each 409 by code, not generic success/retry.

## Recommended external bot flow

This change provisions no routine, model, credentials or migrations. Run outside
Giraffe with private token/model configuration and persisted pending-work state.
1. Validate `/me`, account/scopes/expiry; alert on 401 or upcoming expiry. Use the
   three analysis scopes, not application writes.
2. Start with `/sources` and `/repos?scope=all`; periodically repeat full scans.
   Between full scans use `since` only as an optimization. Merge pending/failed
   work first, and persist pending identity/full versions before advancing cutoff.
3. Build repository/domain and global work from actual source identities/versions.
   Read observations; verify account, versions and coverage. If versions moved
   since indexing, recompute identity. Bound batches locally without dropping work.
4. Compute stable report ID; GET existing reports if useful before inference.
   Analyze only when no matching valid completed report exists. Publish truthful
   reports; insufficient evidence is `unknown`. Reconcile uncertain POST/409 by GET
   and full version. Mark work done only after publication is confirmed.
5. Publish globals using account observations or the correct complete child-report
   set. Keep incomplete/failed domains pending. Create/PATCH `grok-bot-run` with
   current revision, accurate counts/status/time and safe errors; a failed status
   write must not erase pending work or blindly recreate reports. It is not a cursor.
6. Reconcile full scans even after empty polls; rotate tokens before expiry. The
   analysis page shows the bot's last-run record, not the presence of a local runner.

## Access-protected browser token management

These Access-protected browser endpoints are not bearer management APIs. Prefer
the dashboard. Direct examples require an Access session cookie, and writes require
same-origin `Origin`. Keep cookies private; browser account IDs are 21 characters
`[A-Za-z0-9_-]`.

```bash
read -r -s -p 'Access browser cookie value: ' ACCESS_COOKIE; printf '\n'
browser() { curl --fail-with-body -sS -H "Cookie: CF_Authorization=$ACCESS_COOKIE" -H "Origin: $BASE" "$@"; }
browser_json() { browser -H 'Content-Type: application/json' "$@"; }
```

### Tokens

| Method/path              | Query/body                                             | Response                                |
| ------------------------ | ------------------------------------------------------ | --------------------------------------- |
| GET `/api/tokens`        | Required query `account_id`                            | `{ account_id, items:TokenMetadata[] }` |
| POST `/api/tokens`       | `{ account_id, label, scopes, expires_in_days? }`      | 201 metadata plus one-time `token`      |
| PATCH `/api/tokens/:id`  | `{ account_id, label?, scopes? }`, at least one change | Metadata, never token                   |
| DELETE `/api/tokens/:id` | JSON `{ account_id }`, no extra fields                 | 204; revoke, preserve history           |

Metadata is `{ id, account_id, label, scopes, creator, created_at, expires_at,
revoked_at, last_used_at }`; last two can be null. Label: trimmed nonempty, maximum
120, no controls. Scopes: 1-5 distinct known scopes; expiry integer 1-90 days,
default 30. Creator comes from Access, not input. Additional errors:
403 `scope_escalation`, 409 `token_changed`, 404 `not_found` for unavailable token.

```bash
browser -G "$BASE/api/tokens" --data-urlencode "account_id=$ACCOUNT"
jq -n --arg account "$ACCOUNT" '{account_id:$account,label:"External analysis bot",
  scopes:["observations:read","agent:read","agent:write"],expires_in_days:30}' |
  browser_json -X POST "$BASE/api/tokens" --data-binary @-
TOKEN_ID='replace-with-metadata-id'
jq -n --arg account "$ACCOUNT" '{account_id:$account,label:"Read-only",scopes:["observations:read"]}' |
  browser_json -X PATCH "$BASE/api/tokens/$TOKEN_ID" --data-binary @-
jq -n --arg account "$ACCOUNT" '{account_id:$account}' |
  browser_json -X DELETE "$BASE/api/tokens/$TOKEN_ID" --data-binary @-
```

Mint responses contain credentials: never send them to shared logs.
