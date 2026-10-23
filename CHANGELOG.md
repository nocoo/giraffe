# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v0.23.0 - 2026-10-23

### Fixed

- Persist accepted factory steps and pages atomically before later work. A subsequent failure retains earlier results, request accounting and retry evidence; stale leases cannot publish. Renew 40-second deadline-capped leases at boundaries, release owned leases on uncaught failures, and redeliver lease collisions at expiry.
- Retry queue overload sends with bounded 0.5/1/2-second backoff and failed deliveries with 5/10/15-second delays. Structured invocation and dispatch logs expose cursor/cost/end-reason and operation-level failures without tokens, payloads or raw exception text.
- Resume slow snapshots page by page without refetching accepted responses. Preserve catalog identity lookups across yields and process large raw REST pages without retaining their unused fields together in memory.

### Changed

- Reconcile Issues with `since` and PRs with an updated-descending cutoff against complete, non-retained observations. Validate current state counts, restart full collection on mismatches, and refresh retained PR GraphQL state even for closed/merged PRs. Add optional event `updatedAt`; incremental coverage describes the reconciled stream, not just changed rows.
- Reuse one complete run-owned Actions history for stream metrics, detail snapshots and deployment history. Explicitly limited histories retain the old snapshot and may require the existing bounded filtered-window collection rather than claiming completeness.
- New quick runs use 30 UTC dates; deep runs keep 90 and existing runs retain their frozen windows. Flush request accounting with step checkpoints instead of per-request journal writes; factory D1 admission/hard caps are 600/800 under the paid-plan 1,000-query limit.

### Local Measurement And Limits

The deterministic warm 60-repository daily fixture executes the real runner,
SQLite and existing fake-GitHub response model; every measured run publishes
all 1,146 logical steps. Latencies are fixed from the supplied brief.

| Revision / stage | Invocations | Requests | Simulated minutes |
| --- | ---: | ---: | ---: |
| v0.22.1 baseline `12d4612` | 426 | 1,651 | 41.678 |
| P1 recovery `e8a8372` | 274 | 1,669 | 42.004 |
| v0.23 source candidate, serial repositories | 166 | 1,221 | 23.898 |

The fixture excludes D1/CPU/queue-delivery latency and production stalls; it is
not a production SLO prediction. The under-20-minute goal remains unmet. A 4–6
repository pool is not included pending clarification of the global one-in-flight
step crash-loss requirement versus one in-flight step per parallel repository.
No configuration, dependency, lockfile or schema migration changes are included;
no production operations were performed. This branch does not claim the complete
B14A brief is ready.

## v0.22.1 - 2026-10-23

### Fixed

- Factory stream envelopes and `/sources` now share coverage-aware freshness. Retained limited dependencies correctly report `freshness.missing:1` on both endpoints; complete retained evidence keeps its original age and reports zero only with a valid evidence timestamp. Current limited evidence also remains incomplete.
- Repository retention summaries read only SQL-projected identity/retained flags for selected current repositories, never full dependency/manifests payloads. Empty selections skip factory reads; large-evidence, split-page and identity regressions keep the response unchanged.

### Added

- Machine `/repos` items and `/factory` repository entries expose `retained:{any,streams}` derived solely from immutable published stream coverage. Catalog repositories without factory data return `retained:null`; published repositories without retention return `{any:false,streams:[]}`, which does not imply complete coverage.

### Consumer Notes

- Check both coverage and freshness age before treating retained evidence as current. Existing fields keep their shapes; no migration, publication rewrite, execution/batching, ETA, deployment or retention-policy change is included.
- The `/repos` retention summary is a read-time enrichment, not part of catalog source/content versions. Inspect it independently of catalog version changes, or follow factory/source publication changes.
- Document optional `/refresh-runs` `invocations` as successful lease claims including recovery. Legacy/zero-count runs omit it; missing is not measured zero. Compare batching with requests, executed work and measured wall duration for matching workloads, not invocation counts alone.

## v0.22.0 - 2026-10-23

### Added

- Additive `invocations` telemetry counts acquired execution leases, including crash recovery, so scheduled refresh cost can be measured without upstream reads.
- Migration `0025_factory_run_journal.sql` preserves fenced request/attempt/duration audits across batched execution and crash replay. Existing snapshots, publications and retention roots remain intact.

### Changed

- Refresh workers execute multiple steps and stream pages per lease, under 25-second new-work admission, 40-request and bounded D1 budgets. Long work renews ownership before requests; buffered writes still commit atomically. Rate-limit backoff, cancellation, publication readiness and source windows remain unchanged.
- Claim and attempt auditing no longer rewrite the whole run payload. Sparse step storage restores required API fields on read; the public run contract is unchanged apart from additive invocation telemetry. Downgrading to a v0.21 reader requires the documented pause/drain and tested offline payload expansion, not a code-only rollback.
- Local fixtures preserve a 1,146-step daily plan in 320 invocations and a 19-step selected plan in five. These fixture counts are not a production-duration guarantee; queue/deploy configuration and repository parallelism are unchanged.

## v0.21.1 - 2026-10-23

### Fixed

- Retain regressed factory evidence per stream instead of rejecting the entire repository version. Repeated dependency parse limits no longer freeze healthy commits, issues, pull requests, Actions, releases or alerts; current-run activity inputs remain intact.
- Preserve retained evidence's original run, observation/publication time, source window and content metadata. Missing retained payloads remain explicitly unavailable, and mixed publications expose repository state `partial` with `coverage_regression_retained`.
- Scale refresh completion estimates by planned work and remaining steps, using historical per-step calibration and observed execution overhead rather than reusing a whole-run duration for every plan size, including manual selected-scope runs.
- Clarify that `refresh-runs/latest?kind=quick|deep` filters depth across all triggers and scopes; a manual quick run can match `kind=quick`, while scheduled daily consumers must request `kind=daily`.

### Consumers

- After deployment, repositories with persistently parse-limited dependencies, such as `nocoo/lizheng.dev`, advance their healthy factory source rows on the next successful scheduled or manual refresh that includes them. Daily quick refresh uses the same fixed publication path; no manual production backfill is required.
- Retained streams stay flagged with `retained: true` and retain their original source version and freshness. A repository's newer observation does not make retained stream evidence current; consumers must inspect each stream's coverage and observation.

## v0.21.0 - 2026-10-23

### Added

- Read-time account activity subtotals over frozen repositories with complete per-metric evidence, plus `totals_partial` and `totals_coverage.missing` diagnostics. Existing publications benefit without new collection or storage rewrites; wholly unavailable metrics remain null and known empty membership remains zero.
- Latest refresh readiness includes canonical trigger/catalog `kind`, independent `depth`, and `publishedAtReason` for unpublished, in-progress, failed, cancelled or unprovable legacy runs. SQLite projects only required metadata, counts and failed-step summaries instead of returning the full run payload.
- Agent-state PUT accepts `If-Match: "0"` as an atomic create-only precondition, with HTTP 409 `revision_conflict` when state already exists or another create wins.

### Fixed

- Account list and CI content versions no longer become null because one saved legacy dependency lacks content metadata. Compositions use a stable full-version marker for that input while raw legacy and immutable-stream metadata stay unchanged.
- Every private machine response receives `Cache-Control: private, no-store`, authorization-aware `Vary` and `Referrer-Policy: no-referrer`, including authentication, validation, not-found, unexpected-error and conditional responses.
- Document and pin HTTP 409 `account_conflict` for competing running/paused refreshes, `422 snapshot_incomplete` diagnostics, and selected-scope refresh behavior without activity publication.

### Consumers / migration

- Additive fields preserve existing field types. Activity totals can now contain useful partial values: inspect `totals_partial` and `totals_coverage.missing`, not just numeric totals or the whole-run status. Response ETags and the `account:activity` content-version derivation change; publication IDs/timestamps remain frozen. Account compositions with legacy inputs now have deterministic hashes, sensitive to those inputs' full versions until ordinary refresh saves content metadata.
- Treat latest-run `kind` as `catalog|daily|weekly|manual`, not the quick/deep query selector; use `depth` for that distinction. Null `publishedAt` is explained by `publishedAtReason` and never proves success.
- Private response headers now also cover error paths. Keep conditional caches scoped to bearer identity. `If-Match: "0"` changes from a rejected header to create-only; handle a competing create as 409 and reload the current revision.
- No database migration, manual backfill, production write, dependency update or lockfile change is required. Version displays and `/api/live` derive from root `package.json`.

