# Machine API v1 Reference

The machine API reads saved GitHub observations, stores reports/records/jobs, and
optionally manages refresh settings. It is not a live GitHub proxy or a model
inference service. Only `https://giraffe.hexly.ai/api/v1/*` has an Access bypass;
the Worker authenticates resource requests. The dashboard and credential-management
endpoints remain Access protected. Accounts/snapshots are deployment-shared, not
per-user tenants. See [the boundary contract](11-agent-api.md).

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
  `last_used_at`. Responses use `Cache-Control: private, no-store` and
  `Referrer-Policy: no-referrer`.
- JSON writes require `Content-Type: application/json`, UTF-8 if charset is given.
  Strict schemas reject extra fields. No body/query is defined unless listed.
- Reads/updates return 200, resource creation 201, refresh start/control 202,
  deletions 204 with no body except star deletion, which returns its 200 record.
  Separate reads are not a transaction; verify versions.

| Scope | Allowed operations |
| --- | --- |
| `observations:read` | GET sources, catalog, account/repository observations and published streams |
| `agent:read` | GET records/reports/jobs |
| `agent:write` | POST/PATCH/DELETE records/reports/jobs |
| `app:read` | GET settings and refresh runs |
| `app:write` | PUT/DELETE settings; POST refresh start/control |

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
    "observations": true, "agentRead": true, "agentWrite": true,
    "appRead": false, "appWrite": false
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

