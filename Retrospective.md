# Retrospective

## 2026-09-24 — Neutral badges followed the system theme

The assessment's dark-theme screenshot exposed pale text on the pale gray status badge. Its Tailwind `dark:` foreground variant followed the system color scheme while Basalt's theme toggle used the application theme. The foreground now uses `basalt-dark:`, matching the provider. Browser checks measure neutral badge contrast in both application themes; a screenshot that merely fits the viewport is not proof that its labels are readable.

## 2026-09-24 — Security assessments overlooked active Issues

The security judgment and report completeness check used only the optional alert stream. A complete, empty bot feed could therefore support a healthy security section even when Issue coverage was unavailable. The regression reproduced that unsupported all-clear. Security assessment now treats active Issues as its primary evidence and bot findings as a supplement; missing alerts cannot erase a reported Issue risk. The input also separates the latest fourteen days and the preceding comparison period from long-term totals, retains older unresolved work and distinguishes outside-scope exclusions from missing sampled evidence. Test the evidence required for each conclusion, including unavailable primary sources and positive findings when supplemental sources are absent.

## 2026-09-24 — Repository tabs collapsed their loading layout

On the first visit to a repository tab, the page header replaced its two-line snapshot description with plain text until the selected snapshot arrived. That removed 30 pixels above the tab bar and restored them after loading. Cached tabs kept their timestamp and therefore appeared stable. Skeletons also returned `null` for their first 200 milliseconds, briefly reducing the active panel to zero height. Keep the header description and timestamp geometry mounted, hiding unavailable timestamps from both sight and assistive technology, and defer only skeleton visibility. Delayed-response browser regressions cover the first frame, skeleton reveal, a different tab-specific timestamp, and cached switching at desktop and mobile widths. Layout checks must include pending states, not only settled screenshots. The full browser suite caught an older assertion requiring timestamp DOM removal; that check now verifies visual and accessibility absence, followed by visibility when fresh data arrives.

## 2026-09-24 — Jev input budgets differ from report input budgets

The first Jev stage reused the full repository report input. Pew produced an 84,852-byte state and a 105,135-byte request; the service immediately returned HTTP 400 with `max_tokens_exceeded`. The assessment executor then erased the safe model failure category as `ai_error` and retried identical requests three times. A compact, byte-bounded projection now retains daily cadence, stable evidence IDs and explicit omissions/excerpts while the report stage keeps its original input. A read-only replay of the same saved source returned 17 valid judgments in about 1.4 seconds. Synthetic connection probes and tiny fixtures cannot establish that realistic repository payloads fit the model context. Add multilingual size-bound regressions and preserve specific safe diagnostics; deterministic request failures must not enter the transient retry loop.

## 2026-09-24 — Dependabot alerts require cursor pagination

Single-repository refresh repeatedly stopped at security alerts because the collector sent `page=1` to the Dependabot REST endpoint. GitHub rejects that parameter with HTTP 400; the generic error path then waited 30, 60 and 120 seconds before failing, skipping repository publication and AI analysis. Removing the parameter returned HTTP 200 in a read-only probe. The collector now consumes the endpoint's `after` cursor from Link headers while retaining the original repository and filters. Regression fixtures reject numeric pagination and cover checkpoint resumption, cursor validation and completion through repository saving and the AI checkpoint. Generic empty-success fixtures must not conceal endpoint-specific pagination contracts.

## 2026-09-24 — Refresh plan changes affect every progress denominator

Adding the AI checkpoint changed both scoped and full refresh totals. The first targeted checks covered the new checkpoint, but the full browser suite still expected four phases, eighteen repository steps and twenty-five full-refresh steps. Update every fixed plan/count assertion across unit, HTTP and browser tests when changing the frozen plan. Keep those expectations explicit so they can catch an unintended expansion of refresh scope.

## 2026-09-24 — Duplicate focus indicators in composite controls

Factory-wide focus selectors overrode Basalt's input-group styles, drawing a square outline around the inner search input on top of its rounded group border. Unlayered page CSS takes precedence over the package utilities. Scope application focus styling to native controls without `basalt-ui` and let the component own its focus treatment. Verify keyboard traversal and clear-button focus restoration in the rendered composite control, including both themes and narrow viewports.

Accident narratives for this repo.

Routing: narrative stays here. A project-specific rule that will recur may become one line in `AGENTS.md`. Cross-project lessons go to nmem or a global rule. If it can be checked by a machine, add a hook or test instead of prose.

## 2026-09-24 — Repository selection expanded into whole-site refresh

The refresh API applied repository selection only to factory statistics, then appended every accessible repository's detail pages and account-wide collection. A single selected repository with 161 accessible repositories produced 1,465 logical steps. Scoped plans now include only the resolved repositories' statistics and detail tabs plus publication: 19 steps for one repository. Full-site work remains exclusive to the full scope. Tests assert request isolation and preservation of untouched snapshots so reducing the target list cannot accidentally replace global lists with partial data. Repository detail refresh also stops rebuilding Insights and digest from unchanged sources; previously this gave old data a new timestamp. Existing frozen runs retain their plans and must be cancelled and restarted to change scope.

## 2026-09-24 — Flow chart tooltip payload mismatch

The PR and Issue flow charts nested the original daily record under `day`, while the shared tooltip read that record directly from the Recharts payload. Hovering passed `undefined` to `formatFactoryCount` and raised an uncaught render exception that unmounted the page. Static chart checks had missed this interaction. Preserve the daily fields at the top level, as the other daily charts do, instead of hiding the mismatch with a numeric fallback. Browser regressions now hover all four daily chart variants, assert the actual tooltip values, and exercise the ledger afterward.

## 2026-09-24 v0.9.0 tag release raced main CI

Pushed `v0.9.0` immediately after pushing main, before CI on `ad7f242` finished. The tag-triggered Release workflow resolves its source by requiring an already-successful CI run for that SHA, so it failed in 12s with `No successful .github/workflows/ci.yml run on main for ad7f242`. Fixed by waiting for CI green, then `gh run rerun`. Rule: after pushing the release commit, wait for the main CI run to succeed before pushing the version tag; the workflow_run path will already deploy main on its own.

## 2026-09-24 palette verification mistakes

The first isolated visual probe requested `127.0.0.1` while Vite was listening on IPv6 localhost, so Chromium refused the connection. Using the actual listening host fixed the probe without touching the daily server. Verify the bound address before diagnosing application failures.

An unanchored CSS replacement also matched the suffix of two status-specific icon selectors and temporarily gave them the generic info color. Diff review caught this before commit; the warning/success icons were restored to semantic colors while their data marks retained candy fills. Anchor selector edits to complete rules and inspect the resulting diff before accepting a bulk color change.

## 2026-09-24 — Settings forms need scoped browser assertions

Adding two independent AI settings forms exposed browser checks that selected every `form[aria-busy]` or every alert on the settings page. Those checks became ambiguous even though the PAT interaction still worked. The full local browser run caught the regression before publication. Scope PAT assertions to their form/field, and include the new settings GET in shared UI fixtures so an unrelated mocked 404 cannot create an extra alert. The complete 40-test browser run then passed.

## 2026-09-24 — Progress updates entered the user-input channel

During assessment verification, two informational updates were mistakenly sent through the user-input tool, producing unnecessary input boxes. The task needed no user decision. Keep progress in commentary and reserve input tools for a concrete missing answer; after a mistaken input request, acknowledge it in commentary rather than issuing another input request.
