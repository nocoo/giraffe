# Repository coordinator

The local `work` command implements a bounded controller-led repository workflow.
The runtime enforces phase transitions and tool capabilities; the controller decides
repository/issue order and whether existing uncommitted work is reasonable to retain.

1. Load the latest **saved** Giraffe catalog, issues and PRs. GET never refreshes GitHub.
2. Ask Jev one choice question per repository with every saved open issue/PR as a
   candidate, at most 25 repositories per request. Preserve all candidates and their
   returned relative preference. Missing candidates or answers are errors.
3. In parallel, four resident conversations analyze saved Issues/PR/CI/CD observations.
   Live mode publishes schema-validated reports with `account:*` source provenance;
   dry run prints results without online writes. Omitted/stale evidence cannot pass.
4. Inspect selected existing `~/workspace/personal/<name>` repositories read-only,
   including origin, main tracking, dirty diff, instructions and required checks.
   Ask the controller to order every issue exactly once and assess retained changes.
5. Ask Jev for each worker's configured model/thinking profile. One resident
   preparation conversation describes or executes safe main preparation, mirror
   installation, UT/lint/type checks and handoff.
6. A persistent per-repository worker receives the directory and ordered tasks.
   Dry run can only return a structured rehearsal. Live workers have bounded
   read/write/install/check/atomic-commit tools; no shell, push or issue-close tool.
7. The host controller validates live issue identity, baseline gates, committed
   HEAD and checks, pushes main normally, verifies the remote SHA and closes only
   completed issues. Unpushed commits are allowed; unrelated retained changes must
   remain unchanged. Never discard changes, bypass hooks or force push.

## Acceptance

Unit tests use fake models/APIs and temporary repositories. Real five-repository
dry-run acceptance must show all four domain analyses, controller scheduling, a
shared preparation conversation, five distinct worker conversations and zero
repository/GitHub mutations. This does not certify actual repairs or publication.

The command is one-shot, not an installed service. Conversation storage is separate
for work, work dry run, and existing analysis/repair. Native work must be re-inspected
after interruption; no implicit replay of commits or issue closure is promised.

`work --no-push` performs local execution and verifies the final commit/checks but
does not push or close issues. The worker's `latest` operation verifies current
stable package metadata against the configured approved mirror; stale issue target
versions are not assumed to be current. Metadata includes engine and peer constraints.
Inseparable peer upgrades share one checked atomic commit and all covered issue
numbers; remaining issues retain their priority order. Empty commits are not a
substitute for verified work.
Already-current issues use a read-only `satisfied` action: current registry metadata,
exact manifest/lock versions, unchanged workspace and passing checks are required.
This records existing HEAD evidence rather than creating an empty commit.

Preparation completion requires a `prepare` call in the current assignment, not
historical conversation evidence. A clean fast-forward establishes the new check
baseline before installation. Worker reads support bounded character windows and
literal matching, including large lockfiles. Native diagnostics retain redacted
failure tails. Bun installations remove temporary approved-mirror tarball URLs
without changing resolved versions or integrity hashes. Only official Biome schema
URL version changes are exempt from the otherwise immutable gate-content check.

## Real local acceptance — 2026-10-03

Two repositories were randomly selected without replacement from 25 eligible,
unoccupied npm/Bun main workspaces: `nocoo/backy` and `nocoo/r2shot`. No target
push, issue closure, release or deployment was authorized or performed.

- Backy worker 198 (Astra/high): commit `3be12bb`, Undici 7.29.1 to 8.11.2,
  Node >=22.19 and three dependency-policy regressions. 781 tests, lint, types,
  build and normal commit hooks passed. Coverage: 98.24/95.70/96.92/98.92 percent
  (statements/branches/functions/lines). A separate local Miniflare HTTP smoke
  passed with the installed Undici 8.11.2; full Backy L2/L3 was not run.
- R2Shot worker 341 (Sol/low): seven commits ending at `b145913`; eight package
  upgrades, with Vitest/coverage coupled. Vite 8.3.2, AWS SDK 3.1146.0 and Node
  types 26.6.4 supersede the issue targets. Existing jsdom 30.1.1 was verified
  without an empty commit. 160 unit tests, 9 integration tests, lint, types, build
  and hooks passed. Coverage: 99.76/99.13/100/99.75 percent. Chrome's first E2E
  attempt hit screenshot quota; the unchanged repeat passed all 11 scenarios.

The first real execution was not unattended success: preparation policy/memory,
oversized mirror diffs and schema guards caused stops. An operator inspected exact
interrupted diffs and pinned their hashes before continuing the same conversations
using a one-off local recovery harness. General automatic crash recovery remains
unimplemented; this evidence does not claim otherwise. The final worktrees are
clean with Backy ahead one commit and R2Shot ahead seven; all ten issues stay open.

## Boundaries

Only existing owned, non-fork, non-archived repositories with main, npm/Bun root
manifests, usable UT/lint scripts and executable commit/push hooks are eligible.
Dirty work may be retained but workers cannot overwrite or commit its paths.
Missing instructions, unsafe/oversized diffs and changing baseline gates block work.
Native repository scripts run with the user's filesystem/network permissions.
Model/API credentials are not injected into their environments.