| Query | Validation / meaning |
| --- | --- |
| `since` | Optional strict ISO datetime with `Z` or explicit offset; e.g. `2026-10-18T08:00:00Z` or `2026-10-18T16:00:00+08:00`. Empty, offset-less and invalid calendar values fail with 400. |
| `repository` | Optional `owner/name`, at most 200 characters, matching `[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+`; resolve to canonical catalog name, or 404. |

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
  "sources": [{
    "resource": "repo:nocoo/giraffe:issues",
    "version": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "contentVersion": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "fetchedAt": "2026-10-19T00:10:00Z",
    "freshness": {
      "oldestAt": "2026-10-19T00:10:00Z", "latestAt": "2026-10-19T00:10:00Z",
      "total": 1, "missing": 0
    },
    "coverage": null, "truncated": false, "unavailable": false
  }]
}
```

Each source has all eight fields shown. `contentVersion` is nullable: rows saved
before content metadata was introduced have no stored hash, and a projection with
an unhashed input also returns null. Factory streams require stored metadata for
the advertised immutable version; missing/mismatched metadata returns null while
the existing version/coverage remains. Null is not a content proof: fall back to
full-version equality. Hashes fill in after the source's next ordinary refresh;
GET never backfills them. Source identities map to data endpoints:

| Resource identity | Data endpoint |
| --- | --- |
| `repo:owner/name:details`, `:issues`, `:prs`, `:actions`, `:releases` | `/repos/owner/name/:resource` |
| `account:repos`, `account:issues`, `account:prs`, `account:ci`, `account:factory` | Corresponding account endpoint |
| `account:activity` | `/activity?run=latest` |
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
    "oldestAt": "2026-10-19T00:10:00Z", "latestAt": "2026-10-19T00:10:00Z",
    "total": 1, "missing": 0
  },
  "coverage": null, "truncated": false, "unavailable": false,
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
Machine `/factory` and `account:factory` expose `truncated:true` when
`publication.inventory.complete !== true`, even when `freshness.missing` is zero.
An existing saved `truncated:true` is also preserved, even with complete inventory;
the same combined rule enters the account factory content hash.
`fetchedAt` is the latest eligible immutable observation, never the publication
clock. Inventory `total`, `scanned` and `pages` remain historical collection
metadata, not projected repository counts.
Default/`scope=all` factory reads preserve the saved account-wide contribution
calendar exactly: all 90 `contribution.days[]` entries, totals, status and
`contributionObservation` provenance. Repository/catalog filtering does
not rewrite this account-wide evidence. Only `scope=starred` returns
`contribution:null`, `contributionExcluded:true` and `contributionStatus:"unavailable"`
without `contributionObservation`: the calendar has no repository breakdown and
cannot be attributed to that subset. Original publication windows and repository
versions are retained; GET neither recollects nor rewrites the calendar.
CI freshness `total` counts selected owned repositories. A repository counts once
as `missing` if any required Actions/releases/details dependency lacks a valid
available timestamp. `oldestAt` and `latestAt` still inspect all three dependencies;
they never collapse a partly missing repository into complete coverage.

### Content version recipe

`version` in `/sources` and `sourceVersion` in observation envelopes are unchanged:
snapshot versions hash `JSON.stringify(projectedData)`, including `fetched_at`,
so a new saved refresh timestamp changes them. Raw snapshots reuse this exact full
digest from saved metadata when available; account projections still derive full
versions from their projected JSON. Factory/publication/stream/calendar
versions instead use their original run IDs. The additive, nullable
`contentVersion` is computed when evidence is saved, not by decoding and hashing
stream payloads on GET. It is not an ETag; `/sources` ETags still describe the full
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

| Context | Removed fields |
| --- | --- |
| Every snapshot root | `fetched_at`, `repository_fetched_at`, `source_fetched_at` |
| Root `freshness` object | `oldestAt`, `latestAt`; retain `total` and `missing` |
| Factory root/stream root | `runId`, `revision`, `leaseUntil`, `startedAt`, `requests`, `rate`, `rateLimits`, `cursor`, `publication`, `next` |
| Factory stream `coverage` and factory `repos[].coverage[stream]` | `fetchedAt`, `sourceFetchedAt`, `pages`, `strategy`, `source` |
| Factory stream `observation` and factory `repos[].observation` | `version`, `refreshedAt`, `metadataAt`, `source`, `repo`; retain the original `window` |
| Factory `repos[]`; `inventory` | `metadataAt`; `pages`, `after`, respectively |
| Factory `contribution`; its `days[]`; `contributionObservation` | `fetchedAt`, `observedAt`; `observedAt`; `version`, `fetchedAt`, respectively |

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
`fullVersion` is the existing `sha256:` plus lowercase hex digest of UTF-8
`JSON.stringify(prSnapshot(finalSavedData))`, with no canonical key sorting or
timestamp removal. Saving it avoids rehashing raw snapshots on each read without
changing any full-version bytes. Account projections still hash their projected
JSON as before. All physical pages of a snapshot carry the same logical hashes.
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
An existing input without a stored hash makes the composite null.

| Projection | Composite inputs and selection |
| --- | --- |
| Account repos/issues/PRs and other projected lists | Catalog and aggregate snapshot hashes, plus hashes of the complete repository pages actually selected to replace aggregate rows; selected repository names, completeness, freshness `total`/`missing` and truncation. Repo catalogs also include local starred/statistics-enabled flags. |
| Account CI | Catalog hash and selected repositories' latest saved `actions`, `releases`, `details` hashes, keyed by lowercase repository source identity; missing rows use `"missing"`; derived freshness `total`/`missing`. Refresh-clock-dependent verdicts, ages and histograms are not hashed. |
| Account factory | Saved publication and catalog hashes, selected catalog repository names, enabled published repository identities (`observed`), scope, derived freshness `total`/`missing` and combined saved/inventory `truncated`. |
| Contributions | Saved publication hash and resolved inclusive `since`/`until` dates. |
| Derived insights | Null; use the unchanged full `sourceVersion`. |

These composites conservatively invalidate on dependency changes, even if a
particular projected list or calendar is unchanged. For example, another part of
the publication can change the contributions hash. Scope/date selections matter;
compare the same resource and selection. `/sources` account hashes agree with the
corresponding default/all observation endpoints.

Migration `0014_source_content.sql` adds the two nullable columns and covering
indexes `snapshots_content(account_id,kind,content_meta)` and
`factory_resources_content(run_id,repo,stream,content_meta)`, without rebuilding
tables or backfilling legacy payloads. Pre-release rows return null until their
next normal save; a composite remains null while any existing dependency lacks a
hash. Do not refresh upstream or decode old payloads to repair hashes on GET.
See [migration and performance evidence](12-source-performance.md#persisted-content-versions-v0170).

### Account endpoints

| GET path | `data` shape |
| --- | --- |
| `/repos` | `{ repos: Repo[], fetched_at, truncated, ...savedMetadata }`; owned saved catalog repositories by default, with `starred` and its deprecated alias `statistics_enabled` |
| `/issues` | `{ issues: Issue[], fetched_at, truncated, repository_fetched_at?, freshness?, ...savedMetadata }`; saved open issues |
| `/prs` | `{ pull_requests: PullRequest[], fetched_at, truncated, repository_fetched_at?, freshness?, ...savedMetadata }`; saved open PRs |
| `/ci` | `{ streams, repos, daily, totals, fetched_at, freshness, unsaved }`; deterministic saved Actions/releases/details summaries; `unsaved` lists repos without an available saved Actions input |
| `/factory` | Published `FactorySnapshot`: `{ schema:1, account_id, owner, runId, revision, leaseUntil, startedAt, fetched_at, window, status, inventory, repos, cursor, requests, rate, contribution, contributionStatus, ...publicationMetadata }` |

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
{"mergeable":true,"mergeStateStatus":"CLEAN","checks":{"state":"SUCCESS"}}
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
  days: [{date,count:number|null,partial,observedAt,unavailable,
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

`sourceVersion` identifies the original calendar observation run, not necessarily
the newest global publication. `source.publicationId` identifies that publication;
`data.window` is the retained calendar's original frozen window. A newer failed
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
until a newer successful run observes it again. Normal daily scheduled refreshes
now collect contributions as well as weekly/full runs; manual selected runs do
not silently broaden to account-wide collection. One calendar request plus six
15-day aggregate batches costs at most seven resumable lease pages for 90 days,
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
selects that immutable publication. `repository` is optional. Unknown query keys
are rejected. The Access-protected browser reads the active account through
`GET /api/activity` with the same selectors. Neither endpoint collects GitHub or
updates token activity. Both support private, authenticated ETag/304 polling.
Duplicate filters also return 400 `validation_failed`. Unknown run IDs return
404 `not_found`; a known run without a successful publication (including a running,
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
  totals, contributions, coverage, truncated }
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
its publication version, content version and saved `fetchedAt`.
Repositories with failed, unavailable or limited steps have `coverage.run.status`
`partial`. Per-source missing evidence remains unavailable/null; a total whose
source evidence is partial or unavailable stays null, never a fabricated zero.
`membership` freezes repository names independently of stored pages, so capacity
cuts cannot make a selected member look unselected. An unclassifiable failed
workflow leaves the red default-branch total null and `default_branch` coverage
partial rather than claiming no red workflows.
Publication first profiles frozen repository payload lengths and loads at most
4,000,000 UTF-8 bytes in frozen membership order, independently of the 16-page
output limit. Input-budget omissions retain membership, partial/truncated
coverage and null account totals, never complete zero results.

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

The supplementary collector normally adds one refs/tags GraphQL request per repo,
plus a successful-workflow REST request only when the complete saved 90-day action
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

No completed discovery publication returns 409 `catalog_unpublished`. Event
retention is bounded to 90 days and 10,000 combined change/unconfirmed events per account. Eviction removes
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
the external bot owns that policy and must respect owner overrides.

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

| Resource | `data` fields beyond saved `fetched_at`, `truncated`, metadata |
| --- | --- |
| `details` | `description`, `homepage`, `default_branch`, `license`, `is_archived`, `open_issue_count`, `stargazer_count`, `fork_count`, `pushed_at`, `url` |
| `issues` | `issues: Issue[]`, shape above |
| `prs` | `pull_requests: PullRequest[]`, shape above |
| `actions` | `runs: [{ id, name, html_url, status, conclusion, event, head_branch, created_at, updated_at }]` |
| `releases` | `releases: [{ id, tag_name, name, html_url, draft, prerelease, published_at }]` |
| `traffic` | `forbidden`, `views: { count, uniques, points }`, `clones: { count, uniques, points }`; points retain GitHub timestamp/count/uniques |
| `security` | `features`, `unavailable`, nullable `dependabot_open` / `code_scanning_open`, alert-summary `items`; optional safe `reason`, `reason_code`, `retained` |
| `languages` | `languages: { [languageName]: byteCount }` |
| `contributors` | `contributors: [{ login, avatar_url, html_url, contributions }]` |

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
[{ since, until }], coverage, fetched_at, observation?, manifests?, truncated,
unavailable }`.
`coverage` is `{ status, pages, fetchedAt, source, reason, reason_code?, retained?, observed, strategy?,
sourceFetchedAt? }`; status is `pending|partial|complete|unavailable|limited`,
strategy `full|incremental|reused`. An empty list proves zero only with complete
coverage. `next` is saved collection metadata, not a machine pagination URL.

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
coverage, with `truncated:true`, `unavailable:false` and missing freshness coverage
in the source index. Items, manifests, `coverage.observed`, source URLs, original
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

