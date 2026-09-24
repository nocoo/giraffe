# Repository AI assessments

Two independently configured services run after a refreshed repository version is accepted:

1. TypeSafe Jev uses the official `@typesafe-ai/sdk` TypeScript client for priority judgments.
2. `@nocoo/next-ai/server` supplies the OpenAI or Anthropic model for a structured repository report.

Settings are deployment-wide, like GitHub accounts. The settings page has separate model/key cards, draft connection tests and a clear-key action. Both configurations must be saved before future refreshes create assessments. A connection test uses a minimal synthetic prompt, does not save the draft, and may consume provider credits. Saved credentials use the existing versioned AES-GCM encryption keys and never appear in public responses. Changing the destination, protocol or authentication requires re-entering the key.

## Input and judgment template

Each job binds to the accepted immutable repository version and its original observation window. Source data consists of repository metadata, delivery metrics and daily activity, and stored commits, issues, PRs, CI runs, releases, dependency declarations and optional Dependabot alerts. Issue/PR bodies and advisory summaries are bounded excerpts. No extra GitHub calls occur during assessment or GET requests. Diffs, review threads, runtime exposure and exploitability are not collected; reports must not infer them as facts.

Each stream supplies up to 24 observed records, prioritizing open records and then recent timestamps. Omitted counts and original coverage accompany the sample. Evidence IDs are namespaced by stream. Missing security coverage remains unknown, not an error or a successful zero. Both prompts treat repository content as untrusted data, never instructions.

Template version 1 has eight fixed, independent questions:

| ID | Decision |
| --- | --- |
| `security_urgency` | Security cases needing immediate mitigation |
| `external_pr_review` | External PRs needing maintainer judgment |
| `unusual_pr_risk` | Unusual architectural, authentication or supply-chain changes |
| `blocking_issues` | Incidents and time-critical user-facing failures |
| `delivery_cadence` | Intervention warranted by observed delivery cadence |
| `review_backlog` | Stalled PR review flow |
| `delivery_reliability` | CI/release reliability concerns |
| `issue_flow` | Accumulating unresolved user needs |

Up to sixteen item-specific questions are interleaved across alerts, PRs and issues, for at most 24 total. Each answer selects `urgent`, `review`, `routine` or `unknown`. The application validates the choice, probability distribution and confidence, retaining them independently of the report. Low confidence, incomplete coverage and omissions mark the judgment uncertain. Confidence describes the model distribution, not factual certainty.

## Report contract

The authoritative contract is `repositoryReportSchema` in `src/lib/ai-review.ts`. It requires `schemaVersion: 1`, summary, overall status, security/PR/issue sections, delivery status/trend, prioritized actions and limitations. All objects reject additional keys; enums, string lengths, array bounds and evidence references are validated server-side. Urgent findings and immediate actions require references. Incomplete coverage cannot produce an all-clear. The prompt includes the JSON Schema and explicit JSON self-check instructions. One repair attempt receives only a fixed validation code; invalid output never replaces the last valid report.

The formatted repository detail tab renders plain text, statuses, actions, limitations and expandable judgments. Source and report versions/timestamps come from the application, not the model. Repository content is not rendered as HTML or executed as instructions.

## Execution and persistence

`0005_ai_settings.sql` adds encrypted settings. `0006_ai_reviews.sql` adds one bounded assessment row per account/repository. Existing data remains untouched. The canonical initial schema and local migration runner include both migrations.

The existing fenced repository commit also creates an assessment job, only when new data is accepted and both providers are configured. Coverage regression, failed collection and legacy restoration do not create jobs. Queue messages use `{reviewId}`; each delivery executes one stage. A three-minute lease and random token fence all results. Stage requests have a 40-second total deadline and disable SDK retries. Summary format repair shares that deadline. Failed stages retry at most three times with bounded delay; safe error codes are persisted, never raw provider errors.

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
