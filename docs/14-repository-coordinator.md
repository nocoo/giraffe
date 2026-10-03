# 14 — Unified Work Runtime

`bun run agent work` owns one account lock, one durable runtime, one controller and
one five-field cron. It remains alive until stopped. `--once` requests one bounded
occurrence and reports failures nonzero. `--dry-run` uses isolated memory while
sharing the account lock; `--no-push` runs checked local atomic commits only.
Active live occurrences freeze mode, repository filter and limit across restart.

Local configuration has one schedule:

```json
{ "work": { "cron": "0 * * * *", "timezone": "Asia/Shanghai", "registry": "https://mirrors.tencent.com/npm/" } }
```

Providers/roles/service retain their existing configuration. Old watch/repairs
keys are rejected, not silently interpreted. No automatic service is installed.

Portfolio comes from saved Web automatic-refresh observations. No second full
GitHub collection occurs. Jev asks one candidate-priority question per repository
in batches of at most 25, then selects configured worker model/thinking level.
Four domain conversations save reports alongside controller planning.

All three Jev paths cap the serialized UTF-8 request body, including `model`, at
16 KiB. This is a byte budget, not an exact token guarantee. Priority batches are
greedily packed by bytes and repository count; domain questions split sequentially
when necessary. Descriptions are clipped by Unicode codepoint with explicit
markers; omitted limitations, count entries and evidence have numeric totals.
Repository, candidate and evidence identities remain intact. Worker routing sends
only repository flags and ordered authorized task IDs, kinds and clipped titles.
Original observations and ranked results retain full descriptions. All batches
are preflighted before the first provider call. An oversized single scope fails
with its lane, repository, byte count and limit for manual inspection/narrowing;
no candidates are silently dropped and the oversized payload is never retried.

Each selected repository uses its existing personal main checkout. Preserve ahead
commits and reviewed dirty paths. Workers cannot overwrite/commit pre-existing
dirty files, create branches/worktrees/clones, push or discard changes. Baseline
failures remain visible and may be repaired; final checks must pass normally.

One worker and one distinct independent read-only reviewer conversation per
repository form a maximum-20-round fix/check/review loop. Counter/findings/approved
HEAD persist before retries; failed tests consume a round. Review corrections can
commit any assigned completed task without duplicate completion counts. Review
diff includes every commit ahead of origin/main. Recovered approval rechecks HEAD
without a twenty-first fix. Exhaustion never permits push.

Host push requires passing tests and independent review plus essential scope and
preservation safety. It verifies/reconciles remote main SHA. Issue/PR disposition
closes only completed dependency issues after the pushed marker persists. PR
merge/closure is report-only. No automatic release, rollback
or direct deployment. A normal push may trigger the repository's existing CI/CD,
including its configured release/deployment workflows. For exact pushed SHA, bounded live gh Actions reads happen at ten
minute intervals, at most three checks across restart; missing/partial/cancelled/
skipped-only evidence is pending or timeout, never passed. A complete set of
successful workflow runs is passed; evidenced failures are failed.

Generic agent jobs/records carry bounded Work events, repository pair/round/check/
review/commit/publication trace and cron heartbeat. The `/work` route renders
typed repository summaries alongside a bounded event tail. Terminal publication follows queued trace writes; no new
streaming or cloud service is introduced. Historical rows and runtime files stay.

Task identity uses the sorted authorized task identity/version set, not model
priority order or cron timestamps. Unchanged terminal tasks retain their outcome
across occurrences; changed source evidence creates a new task. Local no-push
approval stays publishable with the same round counter in a later live occurrence.
Transport verification failures remain retryable, not permanent terminal blocks.
Published repositories resume issue closure and SHA follow-up without verifying
now-closed issues again. Terminal Web delivery retries reuse saved timestamps and
never rerun completed native work. Failed/timeout follow-up is attention, not green.

## Implementation Scope

The runtime discovers dependency requests (including labeled Choko arrow titles),
exact non-draft `[CO]` PRs and recurring failed main CI/CD runs from saved Web
repos/issues/PR/CI snapshots. Jev ranks all observed candidates, including ordinary
issues for context, but only discovered authorized tasks can execute. A `none`
choice suppresses execution. Model routing uses the existing separate question.
Tasks use `dependency:N`, `pr:N`, `ci:runId` throughout plans, tools and progress.

Workers and reviewers receive bounded live issue evidence, complete PR head/base
and patches, and failed-run jobs/steps. A fixed assigned-run read-only log tool
provides sanitized bounded diagnostics. Missing patches/jobs defer that task,
never unrelated work. PR cleanup applies justified equivalent edits on current
main; no merge/rebase/cherry-pick or remote PR disposition is inferred. Reviewed
no-change and deferred outcomes persist with reasons and are independently
reviewed without empty commits. Only committed or exact-latest satisfied
dependency tasks are closed after push; CI and PR repair may push with no closure.

Package writes require exact task-bound package tokens in verified issue text,
approved-mirror latest stable lookup and the original lock-resolved version.
Bun lock extraction uses Bun.JSONC.parse through a fixed host command, never eval
of lock content. Downgrades, prereleases, unrelated package changes and critical
major upgrades are rejected before writes. `work.criticalPackages` defaults to
react, react-dom, next, vue, @angular/core, hono, vite, vitest,
@vitest/coverage-v8, typescript, wrangler and undici; users may supply the list.
The MVP defers an excluded major with a reason while other tasks continue rather
than automatically choosing an older same-major release. Legitimate test/config
repairs remain available; checks/review must reject weakened coverage/assertions.

Post-push expectations use recorded main push and workflow_run workflow names.
Schedule-only, PR-only and tag-only runs are excluded. Historical snapshots
without event/branch identity are unknown, not passed; CI-only green
does not complete follow-up while expected CD is absent. Checks remain reporting,
not an additional pre-push acceptance gate. Payload compaction preserves task IDs
and outcome codes while explicitly omitting oversized reasons.
Potential flakiness is not proof of test cause. Important ecosystem/runtime/
framework majors require manual attention, not blind upgrades. No test deletion,
coverage reduction, hook bypass or credential/infrastructure repair is authorized.

Unit acceptance uses fake APIs/models, injected clocks and temporary local Git.
Native scripts execute as the trusted user; this is not isolation. Historical
Backy/R2Shot acceptance predates this unified runtime and proves neither unattended
recovery nor current CI/CD. Parent independently owns local L2/L3 acceptance.