| Method/path under `/accounts/A` | Scope | Query/body | Response |
| --- | --- | --- | --- |
| GET `/agent/C` | `agent:read` | List filters below; no body | `{ account_id, items: Resource[], nextCursor:string|null }` |
| GET `/agent/C/:id` | `agent:read` | None | `{ account_id, item: Resource }` |
| POST `/agent/C` | `agent:write` | Create fields below; no query | 201 `{ account_id, item }` |
| PATCH `/agent/C/:id` | `agent:write` | Current positive integer `revision` plus supplied mutable fields; no query | `{ account_id, item }` |
| DELETE `/agent/C/:id` | `agent:write` | Required query `revision`, positive safe integer; no body | 204 |

Resource shape:

```json
{
  "id": "grok-bot-run", "account_id": "AAAAAAAAAAAAAAAAAAAAA",
  "repository": null, "type": "grok-bot-run", "status": "completed",
  "source_version": null,
  "payload": { "lastRunAt": "2026-10-19T01:30:00Z", "status": "completed", "analyzed": 4, "skipped": 0 },
  "revision": 1, "created_at": "2026-10-19T01:30:00Z", "updated_at": "2026-10-19T01:30:00Z"
}
```

| Create field | Constraint |
| --- | --- |
| `id` | Optional; omit for generated ID, supply stable ID for retry safety |
| `repository` | `owner/name` syntax above, maximum 200, or null; default null; generic store does not check catalog membership |
| `type` | Required `[a-z][a-z0-9-]{0,79}` |
| `status` | Required `[a-z][a-z0-9_-]{0,39}` |
| `source_version` | String maximum 200 or null; default null |
| `payload` | Required JSON object, not array/scalar; serialized UTF-8 maximum 65,536 bytes |

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

