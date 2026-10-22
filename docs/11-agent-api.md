# Machine API v1 and external analysis

The Worker collects GitHub observations into D1 and serves the browser console. The
analysis desk reads reports and run status published by external programs; Giraffe
does not bundle an analysis runtime, run model inference, or execute code changes.
The complete endpoint reference, request examples, validation limits and recommended
consumer flow are in [Machine API v1](api.md).

## Authentication and token management

Only `https://giraffe.hexly.ai/api/v1/*` is outside the dashboard's Cloudflare
Access gate. **Every** machine API request, including identity and collection
reads, requires a bearer token. There are no tokenless machine endpoints. Tokens
are opaque, hash-only, fixed to one GitHub account, revocable and scoped. Their
expiry is 1-90 days (30 days by default); create a replacement and rotate it
before expiry. There is no renewable token or refresh-token flow.

Create, inspect, reduce scopes, and revoke tokens in the Access-protected dashboard.
Token-management browser requests remain same-origin protected. A raw token is
returned only once when created. Keep it in the external consumer's private
configuration; never put it in URLs, logs, reports, or browser persistence. A
machine token cannot select or change the dashboard's active account. Accounts and
snapshots are shared by authorized users of a deployment, not tenant-isolated.

Scopes are independent:

| Scope | Capability |
| --- | --- |
| `observations:read` | Read saved source indexes, account/repository observations and published factory streams |
| `agent:read` | Read generic records, reports and jobs |
| `agent:write` | Create, update and delete generic records, reports and jobs |
| `app:read` | Read refresh settings and runs |
| `app:write` | Change settings and start/control explicit refresh runs |

An external analysis consumer normally needs only `observations:read`, `agent:read`
and `agent:write`. It does not need application write access. Missing/invalid,
expired or revoked tokens return 401; an account mismatch or missing scope returns
403. Responses are private and non-cacheable. GET does not refresh GitHub or update
token activity.

## Saved observation contract

