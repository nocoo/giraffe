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

## 2026-09-24 — Verify external lookups in the Worker runtime

The new Hexly lookup passed mocked Node tests and a direct Bun request, but the
same request failed immediately in the daily local Worker. Changing only
`redirect: "error"` to `redirect: "manual"` made the real Rio request succeed.
The local runtime did not behave like the Node fetch mock despite the accepted
TypeScript type. The client now handles non-success redirects explicitly, and
real local HTTP tests exercise the full Worker lookup against a loopback stub.
For future outbound integrations, verify one real local Worker request early;
typechecking and mocked fetch results do not establish runtime compatibility.

The full browser suite also retained an assertion for the short repository name
`tools`, while the integrated table intentionally displays `nocoo/tools`. Update
existing identity assertions alongside the new scenarios, retaining the owner
where the same repository name could belong to different accounts.
The missing-snapshot check must scope links to the header with the exact project
title: both the application header and the repository header contain a GitHub
destination and a level-one heading. Retain browser traces for failed identity
journeys so navigation failures preserve their original evidence.

## 2026-09-26 — Verify rendered component content and named refresh steps

During refresh-console work, `LayerCard.Header` was initially given a `title`
attribute instead of heading children. Its DOM props accepted the attribute,
but it would not render a visible heading. Reading the installed component
type exposed the mistake before commit. Use explicit children for this header
and verify the rendered heading in the browser; typechecking alone cannot
prove visible content. Reordering refresh steps also exposed tests tied to
numeric positions. Locate the intended step by kind so cooldown and retry
checks continue to exercise the same behavior after plan changes.

## 2026-09-26 — Run the complete browser suite before release

The focused refresh-console and page checks passed, but release CI found two
older browser assertions that still expected the previous UI contract: a
26-step full refresh and a security-coverage footer below the signal list.
The explicit Insights step makes the run 27 steps, and optional security
diagnostics now belong only in the refresh console. Update the run assertion
and verify successful Insights generation; measure the signal list itself
against its card body instead of depending on an unrelated footer. Run the
complete browser suite when shared refresh plans or page structure change,
even when focused scenarios and unit coverage already pass.

The added assertion initially confused a snapshot resource with a step kind;
Insights is `kind: "snapshot", resource: "insights"`. Read the shared step
type and existing server assertions before extending browser checks. A progress
update also inferred success from later test output before the suite finished.
Report individual success only from its result, and complete-suite success
only after the runner exits successfully.

## 2026-09-27 — Incremental list identity

While adding quick page merges, the initial implementation keyed mapped Issue/PR
rows only by URL. Local fixtures without URLs exposed a real weakness: unrelated
repositories with the same empty key collapsed into one entry. The existing
multi-repository pagination test failed before publication. The merge now uses
resource IDs or repository plus issue number when a URL is absent; whole-page
closure updates and cross-repository retention have dedicated checks. Future
incremental collectors must verify identity against both raw and mapped payloads,
including sparse records, before reusing a generic merge operation.

The final reuse review also found that comparing only consecutive statistics
heads could reuse an older language/contributor snapshot after a failed detail
refresh. A failing regression test reproduced it. Page reuse now requires that
page's own recorded `source_head` to match current successful metadata; missing
provenance forces collection. Reuse decisions must follow the artifact being
reused, not merely the latest parent record.

## 2026-09-27 — Existing development databases need every migration

The refresh release added migration 0007, but the development bootstrap kept a
manual list ending at 0006. Fresh test databases used the complete schema and
passed; an existing local database lacked both refresh tables, so settings and
manual run creation returned database errors before collection started. The
startup health check only proved connectivity and did not detect the missing
tables. Development startup now reads every SQL migration in filename order,
matching the migration verifier. A regression test reproduces an existing
pre-schedule database, verifies refresh tables are usable after startup, and
checks repeated startup preserves saved snapshots. Verify both fresh and
populated database startup whenever a feature adds persisted state.

## 2026-09-27 — Serialize production exports with every deployment

