# Dependency repair workbench

`/repairs` is a read-only execution workbench with one limited control: request pause
or resume of the local scheduler. It cannot enable repairs, add a repository profile,
change local tool configuration, reveal model credentials or grant Git push permission.

## Stored contracts

The browser imports `@nocoo/giraffe-agent/repair-contracts`. It reads paginated jobs
with type `dependency-repair` and validates every `RepairProgress` against its stored
ID, account, repository and status. Invalid or impossible progress is reported explicitly.
The `repair-cron` record uses `CronStatus`; a heartbeat older than 45 seconds is offline.
The runner publishes every 10 seconds. The browser polls every five seconds only while
visible, backs off on failure and resumes on focus. Read failures retain the last record,
not an invented success. Event history is chronological and bounded to 80 entries.

Pause/resume writes only the revisioned `repair-control` record through the existing
Access-authenticated, same-origin browser resource API:

```json
{
  "id": "repair-control",
  "type": "repair-control",
  "status": "paused",
  "repository": null,
  "source_version": null,
  "payload": { "paused": true }
}
```

The desired pause state is shown separately from the runner's acknowledged state.
`status: enabled` means a pause request was removed, not that local execution or push
was authorized. Concurrent revisions fail visibly and require a fresh read.

## Execution status

The desk distinguishes discovery, planning, preparation, fixing, checking, reviewing,
exact-code signoff, pushing and pushed. Blocked prerequisites, cancellation and exhausted
iterations are terminal explanations, never a successful fix. Repair/review rounds are
bounded to 20. A signoff is labeled exact only when its HEAD, content fingerprint and
reviewed round match the current job and it contains a validation digest. Signoff alone
is not evidence of a remote push; only the `pushed` stage counts as pushed.

Details show the planned manifest/dependency/version and provenance, worker and reviewer
conversation IDs, current and reviewed commit identities, findings and bounded events.
All issue/tool/reviewer text renders as text, not HTML or executable instructions. Issue
links must match the GitHub repository and issue number. Branch links are restricted to
`giraffe/deps-*`. There are no merge, default-branch push, force-push or release controls.

## Driver prerequisites and acceptance

The host driver requires an explicitly configured repository profile, unchanged baseline
check scripts, activated executable hooks and available local Git and npm/Bun tools.
Package installation, checks, commits and push hooks execute directly on the local
machine. There is no operating-system isolation boundary. Use only repositories and
scripts the owner trusts; allowlisted model file tools do not restrict what repository
scripts or hooks can access. Missing tools or check profiles are actionable blocked states.

Workspace tests use only temporary repositories and fixture tools, never GitHub,
production worktrees, real credentials or model calls. Repairs use independent clones,
leaving the owner's original checkout untouched. Checks bind complete bounded content
fingerprints. Push requires exact reviewer and validation proofs, clean state and normal
Git hooks, with no force push or hook bypass. Credentials are not exposed through model
tools or dashboard payloads; direct local execution is not a security containment claim.
No live repair push is claimed by these fixture tests.

Browser acceptance covers desktop/mobile light/dark, offline heartbeat, paused scheduler,
missing local tools/profile, 20-round exhaustion, exact signoff and safe pause-only writes. Production
execution requires local owner grants and independent review; this document does not
authorize deployment or an actual repair push.