## v0.20.1 - 2026-10-23

### Fixed

- Preserve current-run activity when repeated dependency parse limitations retain an older repository observation. The freeze guard previously discarded every current stream solely because the accepted repository version was older. A successful repository commit in this run now also establishes current evidence, with matching repository identity when recorded; every stream must still carry this run's ID. Dependency evidence retention and stale-source rejection remain unchanged.
- Exclude terminal `limited` steps with `dependency_parse_unsupported` from activity run gaps. This diagnostic alone no longer makes `coverage.run` partial or the activity publication truncated; other failed, unavailable and limited steps retain their existing behavior. Dependency coverage remains independently limited.
- Capture the default branch in each successful current-run metadata step and use that evidence for activity collection and publication, independently of retained repository versions. Default-branch renames now classify CI and branch commits correctly. Missing, failed or identity-mismatched metadata yields unknown branch classification and unavailable default-branch coverage, never the retained branch. Red default-branch totals remain null without verified branch evidence, including empty or all-successful CI lists. In-flight runs whose metadata predates this field also keep other-branch counts null and coverage unavailable; supplemental collection discards unverified branch classifications and pending histories while preserving independent tag and deployment evidence.
- No schema migration is required. Historical activity publications are immutable and are not rewritten; the fixes apply to future publications.

## v0.20.0 - 2026-10-22

### Added

- R9: latest refresh readiness by kind, explicit publication timestamps and failure summaries. Site snapshots now remain staged until the fenced publication transaction; completed and partial runs expose readiness only after their published sources and activity are visible together.
- R5: persistent per-repository agent state with stable catalog identity, revision/If-Match concurrency, a 16 KiB JSON limit and read-only repository summary/status/review-time views. Renames, refreshes and removals preserve notes.
- R6: stable repository metadata with field provenance, strict machine updates and catalog-only creation-date filling. Repository details show creation time/category; agent values and catalog lifecycle history stay separate.
- R8: strict global `github-daily` reports, atomic same-date revision replacement, authenticated generic latest-by-generation reads with ETag/304, and latest-seven daily browsing with safe text/Xray links beside existing analysis domains. Invalid legacy daily content is hidden with a notice and remains preserved in generic storage.

### Changed

- Behavior change: agent star writes no longer return 409 `owner_override`. All star writes are last-write-wins, including same-direction writes; provenance remains informational in unchanged read fields. No star-data migration or rollback of the 0.19.1 provenance correction is included.
- `github-daily` now has a typed canonical/global/completed contract instead of an opaque generic payload. Noncanonical or invalid historical daily rows are preserved in generic reads but hidden from typed latest/history with a notice count; other generic report types remain unchanged.

### Migration

- Apply additive migration 0022 after 0.19.1's 0021. Historical runs receive a null readiness marker, including after resuming an active pre-upgrade run, because pre-0.20 site snapshots were published incrementally and complete atomic publication cannot be proven. No observations or runs are deleted.
- Apply additive 0023 and 0024 next for identity-keyed agent state and repository metadata. Existing GitHub observations remain unchanged; metadata initializes only on explicit writes or future catalog publication. Catalog first-seen/removal timestamps are reused rather than duplicated.

### Fixed

- Reject new capacity loss after publication metadata is included in final snapshot pages; a limited collection preserves the previous complete snapshot and its original timestamp.
- Prepare site publication from bounded per-page hash metadata instead of loading all staged payloads. New staged-site `sourceVersion` values use a documented publication-bound composite digest; consumers compare opaque versions rather than hashing response JSON. Canonical content hashes and historical/direct snapshot versions are unchanged.
- Apply latest-report privacy headers to validation, missing-resource and account/reader errors on both browser and machine paths without changing typed latest's `200`/null result.
- Remove stale owner-override policy and obsolete claims that repository agent-state/metadata write APIs do not exist.

## v0.19.1 - 2026-10-22

### Fixed

- B1: query each Beijing contribution date using one UTC calendar date; reject multiple, wrong-date or inconsistent native cells as partial with a null count instead of reporting a summed green square. Preserve native provenance and independently nullable composition.
- B2: publish finished partial activity runs, retain/discover/read them alongside completed publications, and chain windows only from actual published eligible runs. Mark repository step gaps partial, preserve null totals for missing evidence, and classify collector capacity limits as `counts.limited` rather than failed without masking mid-pagination access loss.
- B3: include valid positive-work partial runs in the last-five same-kind ETA median. Preserve failed/cancelled/zero-work exclusions and explicit null-with-reason when no eligible history exists.
- B4: apply private no-store, credential-specific Vary and no-referrer headers to activity errors (400/404/409), successful responses and 304s for both browser and machine readers.
- B5: add idempotent migration 0021 to correct only the 18 named untouched `nocoo` stars from owner to agent provenance, guarded by account, repository, starred state, null reason and the exact 0017 seed timestamp; preserve timestamps and every other field. The marked local backup changes exactly 18 rows and zero on replay.
- B6: pin existing catalog semantics without changing behavior: after first publication, a cursor before the 0019 initialization floor returns 410 immediately, even without eviction; preserve that floor and never synthesize removals for pre-history absences such as rsshub/wiki.

## v0.19.0 - 2026-10-22

### Added

- R4: persist immutable, bounded current-run activity for eligible account-wide quick/daily refreshes, with seamless successful-run boundaries, explicit first/gap windows, workflow metadata, PR/issue lifecycle, release/tag events, branch commits, current open items/security and deployment evidence. Nullable coverage never becomes a fabricated zero. Add read-only browser `/api/activity`, scoped machine `/activity`, ETag/304 and `account:activity` source discovery.
- R4: add the Basalt `/today` page and repository current-run panel, including gap/truncation, lifecycle/release/red-CI/deploy sections and Beijing-requested contribution totals/composition with honest GitHub-native calendar provenance. Keep `/` landing on `/factory`.
- R7: track catalog additions, confirmed deletions, archive/unarchive, visibility/fork changes and stable-ID renames. Add read-only `/catalog/changes`, four repository discovery timestamps and explicit `include=removed`, with bounded retention and authenticated ETag/304.

### Changed

- R7: confirm disappearance by stable ID, not name. Never auto-remove previously private repositories; public candidates require a previously known private-owned identity still visible in the complete listing and unambiguous identity-not-found evidence. Permission-hidden 404s and all uncertain lookups preserve state and report `unconfirmed[]`. Missing candidates above `max(3, 10% of owned repositories)` suppress all removals. Confirmed deletion atomically clears stars and mutable residue, while immutable evidence and generic agent resources survive. Default-star policy stays external.

### Fixed

- R7: include quarantined identities from earlier replacements in the mass-removal guard. Keep the denominator limited to current owned membership; above the exact threshold, preserve all current/quarantined state and report every candidate as `mass_removal_guard` without confirmation calls.

- R7: same-run different-ID name replacement no longer blocks discovery. The listed identity owns the name while unresolved old state is preserved by identity, without inheriting old stars or factory evidence. Stable-ID lookup detects renames without name-based deletion guesses.

- P3: enforce the 1,500,000-byte UTF-8 snapshot-page limit using the final truncation flag, including exact multibyte boundaries. Oversized non-list metadata uses a bounded, explicitly truncated compact form; metadata that cannot fit even that form fails instead of storing an oversized page. Keep the two-page limit.

### Migration and Compatibility

- Apply additive `0018_activity.sql` before code deployment; retain its immutable header/pages on rollback. No historical activity body is backfilled. Pre-migration successful run metadata can supply the next boundary. Activity bytes participate in account budgets and the latest two usable publications survive newer failed runs.
- GitHub管家 can poll `account:activity` and then `/activity?run=latest`; use saved window and coverage instead of reconstructing daily activity from the 90-day streams. Unknown runs return 404 and known unpublished runs return 409. Missing lists/counts remain null. Native contribution dates are not relabeled Beijing squares. Seven-day comparison against live `gh` remains a post-release operator acceptance task; automated proof uses isolated fixtures only.
- Apply additive `0019_catalog_history.sql`; existing saved catalog rows receive their saved fetch timestamps without fabricated change events. `/repos` excludes removed rows by default; request `include=removed` when needed. Poll the inclusive discovery cursor with event-ID deduplication; 409 means not initialized, and 410 means the 90-day/10,000-event history expired and requires catalog resynchronization. No R5/R6 agent-state/meta endpoints are introduced.
- Apply `0020_catalog_identity_safety.sql` before the repaired writer. Preserve current-name ownership, displaced mutable state and unconfirmed history on rollback; do not roll back to a writer that deletes on ambiguous 404s or ignores identity ownership. Discovery responses add required `unconfirmed[]`; the 90-day/10,000-event bound covers changes and unconfirmed observations together.

