# Landed activity observations (v0.24)

Status: approved snapshot-based ledger, owner decision 2026-10-24. Migration
`0026_activity_commit_ledger.sql` is additive and has no backfill.

## Attribution contract

Default-branch activity uses first observation, not committer date or an inferred
push timestamp. Each account / stable GitHub repository ID / SHA identity is
admitted once. Its original reporting window, observation time and run identity
never change. A commit dated in window N but first observed in snapshot N+1 is
attributed only to N+1. Rolling factory statistics and other-branch activity keep
their existing date-based semantics.

A snapshot begins when reconciliation pins the successful current-run metadata
head and branch. Pagination always uses this immutable SHA. The reporting window
is the run's frozen window, not a claim that GitHub was sampled retrospectively at
its cutoff. Commits pushed and force-pushed away **between two snapshots are
invisible**. Already observed commits remain counted after removal; reintroducing
the same SHA never counts it again. Distinct rewritten SHAs are distinct commits.

## Bounded collection

`activity_commit_heads` retains the last completely reconciled head and an active
checkpoint (pinned head, branch, original window/run/time, mode and cursor). The
first reconciliation walks pinned history, without date filters. Later snapshots
paginate the old-head / new-head comparison. An unavailable comparison or a
divergent history falls back to walking the pinned new head. An unchanged head
requires no upstream commit request. Every accepted page and its next checkpoint
are committed atomically under the existing run lease; an expired lease accepts
neither. Only complete reconciliation advances the baseline.

The ledger retains a compact `reconciliation` marker on each identity so a SHA
repeated across accepted pages cannot inflate completeness. The marker may change
on later snapshots; original observation metadata never does. History follows
validated same-resource next links even on short pages; comparison totals count
unique accepted rows, not repeated page deliveries.

Each step accepts at most one upstream page (100 commits), then yields to the
existing four-lane pool. Shared request (40), statement (600 soft / 800 hard), wall
(25 seconds) and lease budgets remain authoritative; there is no unbounded
catch-up loop inside one step. A successful slow response renews ownership before
processing and checkpointing, without another pre-request budget check.

An interrupted reconciliation survives run cancellation and retention. The next
activity run finishes that pinned snapshot with its **original** attribution,
then reconciles its own current head. Renames and remove/re-add preserve the
stable repository-ID ledger; a new repository ID starts a separate history.
Gaps do not introduce a committer-date cutoff. First catch-up is explicitly marked
bootstrap: old reachable history is observed evidence, not newly pushed work.
No historical activity publication is rewritten or used as migration backfill.

## Publication and delayed evidence

`activity_commit_ledger` stores permanent identities and compact pending payloads.
Publication reads a bounded pending selection per repository. Current-window
items contribute to `commits.default`; delayed items are grouped separately in
`commits.deferred` by their **original** observation run/window. They never inflate
the later window's count. Each default commit includes `observation` metadata
(`runId`, `window`, `at`, `bootstrap`). `at` on the commit remains committer date.

Only identities actually present in the final packed immutable publication are
marked published in the same fenced transaction. Packed-out items, omitted
repositories and cancelled runs leave payloads pending; coverage is partial,
never a successful zero. Subsequent publications can expose delayed evidence
without changing old publications. Counts for an observation window may therefore
be delivered across several publications, always explicitly grouped by that
window and never repeated. A GET is still read-only and never drains the ledger.

## Capacity, cost and rollback

The two new tables reference accounts only, not retained run rows. Account
deletion cascades; pruning never evicts deduplication identities or checkpoints.
All ledger/head UTF-8 bytes participate in account accounting. Reconciliation
fails closed before exceeding 100,000 identities or 64 MB ledger/head storage per
account, or the existing 512 MB account budget. At capacity it retains the cursor,
pending evidence and previous good publication; no partial page is accepted and
no identity is evicted. These explicit limits bound permanent storage growth.

First catch-up costs approximately sum(ceil(reachable commits / 100)) GitHub
requests across repositories and O(unique SHA) stored identities. For 60 repos
with 1,000 commits each this is about 600 history requests / 60,000 identities;
10,000 each exceeds the account identity ceiling and fails closed rather than
silently truncating. Warm daily operation needs zero commit requests for unchanged
heads, and approximately one comparison page per changed repo with <=100 new
commits. Initial catch-up and warm daily benchmark results must be reported
separately; simulated upstream timings do not prove production latency.

Migration creates empty tables/indexes only; it does not scan GitHub or rewrite
existing data and is safe while a 0.23.x run is in flight. Rolling the Worker back
to **0.23.1** leaves these tables unused and harmless: no down-migration is needed.
The old Worker resumes its old date-based activity semantics; that downgrade
interval is not covered by the new ledger guarantee. Re-upgrading resumes retained
checkpoints and identities, reconciles currently reachable history, and cannot
recover commits made unreachable while downgraded. Ledger attribution remains
separate from old-version publications.
