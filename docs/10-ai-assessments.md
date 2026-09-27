# Repository AI assessments

Two independently configured services can run after a refreshed repository version is accepted:

1. Optional TypeSafe Jev uses the official `@typesafe-ai/sdk` TypeScript client for priority judgments.
2. `@nocoo/next-ai/server` supplies the OpenAI or Anthropic model for a structured repository report.

Settings are deployment-wide, like GitHub accounts. The settings page has separate model/key cards, draft connection tests and a clear-key action. Only the summary configuration is required. Jev has an enable switch that retains its encrypted key; disabled or missing Jev configuration skips judgment. Rejected or transient judgment failures receive one retry after 15 seconds; an exhausted judgment continues to the report with no fabricated judgment. Authentication and local size failures skip judgment immediately. A connection test uses a minimal synthetic prompt, does not save the draft, and may consume provider credits. Saved credentials use the existing versioned AES-GCM encryption keys and never appear in public responses. Changing the destination, protocol or authentication requires re-entering the key.

## Input and judgment template

Each job binds to the accepted immutable repository version and its original observation window. Source data consists of repository metadata, delivery metrics and daily activity, and stored commits, issues, PRs, CI runs, releases, dependency declarations and optional Dependabot alerts. Issue/PR bodies and advisory summaries are bounded excerpts. Text reaching the collector title/body limits is conservatively marked excerpted, and that marker survives Jev projection and prevents unsupported all-clear conclusions in either stage. No extra GitHub calls occur during assessment or GET requests. Diffs, review threads, runtime exposure and exploitability are not collected; reports must not infer them as facts.

The primary assessment window is the last 14 days ending at the immutable source window end, never the time the model runs. `focus.recent` and `focus.previous` contain adjacent windows and activity counts computed from all stored source records before sampling, clamped to available source history. The original `metrics` and daily series remain longer-term context; they must not be relabeled as two-week totals. Comparisons require adequate coverage and account for shortened windows.

Each stream supplies up to 24 relevant records: recent creation/closure/merge/activity, all observed open Issues/PRs/alerts regardless of age, and current dependency declarations. Open work is prioritized, then latest activity. Older resolved records are excluded from the recent sample, with separate `excluded` counts; `omitted` counts describe unsampled in-scope records and still prevent an all-clear. Original coverage accompanies the sample. Evidence IDs are namespaced by stream. Active Issues are the primary security evidence, including older unresolved incidents; GitHub security bot alerts provide supplemental evidence. Missing or disabled alerts are a limitation, not a repository error or a successful zero. They never erase risks reported in Issues. A healthy security conclusion requires complete Issue and alert coverage; neither an empty bot feed nor unavailable Issues establishes safety. Both prompts treat repository content as untrusted data, never instructions.

Jev receives a separate projection capped at 24,000 UTF-8 bytes, leaving room below its documented 32k-token state-plus-longest-question limit and 64k-token total request limit. Daily cadence uses a labeled matrix without dropping days or counts; individual cycle-time arrays and author aggregates are excluded from both model projections. Event URLs are omitted, titles and bodies are shortened with explicit excerpt markers, and the largest event stream loses its lowest-priority trailing records until the state fits. Omitted counts increase accordingly. Questions and evidence references are built from the retained records, and shortened or omitted evidence makes the affected judgment uncertain. The summary receives its own projection capped at 48,000 UTF-8 bytes with 800-character body excerpts. It preserves immutable windows, cadence and omission markers. The complete Jev state-plus-question request is capped at 48,000 bytes. These are application byte budgets, not tokenizer measurements; provider context rejection remains an explicit error.

Template version 2 retains eight fixed, independent questions and records its exact `focusWindow`. Previously stored v1 judgments retain their original version and must not be presented as assessments made under the two-week policy:

| ID | Decision |
| --- | --- |
| `security_urgency` | Active Issue security cases needing mitigation, supplemented by bot alerts |
| `external_pr_review` | External PRs needing maintainer judgment |
| `unusual_pr_risk` | Unusual architectural, authentication or supply-chain changes |
| `blocking_issues` | Incidents and time-critical user-facing failures |
| `delivery_cadence` | Intervention warranted by observed delivery cadence |
| `review_backlog` | Stalled PR review flow |
| `delivery_reliability` | CI/release reliability concerns |
| `issue_flow` | Accumulating unresolved user needs |

Up to eight item-specific questions are interleaved across Issues, PRs and alerts in that order, for at most 16 total. Each answer selects `urgent`, `review`, `routine` or `unknown`. The application validates the choice, probability distribution and confidence, retaining them independently of the report. Low confidence, incomplete coverage and omissions mark the judgment uncertain. Confidence describes the model distribution, not factual certainty.

## Report contract

