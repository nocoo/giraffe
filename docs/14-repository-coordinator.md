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

## Boundaries

Only existing owned, non-fork, non-archived repositories with main, npm/Bun root
manifests, usable UT/lint scripts and executable commit/push hooks are eligible.
Dirty work may be retained but workers cannot overwrite or commit its paths.
Missing instructions, unsafe/oversized diffs and changing baseline gates block work.
Native repository scripts run with the user's filesystem/network permissions.
Model/API credentials are not injected into their environments.
