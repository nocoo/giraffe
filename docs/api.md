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
  deletions 204 with no body. Separate reads are not a transaction; verify versions.

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
remain stored. Browser inbox/statistics views use the same membership boundary;
their statistics participation rules still apply. Generic records/reports/jobs are
application resources, not GitHub observations, and retain their independent CRUD
contract.

### GET /accounts/A/sources

Shares saved-source assembly with the browser's `/api/agent/accounts/A/sources`.
Machine `repositories` is the sorted **entire saved catalog**, including unstarred,
disabled-statistics, forked, archived and otherwise browser-inactive repositories.
It does not depend on the dashboard active account or browser activation filter.

| Query | Validation / meaning |
| --- | --- |
| `since` | Optional strict ISO datetime with `Z` or explicit offset; e.g. `2026-10-18T08:00:00Z` or `2026-10-18T16:00:00+08:00`. Empty, offset-less and invalid calendar values fail with 400. |
| `repository` | Optional `owner/name`, at most 200 characters, matching `[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+`; resolve to canonical catalog name, or 404. |

Unknown query keys fail with 400; there is no scope, pagination or cursor.
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
    "fetchedAt": "2026-10-19T00:10:00Z",
    "freshness": {
      "oldestAt": "2026-10-19T00:10:00Z", "latestAt": "2026-10-19T00:10:00Z",
      "total": 1, "missing": 0
    },
    "coverage": null, "truncated": false, "unavailable": false
  }]
}
```

Each source has all seven fields shown. Source identities map to data endpoints:

| Resource identity | Data endpoint |
| --- | --- |
| `repo:owner/name:details`, `:issues`, `:prs`, `:actions`, `:releases` | `/repos/owner/name/:resource` |
| `account:repos`, `account:issues`, `account:prs`, `account:ci`, `account:factory` | Corresponding account endpoint |
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

### Observation envelope

The following data endpoints return this envelope; `/sources` does not:

```json
{
  "account_id": "AAAAAAAAAAAAAAAAAAAAA",
  "data": { "issues": [], "fetched_at": "2026-10-19T00:10:00Z", "truncated": false },
  "sourceVersion": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
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
including repositories with no open items (`all` is the full catalog; `starred` is its
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

Factory freshness counts selected catalog repositories, including entries absent
from the publication. Only immutable repository `observation.refreshedAt` supplies
their time; absent/invalid observations count as missing. Its `fetchedAt` is the
latest such observation, never the publication clock. Inventory `total`, `scanned`
and `pages` remain historical collection metadata, not projected repository counts.
The account-wide contribution calendar has no repository breakdown, so projections
return `contribution:null`, `contributionExcluded:true` and
`contributionStatus:"unavailable"` rather than attributing excluded data to the
selection. Original publication windows and repository versions are retained.
CI freshness counts three dependencies per selected repository (Actions, releases,
details); missing/unavailable dependencies count as missing.

### Account endpoints

| GET path | `data` shape |
| --- | --- |
| `/repos` | `{ repos: Repo[], fetched_at, truncated, ...savedMetadata }`; all saved catalog repositories by default, with `statistics_enabled` and `starred` |
| `/issues` | `{ issues: Issue[], fetched_at, truncated, repository_fetched_at?, freshness?, ...savedMetadata }`; saved open issues |
| `/prs` | `{ pull_requests: PullRequest[], fetched_at, truncated, repository_fetched_at?, freshness?, ...savedMetadata }`; saved open PRs |
| `/ci` | `{ streams, repos, daily, totals, fetched_at, freshness, unsaved }`; deterministic saved Actions/releases/details summaries; `unsaved` lists repos without an available saved Actions input |
| `/factory` | Published `FactorySnapshot`: `{ schema:1, account_id, owner, runId, revision, leaseUntil, startedAt, fetched_at, window, status, inventory, repos, cursor, requests, rate, contribution, contributionStatus, ...publicationMetadata }` |

Each accepts only the documented selector `scope=all|starred`, default `all`;
invalid/repeated scope returns 400. `starred` means local Giraffe stars, not GitHub
stars. No statistics participation filter or HTTP pagination is applied. Open-item
lists are not closed-event history; use factory streams for that.

```bash
for resource in repos issues prs ci factory; do api "$API/$resource?scope=all"; done
```

Item fields (saved metadata can add fields; do not reject unknown observation data):

- `Repo`: `name_with_owner`, `name`, `owner_login`, `description`, `stargazer_count`,
  `fork_count`, `open_issue_count`, `primary_language`, `pushed_at`, `visibility`,
  `is_private`, `is_archived`, `is_fork`, `url`, `statistics_enabled`, `starred`.
- `Issue`: `name_with_owner`, `number`, `title`, `url`, `created_at`, `updated_at`,
  `author_login`, `labels: [{ name, color }]`, `comments_count`.
- `PullRequest`: `name_with_owner`, `number`, `title`, `url`, `created_at`,
  `updated_at`, `author_login`, `is_draft`, `review_decision`, `additions`,
  `deletions`, `base_ref`, `head_ref`.
- CI `totals`: explicit workflow and repository counts documented below;
  `daily` entries: `{ x, success, failure, other }`, with date string `x`.
  Full nested summaries: [`ci-health.ts`](../apps/web/src/lib/ci-health.ts).
- Full factory repository metrics, observation versions/windows, coverage and
  publication fields: [`factory-types.ts`](../apps/web/src/lib/factory-types.ts).

### Saved CI verdicts and units

CI uses only saved Actions, releases and details. The evaluation clock is the newest
valid saved input time, not the request's wall clock. A report can therefore be stale
even when a verdict is healthy; inspect its freshness separately.

- Project verdicts use only runs on the **known default branch**
  from saved repository details. Missing/empty default branch, null run branch,
  feature/PR branches and tag refs are not assumed to be default-branch evidence.
  No branch-existence or open-PR lookup is performed. Branch and bot streams remain
  observational and never make project workflow/repository verdicts broken or flaky.
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
  workflows or repositories. `botStreams` counts bot streams; `truncatedRepos`
  counts repository summaries whose saved inputs are truncated.
- `daily` remains an all-branch, non-bot completed-run histogram, not a health
  verdict; its success/failure/other values are run counts.

Per-repository summaries likewise expose `brokenWorkflows`, `flakyWorkflows`,
`healthyWorkflows`, `idleWorkflows`, `totalWorkflows`, `nonDefaultBranchStreams`,
`nonDefaultBranchFailures` and `botStreams`. The ambiguous legacy totals and
per-repository count names are removed; consumers must use the explicit-unit names.

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
| `security` | `unavailable`, `dependabot_open`, `code_scanning_open`; not alert-event details |
| `languages` | `languages: { [languageName]: byteCount }` |
| `contributors` | `contributors: [{ login, avatar_url, html_url, contributions }]` |

```bash
api "$API/repos/$OWNER/$NAME"
for resource in details issues prs actions releases traffic security languages contributors; do
  api "$API/repos/$OWNER/$NAME/$resource"
done
```

Unknown resource names are 404; absent saved pages are 409 `snapshot_missing`.

### Factory stream endpoints

`GET /factory/repos/:owner/:name/:stream` accepts exactly `commits`, `issues`,
`prs`, `actions`, `releases`, `alerts`, `dependencies`, without query/body:

```bash
for stream in commits issues prs actions releases alerts dependencies; do
  api "$API/factory/repos/$OWNER/$NAME/$stream"
done
```

Envelope `data` is `{ runId, items: FactoryEvent[], next: string|null, ranges:
[{ since, until }], coverage, fetched_at, observation?, truncated, unavailable }`.
`coverage` is `{ status, pages, fetchedAt, source, reason, observed, strategy?,
sourceFetchedAt? }`; status is `pending|partial|complete|unavailable|limited`,
strategy `full|incremental|reused`. An empty list proves zero only with complete
coverage. `next` is saved collection metadata, not a machine pagination URL.

Events have `id`, `title`, `url`, `at`, `createdAt`, `closedAt`, `mergedAt`, `author`,
`state`, and optional `body`, `severity`, `conclusion`, `draft`, `review`, `version`,
`path`. `observation` has `{ version, window, refreshedAt, source:"run"|"legacy",
repo?, metadataAt? }`. Envelope `source.kind` is `factory`, `source.publicationId`
identifies the publication, while `sourceVersion` identifies the immutable
repository observation; mixed publications can contain older repository versions.

Unknown streams are 400; catalog/publication repository misses are 404; missing
immutable source data is 409 `snapshot_missing`. No observation/publication writes
are available through this API.

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

Grouped examples apply identically to all three collections:

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

json -X POST "$API/agent/jobs" --data '{"id":"analysis-request-1","repository":"nocoo/giraffe","type":"analysis-request","status":"pending","payload":{"domain":"issues"}}'
REVISION="$(api "$API/agent/jobs/analysis-request-1" | jq -er '.item.revision')"
api -X DELETE "$API/agent/jobs/analysis-request-1?revision=$REVISION"
```

Report POST is shown next. Payloads must never include secrets or raw
secret-bearing errors. The generic server validates storage structure, not the
analysis schema; successful persistence alone does not prove UI acceptance.

## Publishing analysis

The web owns [`analysis-contracts.ts`](../apps/web/src/lib/analysis-contracts.ts).
POST reports with `type:"github-analysis"`, `status:"completed"`. Row `repository`
must equal payload `repository`, and row `source_version` must equal payload
`sourceVersion`. Repo scope requires canonical repository; global scope uses null.

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
| `sources` | Maximum 500 `{ resource:string, version:string|null, fetchedAt:string|null, complete:boolean, stale:boolean }` |
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

Repo sources cite source-index identities/full versions. Global reports can cite
`account:*` observations, or canonical repository names with child report
`sourceVersion` values; the latter must cover the browser's expected repository set.
Machine catalog membership and browser activation intentionally differ in PR1.
The UI checks source versions, completeness and age (36 hours), and shows `unknown`
for missing, stale, superseded or incomplete evidence regardless of report creation
time. Do not treat unavailable/limited coverage as successful empty evidence.

### Stable IDs and publication

Use `analysis-{repo|global}-{domain}-{first12}`: `repo` is a literal scope word,
not a slash-containing repository. Report `sourceVersion` is hex SHA-256 of a
deterministic encoding of scope, canonical repository/null, domain, and **sorted
source identities plus full versions**. Include repository identity to avoid
collisions between repositories with identical data. Take `first12` from that
report digest, never from the raw observation's `sha256:` prefix or digest alone.
Exclude generation times/confidence so retries remain stable. Example recipe:

```bash
api "$API/repos/$OWNER/$NAME/issues" > observation.json
jq -n --arg repository "$REPOSITORY" --slurpfile observations observation.json \
  '{scope:"repo",repository:$repository,domain:"issues",sources:[
    $observations[0] | {resource:.source.resource,version:.sourceVersion}
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
sources/evidence/times. This minimal illustrative shape makes no passing claim;
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
`{ lastRunAt, status, analyzed, skipped, error? }`. Recommend ISO timestamp,
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

## Application management

An analysis bot does not need these permissions. All paths are under
`/api/v1/accounts/A`; repository paths resolve against the saved catalog.
Local stars/statistics are Giraffe configuration, not GitHub writes.

### Settings, stars and statistics

| Method/path | Scope | Body | Response |
| --- | --- | --- | --- |
| GET `/settings` | `app:read` | None | Settings shape below |
| PUT `/stars/:owner/:name` | `app:write` | None needed; add star | Settings |
| DELETE `/stars/:owner/:name` | `app:write` | None; remove star | 204 |
| PUT `/statistics/:owner/:name` | `app:write` | Strict `{ "enabled": boolean }` | Settings |
| DELETE `/statistics/:owner/:name` | `app:write` | None; remove override, restore defaults | 204 |

No query parameters. Settings is `{ account_id, stars:string[], statistics:
[{ repo, enabled:boolean }], schedules:Schedule[] }`. Statistics lists explicit
overrides, not every effective value. PUT returns settings even without `app:read`.
Repeated add/remove star or remove override is harmless.

```bash
api "$API/settings"
api -X PUT "$API/stars/$OWNER/$NAME"
api -X DELETE "$API/stars/$OWNER/$NAME"
json -X PUT "$API/statistics/$OWNER/$NAME" --data '{"enabled":true}'
api -X DELETE "$API/statistics/$OWNER/$NAME"
```

### PUT / DELETE /schedules/:kind

Requires `app:write`; kind `daily|weekly|catalog`; no query. PUT requires **all**
fields in strict JSON `{ enabled, time, weekday, scope }`:

| Field | Validation |
| --- | --- |
| `enabled` | Boolean |
| `time` | `HH:MM`, `00:00`-`23:59`, fixed UTC+08:00 |
| `weekday` | Integer 0-6, Sunday 0. Weekly uses it; daily accepts but ignores it for timing; catalog requires 0. |
| `scope` | `all|starred`; daily requires `starred`, catalog requires `all`, weekly permits either |

PUT returns Settings. Each Schedule is `{ kind, enabled, time, weekday, scope,
nextAt, lastRunId, lastError }`; last three can be null. PUT recalculates `nextAt`
and clears `lastError`, without resource revisions. DELETE has no body, returns
204, and restores a disabled default on reads: daily `08:00/starred`, weekly
`04:00/all`, catalog `07:00/all`, weekday 0. These are defaults, not a claim about
production configuration. This schedules cloud refresh, not a bot routine.

```bash
json -X PUT "$API/schedules/daily" --data '{"enabled":true,"time":"08:00","weekday":0,"scope":"starred"}'
json -X PUT "$API/schedules/weekly" --data '{"enabled":true,"time":"04:00","weekday":0,"scope":"all"}'
json -X PUT "$API/schedules/catalog" --data '{"enabled":true,"time":"07:00","weekday":0,"scope":"all"}'
KIND='catalog'; api -X DELETE "$API/schedules/$KIND"
```

### GET /refresh-runs

Requires `app:read`; no body or supported query. Returns `{ account_id,
items:Run[] }`, at most 21 runs, running/paused first, then newest creation time.
No pagination or machine run-detail GET exists. Runs exclude `checkpoint`; older
non-active runs have `steps:[]`, not full history. No browser progress/lease summary
is added.

Run fields: `id`, `account_id`, `owner`, `requestKey`, `mode`, `repos`, `repoIds`,
`window:{since,until}`, `steps`, `cursor`, `status`, `startedAt`, `updatedAt`,
`finishedAt`, `nextAttemptAt`, `requests`, `version`, `restoreCursor`, plus optional
`selection`, `depth`, `trigger`, `schedule`, `siteRepos`. Status is
`running|paused|completed|partial|cancelled|failed`. Steps carry `kind`, `repo`,
`status`, `attempts`, `startedAt`, `finishedAt`, `durationMs`, `pages`, `error`, and
optional `resource`, `sourceHead`, `strategy`, `snapshotCursor`, `retryFailures`.
Nested types: [`factory-run.ts`](../apps/web/src/lib/factory-run.ts).

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
failed selects failed state. Existing factory participation policy applies, unlike
the unfiltered machine catalog. Refresh selection is bounded to 500 repositories
and must be nonempty except for existing `all` behavior.

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
