# Repository AI assessments

Two independently configured services run after a refreshed repository version is accepted:

1. TypeSafe Jev uses the official `@typesafe-ai/sdk` TypeScript client for priority judgments.
2. `@nocoo/next-ai/server` supplies the OpenAI or Anthropic model for a structured repository report.

Settings are deployment-wide, like GitHub accounts. The settings page has separate model/key cards, draft connection tests and a clear-key action. Both configurations must be saved before future refreshes create assessments. A connection test uses a minimal synthetic prompt, does not save the draft, and may consume provider credits. Saved credentials use the existing versioned AES-GCM encryption keys and never appear in public responses. Changing the destination, protocol or authentication requires re-entering the key.

## Input and judgment template

Each job binds to the accepted immutable repository version and its original observation window. Source data consists of repository metadata, delivery metrics and daily activity, and stored commits, issues, PRs, CI runs, releases, dependency declarations and optional Dependabot alerts. Issue/PR bodies and advisory summaries are bounded excerpts. Text reaching the collector title/body limits is conservatively marked excerpted, and that marker survives Jev projection and prevents unsupported all-clear conclusions in either stage. No extra GitHub calls occur during assessment or GET requests. Diffs, review threads, runtime exposure and exploitability are not collected; reports must not infer them as facts.

The primary assessment window is the last 14 days ending at the immutable source window end, never the time the model runs. `focus.recent` and `focus.previous` contain adjacent windows and activity counts computed from all stored source records before sampling, clamped to available source history. The original `metrics` and daily series remain longer-term context; they must not be relabeled as two-week totals. Comparisons require adequate coverage and account for shortened windows.

Each stream supplies up to 24 relevant records: recent creation/closure/merge/activity, all observed open Issues/PRs/alerts regardless of age, and current dependency declarations. Open work is prioritized, then latest activity. Older resolved records are excluded from the recent sample, with separate `excluded` counts; `omitted` counts describe unsampled in-scope records and still prevent an all-clear. Original coverage accompanies the sample. Evidence IDs are namespaced by stream. Active Issues are the primary security evidence, including older unresolved incidents; GitHub security bot alerts provide supplemental evidence. Missing or disabled alerts are a limitation, not a repository error or a successful zero. They never erase risks reported in Issues. A healthy security conclusion requires complete Issue and alert coverage; neither an empty bot feed nor unavailable Issues establishes safety. Both prompts treat repository content as untrusted data, never instructions.

Jev receives a separate projection capped at 24,000 UTF-8 bytes, leaving room below its documented 32k-token state-plus-longest-question limit and 64k-token total request limit. Daily cadence uses a labeled matrix without dropping days or counts; individual cycle-time arrays and author aggregates stay in the summary input. Event URLs are omitted, titles and bodies are shortened with explicit excerpt markers, and the largest event stream loses its lowest-priority trailing records until the state fits. Omitted counts increase accordingly. Questions and evidence references are built from the retained records, and shortened or omitted evidence makes the affected judgment uncertain. The second-stage summary retains the original input. These are application byte budgets, not tokenizer measurements; provider context rejection remains an explicit error.

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

Up to sixteen item-specific questions are interleaved across Issues, PRs and alerts in that order, for at most 24 total. Each answer selects `urgent`, `review`, `routine` or `unknown`. The application validates the choice, probability distribution and confidence, retaining them independently of the report. Low confidence, incomplete coverage and omissions mark the judgment uncertain. Confidence describes the model distribution, not factual certainty.

## Report contract

The authoritative contract is `repositoryReportSchema` in `src/lib/ai-review.ts`. It requires `schemaVersion: 1`, summary, overall status, security/PR/issue sections, delivery status/trend, prioritized actions and limitations. All objects reject additional keys; enums, string lengths, array bounds and evidence references are validated server-side. Urgent findings and immediate actions require references. Security findings marked attention or urgent require relevant Issue, alert or PR references; delivery counts alone are not security evidence. Incomplete coverage cannot produce an all-clear. An overall healthy result also requires all four domain sections to be healthy and no immediate actions, preventing contradictory risk labels. The prompt includes the JSON Schema and explicit JSON self-check instructions. One repair attempt receives only a fixed validation code; invalid output never replaces the last valid report.

The formatted repository detail tab renders plain text, aligned icon/status labels, confidence meters, four-choice probability distributions, actions, limitations and expandable judgments. Standard question IDs receive Chinese display titles while preserving the original question in the details. Confidence is distribution concentration rather than factual correctness; manual-review hints remain textual as well as visual. Source and report versions/timestamps come from the application, not the model. Repository content is not rendered as HTML or executed as instructions.

## Execution and persistence

`0005_ai_settings.sql` adds encrypted settings. `0006_ai_reviews.sql` adds one bounded assessment row per account/repository. Existing data remains untouched. The canonical initial schema and local migration runner include both migrations.

The existing fenced repository commit also creates an assessment job, only when new data is accepted and both providers are configured. Coverage regression, failed collection and legacy restoration do not create jobs. Queue messages use `{reviewId}`; each delivery executes one stage. A three-minute lease and random token fence all results. Stage requests have a 40-second total deadline and disable SDK retries. Summary format repair shares that deadline. Timeouts, temporary provider failures, rate limits and invalid model output allow at most three attempts with bounded delay. Context overflow, authentication failure and rejected request formats stop immediately. Safe specific error codes survive persistence and drive refresh/report guidance; raw provider errors never enter stored records or public responses.

Accepted GitHub data does not depend on AI success. New refresh plans include one AI checkpoint per statistics repository, after page collection and before final publication. The checkpoint observes the existing job for exactly that run/source version and makes no provider calls; the background job can already be running while pages are collected. Refresh completion waits until assessment succeeds, fails or is skipped. Five-second checkpoint polling respects longer persisted AI retry deadlines. Missing configuration is an explicit optional skip, not a partial refresh or a warning. AI failures remain separate from collection failures and do not rewrite repository state. Failed queue dispatch is recovered by the minute scheduled outbox scan. A new source replaces pending work and preserves the last valid report; obsolete workers cannot publish. Report and input payloads are bounded, counted within the existing account storage budget, and removed with their account. No unbounded report history is accumulated.

Endpoints require the existing Access identity and write Origin guard:

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/ai/settings` | Public configuration and key-presence flags |
| POST | `/api/ai/settings/:kind` | Save `summary` or `judgment` configuration |
| POST | `/api/ai/settings/:kind/test` | Test submitted draft or retained key |
| DELETE | `/api/ai/settings/:kind` | Clear one configuration/key |
| GET | `/api/repos/:owner/:name/assessment` | Active-account report and stage; read-only |

Local preview uses `https://giraffe.dev.hexly.ai`. Automated verification uses fake credentials and mocked SDK/provider responses. Real service authentication and model quality require the owner's saved keys and are not claimed by those tests. Rollback stops assessment dispatch and restores the prior application revision; retain the additive tables for subsequent recovery.