## v0.18.0 - 2026-10-22

### Performance

- Enable Smart Placement as the only deployment-configuration change. Placement needs time to learn real traffic; no immediate location or latency improvement is guaranteed.
- Batch account observations, repository tabs, factory streams, settings and run lists after authorization; preserve exact response bodies, ETags and private conditional-response headers against the pure functional baseline. Resolve contribution publication heads inside their saved-data query.
- Report honest CPU-phase timing, including production frozen-clock zeros, with safe numeric decoded row/byte, hash operation and serialized byte counters. Count overlapping hash intervals once rather than summing concurrent waits. Local high-resolution measurements and exact post-R1/R2/R3 cross-version comparisons keep timing evidence separate from response contracts.

### Changed

- Remove the proposed per-request SQL JSON trimming after independent review confirmed a CPU regression. Sources read stored payloads directly while retaining batching, honest timing/work counters and exact response bytes/ETags. No early 304 is added: existing stored hashes do not encode the complete projected representation or its validator.

- Preserve each scheduled daily until same-day admission or an individual failed audit. Terminal work hands off deferred daily runs without manual cooldowns; exact-slot weekly ties win without cancelling active work. Replace latest-only recovery and invisible preparation failures with durable per-occurrence outcomes.
- Add read-only `expectedFinishAt`/`expectedFinishAtReason` to every exposed run using the account's last five completed actual-kind wall durations, independently of the displayed history limit and absolute deadline.

### Root Causes

- Recheck completed catalog preparation and current membership before canonical admission: a completion between readiness and idempotency reads must not consume the daily key as a false failure.
- Separate selected factory membership from published observations. Publication-only client denominators hid missing repositories and reported healthy 7/7 coverage for a 7/14 selection; filters, freshness and health now share explicit selected membership.
- Historical scheduler revision `ac2d1e3` held later work behind the single active catalog and advanced the original daily cursor from recovery time, silently jumping over October 17/18. Page leases were renewable without an absolute lifetime. v0.15.14 bounded that lock but did not fix every missed-slot, failed-preparation or handoff path. The exact catalog stall mechanism is not provable without historical Queue/cursor/fence traces; healthy cron alone is not evidence of consumer progress.

### Changed Membership And Stars

- Protect browser star decisions with owner/agent provenance and durable owner-unstar tombstones. Agent conflicts return 409 `owner_override`; same-direction owner writes are preserved as 200 no-ops. Add GET `/stars`, optional write reasons and repository source markers. Star PUT/DELETE now return a 200 star record instead of settings/204.

- Consolidate daily refresh membership into local stars. Daily selects starred-owned repositories; full refresh and all-scope projections select every owned catalog repository, including archives/forks. Non-owned repositories never enter refresh plans or coverage/freshness denominators. Selected but unpublished repositories count as missing. Remove the hard-coded mirror exclusion and browser statistics toggles; archived repositories retain the full collection plan.
- Replace statistics writes with 410 `deprecated` and no writes. Settings returns `statistics:[]` with `statistics_deprecated:true`; the deprecated repository `statistics_enabled` field equals `starred`. Bots must replace statistics preferences with star management.
- Normalize CI freshness units from three input slots per repository to selected repository count. A repository is missing if any required Actions/releases/details timestamp is absent; oldest/latest times still inspect all three dependencies.

### Migration

- Apply additive `0017_star_provenance.sql` after membership cleanup. Surviving stars become owner records; cleaned-up stars remain absent. Keep unstar tombstones and new columns on rollback; old code that treats every row as starred is not a safe rollback target. Legacy timestamps use saved account metadata, not a claimed original star-event time.

- Apply `0016_star_membership.sql`: unstar exactly those account/repository pairs with an explicit false statistics override, then clear all override rows, including departed repositories. Explicit true overrides do not create stars. Keep the empty table for schema rollback, preserve observations/history, and create no owner tombstones for removed stars. The cleanup is deterministic and idempotent; schema docs include the affected-row query.

## v0.17.3 - 2026-10-22

### Docs

- Reduce the machine API skill from 848 to 317 lines, replacing duplicated field, factory, dependency-parsing and application-management details with verified links to the API reference. Add linkable headings around existing dependency contracts without moving their content.
- Describe the current API without version-history wording while retaining authentication/scopes, source discovery, full content-version skip checks, report publication, retries and the external bot loop.
- Identify the analysis report projection as browser-only and explain how machine clients reconstruct the newest three reports per exact scope/repository/domain from generic paginated reports, including all statuses and exact timestamp/ID ordering.

### Compatibility

- Documentation-only release: no API, runtime, test, migration, dependency, lockfile or production configuration changes. The authoritative package version supplies the application and health endpoint displays.

## v0.17.2 - 2026-10-22

### Fixed

- Track Dependabot and code-scanning availability independently. A shared unavailable flag previously allowed one denied feature to contradict the other feature's collected alerts. Save per-feature status and safe reasons, keep unavailable counts null, and retain older evidence separately instead of overwriting current counts. Expected-unavailable refresh steps remain unavailable, not failed. Read-time Insights and account projections use selected feature coverage, retain prior complete evidence with its original time, and never call missing or storage-truncated coverage an available zero. Validate combined current/retained page capacity before writing.
- Synchronize security feature completeness after final page-capacity truncation, not only in account projections. New pages persist partial coverage; repository browser/machine reads correct legacy truncated availability without changing stored evidence or versions.
- Request only `OPEN` GraphQL vulnerability alerts, matching the factory REST `state=open` contract. Neither path filters open alerts by the factory time window. The omitted GraphQL state filter was a proven query-contract gap; the reported production six-alert discrepancy is not conclusively attributable to it because the reads were 28 minutes apart and saved upstream responses are unavailable.
- Recognize explicit disabled code-scanning messages with a fixed safe reason code; preserve the existing explicit Dependabot-disabled classification without returning upstream bodies. The historical Dependabot `unknown` observation is not explained by the current classifier alone.
- Preserve PR lifecycle state discarded by the GraphQL mapper. Account, repository and factory PR projections expose lowercase `open`, `closed` or `merged`; legacy unknown state stays null rather than inventing an open PR.
- Keep lifecycle presentation out of legacy PR digest inputs, preserving 0.17.1 source versions and `/sources` ETags for unchanged rows with or without content metadata. Cross-version tests export the entire pinned baseline source tree instead of mixing the old reader with current dependencies.
- Batch the five source-index SELECTs into one D1 round trip after authorization, reducing `/sources` from six sequential trips to two without changing fields, ordering, versions or ETag semantics. Geographic D1 wait, not hashing CPU, best explains the steward's production wall/CPU evidence. Add safe `Server-Timing` phase and round-trip metrics to authenticated 200/304 responses.

### Policy Verification

- Preserve existing weekly/daily statistics selection. Tests confirm all 13 explicitly statistics-disabled repositories are excluded from factory metrics; repository-detail snapshots use an independent lane that still plans all nine pages, including for starred disabled repositories. Observed timestamps alone do not prove security-only execution. No eligibility, settings or catalog-failure behavior changes.

### Migration and Compatibility

- No migration, dependency, lockfile or production configuration change. Existing snapshots and immutable publication rows are not rewritten. Old security snapshots without feature metadata remain readable with unknown feature availability; only newly collected snapshots gain the explicit feature contract. Smart Placement, read replication and batching other routes remain follow-up decisions, not enabled settings.

### Breaking Changes

- Security summary: any unavailable feature previously meant top-level `unavailable:true` -> now true only when both features are unavailable. Consumers must inspect `features.dependabot` and `features.code_scanning`; each has `status:available|unavailable|partial`, `reason_code` and a fixed safe `reason`.
- Unavailable feature counts: misleading zero or overwritten prior counts -> null. Prior evidence is separate under `retained.<feature>` with its original timestamp and items; it is not current availability. Missing legacy feature metadata means unknown, not confirmed available zero.
- Explicit code-scanning disablement: `unknown` -> `code_scanning_disabled`; existing Dependabot `alerts_disabled` is unchanged. Open-alert collection: unspecified GraphQL states -> explicit `OPEN`.
- Newly collected PR state: missing/null -> lowercase lifecycle enum. Legacy snapshots without lifecycle evidence continue returning null; old persisted hashes are not rewritten.

