# Landed activity observations (v0.24 design)

Status: design proposal, not implemented. The decision below requires approval
before replacing the requested no-loss guarantee with a narrower contract.

## Required decision

The brief's absolute no-skipped-commit requirement and exact landing-window
attribution cannot be established from periodic head samples. Two GitHub
histories can produce identical responses: one has no changes between samples;
the other briefly pushes a commit and then force-pushes it away. No local
algorithm can distinguish them. A head sampled after the frozen cutoff also
cannot establish whether a commit landed before or after that cutoff.

Choose either an explicitly observation-scoped contract (the proposal below),
including growing compact SHA identities under the existing storage capacity,
or authorize a durable push-event source and its configuration/storage design.
No migration or attribution implementation is applied until this is resolved.

## Semantics and limits

Default-branch activity is an observation ledger, not a committer-date query.
Each account/repository-ID/SHA is published at most once by the new collector.
The first complete sample of a default-branch head establishes its reachable
history; subsequent samples compare the previous observed head with the current
run's frozen metadata head. Commit dates remain source metadata, never admission
filters. A commit authored yesterday but first visible in today's sample belongs
to today's activity publication. `observed_at` records first observation; it is
not a fabricated GitHub push timestamp.

A polling API cannot discover a commit introduced and made unreachable between
samples. Neither a compare endpoint nor a commit timestamp can establish when
such a commit landed. The guarantee covers commits reachable from sampled heads
and pages already accepted locally. An absolute guarantee covering unobserved,
subsequently unreachable commits requires a durable upstream push-event source;
that is outside this branch's no-configuration-change authorization.

The activity window remains the run's frozen reporting window. Metadata is
sampled during execution, not retrospectively at `window.until`; therefore
observation attribution is explicitly distinct from exact push-time attribution.
Rolling factory commit statistics retain their documented committer-date window;
they are not the source of default-branch activity counts.

## Collection and publication

1. Pin the default branch and head from successful current-run metadata. Do not
   follow a moving branch during pagination. An unchanged head requires no commit
   request but still drains previously accepted, unpublished evidence.
2. Paginate `compare/previous...current` without date filters. A divergent compare
   enumerates new reachable commits, including rewritten commits with old dates.
   When the previous object is unavailable, walk the pinned current history.
   Distinct SHAs are distinct commits; an already published SHA reintroduced by a
   force push is not counted again. A removed SHA does not retract old evidence.
3. Persist each accepted page under the run lease, with its next cursor and an
   idempotent insert into a durable SHA ledger. Pending compact commit payloads
   survive cancellation, missing publications, gaps and repository removal.
   Advance the observed head only after its complete history/difference has been
   durably accepted. Failed pages never become successful zero counts.
4. Freeze pending records into the existing immutable activity publication. In
   the same fenced transaction, mark only SHAs actually present in the final
   packed publication as published and discard their pending payloads. Capacity
   omissions stay pending for a subsequent publication; coverage is partial,
   never a complete zero. Retries cannot insert or publish the same SHA twice.

With no prior observation, reachable history is bootstrap evidence, not proof
that every old commit was just pushed. The first window explicitly identifies
this bootstrap. Upgrade reconciliation must not reinterpret previous activity
publications as new landings. Repository rename/re-add retains the same GitHub
node-ID ledger; deletion/recreation with a new node ID starts a separate history.
Account deletion removes both heads and ledger rows. Cross-account counts remain
independent. A gap has no date cutoff: pending and newly reachable commits remain
eligible even if their committer dates precede the reporting window.

## Storage, migration and cost

Existing run journals are retained for a bounded period and cannot provide
permanent deduplication after old SHAs are reintroduced. An additive migration
after `0025` is therefore required for compact head and SHA records; no existing
table, row or resource is rewritten. Old Workers ignore the new tables. Pending
payloads participate in account storage accounting; published rows retain only
the identity required for exact deduplication. This identity set grows with
unique observed commits: exact indefinite deduplication is not bounded storage.
The existing account capacity must fail closed rather than evict identities.

There is no migration-time GitHub backfill. Initial reconciliation is resumable
and costs O(reachable commits / 100) API pages and O(unique SHAs) storage. Warm
unchanged heads cost zero commit pages; changed heads cost the paginated compare.
An unreachable baseline requires a full traversal. No production backfill or
refresh is triggered from a development machine.

Downgrade leaves the additive tables intact. A v0.23 Worker cannot maintain this
ledger and still uses commit-date activity semantics; do not claim the new
guarantee for windows produced during downgrade. Reconcile retained publications
before resuming new attribution after mixed-version operation. Existing in-flight
v0.23 checkpoints must remain readable and accepted pages must not be discarded.
