# Machine API v1 Reference

The v0.27.1 release provides one unified A-then-B refresh and keeps the analysis UI
removed. Current run creation/status, parameters, stars, caching and daily
scheduling are specified in [the refresh contract](15-unified-refresh.md).

The machine API reads saved GitHub observations, stores reports/records/jobs, and
manages saved application preferences. It is not a live GitHub proxy or a model
inference service. Only `https://giraffe.hexly.ai/api/v1/*` has an Access bypass;
the Worker authenticates resource requests. The dashboard and credential-management
endpoints remain Access protected. Accounts/snapshots are deployment-shared, not
per-user tenants. See [the boundary contract](11-agent-api.md).

Legacy quick/deep/full, run-control and schedule-kind routes are removed.
Current observations use only the new `refresh_*` tables, never a fallback to
legacy publications. Historical retirement behavior is documented separately in
[Phase 1](14-phase1-retirement.md), not as the current endpoint contract.

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
The analysis browser surface is removed. Exactly one valid type query is
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

Daily-report browser projections and presentation are removed. Machine report
reads remain bounded to the selected account/type's retained reports; no indexed
O(1) latest claim is made. No data migration is introduced.

## Run readiness

`GET /accounts/:account/refresh-runs/latest` requires `app:read` and returns the
latest new refresh run, or `409 snapshot_missing` before any run exists.
It never starts or revives a run. A run can be `queued`, `running`, `completed`,
`partial`, `failed` or `cancelled`; `phase` is `account`, `repos` or `done`.
Use each saved observation's timestamps and coverage, not just run completion,
when deciding whether a source is ready. Cached sources retain their old times.

The numeric `requests` field remains the actual total. Its detailed counterpart
includes failed attempts, retries and pagination, not logical steps:

```json
{
	"requests": 5,
	"requestBreakdown": {
		"total": 5,
		"graphql": 2,
		"rest": 3,
		"a": { "graphql": 1, "rest": 0 },
		"b": { "graphql": 1, "rest": 3 }
	},
	"partial": true,
	"partialReasons": [{ "repo": "nocoo/giraffe", "codes": ["alerts:permission_denied"] }],
	"cancelRequested": false
}
```