## v0.17.1 - 2026-10-21

### Fixed

- Replace the analysis page's 5,000-row report traversal with a dedicated browser projection: newest three rows per exact `(payload.scope, row.repository, payload.domain)`, ordered by the actual `generatedAt` instant descending, then ID descending. Use indexed key seeks and hydrate only selected payloads in one read-only query, preserving generic machine list pagination and every historical row.
- Guard report index/query extraction with `json_valid` so schema-accepted JSON beyond SQLite JSON1's nesting depth preserves historical migration and generic POST/PATCH behavior. Uninspectable scope/domain/time components index as null without modifying or dropping payloads.
- Preserve arbitrary fractional-second generation ordering in report index seeks, top-three selection, client candidate ranking and child-report chronology. Sort normalized whole-second epoch, trailing-zero-trimmed fraction digits and binary ID descending; normalize the full accepted signed-offset range and strip fractions before date conversion to prevent `.9999` rounding carry. Equivalent instants remain ties; generic/reader schemas are unchanged.
- Derive factory freshness from enabled published repositories instead of the whole catalog, consistently across browser factory reads, machine `/factory` and `/sources`. Incomplete publication inventory sets machine `truncated:true`. This fixes the reported 126/1 total/missing caused by non-owned `chaconnewu/wuyu-nltk1`, the September 24 oldest time from archived/statistics-disabled `hermes-on-herdr`, and 47 legacy archived/fork entries dated September 29; these are reported production symptoms, not measurements from this local run.
- Parse job/step multiline workflow `if:` conditions, including plain continuations and literal/folded block scalars with chomping/indent indicators, without interpreting their bodies as dependency references. Validate plain headers and every continuation; flow collection starts, mapping/sequence-like lines and comment-ended continuations fail closed, while key-like block scalar content stays ignored. Echo-like release fixtures retain complete coverage and stable job-qualified IDs; other unsupported workflow shapes remain fail closed.
- Finish dependency safe-parse limits as terminal `limited`, with separate progress/history counts, instead of failing an otherwise completed run. Freeze `dependency_parse_unsupported` diagnostics into new publications while retaining stronger items, manifests and original evidence versions/windows/timestamps, including empty limited baselines. Browser/machine streams and metadata-only `/sources` expose the same retained limited coverage and null-preserving conservative content hash; subsequent successful publication clears the diagnostic. Capacity truncation, interrupted pagination and genuine failures still make runs partial.

### Migration and Compatibility

- Add `0015_analysis_reports.sql`, a repeatable partial expression index without a table rebuild or payload rewrite; apply it before deploying the reader and retain it on code rollback. UI candidate selection changes from all historical reports to the newest three rows per key across all statuses; current-source preference and strict validation apply only within that set. The separate `grok-bot-run` record-list ceiling remains unchanged. No new dependencies or automatic cleanup.

### Breaking Changes

- Account factory freshness: whole selected catalog -> enabled published repositories; absent/invalid observations within that set remain missing. Incomplete inventory previously could expose `truncated:false` -> now `true`. Machine list membership, publication versions and evidence windows do not change. Composite `contentVersion` adds enabled published identities and inventory truncation alongside corrected total/missing, so consumers must recompute affected account-factory reports.
- Dependency safe-parse outcome: step `failed` / `error:coverage_limited` -> `limited` / `error:dependency_parse_unsupported`; refresh counts add `limited`, and this outcome alone changes run/publication `partial` -> `completed`/`complete`. Retained evidence previously appeared complete -> now `coverage.status:limited`, `reason_code:dependency_parse_unsupported`, `retained:true` and `truncated:true`. Its full evidence version/time stays unchanged, but a non-null content hash now composes the retained hash with frozen coverage; null remains null. Historical publications/runs are not rewritten and no schema migration is required for these JSON fields.
- Ambiguous plain workflow conditions previously skipped as scalar content -> dependency `limited`, including flow collection headers, mapping/sequence-like continuations and lines after a comment-ended scalar. Literal/folded blocks keep ignoring key-like body text; valid plain conditions retain complete coverage.

### Docs

- Compare `/sources` across v0.16.1, v0.17.0 and batch 7 using the same 126-repository real-stream and all-null metadata fixtures. Record median/p95, query/payload/body evidence and isolated metadata lookup cost. No meaningful local latency regression matches the reported production timing; retain all eight source fields, including nullable `contentVersion`, and leave runtime code unchanged.

## v0.17.0 - 2026-10-21

### Added

- Add nullable `contentVersion` to saved observation envelopes and every source-index entry, preserving full versions, immutable windows, read-only behavior and the five-query source reader. Compute hashes at save time from size-bounded snapshots and raw factory streams with their original checkpoint window; account projections compose persisted dependency hashes. Canonical UTF-8 JSON uses recursively sorted keys and SHA-256, excluding only explicit collection/request metadata paths, including `source_fetched_at` and coverage request URLs while retaining `source_head`. `/sources` reads no factory stream payload bytes.
- Persist the exact existing full-version digest alongside content hashes so raw snapshots avoid repeat hashing; account projections keep their existing JSON-derived full versions. The content-only stream window substitution does not change saved payloads or full versions.
- Accept optional content hashes on strict analysis report sources. Direct reports remain current across refreshes with unchanged content and age from current source confirmation times; if either hash is absent/null, compare full versions. Preserve completeness checks, 36-hour evidence freshness and independent 48-hour bot overdue status.

### Migration and Compatibility

- Add migration `0014_source_content.sql`: nullable `content_meta` columns on snapshots and factory resources, plus covering metadata indexes; no table rebuild or old-payload backfill. Legacy sources return null until their next ordinary save, and composites remain null while an existing dependency has no hash. Producers omit null report-source hashes and use full-version fallback. Preserve the additive schema on rollback.
- Non-breaking: existing full versions and valid reports remain supported; no new dependencies, lockfile changes or automatic cleanup. Derived insights expose null content hashes. Composite hashes conservatively invalidate when saved dependencies or selection/quality metadata change, even if the projected output does not.

### Docs

- Clarify generic jobs do not execute analysis, recommend four account-sourced global reports for the default view, and document exact hashing, full-hash skip checks, ID-only prefixes and source identity mapping.
- Document the strict `grok-bot-run` payload and revisioned full-replacement workflow, validation of non-completed analysis rows and explicit report deletion. The historical 5,000-row report UI cap is removed in v0.17.1 by a newest-three-per-key projection; the run-record list retains its separate ceiling. Correct the distinction between generic server validation and strict reader validation: malformed selected rows raise errors but do not prevent valid cards from rendering.
- Extend the 126-repository source benchmark with real near-cap factory streams, payload-byte and metadata-index regressions; distinguish historical batch-3 measurements from the persisted-hash performance evidence.

## v0.16.1 - 2026-10-21

### Fixed

- Deduplicate account `/factory` dependency summaries per repository by exact `(path, name, version, url)` equality, preserving first-seen order and distinct refs. The browser aggregate and its dependency graph use the same read-time projection, without extra D1 reads or changes to writers, schema, saved rows, coverage or publication versions/windows.

### Compatibility

- Non-breaking: only identical duplicate summaries are removed. Aggregate `repos[].dependencies` retains `{name, version, path, url}` without an `id`; job-level `#job=` and legacy `#ref=` IDs remain exclusive to the per-repository dependencies stream.

## v0.16.0 - 2026-10-21

### Added

- Support 1-6 normalized refresh times for daily, weekly and catalog schedules, with Basalt add/remove controls, earliest-slot scheduling and exact missed-slot accounting. Preserve fixed UTC+08:00 and the readable/writable single `time` alias.
- Refresh the account contribution calendar on scheduled daily runs as well as weekly/full runs. Collect six nullable contribution types in bounded, resumable daily aggregate batches and retain prior good evidence after failures.
- Expose `GET /api/v1/accounts/:account/contributions` with inclusive saved date filters, strict validation, observation provenance, missing/partial-day semantics and authenticated ETag/304 responses. Preserve GitHub calendar date/count attribution; explicitly label UTC type windows rather than claiming Shanghai-equivalent buckets.
- Add consistent `mergeable`, `mergeStateStatus` and `checks.state` to account, repository and factory PR responses. Collect through existing GraphQL searches and bounded factory node batches; old/unavailable observations read as null.