During v0.11.0 verification, the main-triggered deployment had succeeded, but
the tag-triggered deployment was still pending when a post-deployment D1 export
started. Its migration query then failed with Cloudflare error 7500 while the
export was in progress. The error alone does not prove the export caused it,
but D1 explicitly warns that export can temporarily block queries. Wait for
every release trigger to settle before exporting production data, and complete
exports before retrying deployment. Historical row hashes matched after the
export; the failed deployment was retried without moving the published tag.

## 2026-09-27 — Match label orientation and control sizes

The automatic refresh form combined a stacked time label, inline select labels
and a smaller save button. Centering the outer row could not align their control
edges. Use the same inline label arrangement and Basalt control size within a
row. Check rendered control bounds and screenshots across desktop and narrow
viewports; a passing save interaction or overflow check does not prove alignment.

## 2026-09-27 — Remove dialog scroll containment from full pages

Moving refresh management from a dialog into ContentIsland retained an inner
`overflow: auto` and `overscroll-behavior: contain`. The inner body expanded to
its content height, leaving no scroll range, yet swallowed wheel input before
the scrollable island could receive it. Locator screenshots had automatically
scrolled elements into view and missed the broken user interaction. Remove the
obsolete inner scrolling rules and keep ContentIsland as the page scroll owner.
Browser regressions now use real wheel input over all three tabs at desktop
and narrow widths, reaching expanded diagnostics and returning to the top.

## 2026-09-27 — Native time inputs need the active color scheme

The schedule input used Basalt text and surface tokens, but its native clock
indicator retained the browser's default light appearance on a dark surface.
Alignment screenshots did not catch its low contrast. Set the native input's
color scheme from the active application theme, and inspect both theme variants
when introducing browser-rendered controls; token colors alone do not style
their native indicators or picker surfaces.

The first fix used Tailwind's `dark:` variant, which follows the operating
system here. Basalt exposes `basalt-dark:` for the application's chosen theme.
Testing only matching OS and application themes missed the distinction. The
input now uses the package variant, with a browser regression covering explicit
light/dark choices and a system theme change while dark remains selected.

## 2026-09-27 — Composed cards need a body slot

The refresh page-results card combined `LayerCard.Header` with a bare paragraph
and definition list, assuming `padding="md"` would pad the root. Basalt disables
root padding when composed slots are present, so the title was inset 16px while
the content touched the edges. Place content in `LayerCard.Body` and remove the
ineffective root padding prop. Browser regressions compare title, description,
list and bottom gutters at desktop and narrow widths.

A source scan of client card composition and 92 local browser states across
all 11 routes, the not-found page, refresh tabs and repository tabs found no
additional instances of bare card content or blocked wheel scrolling. Checks
covered 1440px/390px widths and light/dark themes using fixture data; horizontal
overflow and inner scroll containment were inspected alongside actual wheel
input. Verification used installed Basalt 2.1.8. Future card changes must inspect
rendered content bounds, not infer padding from a root prop.

## 2026-09-27 — Wait for exact-commit CI before pushing release tags

For v0.11.1, main was pushed through passing local gates, then the release tag
was pushed while the matching GitHub browser job was still running. The shared
release-source action rejected the tag deployment because no successful main
CI existed yet for that commit. It stopped before checkout, migrations or
deployment. Inspect reusable release-source requirements, wait for successful
CI at the intended release SHA, then push the tag. If already published, retain
the tag and rerun its deployment only after the prerequisite CI succeeds.

## 2026-09-28 — AI repair constraints and local migration replay

The first historical replay still returned an unsupported all-clear after a textual repair instruction. Prompt wording alone did not reliably constrain status choices. Per-domain response schemas now exclude healthy when the sampled evidence is incomplete, while server validation remains mandatory. Both selected historical failure samples then passed through the configured gateway in 16.3 and 14.2 seconds. These samples demonstrate compatibility, not a universal model-quality guarantee.

An initial ALTER-column migration failed the local startup replay test because this project initializes its latest schema and replays migrations idempotently. No production migration ran. The provider switch now uses an additive, idempotent options table; backup-copy migration replay and rollback checks preserve existing rows. Inspect both production migration tracking and local schema bootstrap before choosing DDL.