`partialReasons` lists safe codes for every incomplete/missing repository
dimension; account-level entries use `repo: null`. Missingness never exposes
raw GitHub errors or credentials. `completedRepos` counts processed repositories,
including partial ones, not repositories proven complete. See the
[request budget](15-unified-refresh.md#request-budget-and-partial-reasons).

These detailed fields are produced by v0.27.1 runs. Historical terminal v0.27.0
payloads retain their original numeric total without fabricated breakdowns.
Schema cutover explicitly fails old active payloads with
`errorCode: "refresh_schema_cutover"`; already-saved observations remain intact.

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
- Reads/updates return 200, resource creation 201, refresh creation and pending
  cancellation return 202,
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

Reads saved sources through the authenticated machine boundary only.
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

`account:activity` describes the current owned catalogue membership and the
canonical Activity publication, including members without observations. Its
account-wide content identity does not change when a `repository` filter is
applied. Publication time and original source observation times remain distinct;
missing, mismatched or truncated stream evidence uses the same coverage rules as
`/activity`. Owner-attributed commits remain unavailable, so Activity is partial
even when all supported lifecycle streams have complete coverage.

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
are the latest applicable times among the selected days, not a later historical merge.

`sourceVersion` identifies the original calendar observation run, not necessarily
the newest global publication. `source.publicationId` identifies that publication;
`data.window` is the calendar's original collection window. The new account
stage uses one native calendar query; no historical type merge or legacy
calendar fallback occurs. `collectionStatus` reports the saved collection
status, and GET never advances freshness. `/factory` retains that same saved
calendar and its original timestamps.

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

Per-day typed aggregates are not collected. Their fields remain null,
`breakdown:"unavailable"` exposes the limitation, and the calendar's
`typesStatus` remains partial. No residual/private type is inferred and totals
are never adjusted to fit repository commit counts.

`partial` is evaluated against the frozen observation window, not the current
GET date. A native calendar date reaching the UTC cutoff date remains partial;
a closed Shanghai repository day does not prove that GitHub's differently
attributed calendar date is complete. Fetch and observation timestamps remain
those of the account-stage calendar request. Activity does not provide an
attributed contribution calendar in phase 2; external consumers must keep the
native calendar's missingness and partial flags rather than infer one.

Sources: [GitHub contribution time attribution](https://docs.github.com/en/account-and-profile/reference/profile-contributions-reference#how-contribution-event-times-are-calculated),
[GraphQL calendar dates](https://docs.github.com/en/graphql/reference/users#contributioncalendarday),
[GraphQL collection bounds](https://docs.github.com/en/graphql/reference/users#user).

```bash
api "$API/contributions"
api -G "$API/contributions" --data-urlencode 'since=2026-10-01' --data-urlencode 'until=2026-10-21'
```

### GET /activity

`GET /api/v1/accounts/:account/activity?run=latest&repository=owner/name`
requires `observations:read`. The Access-protected browser uses
`GET /api/activity` for the active account. These reads never collect GitHub,
update token activity or repair stored observations.

`run` defaults to `latest`. Only the current new factory publication is
available; an explicit retained run ID (or unambiguous prefix) resolves against
new refresh-run history. An unknown run returns 404 `not_found`, an ambiguous
prefix returns 400 `validation_failed`, and a known run without the current
publication returns 409 `activity_unpublished`. Before any new publication,
`latest` also returns 409. Historical legacy publications are never consulted.

`repository` optionally selects a current owned repository by name. A repository
outside that current catalogue returns 404. Identity joins use immutable GitHub
IDs, so name reuse cannot inherit old evidence. Unknown or duplicate query keys
return 400. Successful responses support authenticated ETag/304; all responses
use `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.
Machine responses vary on `Authorization`; browser responses vary on
`Cookie, Cf-Access-Jwt-Assertion`. Errors do not receive an ETag.

The response retains the `ActivitySnapshot` format:

```text
{ account_id, runId, previousRunId, fetchedAt, membership,
  window: { since, until, timezone?, gap, first },
  repos: [{ repo, ci_runs, prs: { opened, merged, closed },
    issues: { opened, closed }, releases, commits: { default, other, items },
    deploy, snapshot, coverage }],
  totals, totals_partial, totals_coverage, contributions, coverage, truncated }
```

The requested closed calendar-day window comes from the current publication,
with inclusive UTC timestamp boundaries and its original display timezone.
There is no old quick-run checkpoint or author-event ledger: `previousRunId`
is null, and `first` / `gap` remain true rather than asserting contiguous
reporting history. The top-level fetch time identifies publication; per-stream
`coverage.source` retains the actual run ID, fetch time, original window and
complete ranges. A publication does not renew source evidence.

Supported PR/Issue lifecycle events, sampled CI and published releases are
projected from new saved resources. Event timestamps are filtered to the requested
window. Missing sources, incompatible source versions or disjoint source windows
stay unavailable; incomplete overlapping coverage stays partial. Lifecycle
coverage does not claim a complete current open inbox. PR classification is
partial when required labels are unavailable.

Owner-specific commits are unsupported by repository-wide GraphQL counts:
`commits.default`, `commits.other` and `commits.items` remain null. Native
contribution calendars also lack Activity attribution, so `contributions` is
null; read the separate `/contributions` endpoint for the calendar. Uncollected
security snapshots, tags and other dimensions stay explicitly unavailable.
Known empty arrays differ from unavailable nulls; totals and coverage never
convert missing evidence to a successful zero.

### GET /catalog/changes

`GET /api/v1/accounts/A/catalog/changes?since=<ISO datetime>` requires
`observations:read` and remains read-only. Exactly one `since` timestamp with
an explicit timezone is required; unknown/duplicate keys and invalid timestamps
return 400 `validation_failed`.

The new catalogue stores current immutable identities, not an event-history
ledger. Valid requests return 409 `catalog_unpublished`; old catalogue states,
changes and unconfirmed rows are never used as a fallback. Read `/repos` for
the latest new catalogue and use the unified refresh-run endpoints to inspect
collection progress. No synthetic additions, removals or complete history are
invented from current rows.

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

Saved quick runs used a 30-date window and deep runs a 90-date window; always
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

## External reports

Externally produced reports remain generic machine resources. The server validates
storage structure and revision rules, not an analysis UI schema. No analysis
contract module, report cards, bot-status presentation or browser projection is
part of this release. Successful persistence does not execute any job.

Payloads must not contain secrets or raw secret-bearing errors. Producers may
include saved source versions and timestamps as their own evidence, but must
not label unavailable collection as fresh or complete. Existing report rows
remain accessible through the generic resource API.

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
statistics_deprecated:true, schedules:[{time:"03:00",timezone:"Asia/Shanghai",cron:"0 19 * * *",scope:"starred"}], collectionAvailable:true }`. The empty statistics field and
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

### Unified refresh endpoints

All endpoints below require the existing fixed-account bearer and scope checks.
Read operations require `app:read`; start/cancel require `app:write`.

| Method and path                 | Result                                               |
| ------------------------------- | ---------------------------------------------------- |
| `GET /refresh-runs`             | `200`, up to 50 `items`, `collectionAvailable: true` |
| `GET /refresh-runs/latest`      | `200` run, or `409 snapshot_missing`                 |
| `GET /refresh-runs/:id`         | `200` account-fenced run, or `404 not_found`         |
| `POST /refresh-runs`            | `202` queued/active run                              |
| `POST /refresh-runs/:id/cancel` | `202` pending cancellation, or `200` terminal run    |

Start accepts a strict object with optional `since`, `until` (inclusive closed
calendar days, 1–31 days), `timezone` (IANA, default `Asia/Shanghai`), `dimensions`
(nonempty, distinct `commits|issues|prs|actions|releases|alerts`), `force` (default
false), and `repo` (`owner/name`). Dates default to yesterday. Matching active
manual requests return the existing run; different parameters return
`409 refresh_conflict`. Unknown parameters and legacy modes return 400.

Automatic B includes all locally starred repositories regardless of owner, plus
genuinely new, unobserved, non-fork repositories owned by the account and created
in the current Shanghai day. Owner filtering applies only to the new-repository
exception; unstarred foreign repositories never enter automatic B, even on an empty DB.
Explicit `repo` selects any current catalogue repository after A. No refresh
changes stars. Full cache hits require no B requests unless forced.

Cancel takes no parameters. It durably records cancellation and stops after the
current repository (or A step) finishes, retaining existing repo×day data. Queued
runs cancel without collection. The response is the current run; pending requests
have `cancelRequested: true`, terminal cancellations have `status: "cancelled"`.
Repeated requests are idempotent. Existing terminal runs retain their status and
payload; unknown or other-account IDs return 404. Authentication, account fencing,
write scope and browser same-origin checks apply before mutation.

Browser equivalents are `/api/refresh-runs`, `/latest`, `/:id` and `/:id/cancel`,
using the active account and Cloudflare Access. `GET /settings` advertises
`collectionAvailable: true` and the fixed 03:00 Asia/Shanghai schedule. The removed
`POST /refresh-runs/:id/control` and `PUT|DELETE /schedules/:kind` return 404;
quick/deep/full, mutable schedules and historical run revival remain unsupported.

## Errors, limits and retries

Errors are `{ "error": { "code": "scope_forbidden", "message": "scope required" } }`.
Use status/code, not message text. Auth/scope checks may precede route validation.
Machine errors are JSON, not Access redirects; no standardized details array or
`retryAt` JSON field exists.

| HTTP | Code                                   | Meaning/action                                                                    |
| ---- | -------------------------------------- | --------------------------------------------------------------------------------- |
| 400  | `validation_failed`                    | Invalid JSON/content type, oversized body, schema/query/revision error; fix input |
| 401  | `token_unauthorized`                   | Missing/malformed/expired/revoked bearer or unavailable account                   |
| 403  | `account_forbidden`, `scope_forbidden` | Wrong account or missing required scope                                           |
| 404  | `not_found`                            | Unknown endpoint/resource/repo, missing item/run/publication repository           |
| 404  | `revision_conflict`                    | DELETE target missing                                                             |
| 405  | `method_not_allowed`                   | Unsupported method/mutation; unregistered routes may instead be 404               |
| 409  | `snapshot_missing`                     | Saved/immutable source unavailable; not zero                                      |
| 409  | `resource_exists`                      | GET and compare full intended resource identity/version                           |
| 409  | `revision_conflict`                    | Reload current revision and reconcile                                             |
| 409  | `refresh_conflict`                     | Different refresh already active; read its status before starting another         |
| 503  | `refresh_unavailable`                  | Durable refresh binding unavailable; diagnose configuration before retrying       |
| 500  | `internal_error`, `db_error`           | Bounded backoff and operator diagnosis                                            |

Implemented application limits, not inferred Cloudflare/GitHub quotas:

| Surface                            | Limit                                                      |
| ---------------------------------- | ---------------------------------------------------------- |
| Tokens                             | 1-90 days; default 30                                      |
| Resource payload / POST-PATCH body | 65,536 / 70,000 UTF-8 bytes, respectively                  |
| Resource ID / list page            | 1-80 URL-safe ASCII characters / default 50, maximum 100   |
| Statistics JSON body               | 2,048 bytes                                                |
| Refresh run list                   | Latest 50 runs; `collectionAvailable: true`, no pagination |
| Browser token management JSON      | 8,192 bytes                                                |

There is **no application requests-per-second/minute quota**, per-token throttle,
standard rate-limit headers, documented total resource-count limit, or source-index
pagination. A 25-repository bot batch is not an API quota. Cloudflare/edge policy
may still reject requests. Saved GETs never call GitHub; only explicit refresh
creation and the fixed daily schedule start collection.
Use bounded exponential backoff/jitter for transport, edge 429 and 5xx failures;
honor `Retry-After` only when supplied. Reconcile uncertain POST/PATCH results;
handle each 409 by code, not generic success/retry.

## Recommended external consumer flow

1. Obtain an expiring, fixed-account token with only the required scopes.
2. Read `/sources` and supported saved observations; preserve timestamps,
   missingness and coverage when presenting evidence.
3. If freshness is insufficient and the token has `app:write`, start a unified
   refresh and poll its account-fenced status until terminal. Inspect
   `partialReasons` and source timestamps before consuming results; cancel
   unwanted work through `POST /refresh-runs/:id/cancel`. Never invoke retired
   controls or schedule-kind routes.
4. If needed, publish externally produced resources using the generic
   records/reports/jobs API and revision controls. Giraffe does not execute them.
5. Rotate the token before expiry; never store it in URLs or logs.

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