### Fixed

- Stop terminally failed contribution checkpoints from being resumed by later repository streams or replacing prior calendars.
- Preserve separate REST/GraphQL rate reserves across PR pages, metadata transitions and failed-page rollback while keeping the public latest-rate observation unchanged.
- Explain legacy stream 409 responses with distinct missing-payload and version-mismatch messages. Matching pre-observation snapshots already support the publication-window fallback; preserve the immutable-source checks rather than fabricating missing evidence.
- Make workflow dependency IDs unique during collection/reuse and machine/browser reads. Capture real job keys with a bounded indentation scan, collapse identical legacy saved evidence and preserve distinct refs/content without rewriting historical rows or adding dependencies.
- Detect workflow jobs relative to the document's actual root indentation. Fail closed with limited coverage for missing or unsupported job structures instead of publishing a complete zero; retain stronger prior repository evidence and its original version/window.

### Migration and Compatibility

- Add migration `0013_refresh_schedule_times.sql`: an idempotent side table/backfill and legacy-column synchronization triggers, with no table rebuild or existing schedule changes. Local SQLite backup validation proves row preservation, rollback compatibility and integrity. Keep the table/triggers when rolling back code.
- Existing `time`-only writes map to `times:[time]`; `time` reads as the first sorted slot. Existing contribution totals and immutable publication identities remain intact. Additional times are not enabled automatically and require the owner's choice.

### Breaking Changes

- Workflow dependency identity: `<file>:<target>` -> `<file>:<target>#job=<encoded-job-key>` for newly collected references, including singletons, so job/ref ordering and source HEAD changes cannot rename a job reference. Example: `.github/workflows/ci.yml:nocoo/base-ci/.github/workflows/test-job.yml` -> the same base with `#job=api` and `#job=browser`. Legacy identical copies collapse to one unchanged ID; legacy distinct refs change from the colliding base ID to `#ref=<encoded-ref>`. Multiple refs within a known job append `&ref=<encoded-ref>`; distinct same-ref evidence additionally appends `&entry=<canonical-content-rank>`. Legacy ranks are stable for the same saved evidence set, not inferred job identities. Consumers must rebuild dependency-ID indexes when these normalized shapes first appear. Non-workflow IDs, source versions and publication windows are unchanged.

## v0.15.15 — 2026-10-21

### Fixed

- Populate machine factory stream `data.ranges` with the saved repository observation window, retaining the existing field rather than removing it. `data.observation.window` remains authoritative; legacy data without an observation uses its saved publication window, not the internal pending-range queue.
- Normalize saved dependency metadata and separate own root/workspace package identities into `manifests`, preserving known identities during collection reuse, restoration and dependency-graph projection without new workspace scanning or rewriting historical rows.
- Bound resource trimming when manifest metadata alone exceeds the byte budget: collection fails with `factory_capacity` and retains prior evidence instead of looping after all items are removed.
- Project the newest dated saved GitHub rate observation, including newer catalog/active checkpoints, with `observedAt`. Undated, invalid or expired evidence returns null instead of advertising an old reset as current; publication versions and repository windows remain immutable.
- Reuse decoded source snapshots and account projections within each request. The 126-repository benchmark reduces full reader queries from 14 to 5, payload reads from 16.76 MB to 8.78 MB, full median read time from 37.1 to 27.9 ms and empty-since time from 34.5 to 14.0 ms, with unchanged response hashes. These are local SQLite results, not production latency claims.

### Added

- Strong content-derived ETags and authenticated, bodyless `If-None-Match` 304 responses for machine `/sources`, preserving private/no-store, Authorization variance and no-referrer policy. Cloudflare handles response compression; no manual gzip or shared cache is introduced.
- Reproducible source profiling and query-count regressions in `tests/bench/sources.ts`, plus unit and real HTTP coverage for the aligned contracts. No schema migration or forced refresh is required; historical undated rate information stays null until normal collection supplies dated evidence.

### Breaking Changes

- Unknown query keys on every documented machine GET change from silently ignored to 400 `validation_failed`. Remove cache-busters and unsupported selectors; only account observation endpoints accept `scope`, while repository/stream endpoints accept no query parameters.
- Unknown dependency `at`, `createdAt` and `author` change from `""` to `null`. Own `package.json#name` entries move from dependency items to `manifests:[{name,version,path,url}]`; declarations referencing identified own packages are excluded. Config/workflow evidence with colliding names is retained. See the [API reference](docs/api.md) and [performance evidence](docs/12-source-performance.md).

## v0.15.14 - 2026-10-21

### Fixed

- Persist unavailable repository security snapshots with safe, shared reason codes for disabled alerts, denied permissions and missing resources instead of reporting every security refresh as incomplete.
- Count expected unavailable steps separately from failures in refresh history and the console; align factory publication status with the publishing run while retaining prior good evidence and original observation times.
- Bound catalog, quick and deep runs by absolute deadlines, revoke expired leases, release account locks and retain timeout diagnostics in schedule settings.
- Record missed schedule intervals durably and attempt only the latest due slot, without letting audit records delay recovery through collection cooldowns.
- Bound non-default CI branch streams to 30 days of saved activity, retaining idle default-branch workflows without using the GET wall clock or deleting history.
- Restore the exact saved 90-day account contribution calendar, status and provenance for default/all factory reads; only starred projections exclude the account-wide calendar.
- Keep malformed Issues/PR search responses and interrupted list pagination as real failures rather than unavailable outcomes; retain prior snapshots and publish partial status.

### Changed

- Document refresh outcome counts, security reason codes, timeout bounds and missed-slot records for machine API consumers. No D1 schema migration is required; existing historical rows remain unchanged.

### Breaking Change

- Rename `/ci` repository `repos[].verdict` from `none` to `unknown` to match `totals.unknownRepos`. Workflow verdicts remain `broken | flaky | healthy | idle`; the independent `release.pipeline: none` sentinel is unchanged.

## v0.15.13 — 2026-10-21

### Fixed

- Exclude repositories outside the current saved catalog from account observations, source indexes, factory aggregates and browser inboxes at read time, without deleting historical data.
- Include retained baseline observations and missing repositories in catalog-wide freshness, using consistent source times for all and starred selections.
- Classify recovered CI workflows as flaky or healthy and workflows without runs for 14 days as idle; default-branch evidence alone determines project health.

### Breaking Change