| Field | Constraint |
| --- | --- |
| `schemaVersion`, `scope`, `repository`, `domain` | `1`; `repo|global`; `owner/name` or null; `issues|prs|ci|cd` |
| `sourceVersion` | Nonempty full report-source digest; deterministic recipe below |
| `observedAt`, `generatedAt` | ISO datetimes with offsets; source observation time distinct from generation time |
| `verdict`, `summary` | `pass|attention|fail|unknown`; trimmed nonempty summary, maximum 4,000 |
| `findings` | Maximum 8 `{ title, detail, evidenceIds }`; title 1-200, trimmed detail 1-4,000, maximum 20 evidence ID strings |
| `actions` | Maximum 6 `{ title, reason, priority }`; title 1-200, trimmed reason 1-4,000, priority `now|next|later` |
| `limitations` | Maximum 20 strings, each 1-1,000 |
| `sources` | Maximum 500 `{ resource:string, version:string|null, contentVersion?:string, fetchedAt:string|null, complete:boolean, stale:boolean }`; optional content version must match `^sha256:[0-9a-f]{64}$`, not null |
| `evidence` | Maximum 24 `{ id, repository, kind, title, state, detail, url, at }`; id 1-256; repository `owner/name` or null; kind/title/state/detail maxima 40/300/60/900; valid URL or null; at string or null |
| `omitted` | Nonnegative integer count of omitted evidence |
| `judgment` | Required `{ model, choice, confidence?, probabilities? }`; nonempty model; choice `routine|review|urgent|unknown` |
| `producer` | Optional; individual fields optional too: strings `orchestrator`, `executor`, `decision`, `jobId`; integer `conversationId` |

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
  "schemaVersion": 1, "scope": "repo", "repository": "nocoo/giraffe", "domain": "issues",
  "sourceVersion": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "observedAt": "2026-10-19T00:10:00Z", "generatedAt": "2026-10-19T01:30:00Z",
  "verdict": "unknown", "summary": "Saved issue coverage is incomplete.",
  "findings": [], "actions": [], "limitations": ["The saved issue source is truncated."],
  "sources": [{
    "resource": "repo:nocoo/giraffe:issues",
    "version": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "contentVersion": "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "fetchedAt": "2026-10-19T00:10:00Z", "complete": false, "stale": false
  }],
  "evidence": [], "omitted": 0,
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

