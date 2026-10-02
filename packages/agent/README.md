# Giraffe Agent

Local Pi Durable runtime for the Giraffe GitHub console. Model credentials live only
in `~/.config/giraffe/config.json`; browser-authorized API credentials are stored in
`~/.config/giraffe/credentials.json`. Both are private user files, never repository inputs.

The model configuration has two providers and three roles: `orchestrator`, `decision`,
and `executor`. The decision provider uses `typesafe-systemone`; the other two use
one of the Pi AI chat protocols. The service defaults to `https://giraffe.hexly.ai`.

```sh
giraffe login
giraffe status
giraffe analyze nocoo/giraffe
giraffe analyze all --domain ci
giraffe watch --once
giraffe watch
```

Login opens an Access-protected authorization page. The browser sends a short-lived
code to a loopback listener; the CLI exchanges it with an S256 PKCE verifier. API
bearers never appear in callback URLs. Login does not overwrite model configuration.

## Analysis flow

One local SQLite Harness owns one Astra orchestrator conversation and persistent
Sol specialist conversations keyed by repository/global scope and domain. A single
Jev client judges the requested domains in one batch; its urgency distribution orders
the specialists without replacing hard evidence rules. Models submit typed reports
through tools, and unknown evidence IDs are rejected.
Each planning/specialist run is bounded to eight model responses; repeated invalid
tool calls terminate rather than consuming an unbounded model budget. Jev and model
requests also have finite timeouts. Long portfolio scans check pending web requests
between repositories rather than waiting for the next complete sweep.

Each job checkpoints planning, decisions, specialist output and publication. A process
exit preserves unfinished work. Restarting resumes the same model submissions and
reconciles deterministic remote report IDs. An independent SQLite transaction lock
prevents two local processes from owning the same account runtime and releases on
process death. Use one runner machine per account for this MVP; multi-host dispatch
and leases are not implemented.

Watch reads saved Giraffe observations only; it never starts GitHub collection. It
analyzes changed source versions, services dashboard requests (`analysis-request`
jobs), publishes `github-analysis` reports, and writes a heartbeat. Global reports
summarize all expected owned non-archived non-fork repositories, retaining explicit
missing/stale coverage rather than silently analyzing only the available subset.
The analysis scope is not write eligibility: analysis never mutates GitHub. Dependency repairs use the separate explicitly configured cron workflow below.

Reports distinguish `pass`, `attention`, `fail`, and `unknown`. Pass refers only to
the supplied observations, never merge or release authorization. Stale/incomplete
evidence cannot produce a pass. CD remains unknown without verified deployment
evidence. Source versions, timestamps, citations, omissions and Jev distributions
accompany every report. No model credential is sent to Giraffe.

Analysis conversations use only structured output tools, not local shell/file tools.
The original interactive coding-tool demo is separate from unattended analysis.
Failures preserve previous good reports; create an explicit dashboard request to
retry failed work. Source facts and operation state are separate.

Default source staleness is 36 hours; watch interval is 120 seconds, configurable
as `watch.intervalSeconds`. Models are not called when source versions and freshness
class are unchanged. After each completed sweep, remote retention keeps the latest
two valid reports per repository/global domain, the latest 20 terminal jobs, and
the latest terminal and failed job per repository/type. Pending/running jobs and
unrecognized resources are never pruned. Cleanup is capped at 100 records per
collection per sweep and uses revision checks. Local execution history remains on
disk; multi-account retention and multi-host scheduling are not part of this MVP.

Development: `bun run typecheck`, `bun run test:coverage`, `bun run build`. Tests use fake tokens
and loopback callbacks; never production GitHub or D1 resources.

## Dependency repair cron

`giraffe repair` is a persistent local process with a five-field cron schedule, IANA
timezone, a durable active occurrence and frozen candidate cursor. A restart retries
that occurrence; missed schedules coalesce into one run before advancing. It reads
Giraffe open-issue snapshots, then revalidates selected issues and owner/default SHA
with GitHub. Closed or changed candidates terminate independently, not the whole cycle.

Configure the existing private `config.json` with a `repairs` object:

```json
{
  "enabled": true,
  "cron": "0 * * * *",
  "timezone": "Asia/Shanghai",
  "maxRounds": 20,
  "push": false,
  "profiles": {},
  "registry": "https://mirrors.tencent.com/npm/"
}
```

An empty profile map permits discovery and blocked-state reporting, not modifications.
Each trusted repository profile specifies `manager` (`npm` or `bun`), baseline npm
script names in `checks`, exact editable `files`, and an activated `hooksPath`.
The first implementation supports root `package.json` plus its lockfile. It rejects
model access to credential paths, symlink writes, oversized diffs and changes outside
the profile. Ordinary tracked templates, symlinks and attributes do not disqualify a
repository. Model file allowlists are not a boundary for repository scripts.

Git, npm/Bun, the configured checks and normal Git hooks execute directly on the local
macOS/Linux machine as the current user, from a dedicated repair clone. There is no OS isolation
or Docker prerequisite. Use only trusted repositories and scripts: they can access
the user's home directory, credentials and network just like manually run commands.
Install uses `npm install --no-audit --no-fund` or `bun install`, with lifecycle scripts
enabled so normal setup such as Husky can run. The registry is passed per command,
not written to global package-manager configuration. Activate the configured hooks;
Husky 9 profiles use `.husky/_` and keep tracked `.husky/pre-commit` and
`.husky/pre-push` unchanged. GitHub reads and publication use the local `gh` login.
Timeouts, cancellation and excess output terminate the owned process group. A cleanup
permission failure blocks the job for operator intervention without racing file/index
recovery against a potentially active child. This is not hostile-process containment.

One Astra reviewer conversation is separate from the controller and all dedicated Sol
workers. Each worker phase is bounded to 12 model responses and three minutes. At most
20 fix/check/review rounds are allowed; exhaustion cannot push. Signoff requires zero
findings and the exact HEAD, complete diff fingerprint and deterministic check digest.
Only dedicated `giraffe/deps-*` branches can be pushed. No merge, default-branch push,
force push, issue close or release occurs. Local `push: true` is a separate owner grant.

`/repairs` receives revisioned stage events and ten-second cron heartbeats. It polls
while visible every five seconds and distinguishes desired pause from acknowledged
pause. Pausing stops new work and is rechecked immediately before push. Config changes
can retry missing-profile blocks without resetting the existing job's round count;
other environment failures require intervention. Model/API credentials are not passed
to workers, reviewers, child environments or web payloads. This does not prevent native
repository code from reading files accessible to the current user.

```sh
bun run agent repair --once
bun run agent repair
```

Keep this command running (or supervise it through a separately configured process
manager). The CLI does not silently install a LaunchAgent or change system ACLs.
The same account's analysis and repair CLI cannot own its Harness concurrently.