The authoritative contract is `repositoryReportSchema` in `src/lib/ai-review.ts`. It requires `schemaVersion: 1`, summary, overall status, security/PR/issue sections, delivery status/trend, prioritized actions and limitations. All objects reject additional keys; enums, string lengths, array bounds and evidence references are validated server-side. Urgent findings and immediate actions require references. Security findings marked attention or urgent require relevant Issue, alert or PR references; delivery counts alone are not security evidence. Incomplete coverage cannot produce an all-clear. An overall healthy result also requires all four domain sections to be healthy and no immediate actions, preventing contradictory risk labels. The installed AI SDK sends the JSON Schema using structured output. The prompt also includes computed per-domain all-clear permissions and limitation requirements; the request schema excludes healthy from domains without complete evidence, and requests short sections and at most five actions/limitations. Server validation still enforces evidence references and semantic constraints. One repair attempt receives safe validation categories and schema field paths; truncated output is rejected even if it parses. Invalid output never replaces the last valid report.

The formatted repository detail tab renders plain text, aligned icon/status labels, confidence meters, four-choice probability distributions, actions, limitations and expandable judgments. Standard question IDs receive Chinese display titles while preserving the original question in the details. Confidence is distribution concentration rather than factual correctness; manual-review hints remain textual as well as visual. Source and report versions/timestamps come from the application, not the model. Repository content is not rendered as HTML or executed as instructions.

## Cross-repository projection

`GET /api/insights/assessments` reads existing `ai_reviews` rows for the active account and returns one bounded summary per participating repository: stage, whether the report still matches the published repository version, overall and per-section statuses, delivery trend, at most three `now`/`next` action titles, at most eight `urgent`/`review` Jev judgments and the safe failure code. Superseded reports stay visible but are marked stale. Malformed stored JSON becomes `null` instead of a conclusion. The endpoint makes no provider or GitHub calls and writes nothing.

## Execution and persistence

`0005_ai_settings.sql` adds encrypted settings. `0006_ai_reviews.sql` adds one bounded assessment row per account/repository. Existing data remains untouched. The canonical initial schema and local migration runner include these migrations. Migrations 0008 and 0009 add optional provider settings and bounded failure diagnostics without rewriting existing rows.

The existing fenced repository commit also creates an assessment job, only when new data is accepted and the summary provider is configured. Coverage regression, failed collection and legacy restoration do not create jobs. Queue messages use `{reviewId}`; each delivery executes one stage. A three-minute lease and random token fence all results. Jev requests have a 40-second deadline and at most two attempts. Each summary request has an independent 60-second deadline, with at most two calls total for transient failures or validation repair; the queue layer does not repeat this budget. SDK retries are disabled. Provider latency, queue backlog and outages can still prevent completion; these limits bound model work, not end-to-end scheduling time. Safe specific error codes survive persistence and drive refresh/report guidance; raw provider errors never enter stored records or public responses. The private ai_review_attempts table retains at most four stage/attempt failure slots per current assessment, including source version, safe validation reason, HTTP status, elapsed time and token counts when available. Diagnostic storage is included in the account budget; rows follow assessment/account deletion. Successful reports do not erase the optional judgment failure diagnostics.

Accepted GitHub data does not depend on AI success. New refresh plans include one AI checkpoint per statistics repository, after page collection and before final publication. The checkpoint observes the existing job for exactly that run/source version and makes no provider calls; the background job can already be running while pages are collected. Refresh completion waits until assessment succeeds, fails or is skipped. Five-second checkpoint polling respects longer persisted AI retry deadlines. Missing configuration is an explicit optional skip, not a partial refresh or a warning. AI failures remain separate from collection failures and do not rewrite repository state. Failed queue dispatch is recovered by the minute scheduled outbox scan. A new source replaces pending work and preserves the last valid report; obsolete workers cannot publish. Report and input payloads are bounded, counted within the existing account storage budget, and removed with their account. No unbounded report history is accumulated.

Endpoints require the existing Access identity and write Origin guard:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/ai/settings` | Public configuration and key-presence flags |
| POST | `/api/ai/settings/:kind` | Save configuration; judgment accepts boolean `enabled` without deleting its key |
| POST | `/api/ai/settings/:kind/test` | Test submitted draft or retained key |
| DELETE | `/api/ai/settings/:kind` | Clear one configuration/key |
| GET | `/api/repos/:owner/:name/assessment` | Active-account report and stage; read-only |
| GET | `/api/insights/assessments` | Compact saved report/Jev projections for participating repositories; read-only, 409 without a repository catalog |

Local preview uses `https://giraffe.dev.hexly.ai`. Automated verification uses fake credentials and mocked SDK/provider responses. Real service authentication and model quality require the owner's saved keys and are not claimed by those tests. Rollback stops assessment dispatch and restores the prior application revision; retain the additive tables for subsequent recovery.