- Remove legacy ambiguous CI counters and replace them with explicit workflow/repository totals and separate non-default-branch failed-run counts. API consumers must migrate to the fields documented in [CI verdicts and units](docs/api.md#saved-ci-verdicts-and-units).

## v0.15.12 — 2026-10-20

### Changed

- Upgrade `@nocoo/basalt` from 3.1.0 to 3.2.0 across both workspaces and verify the updated page-heading typography in browser tests.
- Upgrade `lucide-react` from 1.58.0 to 1.59.0, `react-router` from 8.4.0 to 8.5.0, and `oxc-parser` from 0.154.0 to 0.155.0 (#72, #79, #78).
- Upgrade `wrangler` from 4.151.1 to 4.151.2 and `@cloudflare/workers-types` from 5.20261016.1 to 5.20261019.1, including the matching Wrangler runtime dependencies (#71, #80).

### Fixed

- Remove the redundant application-owned table row border so Basalt renders one separator between adjacent rows, with browser regression coverage.

## v0.15.11 — 2026-10-19

### Changed

- Document the CI check names, release and redeploy commands, and the production deploy target in `AGENTS.md`, and correct the pinned shared workflow commit.

## v0.15.10 — 2026-10-19

### Added

- Add a repository-owned Giraffe API skill covering saved refresh observations, scoped browser-issued tokens and rotation, revisioned analysis publication, bot run status, and explicitly authorized refresh management.
- Include curl examples, deterministic report identities, safe retry and reconciliation rules, and analysis reader limits verified against the current API and consumer contracts.

## v0.15.9 — 2026-10-19

### Removed

- Remove the bundled local agent runtime, Pi Durable dependencies, runtime commands and build targets, and the Work automatic code-change interface.
- Remove the CLI-only PKCE authorization and token exchange flow; every machine API request now requires a scoped bearer token.
- Remove obsolete runtime and Work documentation, including the legacy agent contract import.

### Changed

- Document Giraffe as an auto-refresh information center with externally published analysis, browser-managed tokens and rotation within 90 days.
- Preserve refresh collection, machine read and analysis-write APIs, the analysis layout, generic revisioned resources and all historical database tables and rows.

## v0.15.8 — 2026-10-19

### Changed

- Show external analysis last-run time, status and analyzed/skipped counts from the account-wide `grok-bot-run` record, with an overdue warning after 48 hours under the default daily cadence.
- Validate bot run payloads without confusing execution status with report evidence freshness; surface failed or malformed records and preserve the existing report layout.
- Stop loading Work heartbeats and jobs on the analysis page while retaining their stored history and the separate Work feature.

## v0.15.7 — 2026-10-19

### Added

- Expose the saved source index through the account-bound machine API with repository and incremental time filters, preserving observation coverage, immutable factory identities and read-only behavior.
- Document every machine API endpoint, token rotation, deterministic report publication, revisioned bot run records and the external analysis routine contract.

### Changed

- Move browser-consumed analysis and Work contracts into the web application; the remaining local runtime consumes those contracts instead of exporting them to the browser.
- Accept external analysis reports without local producer metadata or decision probabilities, while preserving required evidence, provenance and validation of supplied probability distributions.

### Fixed

- Keep incrementally merged global sources discoverable using their newest valid observation time, and match retained factory publications across repository capitalization changes.

## v0.15.6 — 2026-10-18

### Fixed

- Align sidebar disclosures, brand home link, version pill, search placement, collapsed rail and footer with the Basalt template while preserving all navigation destinations and the command palette.
- Preserve sidebar group state across navigation, forward internal link accessibility attributes, and restore mobile drawer focus and breakpoint cleanup.
- Reuse Basalt link buttons and theme switching, with template spacing and regression coverage for branding and navigation in both themes and viewport sizes.

## v0.15.5 — 2026-10-17

### Changed

- Upgrade `@nocoo/basalt` from 2.1.8 to 3.1.0 across the web client, adopting v3 spacing tokens, segmented `Meter` and bar-based `Sparkline` while keeping existing import paths and chart configuration helpers.

### Fixed

- Resolve the workspace lockfile so `@giraffe/web` installs Basalt 3.1.0 instead of a stale 2.1.8 copy that broke L3 visual assertions.

## v0.15.4 — 2026-10-17

### Changed

- Upgrade `happy-dom` from 20.14.5 to 21.0.3. Happy DOM v21 disables CSS and iframe document loading by default (SSRF mitigation); client L1 tests do not rely on external stylesheets or iframe navigation, so no Vitest setup changes were required.

## v0.15.3 — 2026-10-17

### Added

- Local environment gateway plugin, API routing by selected environment, header environment switch, and Vite wiring for local multi-environment development

### Changed

- Factory is the default dashboard landing view
- CI history and latest-run chart outlines use aligned colors
- Dependency updates: `@cloudflare/workers-types` 5.20261016.1, `@earendil-works/chord` / `pi-ai` / `pi-durable` 1.3.0, `@vitest/coverage-v8` and `vitest` 5.0.5, `lucide-react` 1.58.0, `wrangler` 4.151.1

## v0.15.0 — 2026-10-02

### Added

- Persistent local dependency-repair cron with timezone-aware schedules, missed-run coalescing, durable candidate cursors and restart recovery
- Dedicated Sol issue workers and one independent Astra reviewer with exact-code signoff and at most 20 repair/review rounds
- Isolated task-owned Git workspaces, baseline check/hook enforcement, Git metadata integrity seals, durable commit-intent recovery and no-force dedicated-branch publication
- Live repair workbench with cron/heartbeat status, review progress, safe diagnostics, exact commit proofs, bounded events and pause-only web controls

### Safety and Scope

- Repairs initially support explicitly profiled root npm/Bun manifests and dependency-upgrade issues only; all other work is deferred or blocked
- Installs, checks and hooks require a trusted isolated runner; no unsandboxed fallback, automatic merge, default-branch push or release
- Actual target-repository repair execution is not established by fixture tests: a working trusted Docker image/cache and per-repository grants are required
- Model calls, review rounds, diff size, output and web payloads are bounded; telemetry failures do not disable watchdogs or misclassify completed local work

## v0.14.0 — 2026-10-02

### Added

- Local `packages/agent` CLI with private user-level model configuration and browser-consent PKCE login through `@nocoo/base-cli`
- One Pi Durable Harness, one Astra planner, one shared Jev decision client, and persistent Sol specialists for repository/global Issues, PRs, CI and CD
- Authenticated read/write report, job and heartbeat publication with stable IDs, revision conflicts, restart recovery and bounded remote history
- Basalt analysis workbench with four domains, repository/portfolio scope, evidence versions and age, Jev distributions, runner presence and queued requests
- Browser API access to Agent resources under existing Access and same-origin checks

### Changed

- Read GitHub facts from the existing Giraffe collector instead of duplicating collection in the Agent
- Separate current source time, report-generation time and model judgments; stale or incomplete evidence remains unknown
- Bound each model run to eight responses and retain current workflow outcomes ahead of historical failure samples
- Include the Node Agent workspace in root typecheck, lint, build and coverage gates

### Removed

- Cloud AI model settings, provider execution, assessment endpoints and old report consumers; no compatibility fallback remains
- Unused cloud AI dependencies; legacy D1 tables remain intact and frozen collection skips only retired AI stages

### Verification Boundary

- Automated acceptance uses isolated SQLite/Worker/GitHub fixtures; the real model pipeline was exercised visibly using synthetic evidence
- Production browser consent and authenticated Agent publication require the owner to complete `giraffe login`; model success alone does not establish that production acceptance

## v0.13.0 — 2026-10-02

### Added

- Account-bound, scoped and expiring machine API tokens with hash-only storage, web management and immediate revocation
- Explicit browser consent and one-time S256 PKCE authorization for local CLI consumers
- Read-only `/api/v1` saved GitHub observations with source versions, timestamps, coverage and publication references
- Revisioned CRUD for Agent records, reports and jobs, plus explicit local settings and durable refresh management

### Changed

- Move the Worker and React/Basalt application into `apps/web` in a Bun monorepo; reserve `packages/agent` without implementing the Agent
- Keep root version, migrations, operational commands and existing production D1/queue bindings authoritative
- Retain existing cloud AI until the separately developed local replacement is verified

### Operations

- Add token, authorization-code and Agent resource tables through additive migrations; existing observations and immutable publications remain untouched
- Limit machine ingress to `giraffe.hexly.ai/api/v1/*` with Worker bearer checks; dashboard and authorization management remain Access protected

## v0.12.3 — 2026-10-02

### Changed

- Consolidate page, chart and AI source timestamps in one top-right data freshness control
- Show the most recent update as a relative age; expand to inspect precise local source times, older data and missing coverage
- Group collection times from the same finished refresh by its end without modifying stored provenance or statistics windows
- Clear registered sources on navigation and repository-scope changes; retain business event dates and execution diagnostics

### Operations

- Add an authenticated read-only refresh-time metadata endpoint with bounded account-scoped history
- No database migration, new binding or refresh scheduling change is required

## v0.12.2 — 2026-10-01

### Fixed

- Place repository scope, compact search/sort controls and page actions beside business-page titles instead of above them
- Share the subtitle line with primary-data timestamps, wrapping long ranges naturally on narrow screens
- Keep repository scope beside the title on mobile and wrap search/sort controls only when space is limited
- Move secondary Insights source timestamps into an accessible on-demand popover

### Operations

- Preserve filtering, data freshness semantics and saved snapshots; no database migration or new Cloudflare binding is required
- Verify compact headers across all eight business pages, desktop/mobile widths, dark themes and mixed timestamp ranges

## v0.12.1 — 2026-10-01

### Fixed

- Remove the 256 MB account storage quota from refresh creation, execution and AI assessment; storage measurements no longer block collection
- Preserve notification write-through results when background polling resumes after marking a thread read
- Keep bounded reference-safe retention running even if scheduling or queue dispatch fails
- Preserve per-record, per-resource, request and repository-count limits, lease fencing and prior-good-data protection

### Changed

- Remove obsolete write-delta accounting and quota-limit UI/API fields while retaining storage telemetry
- Resolve dependency update issues #2–#21: update React and types to 19.3.0, React Router to 8.4.0, Vite to 8.3.1, Vitest/coverage to 5.0.3, Playwright to 1.63.0 and Wrangler to 4.145.0
- Update Biome, Workers types, Bun types, the React Vite plugin, Happy DOM, Oxc, Hono and Lucide to the reported target versions
- Remove redundant Sharp and Undici overrides; resolved Undici 7.29.1 remains fixed for the reported advisories
- Raise the documented Node.js minimum to 22.22 for the upgraded router

### Operations

- No database migration, history deletion, retention-window change or new Cloudflare binding is required
- Automatic cleanup continues to protect current references, recent publications and the latest 20 runs

## v0.12.0 — 2026-10-01

### Added

- Default starred-repository views with a shared Starred / All scope filter across business pages
- Scope-aware data freshness, including checked empty repositories, mixed source times and missing coverage
- Daily starred refresh of repository data, notifications and explicit Insights derivation, with persisted catalogue preparation
- Optional daily catalogue schedules and clearer manual catalogue/quick/deep task selection

### Fixed

- Patch the transitive Undici dependency to 7.29.1 to clear the current vulnerability gate
- Reconcile current Issue/PR and mutable history pages instead of stopping at arbitrary stored IDs
- Preserve collection timestamps when notifications are marked read and bound bulk-read actions to their selected scope
- Apply repository scope before CI, Insights and factory aggregation; distinguish data time from publication and report time
- Re-read saved page data while visible without causing upstream collection
- Use consistent local-time display for source instants and explicit intervals for daily charts

### Operations

- Apply additive migration 0010 before the matching Worker; existing accounts, snapshots and immutable evidence remain intact
- Daily quick refresh remains starred; weekly deep refresh retains its configured scope for history calibration
- Quick collection retains safe unchanged-head reuse, while mutable source reconciliation may require more GitHub requests

## v0.11.2 — 2026-09-28

### Fixed

- Make Jev judgment optional, with a saved enable switch and one retry before continuing report generation without a judgment
- Bound Jev state, total request size, question count and four-choice answers
- Generate reports with structured output and source-specific status constraints, preserving evidence and coverage validation
- Give each report attempt a separate 60-second deadline and limit generation or repair to two calls without queue-layer retry multiplication
- Reduce report input size while retaining observation windows, cadence and explicit sampling limitations
- Persist safe failure-stage, HTTP and validation diagnostics without raw provider responses or credentials

### Operations

- Apply additive migrations 0008 and 0009 before deployment; existing keys, snapshots and reports remain intact
- Verify installed SDK wire compatibility and replay historical validation/timeout samples through the configured gateway

## v0.11.1 — 2026-09-27

### Fixed

- Restore wheel scrolling throughout the refresh center by letting the application content container own page scrolling
- Align automatic refresh labels, time inputs, selectors and save buttons
- Apply consistent content padding to the per-page refresh results card
- Make native time inputs follow the selected application theme, including manual overrides of the system theme

### Operations

- No new database migration or Cloudflare binding is required

## v0.11.0 — 2026-09-27

### Added

- Dedicated refresh center for manual runs, automatic schedules, progress and history, with quick/deep modes and manual/daily/weekly trigger labels
- Giraffe-local repository stars and configurable daily quick refresh for starred repositories plus weekly deep refresh
- Incremental pagination that starts with the first page and continues until stored records overlap, while processing state changes across each fetched page

### Changed

- Link the software factory refresh entry to the refresh center
- Reuse complete evidence only when its own source head and observation window permit it, and share collected snapshots across global lists and repository pages
- Merge successful selected-repository refreshes into existing global lists while preserving unrelated data and original full-scan timestamps

### Fixed

- Require each page's own source head before reusing language and contributor snapshots after a failed prior refresh
- Apply every local database migration during development startup so existing databases can load refresh settings and create runs

### Operations

- Apply additive, repeatable `0007_refresh_schedules.sql` before deploying the Worker; rollback retains both new tables and existing snapshots
- The first local star initializes daily 08:00 quick refresh for starred repositories and Sunday 04:00 deep refresh for all repositories, in Asia/Shanghai time; schedules remain configurable
- The existing minute cron dispatches automatic refreshes; no new Cloudflare binding is required

## v0.10.2 — 2026-09-26

### Changed

- Prioritize global lists within full-site refresh and report update results for each page in the refresh center
- Make Insights generation an explicit step in the same full-site refresh, after repository and Issue snapshots succeed
- Show optional security collection diagnostics only in the refresh center; other pages display available alerts or a neutral empty state

### Fixed

- Retain the previous Insights snapshot when required sources fail, while allowing generation after optional security or notification failures

### Operations

- No new database migration or Cloudflare binding is required
- Start a full-site refresh in the refresh center to update all page snapshots; existing runs retain their frozen plans

## v0.10.1 — 2026-09-24

### Added

- Rank the top repositories to watch on the Insights focus board using existing focus signals
- List every saved AI assessment across the participating repositories with confidence, status and timestamp, surfaced from a new read-only digest route

### Changed

- Remove the daily digest route, view model, server code and storage helpers; saved assessments remain accessible from the repository detail and the new cross-repository listing

### Fixed

- Keep catalogue and detail table rows compact and unwrapped on narrow viewports
- Mirror settled layout in loading skeletons so first paint of catalogue, alerts, CI, inbox, issues, pulls, repository and settings pages matches the rendered geometry
- Scope project link assertions to the exact header that owns them so other links on the same page cannot satisfy the check

## v0.10.0 — 2026-09-24

### Added

- Hexly single-project identities across repository cards/details, work queues, CI and factory views, with high-DPI Logos, English descriptions, project links and a one-hour success-only memory cache
- Two-stage repository assessments: the official TypeSafe Jev SDK classifies repository evidence, then next-ai generates a validated JSON report with security, PR, Issue, delivery and action sections
- Separate encrypted AI settings cards with connection tests, plus an AI assessment tab with confidence meters, probability distributions, evidence references and retained prior reports
- AI analysis checkpoints in refresh progress, including judgment/report stages, retries and explicit optional skips when providers are not configured

### Changed

- Focus assessments on the latest fourteen days and compare the preceding period; retain older unresolved work and use active Issues as the primary security evidence, supplemented by GitHub security bot alerts
- Unify candy colors, badge contrast, Lucide icons and assessment label alignment; compact refresh banners and show snapshot timestamps and elapsed time
- Treat unavailable optional security data as a limitation, preserving the distinction between missing evidence and an observed zero

### Fixed

- Restrict selected-repository refreshes to their own statistics and detail pages instead of expanding into full-site work
- Use Dependabot cursor pagination and bounded Jev inputs; preserve safe provider diagnostics and avoid retrying deterministic request failures
- Reject unsupported or contradictory all-clear reports, including incomplete Issue evidence and excerpted security descriptions
- Preserve daily chart tooltip records to prevent render crashes, stabilize first-load repository tab geometry, and remove duplicate focus indicators
- Align AI settings cards and make neutral badge contrast follow the application theme

### Operations

- Release applies additive, repeatable `0005_ai_settings.sql` and `0006_ai_reviews.sql` migrations before deploying the Worker; rollback retains both tables and existing snapshots
- Configure both AI services in Settings to enable assessments on future accepted repository refreshes; reads do not start generation or rewrite historical reports

## v0.9.0 — 2026-09-24

### Added
- `GET /api/ci` classifies saved CI runs into workflow and lane streams, folds numbered and Dependabot jobs, and judges each stream broken (consecutive or chronic failures), flaky, healthy or idle, with release cadence per repository
- CI and releases page: summarizes stream verdicts, lists broken workflows first with recent run strips, splits recovered failures into recurring and one-off, charts 30 days of outcomes and ranks releases by pipeline state and staleness

### Changed
- Sidebar navigation is grouped by purpose (overview, repository health, to-do, system) with the flat item list derived from the groups so order has one definition

### Fixed
- Run strips read oldest to newest with the newest cell enlarged and outlined, an old/latest axis on cards and per-cell timestamps; factory sparklines label their start and end dates

## v0.8.0 — 2026-09-23

### Added
- Per-repository "participates in statistics" toggle: forks and archived repositories default off, manual overrides persist in the new `repo_statistics` table and apply at read time to factory, insights, digest and all cross-repository lists
- Repos page lists the toggle as its first column with independent visibility/archive columns and a header-side data-updated stamp; the management list keeps disabled repositories available for re-enabling
- Weekly pulse and motion sections on the factory dashboard
- List-page aggregation view models for boards, insights and overview, shared by new overview cards, rank bars and repository charts across inbox, issues, pulls, alerts, digest, insights, repos and repository detail pages

### Changed
- Restructure the factory dashboard around change and stock with dedicated story and skeleton layouts
- Unify language and category chart colors through a stable multi-color palette in `chart-theme`, keeping known-language mappings consistent across sorting and filtering

### Fixed
- Skip the duplicate factory snapshot read when loading the factory console

### Operations
- Release applies the additive, repeatable `migrations/0004_repo_statistics.sql` before deploying the Worker; rolling back code keeps the table without touching snapshots or saved settings

## v0.7.0 — 2026-09-18

### Added
- Unified software-factory refresh updates site-wide lists, Insights, Digest and repository details through durable, resumable steps, including repositories outside the factory metric scope
- Large refresh dialog with phase and repository progress, actionable failure explanations, history and a compact page-level health/progress banner
- Repository timestamp dialogs with readable local/UTC times, observation windows and elapsed time updated every second

### Changed
- Other pages read saved snapshots without independent refresh buttons or automatic collection; missing data links to the factory refresh console
- Standardize Basalt/Recharts visualizations, green chart colors, typography, table spacing, compact help tooltips and equal-height cards
- Upgrade Basalt to 2.1.8 and Vitest/coverage to 5.0.1; add the Hexly project shortcut and accessible header tooltips

### Fixed
- Let long signal lists expand and fill their cards; remove blue chart-click outlines while retaining green keyboard focus and inset calendar selection outlines
- Preserve prior good page data on failed collection, resume aggregate chunks without duplicate records and keep cancelled/cooling repository progress accurate
- Treat missing GitHub repository or security-alert responses as unavailable data, not successful empty results

### Operations
- No new D1 migration or Cloudflare binding is required; existing account storage limits now also include ordinary snapshots and Digest baselines
- After upgrading, synchronize the repository list in the refresh console before starting the first full-site refresh; repository selection only limits factory metrics
- The legacy `POST /api/refresh` endpoint remains compatible, but the client no longer calls it

## v0.6.0 — 2026-09-16

### Added
- Persistent factory runs with frozen repository order, scope, window and logical step totals; durable progress and history survive browser reloads and Worker restarts
- Cloudflare Queue page execution with D1 fenced leases, retry/backoff, rate-limit deadlines, cron recovery, pause/resume/cancel and server-enforced account/repository cooldowns
- Reference-aware bounded retention and a 256 MB factory-data budget preserve current/mixed snapshot detail while limiting storage growth
- Dense refresh console with repository priorities, selected/filtered/stale/failed scopes, queue timelines, real request counts, coverage, timestamps and bounded polling
- Additive, repeatable D1 migration and a local production-export verification command; legacy resource recovery retains original event windows and timestamps

### Fixed
- Keep last-known-good snapshots visible throughout refresh; atomically commit repository versions and publish consistent global versions at run completion
- Preserve stronger prior coverage on partial failures; prevent stale workers, overlapping starts and retry requests from erasing data or bypassing cooldowns
- Keep renamed repositories distinct by stable GitHub identity, record mixed-version provenance and avoid reading large historical checkpoints during polling

### Operations
- Provision `giraffe-factory` Queue before deployment; Release applies `0001_factory_runs.sql`, `0002_factory_retention.sql`, and `0003_factory_budget.sql` before deploying the Worker
- Existing legacy factory rows remain untouched, enabling data recovery and Worker rollback without destructive down migrations
- `/api/factory/refresh` now accepts the explicit run-plan contract; legacy implicit restart requests are rejected

## v0.5.0 — 2026-09-16

### Added
- Software factory dashboard at `/factory`: overview, language/topic groups, repository drilldowns, and paginated commit, Issue, PR, Actions, Release, and dependency evidence
- Contribution/commit calendars, proportional repository treemap, throughput areas, WIP scatter, sparklines, observed dependency links, and accessible daily ledgers
- Resumable GitHub collection with complete owned-repository pagination, frozen 90-day windows and default-branch heads, explicit exclusions, source timestamps, and per-resource coverage
- Local `factory:audit` and isolated Worker/D1 `factory:preview` commands; survey methodology, real investigation results, and independent review records

### Changed
- Lazy-load page modules and share chart chunks to reduce the initial JavaScript bundle
- Use pinned shared quality and Worker deployment workflows with proven-source SHA verification

### Fixed
- Use Workers-supported manual redirects and explicitly reject 3xx responses before credentials can be forwarded
- Preserve GitHub pagination filters when Link headers use numeric repository URLs; split large Actions queries without time gaps
- Keep unavailable, incomplete, observed-zero, and truncated lower-bound measurements distinct; filter PR/Issue detail by the selected lifecycle date
- Prevent concurrent refreshes and mixed survey generations; preserve the previous snapshot when the first restarted request fails
- Isolate malformed dependency manifests and partial permission loss; avoid ambiguous package-name dependency edges
- Serve audit previews from built Worker assets with valid local account IDs

### Data scope
- No database migration is required; factory data uses the existing snapshots table and is collected on demand
- Dependency evidence covers root manifests and named workflow entrypoints; unavailable security data remains unknown
- Resource limits are explicit (5,000 records / 1.2 MB), and the current UTC day is incomplete

## v0.4.2

### Fixed
- Add `status: "ok"` and `Cache-Control: no-store` to `GET /api/live` health endpoint
- Probe the D1 binding and return HTTP 503 on database failure; keep the optional test marker separate from readiness

## v0.4.1

### Changed
- Upgrade `@nocoo/basalt` to 2.1.2
- Standardize bilingual project README

### Fixed
- Patch `hono` 4.13.7 and override `sharp` 0.35.4 so osv-scanner passes

## v0.4.0

### Added
- Candy-tone badges on catalog pages, using Basalt accent fills and white text
- Basalt Green locked as the default primary accent

### Changed
- Align the sidebar mark with family chrome at 24px

### Fixed
- Lighten loading skeletons to `SkeletonLine` on L2 cards
- Skip skeletons when a page finishes loading within 200ms

## v0.3.1

### Added
- AccentProvider brand green from the logo leaf
- Refined giraffe identity mark

### Changed
- Upgrade `@nocoo/basalt` to 2.1.0
- Pin client chrome to Basalt 2.1.0
- Move the daily wrangler sidecar to 37045 so 7046 stays the lizheng preview

### Fixed
- Keep the sidebar mark still while collapsing
- Use the five-color chart cycle for unlabeled and changes-requested series
- Restore success-badge contrast on the 30% green token
- Record giraffe 7045 / 37045 ports

## v0.3.0

### Added
- Insights board with sectioned KPIs and one chart per card
- Themed KPI cards and icons on repos, issues, PRs, alerts, inbox, digest, and repo detail
- Table chips, meters, and sortable headers
- Logo mark and leaf-green primary theme
- PageHeader well and SectionRule layout on catalog pages

### Changed
- Upgrade `@nocoo/basalt` to 2.0.2
- Drop the duplicate repo table from Insights

### Fixed
- Align page-header control heights
- Remove table-like header dividers from KPI and chart cards
- White-on-fill contrast for themed buttons
- Access empty states and settings card headers
- Skeleton blocks for non-text placeholders

## v0.2.0

### Added
- Basalt dashboard SPA with app shell, sidebar nav groups, and page chrome
- Catalog CSS tokens and color utilities on pages
- Vite HMR via `bun run dev` with `/api` proxy to wrangler
- Sidebar identity from lizheng.blog author profile
- Header GitHub icon linking to the public repo

### Changed
- Upgrade `@nocoo/basalt` to 2.0.0
- Pin client stack docs to Basalt 2.0.0
- Verify `/api/live` version after Worker deploy

### Fixed
- Inbox cache after mark-read writes
- Command palette stacking outside overlay
- Sidebar chrome and extra rail wrappers
- Hide `.dev.vars` from wrangler types check
- Name missing PAT scopes and map add-account field errors
- Apply local D1 schema on boot
- Add-account pending state and skip insights GET without sources
- Nest pages in LayerCard surfaces
- Toast, page skeleton, and single-row title/filter toolbar
