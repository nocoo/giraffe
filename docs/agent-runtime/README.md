# Agent runtime explorer

Open [index.html](index.html) directly in a browser. This is an offline, standalone
HTML/CSS/JavaScript explainer, not part of the production SPA. No server, build,
external font, model connection, credential or API access is needed. Native
controls keep this documentation independent of the React/Basalt application.

## Interactions

- Select a graph node to inspect its responsibilities, capabilities and source.
- Switch dry-run, local-only and publication previews. No mode executes commands.
- Play, pause, step or reset the ten-stage illustrated workflow.
- Inspect the paired Worker/Reviewer return loop and bounded exact-SHA follow-up.
- Switch from the illustrative log to separately labeled historical run evidence.
- Expand startup notes; copy a command explicitly without executing it.
- Use keyboard focus, Enter/Space, and arrow keys in the activity tabs. The layout
  adapts to phones and honors reduced-motion preferences.

## Accuracy

Source snapshot: 2026-10-03, integrated runtime `2be0862` plus dependency-title
helper fix `e9ed54e`. Runtime sources are
`packages/agent/src/{cli,work-daemon,work-coordinator,work-priority,work-conversations,work-tools,work-workspace,work-review,work-followup,work-analysis,work-tasks}.ts`
and [the unified runtime contract](../14-repository-coordinator.md).
Dependency / exact `[CO]` / recurring CI/CD tasks are integrated and validated with
fake APIs/models, temporary SQLite and native Git fixtures. This is code/fixture
evidence, not real new-target PR/CI unattended acceptance or an active service.

The terminal illustration supplied as a visual reference is not the architecture
contract. Giraffe currently has an Astra orchestrator, Jev ranking/routing, four
parallel domain conversations and sequential per-repository workers. It does not
implement an on-call-only Astra architect, per-tool Jev forks, a six-thread worker
pool or automatic installation/startup of `work`.

Recorded repository counts, conversation IDs and model choices are historical
examples, not live telemetry or hard-coded production defaults. The two-repository
repair required operator-assisted recovery. A subsequent authorized push verified
Backy `3be12bb` and R2Shot `b145913`; this page makes no current CI/CD claim.

The separate `watch`, `repair` and `analyze` commands are removed. One `work` command owns the
schedule/controller/account lock, main workspaces and independent repository
reviewers. `--once` is one occurrence; normal invocation remains resident. The
integrated runtime handles typed dependency, PR and recurring CI/CD tasks. Chronic
failures are investigation, not proof of a flaky test cause. Historical
acceptance does not prove this new runtime. No service is automatically installed.
The live execution desk is `/work`; `/analysis` reads saved reports and unified
work-cron presence. Terminal progress delivery and published issue closure resume
from SQLite without repeating worker tools or push.

The graph follows saved Web refresh sources, Jev ranking (at most 25 repositories
per batch) and configured worker routing, shared main-workspace preparation, then
one persistent Worker and one distinct read-only Reviewer per repository. At most
20 persisted fix/check/review rounds include failed checks. Host publication uses
exact tested/reviewed HEAD, persists the push, then closes completed dependency
issues only. PR merge/closure remains report-only. Follow-up reads exact-SHA Actions
every 10 minutes, at most three times across restart; missing evidence is not green.
No automatic deployment, release, rollback, clones, branches or worktrees.
Existing dirt and ahead main commits remain protected.

Copy examples use `--once` to avoid an unexpectedly resident process. Normal
`work` remains resident on `work.cron` / `work.timezone` until stopped. Dry run uses
isolated memory under the same account lock, without workspace actions, online
reports or push. `--no-push` still makes real local commits and independent reviews.
All configured model execution stays local; Astra/Sol names are illustrative,
not product defaults. Opening this map never invokes the CLI or installs a service.

## Verify

From the repository root, using the existing Playwright dependency and installed
Chromium:

```sh
node --test docs/agent-runtime/test.mjs
```

The browser checks cover offline loading, node inspection, all three modes,
playback controls, Reviewer/return-loop/follow-up bounds, valid current source
links, evidence separation, keyboard interaction and responsive widths.
They never run a real agent or access GitHub, Giraffe, model providers or secrets.