## 2026-10-01 — Scope and successful checks define freshness

Daily starred runs successfully merged Issue/PR rows, but list headers displayed only
the old account-wide scan time. Conversely, CI used the newest repository timestamp,
and marking a notification read changed the entire inbox collection timestamp. None
of these timestamps described the page's actual selected evidence. Scope must apply
before both aggregation and freshness calculation. A successful check of an empty
repository counts; missing data does not. Source time, task time, user edits and AI
report generation are separate events.

An ID intersection is not a safe stopping condition for mutable histories: a fixture
with 101 previously open issues closed since the baseline retained the last issue as
open after the first page. Use bounded full reconciliation for current mutable lists;
reserve overlap shortcuts for evidence whose ordering and immutability justify them.

The parallel tool rejected calls containing both legacy `message` and `items` keys,
including empty values. Repeating an unchanged invalid request did not improve the
outcome. Stop after the first deterministic schema failure, correct the shape or use
an available runner, and keep worker file ownership explicit. The inherited Herdr
pane identifiers were stale; do not infer the live pane from them or prompt the
coordinator's own pane as though it were a worker communication channel.

## 2026-10-01 — Retention and storage telemetry are not an artificial quota

The 256 MB account guard could stop collection before the protected recent-20-run
window became eligible for garbage collection. Storage measurement remains useful,
but it must not veto normal refreshes. Removed the account guard and its redundant
per-write byte deltas while preserving per-record/request limits, lease fences and
reference-safe retention. Regression tests now create, execute and assess above the
former threshold. Cleanup runs even when the preceding dispatch step fails.

Dependency issue titles can contain stale baselines or recommend a different fixed
major line. Verify installed versions and the advisory ranges: Undici 7.29.1 fixes
the reported vulnerabilities without a forced 8.x upgrade. After updating Wrangler,
its own dependency pins made the Sharp and Undici overrides redundant, so they were
removed only after confirming resolved versions and a clean security scan.

A browser regression exposed that re-enabling polling after a notification mutation
ran the initial loader again immediately. A late/stale read could replace the saved
write response. The inbox now distinguishes first load from resumed background work;
regressions assert that resuming arms the timer without an immediate duplicate GET.

Browser geometry assertions must sample related elements in one DOM evaluation.
Separate bounding-box calls during tab entrance motion compared two animation frames,
producing a false alignment failure. Measure both boxes atomically and wait for the
existing sub-pixel tolerance, rather than increasing the tolerance or disabling motion.

## 2026-10-01 — Compose page scope inside the header

The shared scope outlet inserted a standalone filter row above every business title,
and the snapshot description forced another row for time. This wasted vertical space
and separated controls from their page. Compose the existing Basalt header actions
instead, share subtitle/time space and test geometry at desktop and mobile widths.
Keep controls grouped when responsive CSS uses display:contents, otherwise badges
can become unintended grid rows. Long timestamps need inline wrapping, not a flex
item that forces its entire value below the label.

Basalt PopoverTitle is a styled heading, not an automatic accessible-name binding.
Connect PopoverContent to its title explicitly and test Escape/focus behavior. Mock
missing API resources as missing responses, not successful empty objects that can
break unrelated identity consumers. In zsh, avoid `path` as a loop variable: it is
tied to PATH and can hide commands for the rest of the shell invocation.

## 2026-10-02 — Verify the allowed local execution boundary

The first local typecheck used Wrangler's default log destination outside the writable
workspace. Redirect subsequent Wrangler logs to an owned temporary path before invoking
project scripts. Local development then failed at loopback binding with EPERM, and Chromium
failed at its macOS Mach service registration. These are execution-environment restrictions,
not application failures. Do not claim browser acceptance or a running dev server based on
unit tests/build output, and do not bypass the restrictions to obtain a green result.

The release follow-up could run Chromium after the execution boundary changed. It exposed
old browser assertions still looking for timestamps in page subtitles and assessment cards.
When moving shared UI, search the entire browser suite for the removed semantic elements,
not only the component name; preserve the timestamp, scope and layout assertions at their
new accessible location before publishing.