Schedule management accepts 1-6 sorted/deduplicated `times` per daily, weekly or
catalog kind, in fixed UTC+08:00. Weekly slots share one weekday. The legacy
`time` alias remains readable/writable; a single-field write replaces the list
with one slot. Conflicting aliases are rejected. `nextAt` selects the earliest
upcoming slot; recovery coalesces earlier missed slots and attempts only the
latest due occurrence. Migration 0013 does not change existing configured times.
See [schedule writes](api.md#put--delete-scheduleskind) for scopes and validation.

Security snapshots persist independent `features.dependabot` and
`features.code_scanning` availability (`available|unavailable|partial`), with
safe `reason` / `reason_code` and null unavailable counts. Top-level `unavailable`
means both features are unavailable; one unavailable feature never hides the
other. Prior evidence is separate in `retained` with its original timestamp.
Old snapshots without feature fields retain unknown per-feature coverage until
refreshed. Factory alerts coverage uses the same safe codes:
`alerts_disabled`, `code_scanning_disabled`, `permission_denied`, `not_found`, `unknown`. Disabled requires
explicit upstream wording; a generic 404 is `not_found` because GitHub hides some
inaccessible resources. Raw upstream messages are never persisted. Unavailability
does not prove zero alerts; truncation and lost pagination remain real failures.
Account read projections preserve prior complete evidence and its original time
instead of replacing it with a newer mixed page. Feature metadata follows selected
evidence, missing catalog coverage never implies zero, and stored truncation is
partial coverage. Current plus retained security must fit the bounded pages;
otherwise refresh fails without replacing prior good rows.

Factory alerts and security Dependabot collection both explicitly request open
alerts, without creation/update-window filtering. Security also includes a
separate code-scanning feature. Their saved collection times can differ within
one run; they are not an atomic upstream observation. See the
[security contract](api.md#repository-endpoints).

All observation paths are GET-only and require `observations:read`. The account in
the path must match the token's fixed account. Reads expose saved data; they are not
a live GitHub proxy and never collect upstream or mutate snapshots.

`GET /api/v1/accounts/:account_id/sources` returns the saved-source index and the
complete saved repository catalog. Optional `since` and `repository` filters narrow
sources; `since` is an optimization, not a durable change cursor. Consumers must
reconcile pending/failed work and periodically perform unfiltered scans. An empty
filtered result does not prove that all sources have been analyzed.

Every documented machine GET rejects unknown query keys with 400
`validation_failed`, including identity, individual resources, settings and run
lists. Repository pages and factory streams accept no query parameters; account
observations accept only `scope`, except `/contributions`, which accepts only
`since`/`until` dates. Authentication and authorization run first.

Machine source indexes support content-derived `ETag` / `If-None-Match` validation
with bodyless 304 responses. Authorization and query validation are never bypassed.
Responses retain private/no-store, Authorization variance and no-referrer policy;
this is explicit polling, not a shared cache. Request-local input reuse reduces
duplicate reads without changing observation versions or writing cache rows.
Cloudflare handles production response compression. See the
[local performance evidence and edge verification limits](12-source-performance.md).

Authenticated `/sources` 200/304 responses also expose safe `Server-Timing`
phase durations, including each D1 round trip. They are headers only, excluded
from JSON, source hashes and ETags; no query text, repository identity or token
data is included. See [timing fields and interpretation](api.md#source-request-timing).

All account observation lists/aggregates and repository/factory source entries are
intersected with the current saved catalog at read time, case-insensitively. Removed
repositories do not leak through retained snapshots or publications; historical
rows are not deleted. Local stars further narrow this catalog, never expand it.
Generic agent resources keep their independent storage/CRUD contract.

Other read paths include:

- `/repos`, `/issues`, `/prs`, `/ci`, `/factory` for saved account observations.
- `/contributions?since=YYYY-MM-DD&until=YYYY-MM-DD` for the saved account-wide
  calendar, with inclusive dates inside its saved range (at most 90 days), strict
  query validation, observation provenance and authenticated ETag/304 support.
- `/repos/:owner/:name` and `/repos/:owner/:name/:resource` for saved repository
  pages (details, issues, PRs, Actions, releases, traffic, security, languages and
  contributors).
- `/factory/repos/:owner/:name/:stream` for immutable published factory streams.

All three PR surfaces (account, repository snapshot and factory PR stream) expose
`state:open|closed|merged|null`; missing legacy lifecycle evidence stays null
until refreshed, never inferred open. GraphQL uppercase states normalize to
lowercase and saved merge timestamps distinguish merged from closed PRs.
Lifecycle presentation does not alter legacy source-version inputs. Unchanged
saved PR rows, with or without cached content metadata, keep their 0.17.1 source
versions and `/sources` conditional ETag; do not hash the displayed lifecycle
fields to reconstruct these opaque identifiers.
They also expose
`mergeable:boolean|null`, `mergeStateStatus:string|null`, and
`checks:{state:SUCCESS|FAILURE|PENDING|ERROR|EXPECTED|null}`. Checks come from
GitHub's latest-head `statusCheckRollup`; absent/legacy values remain null,
never inferred success. These are saved observations, not live merge permission.
See [PR merge and checks state](api.md#pr-merge-and-checks-state).

Daily scheduled runs now refresh contributions through seven bounded resumable
pages (one calendar and six 15-day type batches). Calendar totals stay authoritative;
daily commits/issues/PRs/reviews/restricted/repository counts are nullable, with
explicit unavailable/mismatch markers rather than invented zeros. Calendar dates
retain GitHub attribution (`timezone:github`); type windows use UTC, neither is
promised to match Asia/Shanghai buckets. `observedAt` and `partial` describe the
frozen evidence, not the current GET time. Failed runs retain the prior good
calendar and its original version/window/time. See the
[complete contribution contract](api.md#get-contributions).

Factory stream `data.observation.window` supplies the repository's original
window; `data.ranges` is a one-window array with that value (or the saved publication
window for legacy data without an observation). It is not the internal pending
collection queue. Dependency streams normalize unknown `at`, `createdAt` and
`author` to null. Own root/workspace package identities move to separate
`manifests` metadata and are excluded from npm dependency declarations when saved
evidence identifies them. Existing rows are normalized at read time, with no new
workspace scan, required refresh or schema migration.

Dependency safe-parse limitations use `reason_code:dependency_parse_unsupported`.
New publications freeze this limited coverage even when stronger old evidence is
retained: `coverage.retained:true`, `status:limited`, safe reason/code and
`truncated:true`, while items/manifests, observed count, evidence version/window
and timestamps stay original. Browser/machine streams and metadata-only `/sources`
agree; GET never overlays mutable run/repository state. Their content hash composes
the old stored hash with the frozen semantic coverage, preserving null for absent
or mismatched metadata. Repeated identical limitations keep the hash; successful
accepted evidence clears the diagnostic. An empty limited baseline is never zero.
Full evidence versions can stay unchanged as coverage changes; consumers must
check current completeness and reconcile unfiltered source indexes, not only time
filters. Job/step multiline `if:` values support plain scalar continuations and
literal/folded blocks. Only block bodies may contain mapping-like text without
inspection. Plain headers and every continuation fail closed on unsupported
collection starts, mapping/sequence-like lines or continuations after comments
have ended the scalar; empty/comment-only headers still accept a first plain line.
These unsupported shapes yield limited coverage, never a successful zero.

Account `/factory` rate metadata is the latest dated saved GitHub rate observation
from publication/run checkpoints, including newer catalog or active runs. It
includes `observedAt` and becomes null when usable current evidence is absent or
its reset has expired. This account-wide metadata is independent of repository
publication versions; GET neither invents a newer observation time nor contacts
GitHub to refill it.

Observation responses include the saved data, its opaque `sourceVersion`, actual
`fetchedAt`, freshness and coverage metadata. Preserve full source versions and
original windows. Missing, stale, truncated, unavailable or limited evidence is not
a successful zero. Factory publication and GitHub observations are immutable via
this API. See [saved observations](api.md#saved-observations) for paths, filters,
field shapes and examples.

Repos/issues/PR freshness covers every selected catalog repository, including empty
and missing observations. Per-repository source times fall back to the baseline
that supplied retained data; baseline data must remain visible in `oldestAt`.
New catalog entries without proven baseline coverage or a saved observation count
as missing. Top-level `fetchedAt` is the newest selected observation, not proof of
uniform freshness. Source-index account entries use the same projection.
Factory freshness uses the same selected owned catalog denominator: starred-owned
for daily/starred scope, every owned entry for full/all scope, including archives
and forks. Catalog-only members and members without a valid immutable observation
time count as missing. Non-owned repositories never enter any refresh scope or
denominator. Machine `/factory` and `/sources`'s `account:factory` agree;
both report `truncated:true` when publication inventory is not complete. Machine
reads also retain any saved truncation flag when inventory is complete. Machine
repository list membership has no separate statistics layer. The account factory
content hash includes selected identities, freshness total/missing and
inventory truncation, so changing selected identities invalidates it even when
counts stay equal. Publication versions/windows and stored rows are unchanged;
inventory counters remain historical collection metadata.
Default/`scope=all` preserves the exact saved 90-day account contribution calendar,
status and provenance, independently of repository filtering. Only `scope=starred`
excludes it (`contribution:null`, `contributionExcluded:true`,
`contributionStatus:"unavailable"`, no `contributionObservation`), because the
account-wide calendar cannot be projected to a repository subset. GET is read-only.
CI freshness counts selected owned repositories, not input slots. Any missing or
unavailable Actions/releases/details timestamp makes that repository missing once;
oldest/latest timestamps still inspect all three saved dependencies.

CI verdicts use the known default branch only; missing branch metadata, PR/feature
branches, null refs and tag refs do not establish default-branch health.
PR-event runs are observational even if their source branch is named like the
default branch; a matching name alone cannot prove repository branch context.
Recovered latest completed successes are flaky/healthy rather than broken; workflows with
no runs for 14 days are idle. The clock is saved observation time, not GET time.
Other branch failures remain separate 30-day run counts. Workflow/repository totals
use explicit `*Workflows`/`*Repos` names, with `nonDefaultBranchFailures` measured in
runs; ambiguous legacy count names are removed. See the
[CI rules and fields](api.md#saved-ci-verdicts-and-units) before consuming totals.

Non-default branch streams require a run created within 30 days of the saved
evaluation clock (inclusive cutoff). Older branch-only streams are omitted in both
all and starred views, without deleting history; idle default-branch workflows and
grouped bot streams remain visible. No `branches` parameter is supported.

Workflow verdicts are `broken | flaky | healthy | idle`. Repository verdicts add
`unknown` for no default-workflow evidence (`none` before 0.15.14; breaking rename).
The independent release pipeline sentinel stays `none` for no release workflow.

## Generic records, reports and jobs

The three generic resource collections live under
`/api/v1/accounts/:account_id/agent/{records,reports,jobs}`. They support GET/POST
at a collection and GET/PATCH/DELETE by ID. Creation accepts an optional stable ID;
duplicate IDs return 409 `resource_exists`, not an upsert. Updates and deletes use
revision checks. Payloads are JSON objects capped at 64 KiB. Creating a job stores
application data only: **no endpoint executes local code or runs a job**.

Analysis reports use `type: "github-analysis"`, `status: "completed"`, and the
browser-owned schema in `apps/web/src/lib/analysis-contracts.ts`. Row repository and
`source_version` must agree with payload repository and `sourceVersion`. Reports
cover `issues|prs|ci|cd` and `repo|global` scopes. Model judgment probabilities and
producer metadata are optional; required evidence, source identities, verdict and
timestamps remain validated. A persisted report is not proof that its evidence is
complete or current.

External publishers derive stable report IDs as
`analysis-{repo|global}-{domain}-{first12}` from the deterministic full report
source-version digest. The digest includes the scope, canonical repository, domain
and sorted source identities/full versions. On duplicate or uncertain POST, GET the
resource and compare its full identity and version; never treat a matching 12-digit
prefix alone as proof of a match. See [publishing analysis](api.md#publishing-analysis)
for the complete schema and example.

The `/analysis` page reads reports and the account-wide record whose ID **and** type
are `grok-bot-run`. Its payload is `{ lastRunAt, status, analyzed, skipped, error? }`;
recommended statuses are `running|completed|failed`. Create the record once, then
update it using its current revision. The record is external producer status, not a
schedule, cursor or heartbeat. The page marks the last run overdue after 48 hours
under the default daily cadence. It evaluates report evidence age independently:
source evidence older than 36 hours is stale. Invalid or absent run records do not
imply a live runner. Legacy Work records/jobs remain stored but are not read by the
analysis page.

Report history is not traversed by the page. Its Access-protected, active-account
`GET /api/agent/accounts/:account/analysis/reports` projection selects N=3 rows per
exact `(payload.scope, row.repository, payload.domain)` for `type:github-analysis`
in the reports collection, across all statuses. It returns `{account_id, items}`
with no query parameters or cursor. Per-key order is
`(utcWholeSecond DESC, fractionDigits DESC, id DESC)`: exact time across offsets,
then binary ID descending for ties. The epoch strips fractional seconds before
conversion and manually subtracts signed offsets through +/-23:59. Fractions
remain arbitrary-precision digit strings, with trailing zeros trimmed and leading
zeros retained; no fraction/all zeros use empty text. Equivalent instants and
trailing-zero spellings tie. No `julianday`/millisecond rounding determines order.
The client uses the same exact instant/ID ordering and exact child-generation
chronology, without tightening the accepted ISO datetime schema. ISO-shape
(`????-??-??T*`), timezone/fraction and whole-second guards map missing,
nonmatching or SQLite-unparseable times to null/last, without making generic CRUD
reject relative date strings such as `now`; strict report validation stays in the
client. Edits/revisions
do not promote an old generation unless the payload's generation time changes.
Selected invalid/non-completed rows consume slots and still undergo client
validation; malformed keys are retained as separate groups, not silently dropped.
The UI chooses current-source, valid completed reports only among these three;
older historical or child reports outside that set are no longer candidates.

Every indexed/query JSON extraction guards the payload with `json_valid` first.
Generic JSON deeper than JSON1 can inspect remains legal for storage and CRUD;
its scope/domain/time index components are null, not a migration/write failure.
Selected rows retain original payloads for normal client validation.

The additive partial index `0015_analysis_reports.sql` supports one SQL read with
successor-key and top-three equality seeks; only selected row IDs hydrate payloads
and the final sort is bounded to those rows. K keys yield at most 3K rows, not a
fixed account-wide byte limit. Generic machine `/agent/reports` and generic
browser list semantics remain unchanged (ID-ascending cursor pagination over all
matching rows). History remains intact; there is no automatic deletion or total
5,000-report UI ceiling. The independent run-record traversal still has its
50-page/5,000-row ceiling. See [the precise read rule](api.md#analysis-report-projection-and-retention).

## Refresh management and storage boundary

Refresh history includes `counts:{total,success,failed,unavailable,limited,skipped}` even
when old step arrays are omitted. Expected feature/access unavailability is a
terminal `unavailable` step, separate from real failures. It does not make a run
partial and never means observed zero. Dependency steps also allow terminal
`limited` / `error:dependency_parse_unsupported`,
counted separately without causing partial. This exception is only safe manifest/
workflow parsing: capacity truncation, interrupted pagination/access loss and real
failures retain their failure behavior. Factory publications from that same run
use `complete` for `completed` and `partial` for `partial`; compare run IDs because
failed newer attempts preserve older publications. Historical rows are unchanged.
An explicit first-page denial is distinct from an incomplete paginated list.
Missing search `nodes` without a permission error, or a 403/404 after an accepted
page (including an empty one), fails the snapshot as `snapshot_incomplete` and
retains prior evidence/time; it is never counted as benign unavailable work.

Absolute run deadlines include paused/backoff time: catalog 30 minutes, quick
refresh 6 hours, deep refresh or missing legacy depth 12 hours. `deadlineAt` is
optional on old rows and derived from their start. Scheduler/mutating operations
expire active runs as `failed` / `error:run_timed_out`, revoke leases, release locks
and set schedule `lastError`; GET stays read-only. Each pending daily remains
queued by its schedule cursor until accepted or individually recorded as failed.
If it cannot start before its due day's next Beijing midnight, it receives
`error:scheduled_slot_missed` and a one-slot `missedSlots` audit. Old grouped
audits remain historical records. A due occurrence starts or records a reason
within five minutes under the healthy minute cron. Active work is never cancelled
for a daily; terminal completion immediately hands off same-day daily work,
bypassing only manual cooldowns. Exact-slot weekly ties precede daily, then catalog;
otherwise pending current-day daily work precedes unstarted weekly/catalog work.
Timeout/missed-slot `lastError` warnings persist until an explicit schedule save.

All exposed runs add `expectedFinishAt` and `expectedFinishAtReason`: start time
plus the median wall duration of the account's last five valid completed runs of
the actual catalog/quick/deep kind, across retained history. Read-time calibration
is not a deadline or guarantee. Null uses `no_completed_history`,
`invalid_started_at` or `not_executed`; a valid estimate has a null reason.
No GET backfill, upstream request or schema migration is introduced.

`app:read`/`app:write` can read settings and refresh runs, update stars/
schedules, or explicitly start and control the existing durable GitHub refresh
plan. Refresh management does not execute external analysis or local code. The
browser's account/token controls remain Access protected.

Statistics writes return 410 `deprecated` without changing storage. Settings returns
`statistics:[]` and `statistics_deprecated:true`; `/repos[].statistics_enabled` is a
deprecated alias of `starred`. The migration removes existing stars with explicit
false overrides, then empties but retains the override table. Bots must use stars
for daily membership and must not recreate a separate statistics preference.

`GET /stars` returns `{items:[{repo,starred,source,updated_at,reason}]}`, including
unstarred owner tombstones. PUT/DELETE accept an optional `{reason}` (at most
200 characters), return 200 with the star record, and always use `source:agent`.
Browser writes always use `source:owner`. Opposite-direction agent writes against
owner records return 409 `owner_override` without writes; same-direction writes
are 200 no-ops preserving owner provenance, timestamp and reason. `/repos` adds
nullable `star_source` and `star_updated_at`. Existing surviving stars migrate to
owner; cleanup removals create no tombstones. The settings `stars` list contains
only currently starred names. Bots must stop on owner conflicts, not retry them.

The existing `agent_resources` table stores generic resources, including analysis
reports and run status. Historical Work/resource rows and legacy AI tables remain
preserved; this change does not require destructive migrations. Do not add a bot
routine, model configuration or model credentials to the web application.