| Method/path | Scope | Body | Response |
| --- | --- | --- | --- |
| GET `/settings` | `app:read` | None | Settings shape below |
| GET `/stars` | `app:read` | None | `{items:[{repo,starred,source,updated_at,reason}]}` |
| PUT `/stars/:owner/:name` | `app:write` | Optional `{reason}`; add star | 200 star record |
| DELETE `/stars/:owner/:name` | `app:write` | Optional `{reason}`; remove star | 200 star record |
| PUT `/statistics/:owner/:name` | `app:write` | Ignored | 410 `deprecated`; never writes |
| DELETE `/statistics/:owner/:name` | `app:write` | Ignored | 410 `deprecated`; never writes |

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

An agent write opposite to an owner record returns 409 `owner_override` without
changing storage. A same-direction agent write returns 200 without changing the
owner source, timestamp or reason. Owner unstars persist as tombstones, so a bot
cannot restore the star later. Settings `stars` includes only currently starred
names. `/repos` adds nullable `star_source` and `star_updated_at`, including owner
provenance on unstarred rows; the browser list shows a small source marker.
Browser `POST /api/repos/:owner/:name/star` accepts `{account_id,enabled}` and
returns `{account_id,name_with_owner,starred,star_source,star_updated_at}`. The
client applies these server-confirmed fields immediately, then refreshes its view.

Existing surviving stars migrate to `owner`. R2 cleanup removals create no owner
tombstone, allowing a later agent star. Bots must read the returned star record
instead of the old PUT settings response or expecting DELETE 204, and respect
409 rather than retrying to override the owner.

```bash
api "$API/settings"
api -X PUT "$API/stars/$OWNER/$NAME"
api -X DELETE "$API/stars/$OWNER/$NAME"
```

### PUT / DELETE /schedules/:kind

Requires `app:write`; kind `daily|weekly|catalog`; no query. PUT requires
`enabled`, `weekday`, `scope`, and either `times` or the single-slot `time` alias
in a strict JSON object:

| Field | Validation |
| --- | --- |
| `enabled` | Boolean |
| `times` | Array of 1-6 `HH:MM` values, `00:00`-`23:59`, fixed UTC+08:00 (Asia/Shanghai); deduplicated and sorted on save |
| `time` | Optional legacy single-slot alias. Writing it alone sets `times:[time]`; when both fields are supplied it must equal the earliest sorted slot. |
| `weekday` | Integer 0-6, Sunday 0. Weekly uses it; daily accepts but ignores it for timing; catalog requires 0. |
| `scope` | `all|starred`; daily requires `starred`, catalog requires `all`, weekly permits either |

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

Every run also includes `expectedFinishAt:string|null` and
`expectedFinishAtReason:string|null`. The estimate is its start plus the median
wall duration of the last five valid completed or partial runs of that account and actual
kind (`catalog`, `quick`, `deep`), using all retained history, not only these 21
rows. It is recalibrated at read time and may be in the past; it is not the hard
`deadlineAt` or a completion guarantee. Catalog preparations are catalog samples
regardless of daily/weekly trigger. Samples require real valid start/finish times
and positive work; failed/cancelled and zero-work runs remain excluded. With no
eligible same-kind sample, the estimate stays null rather than borrowing a
different kind's duration. `no_completed_history` means no eligible completed-or-partial
same-kind history, including an account with no usable terminal duration.
Null reasons are `no_completed_history`, `invalid_started_at` or `not_executed`
(zero-work audit); a present estimate has a null reason. Browser run history and
selected detail use the same projection without writing stored payloads.

