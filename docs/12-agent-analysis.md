# Local Agent analysis desk

The `/analysis` workbench reads saved local Agent reports. It never invokes a model
or GitHub during GET. Select the portfolio or one repository and one of Issues, PRs,
CI and CD. Model verdicts are advisory, not merge authorization or deployment proof.
A missing deployment observation must remain `unknown`, not a forced green result.

## Contracts and browser boundary

The web app imports only `@nocoo/giraffe-agent/contracts`, a browser-safe schema export.
`/api/agent/accounts/:account/{records,reports,jobs}` mirrors generic resource CRUD
under Cloudflare Access and same-origin write checks. The requested account must be
the dashboard's current account; no browser bearer secret is needed. Payload validation
is explicit, with invalid reports/work-cron records shown as errors rather than old-report fallback.
Analysis is part of the single local `work` occurrence. The browser no longer
queues independent analysis requests. Historical reports/jobs remain stored.

`GET /api/agent/accounts/:account/sources` reads saved per-repository source versions,
timestamps and coverage. Optional `repository` narrows the result. No request refreshes
GitHub, touches the token activity timestamp or modifies immutable publications.
The browser loads resource lists in bounded cursor pages and rejects repeated cursors
or account changes rather than silently displaying a partial list as complete.

## Freshness and trust

The primary data time is source evidence age, never report generation time. Repository
sources compare `sources[].version` with the current saved resource version. Portfolio
sources refer to the corresponding latest repository report for the same domain, then
inherit its current raw-source status. Freshness is recomputed from the current browser
clock: evidence older than 36 hours or more than one minute in the future is not fresh.
Missing/truncated/unavailable coverage is not a successful zero. Jev probabilities show
priority distribution and confidence separately from pass/fail status.

Reports and upstream content render as plain text. Evidence links allow HTTPS only,
without URL credentials, and use noopener/noreferrer. No report text is an instruction
to run commands. Models are read from report metadata; runner presence uses the unified
work-cron record, never browser model credentials. Heartbeats older than 45 seconds are offline. Polling
runs only while visible, retries with backoff, and resumes on focus/visibility change.

## Cloud AI retirement

Existing AI settings, provider calls, report-generation routes and consumers are removed;
no compatibility endpoint or silent cloud-report fallback remains. Legacy D1 tables and
rows are retained for an additive rollout. Old persisted AI steps are explicitly retired
without invoking a provider; non-AI collection progress, leases and published evidence
remain intact. Insights and CI keep deterministic saved facts independent of Agent reports.
The repository detail links to its scoped Agent workbench instead of loading cloud reports.

## Acceptance scope

UI acceptance uses bounded local fixtures: repository/portfolio, four domains, missing or
invalid data, evidence freshness, queued work and offline runners in desktop/mobile and
light/dark themes. Real three-tier model execution was demonstrated by the coordinator
against synthetic input. Production authenticated Agent publishing remains pending user
browser consent; no current production report is claimed before that acceptance.

The local CLI requires Node >=22.22. Use `giraffe login` / `giraffe work` through
its Node launcher, or the root `bun run agent -- ...` script which explicitly
invokes Node. Do not run Agent source directly with Bun: its durable SQLite runtime
uses Node's `node:sqlite` semantics. The web bundle imports contracts only.

The local analysis implementation targets v0.14.0 after the v0.13.0 API foundation.
Release claims require matching CI and deployment evidence. Browser-consent and
authenticated production analysis remain separate acceptance checks.

## Retention and execution limits

Work publishes bounded progress and finite-turn conversation results on its one
schedule. The existing bounded remote retention keeps recent reports/terminal jobs
and the latest report and failure for each scope. Historical rows are not bulk
deleted or migrated by engine cleanup. The old analysis request queue and planner
are removed. Local transcript history remains user data.
One SQLite transaction lock enforces one account process; no multi-machine lease
or automatic service installation is claimed. Fix/review rounds are capped at 20.
