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
or deployment. For exact pushed SHA, bounded live gh Actions reads happen at ten
minute intervals, at most three checks across restart; missing/partial/cancelled/
skipped-only evidence is pending or timeout, never passed. A complete set of
successful workflow runs is passed; evidenced failures are failed.

Generic agent jobs/records carry bounded Work events, repository pair/round/check/
review/commit/publication trace and cron heartbeat. The existing `/repairs` route
is presented as Work. Terminal publication follows queued trace writes; no new
streaming or cloud service is introduced. Historical rows and runtime files stay.

## Implementation Scope

The unified foundation currently executes dependency-upgrade issues only. Exact
`[CO]` PR code repair with PR diff/head evidence and recurring CI/CD or flaky-test
task discovery/execution remain unimplemented. Jev cannot authorize arbitrary
issues. Worker model routing currently uses a second Jev question after portfolio
priority; combining advice/routing into one repository question remains pending.
Potential flakiness is not proof of test cause. Important ecosystem/runtime/
framework majors require manual attention, not blind upgrades. No test deletion,
coverage reduction, hook bypass or credential/infrastructure repair is authorized.

Unit acceptance uses fake APIs/models, injected clocks and temporary local Git.
Native scripts execute as the trusted user; this is not isolation. Historical
Backy/R2Shot acceptance predates this unified runtime and proves neither unattended
recovery nor current CI/CD. Parent independently owns local L2/L3 acceptance.