Run fields: `id`, `account_id`, `owner`, `requestKey`, `mode`, `repos`, `repoIds`,
`window:{since,until}`, `steps`, `cursor`, `status`, `startedAt`, `updatedAt`,
`finishedAt`, `nextAttemptAt`, `requests`, `version`, `restoreCursor`, plus optional
`selection`, `depth`, `trigger`, `schedule`, `siteRepos`, `deadlineAt`, `error`,
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
making the run partial. Collector `coverage.status:"limited"`, including capacity
truncation with `error:"coverage_limited"`, likewise increments `counts.limited`,
not `counts.failed`; its evidence remains limited, never complete. Interrupted
pagination/access loss, malformed upstream containers and exhausted
upstream retries remain failures. `completed` means the plan finished without
failures or skipped required work, not that every data source is available.
For paginated lists, only an explicit first-page access denial can represent
expected absence. A search response without `nodes` and without an access error
is malformed, not forbidden. A 403/404 after any accepted page (even an empty
page with a next cursor) is interrupted collection: the snapshot step fails with
`snapshot_incomplete`, retains the previous snapshot and its timestamp, and makes
the run/publication partial rather than complete.
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

Requires `app:write`; explicitly schedules GitHub collection. No query; strict body:

| Field | Validation/default |
| --- | --- |
| `requestKey` | Required UUID; logical-request identity within account |
| `mode` | Required `catalog|refresh` |
| `depth` | `quick|deep`, default `deep` |
| `scope` | `all|selected|filter|stale|failed`, default `selected` |
| `repos` | Optional membership array, maximum 500 strings of at most 200; refresh permits only with `selected` |
| `order` | Optional priority array, maximum 500 strings of at most 200; changes order, not membership |
| `repo` | Optional exact repository filter, maximum 200 |
| `language`, `topic`, `query` | Optional filters, maximum 100 each |

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

| HTTP | Code | Meaning/action |
| --- | --- | --- |
| 400 | `validation_failed` | Invalid JSON/content type, oversized body, schema/query/revision error; fix input |
| 401 | `token_unauthorized` | Missing/malformed/expired/revoked bearer or unavailable account |
| 403 | `account_forbidden`, `scope_forbidden` | Wrong account or missing required scope |
| 404 | `not_found` | Unknown endpoint/resource/repo, missing item/run/publication repository |
| 404 | `revision_conflict` | DELETE target missing |
| 405 | `method_not_allowed` | Unsupported method/mutation; unregistered routes may instead be 404 |
| 409 | `snapshot_missing` | Saved/immutable source unavailable; not zero |
| 409 | `resource_exists` | GET and compare full intended resource identity/version |
| 409 | `revision_conflict` | Reload current revision and reconcile |
| 409 | `catalog_incomplete`, `refresh_cooldown` | Prepare catalog or defer refresh |
| 409 | `account_conflict` | Existing running/paused run or concurrent run control |
| 422 | `factory_capacity` | Generated refresh record exceeds capacity; previous data retained |
| 500 | `internal_error`, `db_error` | Bounded backoff and operator diagnosis |

Implemented application limits, not inferred Cloudflare/GitHub quotas:

| Surface | Limit |
| --- | --- |
| Tokens | 1-90 days; default 30 |
| Resource payload / POST-PATCH body | 65,536 / 70,000 UTF-8 bytes, respectively |
| Resource ID / list page | 1-80 URL-safe ASCII characters / default 50, maximum 100 |
| Statistics/schedule JSON body | 2,048 bytes |
| Refresh start/control JSON body | 120,000 bytes |
| Refresh selection/priority / generated plan | 500 entries each / 1,800,000 bytes |
| Refresh concurrency/cooldown | One running/paused run per account; 60-second run-start and 15-minute repository cooldown where applicable |
| Refresh run list | Maximum 21, no pagination |
| Browser token management JSON | 8,192 bytes |

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

| Method/path | Query/body | Response |
| --- | --- | --- |
| GET `/api/tokens` | Required query `account_id` | `{ account_id, items:TokenMetadata[] }` |
| POST `/api/tokens` | `{ account_id, label, scopes, expires_in_days? }` | 201 metadata plus one-time `token` |
| PATCH `/api/tokens/:id` | `{ account_id, label?, scopes? }`, at least one change | Metadata, never token |
| DELETE `/api/tokens/:id` | JSON `{ account_id }`, no extra fields | 204; revoke, preserve history |

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
