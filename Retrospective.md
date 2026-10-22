# Retrospective

## 2026-10-19: Offline version metadata retained mirror URLs

While preparing v0.15.8, an offline `bun install --lockfile-only` run inherited
the temporary package mirror and expanded the lockfile's registry fields. The
version commit passed the existing hooks, which do not check registry neutrality;
the controller caught the unrelated diff before any branch push. The unpublished
version commit was corrected to retain the original package entries and only
change the workspace version. Check the lockfile diff and the absence of pinned
mirror URLs before staging, even when installation is offline; a version-only
change must not silently change CI's package source.

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

## 2026-10-02 — Preserve locked packages when adding a workspace

Moving the application into a Bun workspace caused dependency resolution against the
corporate mirror, which lacked some already-pinned versions. An offline retry against
that registry could not use the Tencent-keyed cache and removed unresolved install links.
Probe the allowed secondary mirror, reuse its exact-version offline cache, and preserve
all resolved lock entries. Strip registry-specific download URLs introduced by lock
regeneration and verify a frozen offline install. Do not downgrade unrelated dependencies
to solve registry lag. Moving source also requires updating schema fixture filesystem paths
and generated Worker entry-module types, not only TypeScript imports.

Monorepo acceptance also caught a browser fixture reading the old `public/` path and
an overbroad CSRF guard that changed unsupported-method responses from 405 to 403.
Keep the Origin check on real write verbs (POST/PUT/PATCH/DELETE), and leave unsupported
verbs to the method gate. Search asset filesystem reads as well as source imports.

Adding a second account selector made a global account-name browser assertion ambiguous.
Scope the assertion to the account table cell's accessible name, which includes its avatar
initials; `getByText(..., exact: true)` does not match a composite cell. Verify a targeted
browser check before committing a selector correction.

A broad monorepo string replacement accidentally changed browser `src` attribute assertions
to the new source directory. Filesystem paths and DOM attribute names are different contracts:
review every exact bare-string replacement and run the full browser suite before release.

## 2026-10-03 - Keep repair execution native and explicit

The first dependency-repair implementation made a Docker image, offline dependency
caches, metadata sealing and a separate bare publication bridge prerequisites before
one real repair had been accepted. This expanded the requested local workflow into
an execution platform and left the usable path blocked. The owner explicitly chose
ordinary local execution. Remove the obsolete adapter and configuration instead of
maintaining two modes. Keep dedicated clones, configured checks, normal Git hooks,
exact-code independent review and the 20-round bound. Do not describe native scripts
as isolated: they run with the user's filesystem and network authority.

The initial native runner prepended project binaries even for host-owned Git, only
killed the direct subprocess, and used a no-op wrapper as a Husky activation fixture.
Independent review caught all three. Keep host command lookup separate from npm/Bun
script lookup, terminate the owned process group before returning, and test actual
Husky-generated hooks with marker and failure assertions. Pass cancellation through
installation and retain its resumable checkpoint rather than permanently blocking it.

One injected test transport mapped the clone URL but missed the later `origin` push
argument. It attempted a GitHub connection and failed during credential acquisition;
no credentials were supplied and no remote mutation occurred. Map both forms and
enforce `GIT_ALLOW_PROTOCOL=file` in the fixture Git helper. A temporary repository
alone does not guarantee a network-free test. Final fixture evidence must remain
separate from real-target execution or publication acceptance.

Normal commit hooks then rejected the first attempt: process cleanup could signal
the same process group from timeout, exit and close callbacks, and a macOS `EPERM`
escaped an event listener. Signal the owned group once, never retry its reaped PID,
and propagate a typed cleanup failure without touching the index or rolling files
back while a process may still be active. The job must block for operator attention
instead of starting another model round. Keep tests for single signalling, explicit
permission failure and each descendant-cleanup mode; do not weaken or bypass hooks.

# 2026-10-03 — Coordinator dry-run integration

The first live priority batch failed because Jev returns rounded probabilities
whose sum can be 0.99. Exact key coverage remains mandatory; the coordinator now
accepts only a small explicit rounding tolerance and preserves raw probabilities.
A regression test rejects materially invalid or missing distributions.

The first five-worker rehearsal completed all handoffs but correctly exited as
failed when one resident analysis hit the decision proxy's source request limit.
Four domain judgments now share one batch instead of four concurrent requests.
Bounded SDK rate-limit retries are enabled for coordinator prioritization. A
successful worker rehearsal must never hide a failed parallel analysis lane.

Workspace delegation stalled in repeated exploration without producing files.
The coordinator reclaimed the critical path and closed its owned helper pane;
future bounded delegation should produce the minimal callable module before
expanding test coverage. No personal target repository was mutated during this
debugging session.

The corrected second run completed all four resident analyses and all five worker
rehearsals with exit code 0. Preparation conversation 47 was reused; workers 66,
88, 110, 132 and 154 were distinct for basalt, bat, bogo, lyre and backy. No online
report or GitHub mutation was performed. This verifies scheduling only, not actual
repair, push or issue closure.

## 2026-10-03 — Refresh preparation baseline after fast-forward

The first real no-push coordinator run fetched and fast-forwarded Backy normally,
then rejected its upstream Biome/instruction changes against the pre-pull policy.
No worker edit, commit, push or issue closure occurred. The baseline must be pinned
after a clean fast-forward, while worker-time changes remain forbidden. A failing
regression test reproduced the stale-policy rejection before the fix. Tool errors
are now printed with credential-safe diagnostics instead of only a missing-handoff
message. The random repository selection remains unchanged during debugging.
The next attempt exposed stale conversational memory: the resident preparation
agent treated the previous run's one-call restriction as already consumed. Each
new assignment now explicitly resets that restriction without discarding history;
host-side execution evidence remains mandatory before any worker handoff.
Prompt wording alone did not recover the resident conversation. The handoff tool
now rejects completion until the required operation was attempted in the current
assignment, and each input carries its assignment ID. This is a runtime workflow
invariant, not reliance on a model remembering the reset instruction.

The first worker correctly refused to guess an Undici upgrade when its large
lockfile response was truncated and runtime evidence was missing. Reads now expose
bounded windows and literal-match offsets; assignments include the actual local
Node version. A blocked repository is retained and reported while other selected
repositories continue, rather than aborting the entire portfolio.

Bun 1.4 rewrote hundreds of default lockfile tarball locations to the temporary
Tencent mirror during a one-package upgrade. The resulting diff hit the review
budget before the worker could commit. Installation now removes only approved
temporary mirror locations, preserving package versions, metadata and integrity
hashes. Existing work remains in place; no reset, stash or hook bypass is used.

R2Shot's worker completed six atomic upgrades but could not synchronize Biome's
schema version because the gate guard rejected all configuration writes. Permit
only official schema-URL version changes with byte-identical remaining settings;
all actual rules, thresholds, scripts and hooks remain pinned. Interrupted workers
require operator-reviewed exact workspace evidence before resuming; historical
success alone is never permission to adopt arbitrary dirty files.

The recovered real run produced Backy commit 3be12bb and seven R2Shot commits
ending at b145913 with normal hooks, no push and no issue closures. Only the
temporary mirror URL normalization was performed by the supervising operator;
workers authored dependency changes, tests and commits. Recovery used the same
controller/worker conversations and exact reviewed diff hashes, not automatic
adoption of arbitrary user changes. R2Shot's first Chrome acceptance hit the
capture API quota; a second unchanged run passed all 11 scenarios, so the first
failure remains recorded rather than hidden as guaranteed stable acceptance.

## 2026-10-03 — Unified Work recovery and evidence

The first unification patch reused issue completion bookkeeping for review fixes,
which could reject a second commit or compare publication against a stale task
HEAD. Review completion now updates each task once and publication uses the exact
independently approved checked HEAD. Recovered approval does not require an
in-memory worker handoff or consume a twenty-first round.

Pi Durable deduplicates request IDs, but validated handoffs initially lived only
in an in-memory ticket. Replaying a settled request therefore returned no result.
Persist validated result plus input identity, schema-validate reuse and reject
changed input. SQLite reopen tests prove no extra model/tool execution. Freeze
controller plan/prepared workspace/completion before recovery instead of asking
the same request to evaluate a changed checkout. Keep unsafe tools non-replayed.

Host push originally bundled issue closure before its durable marker; a closure
failure could repeat publication. Persist SHA before idempotent dependency issue
closure and follow-up. Reconcile remote SHA for uncertain push. A consumed third
poll must settle timeout after restart without a fourth request. Skipped-only,
cancelled, missing or paginated evidence never proves passed CI.

Console-only tool logs initially bypassed Web progress. Route conversations and
native driver through the current occurrence trace, retain compact per-repository
summaries beside a byte-bounded tail, and flush queued traces before terminal
status. Do not present dependency-only foundation as PR/CI repair acceptance.

Terminal repository failures originally escaped into the global cron retry path,
pinning an occurrence indefinitely. Persist source-set task outcomes and finish
terminal repositories while transport failures retain recovery. Priority order is
not task identity. Local no-push approval is not permanent publication completion.
Persist terminal progress before delivery and retry delivery alone on Web failure;
the native pipeline must not restart after a completed local occurrence.

Task integration initially used numeric issue identities for CI/PR work and raw
JSON.parse for Bun's JSONC lock. Use namespaced tasks end-to-end and the existing
Bun parser through a fixed host operation. Package scope must be token-bound to
the task's verified issue text, not substring matches across repository tasks.
Keep host-unavailable evidence fixed deferred and expose each disposition to the
independent reviewer. Follow-up expectations use actual recorded main push and
workflow_run events, not every named workflow; schedules and tag releases are not
missing main checks. Bound disposition details without losing identities/results.

## 2026-10-03 — Unified Work integration acceptance

Normal root hooks accepted the unification with 609 Web tests, 156 Agent tests
and all four coverage metrics at least 95%. Local API suites A/B and dependency
and secret scans passed. Fake models with real SQLite reopen and temporary native
Git repositories with active hooks verified the paired fix/review loop and
publication recovery. No new real-target repair service was enabled.

The full local browser runs encountered two separate five-second visibility/count
timeouts in unchanged UI: the Insights chart in the first run and the factory
signal list in the repeat. Final full-suite acceptance was not entirely green.
Each exact failing test was rerun twice on the same source and assertions; all
four targeted reruns passed. The pre-integration baseline passed 87/87. Retain
this potential-flakiness evidence; never weaken assertions or rerun indefinitely
to erase failures. No unrelated UI fix was made.

The parent attempted `git push` with double-quoted `$expected:refs/heads/main` in
zsh. Its `:r` modifier mangled the refspec, and Git rejected the command before
any remote mutation; this was not an actual remote push. Bracing the variable as
`${expected}:refs/heads/main` preserved the literal boundary. The corrected
normal-hook push at `3073625` succeeded and its exact remote SHA was confirmed.
Brace shell variables adjacent to colons in zsh and verify the exact remote SHA.

## 2026-10-03 — Work priority limit and hidden failure causes

The real first 25-repository Work priority request duplicated the full policy and
candidate data, exceeding Jev's token limit. Its HTTP 400
`detail.error_type=max_tokens_exceeded` was swallowed and presented as a generic
scheduler connection failure. Share policy and repository metadata, include each
candidate title only once, and retain every candidate. The parent verified the
same 25 repositories and 210 choices: 19,128 request bytes, 10,434 input tokens,
2,514 output tokens, with all 25 answers validated. This is priority-call proof,
not acceptance of a restarted Work occurrence; the live runtime remains stopped.

Tick and heartbeat independently read and patched the same cron record revision.
A deterministic fake CAS regression proves they could self-collide with 409;
no live 409 is claimed and the observed live cause was not established as a CAS
collision. Serialize tick, heartbeat and shutdown publication, reading fresh
state inside the chain, while retaining heartbeats during long runs and writing
offline last. Persist bounded redacted failure causes in cron state and append
them to online Work events before the terminal blocked report. Distinguish
publication/check failures from actual run failures instead of hiding upstream
codes or claiming a retry waits for the next cron occurrence.

## 2026-10-13 - Route replacements must target navigation expressions

While moving the repository list from `/` to `/repos`, a scripted replacement
of every `"/"` literal in selected browser tests also changed two repository-name
`split("/")` expressions. Diff review caught both before commit, and their
delimiters were restored. Route migrations must target navigation calls and
route-table entries, not every matching string; inspect each replacement before
running the affected journeys.

## 2026-10-13 - Use explicit search paths

During the CI strip inspection, an unmatched zsh glob prevented an `rg` search,
and an `fd` call treated a directory as its pattern. Both searches were corrected
before editing. Pass known paths to `rg` and use `fd -e css . <directory>` rather
than relying on shell expansion or an omitted pattern.

## 2026-10-18 - Test sidebar changes through the real shell

The first sidebar structure tests rendered Basalt without the application's
LinkProvider. They passed while the production router adapter discarded the new
home link's accessible name. Browser checks and independent review exposed this;
the tests now use the real adapter and verify the icon-only home link. Review also
found that a route-keyed data provider remounted the sidebar, resetting the newly
collapsible groups. Keep page-data resets inside the main column and exercise
disclosure state across navigation. Before replacing a brand mark, search existing
browser assertions for its accessible name and fallback asset, not just callers.

The version-bump command also chained lockfile generation directly into staging
and commit. Bun expanded the temporary registry override into tarball URLs, so
the pending commit was interrupted before completion. Removing only those
generated URLs left the intended single version-entry change; the normal hooks
then ran again. Inspect generated lockfile changes before staging, even when the
package versions have not changed, and never chain generation into publication.

## Incremental source filtering must include merged observation times

The first machine sources filter used `fetchedAt ?? freshness.latestAt`. Review
found that scoped factory refreshes intentionally preserve a global snapshot's
old `fetched_at` while updating `repository_fetched_at`. The global source version
therefore changed, but an incremental caller could miss it because the old time
took precedence. Regression tests for account issues, PRs and the catalog failed
before the fix and passed after selecting the newest valid timestamp. Keep sources
with no valid time, preserve the original provenance fields, and verify both time
directions and the exclusive boundary when filtering composite observations.

A second review found that catalog-only refresh can adopt a new capitalization
while retaining an older immutable factory publication. Match repository filters
case-insensitively, like the factory resource reader, without rewriting persisted
resource identities or versions. The regression exercises both source discovery
and the corresponding immutable resource read across the capitalization change.

## 2026-10-19 — API skill consumer limits

The first API skill draft correctly described the absence of a server resource-count
quota but omitted the analysis reader's separate 50-page, 100-row limit. Review
traced `loadAnalysis` through `allPages`: more than 5,000 reports of the requested
type fail the whole page load even when publication succeeds. The skill now
distinguishes this consumer ceiling, counts all matching statuses/repositories,
and requires explicit authorization for retention rather than deleting history.
The same review clarified that global child-report identities use the browser's
filtered repository set, not the full machine catalog. Verify downstream reader
limits and selection rules alongside endpoint schemas when documenting a routine.

## 2026-10-21 — Verify navigation failures before calling them regressions

The first navigation regression captured `header`, which matched both the shared
AppHeader and a page-owned title on some routes. Its strict-locator failure was
mistakenly reported as a reproduced remount before the failure detail was read.
The assertion now targets Basalt's existing `data-basalt-header` marker. The
incomplete browser runs were stopped, and a fresh old-revision fixture runs only
the relevant regressions before the complete fixed-code suite. Test stores remain
inside task-owned temporary clones; no daily or production data is used. Inspect
the actual assertion failure before reporting red evidence, and scope chrome
selectors to their existing stable semantic markers rather than HTML tag names.

## 2026-10-21 - Compare saved rows, not query execution metadata

The new HTTP observation regression initially compared complete Wrangler D1 query
responses before and after GET requests. The saved rows were identical, but the
query duration changed from one millisecond to zero and caused a false failure.
Compare the ordered result rows for read-only assertions, excluding execution
metadata. Preserve the original failing data-correctness evidence separately from
test-harness defects so a fixture correction is not mistaken for a product fix.

## 2026-10-21 - Timestamp presence does not prove complete coverage

Read-time freshness correctly retained timestamps for rows from truncated baselines,
but starred projections still used missing timestamps to decide completeness. That
cleared the truncation flag when a partial baseline supplied every selected repo's
time. Review reproduced the regression for issues, PRs and alerts. Track coverage
separately from provenance; only complete baseline evidence or a complete replacement
page can clear the selected projection's incomplete flag. Include a same-time full
page regression because equal timestamps do not imply equal coverage.

The next review found that derived Insights still used timestamp presence as proof
that an issue count was exhaustive. A partial list could replace a catalog count
of 90 with one issue and incorrectly lower the health warning. Expose per-repository
coverage to every derived consumer, retain catalog counts when issue coverage is
incomplete, and propagate primary-source incompleteness independently of freshness.
Test complete and incomplete repositories together in both all and starred scopes.

## 2026-10-21 - Resolve case aliases consistently across readers

Case-insensitive catalog membership alone did not make stored snapshot keys
case-insensitive. Review found that CI selected the first matching alias, sometimes
old failed runs, while source discovery could advertise an uppercase page that a
canonicalized data endpoint could not read. Resolve whole logical page groups
before selecting the newest valid saved time, preserve the chosen resource identity,
and share that selection between the index, CI and page reader. Regression tests
follow indexed sources to their data and compare full content versions; aliases
with equal or invalid timestamps must resolve independently of SQL row order.

## 2026-10-21 - Branch names do not identify pull-request execution context

Default-branch CI classification originally compared only `head_branch` with the
saved default branch. A fork PR may also originate from a branch named `main`, so
its failures could override a successful repository push. Review reproduced this
using the existing Actions mapper and saved event fields. Keep all pull-request
event contexts observational, even when branch names match, and include scope in
rendered stream keys so default and PR lanes remain distinct. Verify default health,
separate failed-run counts and the unchanged all-branch daily histogram together.

## 2026-10-21 - Refresh reliability investigation

The refresh pipeline treated expected security access restrictions as incomplete
snapshots and failed steps. It also reported every published factory snapshot as
complete, independently of its run outcome. Regression tests now distinguish
expected unavailability from truncation and malformed evidence, and bind publication
status to the same run's outcome. Retained evidence must survive repeated unavailable
attempts without changing its observation time; testing only the first failure is
insufficient.

The renewable page lease did not bound total run lifetime. A hard wall deadline must
also fence writes, include paused runs, and expire before idempotency lookup or
scheduling. Missed-slot audit records must not impose collection cooldowns on actual
recovery work. Historical-clock queue tests now explicitly control the clock rather
than relying on the fixture's old date still being runnable.

During pane setup, `herdr pane resize --current` resolved to a different focused
pane despite the caller context. The response reported no change; the subsequent
resize used this controller's explicit pane ID. Inspect returned pane IDs and use
explicit IDs for layout mutations instead of assuming caller resolution is reliable.

The first L2 availability run reached the correct persisted reason codes, but a
nested coverage assertion inside `objectContaining` required an exact object and
rejected the additional valid coverage fields. Use a nested partial matcher when
checking only `reason_code`; distinguish matcher defects from behavioral failures.
The new browser assertion also matched a nested diagnostic `summary` instead of
only the repository disclosure. Scope the click to the row's direct child summary
and the subsequent explanation to that same repository row.

Independent review found that checking an accepted scheduled occurrence before
the audit transaction leaves a race: another cron can accept that slot before
the missed ledger is inserted. Recheck acceptance inside the ledger transaction
and advance the cursor only for its own inserted audit row. Apply the same rule
to empty selections so settings never reference a nonexistent audit row. A
deterministic interleaving test catches this; simultaneous cron calls alone did not.

The controller staged a worker's green implementation before its final freeze;
the worker's last strict-type test fixes then remained unstaged. Wait for final
handoff, not an intermediate green report, before staging shared-worktree changes.
Final gate wrappers also assigned the reserved zsh variable `status`, causing a
shell error after successful tests. Use a nonreserved `rc` variable and preserve
the command's exit code; rerun affected verification rather than confuse wrapper
failure with application failure or silently discard an exit status.

PR review found that collector error provenance was lost before executor outcome
classification: a malformed search connection manufactured `github_forbidden`,
and a later-page 403 escaped as if it were first-page absence. The earlier review
and tests covered security pagination but not ordinary saved-page collectors.
Require explicit access errors for first-page absence, and record accepted pages
independently of row counts so empty pages cannot hide interrupted pagination.
Executor regressions must assert the failed step, partial run and same-run
publication, history counts, and unchanged prior snapshot/time together.
The next MAX pass also reproduced access loss across global Issues/PR queue
chunks: local page counters reset, but the durable snapshot cursor remains.
Completeness guards must use both boundaries, not only pagination within one call.
Security GraphQL errors must also distinguish a missing connection from a partial
connection. If a nodes array survives error-path filtering, the response is
incomplete even when every denied node was removed and the array is now empty.
Catalog pagination also needs a nonempty new string cursor whenever it advertises
another page. Missing cursors previously published a false complete empty catalog;
invalid or repeated cursors now fail without replacing saved repositories/time.
Checking only a truthy pagination flag was still insufficient: omitted flags
silently looked terminal. Require an explicit boolean flag, and validate cursor
types before issuing a continuation request, across ordinary GraphQL connections.
An invalid REST next link is also incomplete, not absent. Returning null from a
failed URL parse silently converted a declared continuation into successful EOF;
the parser now preserves that distinction and ordinary collectors retain old data.
Apply the surviving-connection rule consistently to search as well as security:
an empty array after denied nodes are removed is still partial evidence, not whole
source unavailability. Denial fixtures must model a missing connection explicitly.
The old global/repository search switch also classified the same first-page
GraphQL denial differently. Remove that split, retain durable-cursor checks for
later chunks, and propagate known source unavailability to dependent Insights
without masking failed or absent prerequisites. Full-plan controls must isolate
other malformed fixture responses, not mistake an unrelated failure for denial.
The same boundary check found that the shared REST list helper accepted either an
array or an Actions envelope for every endpoint. Require the endpoint's actual
container so a wrong-but-empty JSON shape cannot erase evidence as a successful zero.
The final row-shape pass reproduced the same false-zero outcome after invalid list
elements were silently filtered. Validate record elements before filtering or
mapping; null REST rows, primitives and nested arrays must make collection
incomplete. Legitimate empty lists and nullable optional record fields remain valid.

## 2026-10-21 - Clean up acceptance accounts independently of test order

After the unknown-query regression failed as intended, Vitest prioritized that
previously failing HTTP file on its next run. The machine API acceptance test
revoked its tokens but left a newly created active account behind. The later
method matrix then received `snapshot_missing` instead of `account_missing`.
The query fix passed its unit tests and commit hooks, but the complete HTTP run
correctly caught this fixture leak. Record pre-existing account IDs and delete
only the account created by this test in its cleanup; do not change the matrix's
assertions or depend on cached file ordering. Wait for the full HTTP result before
claiming acceptance, even when focused tests and commit hooks have passed.

During this task a Herdr resize using `--current` resolved the UI-focused pane
instead of the caller. The command reported `changed:false`, so no unrelated
layout changed. The corrected command used the explicit owned pane ID. Use
explicit pane IDs for layout mutations and verify the returned target.

The factory-window HTTP regression repeated the earlier query-metadata mistake:
its no-write assertion compared Wrangler's entire response, including variable
`meta.duration`. A later run failed on 0 ms versus 1 ms with identical saved rows.
Use the existing neighboring test's `statement.results` comparison for both reads.
Review new fixture assertions against recorded incidents, not just one green run.

## 2026-10-21 - Separate fixture transport failures from contract regressions

The first green HTTP run for saved factory rate projection failed with
`ECONNRESET` before any rate GET reached the Worker. Four synchronous Wrangler
fixture commands preceded a pooled HTTP counter read; an expired keep-alive
socket was a plausible cause, not a proven product defect. Move the counter
baseline ahead of the blocking local SQL setup, which makes no upstream requests.
The subsequent complete A/B suites passed without retries or a production
fallback. Keep this transport failure separate from the earlier assertion-based
red tests, and avoid long synchronous fixture blocks immediately before pooled
HTTP reads when arranging read-only/network-count evidence.

The source profiling fixture initially assumed the unit SQLite schema already
contained `_test_marker`; it now creates and verifies its own marker before
inserting data. An expiry test also initially violated the database constraint
`expires_at > created_at`; both synthetic timestamps must describe a valid token
that has subsequently expired. During conditional HTTP testing another redundant
counter read after blocking CLI commands hit an idle connection close. That
duplicate assertion was removed while independent source tests and the new
read-only/network-denying profiler retained no-collection evidence. The corrected
red run failed for the missing validator, not fixture setup or transport errors,
and both complete HTTP suites subsequently passed. No existing or remote data was
used by these fixture corrections.

## 2026-10-21 - Include non-item metadata in bounded collection failures

Moving package identities into `manifests` left the existing byte-limit loop
shrinking only `items`. Independent review supplied a 1.3 MB package version,
below the upstream 4 MB response limit but above the stream's 1.2 MB budget.
After the last item was removed, metadata still exceeded the limit and the loop
never terminated. Normal gates were green because they covered oversized items
and responses, not metadata-only overflow.

New tests first reproduced both fresh and reused paths in owned subprocesses
with a three-second timeout, preventing the regression from blocking Vitest's
own timer. The same scenarios then run in-process for coverage. Collection now
raises the existing `factory_capacity` error when no items remain to trim; the
existing run error path restores its checkpoint, pauses safely and preserves
prior evidence. The tests assert no resource writes and unchanged prior data.
Whenever a payload gains metadata outside a bounded list, verify that every
capacity loop can still make progress or terminate with a controlled failure.

## 2026-10-21 - Review resumable failures and both rate buckets

The first batch-four unit run was green, but independent review reproduced a
terminal contribution failure that the GraphQL-only denial fixture did not cover.
An HTTP 403/404 or exhausted retry restored a pending checkpoint after finishing
the contribution step. Later repository streams resumed that pending work, failed
their own coverage checks and could publish the calendar that should have been
retained as failed evidence. New tests first failed on the pending state, then
proved terminal unavailability, successful downstream repository work and exact
retention of the old calendar, original window and observation time. Test transport
errors and exhausted retries as well as in-band GraphQL errors whenever a formerly
single-page stage becomes resumable.

The added PR node batch also replaced the preceding REST quota with GraphQL quota,
so a low core reserve could disappear behind a healthy GraphQL balance. Separate
bounded checkpoint buckets now survive page boundaries, metadata transitions and
evidence rollback; the public rate remains the latest observation. Regressions
first reproduced both alternating-resource exhaustion and loss of a spent REST
budget when the details request failed. Rolling back data does not undo an
upstream request or its observed quota consumption.

Initial L2 acceptance additionally caught an expired synthetic token whose creation
time was after expiry, and old exact PR assertions missing the newly additive
fields. The expiry fixture now has a valid historical lifetime; account/repository
PR checks share one expected shape. These repeat earlier fixture lessons: compare
the real schema constraints and neighboring assertions before running a long suite,
and do not equate focused unit success with HTTP acceptance. The enabled commit
hook also rejected optional-property assignments until strict TypeScript passed;
no failing commit or hook bypass was used.

A repeated Herdr `--current` resize again resolved a different focused pane and
reported `changed:false`; no unrelated layout changed. All subsequent mutations
used explicit task-owned pane IDs. Read the existing orchestration lessons before
issuing layout commands, not only after the same error recurs.

## 2026-10-21 - Keep dependency identity fixes dependency-free

The batch-four addendum initially chose a YAML library to recover workflow job
keys. Although the registry override was per-command, Bun rewrote 411 existing
lockfile resolution URLs to the temporary mirror. The steward rejected the new
dependency and required restoring both package manifests and the lockfile. Those
three files were restored before any commit; the lockfile was verified byte-for-
byte against origin/main. The replacement uses the explicitly approved bounded
indentation scan, with tests for job keys, steps, comments and scalar script
bodies. Dependency maintenance is not an implicit part of a narrow identity fix;
check the requested scope before installing, and verify lockfile bytes rather
than assuming a temporary registry override leaves the file unchanged.

A new legacy-stream unit test initially reused one request-scoped D1 wrapper for
all seven streams, so its statement counter eventually hit the production cap.
Each stream now gets an independent fixture through parameterized tests. An
early shell command also continued to the commit attempt after focused checks
failed because it used semicolons. The enabled hook correctly blocked the commit;
subsequent validation-to-commit chains use short-circuit execution. Test-fixture
failures must be fixed, never bypassed or mistaken for application regressions.

The first addendum L2 rerun also rejected a browser assertion copied from the
machine stream's collection order. Browser detail intentionally sorts by event
time and ID, so the added workflow ID precedes the numeric package fixture ID.
The expected browser order was corrected without changing either API's ordering.
When sharing new evidence fixtures across readers, verify each reader's ordering
contract instead of assuming identical arrays from identical source rows.

Self-review then found that YAML block scalar headers permit both chomping/indent
orders (`|-2` and `|2-`). The initial scanner recognized only one order and could
misread script text as dependency declarations. Parameterized fixtures first
reproduced literal and folded failures, then verified both orders. Even a scoped
line scanner must exclude all supported scalar-header forms before reading body
lines as structural keys.
The same regression matrix also caught legal trailing spaces after the indicator;
mapping values now trim trailing whitespace before structural classification.

Independent review found that ID generation treated absent and empty refs as the
same string while the collision bucket compared their raw values. Both records
survived but received the same ID. A failing regression now preserves both raw
records and checks unique IDs, reorder stability and idempotence. Collision
classification must use the same normalized value as the generated identifier,
while evidence equality still compares the complete original record.

The review also reproduced dropped actions after folded `if` or `name` step
properties. The scanner used the sequence dash's column as the scalar boundary,
mistaking a later sibling `uses` key for scalar content. Separate red/green cases
now prove the action survives; the scalar boundary uses the property key's column
after any sequence prefix, without weakening exclusion of actual script bodies.

## 2026-10-21 - Do not equate an unrecognized workflow with zero dependencies

Steward review found that uniformly indenting a valid workflow made the scanner
miss `jobs`, then publish complete coverage with zero observations. Earlier tests
varied nested indentation but assumed column-zero root keys. New failing tests
exercise root indentation at mapping and collection level, and reproduce loss of
a prior repository version through the publication writer. The scanner now finds
the actual root indentation, distinguishes missing files from unparsed present
files, and marks unsupported job evidence limited. The existing regression guard
then retains stronger data, its source version and original window. A bounded
scanner must report uncertainty explicitly instead of treating an empty parse as
proof of absence; parser regressions need collection/publication assertions too.

Independent re-review found that recognizing a job key was still insufficient:
flow mappings/sequences on the next line and explicit mapping keys were silently
ignored. New failing collector/publication cases now cover these structures and
use different old/new windows to prove window retention rather than equality by
fixture coincidence. After excluding scalar bodies, every unrecognized line in
the jobs block now fails closed. Unsupported syntax must be rejected by default,
not handled through an ever-growing list of examples that happen to be rejected.

The next review reproduced empty job values and null/mapping-valued steps being
accepted solely because their keys existed. Twelve failing collection/publication
cases now require a nested job mapping and a steps sequence (or an explicit empty
sequence). Recognizing a property name does not establish the shape of its value;
empty block headers need evidence from the following significant line.

The same review found script text inside multiline quoted or tagged scalars
being collected as dependencies. Failing regressions now reject unsupported
quoted continuations, tags and anchors instead of extending YAML parsing. Mapping
separators must also be real YAML separators, so colon-without-space text inside
a continued plain scalar cannot become a uses key. Complete single-line quoted
values and the already recognized literal/folded scalar headers remain supported.
The scope is deliberately fail-closed, not comprehensive YAML compatibility.

Final scoped review found that a nested env/with field named uses could still
be mistaken for a dependency, including a false ref collision that renamed a
real action. Six failing collection/publication cases now constrain uses to the
direct job or step property column. Other uses positions fail closed instead of
guessing their meaning. The scanner must establish both key and structural
position before assigning identity; matching a name and value is insufficient.

## 2026-10-21 - Keep response-only normalization outside shared storage readers

The aggregate dependency fix initially deduplicated summaries in
`normalizePublication`. GET tests proved unchanged stored rows and query counts,
but independent review found that `publicationWrites` reused that reader as its
baseline and consequently wrote deduplicated legacy summaries into the next
publication. A failing writer regression reproduced the unintended change. The
deduplication now runs in `statisticsFactory`, the account/browser response
projection, while storage readers and writers retain their prior behavior. Trace
both read and write callers before choosing a response-only normalization point;
read-only GET assertions alone do not prove unchanged subsequent writes.

## 2026-10-21 - Keep producer identity and payload examples aligned

The content-version guide updated the stable report ID recipe to use content
hashes, but its two report payload examples still omitted source content hashes.
Independent review caught that copying these examples would retain a stable ID
while the page fell back to refresh-sensitive full-version matching. Both examples
now preserve the observation's full version and content version separately from
the report's composite digest. Validate example JSON against the real schema and
trace the complete read/identity/publish/refresh sequence whenever a producer
contract gains a field; prose and ID generation alone are not end-to-end proof.

## 2026-10-21 - Count stream bytes, not only source queries

The first content-version implementation preserved the five-query `/sources`
bound but eagerly loaded and parsed every referenced immutable stream to compute
hashes. The scale fixture represented factory streams only through publication
metadata, so green query-count tests did not measure their actual payload cost.
Adding one valid near-cap stream per repository exposed about 126 MB of payload
reads on the 126-repository fixture, including requests returning no sources.
Moving filters ahead of stream hashing fixed the empty case but still cost about
255 ms for the newer two-thirds and 66 ms for one repository, well above the
batch-3 baseline. A filtered expensive operation is not necessarily a bounded one.

The correction moves content hashing to the existing snapshot/publication/stream
write paths and saves nullable metadata atomically with the payload. Source reads
project that metadata, using compact stored-hash compositions for account views;
old rows remain null until normal refresh instead of triggering a GET backfill.
Covering metadata indexes prevent large row/overflow-page reads during lookups.
Failing regressions now include real payloads and byte/row assertions in addition
to query counts, while the benchmark records full, partial, empty and repository
requests against the prior latency baseline. Performance fixtures must represent
the data newly accessed by a feature; constant query counts do not establish
constant work, and an intermediate optimization needs the same acceptance target
as the original contract.

Independent maximum-reasoning review then found that hashing raw stream `ranges`
did not preserve the observation window: collection drains that pagination queue
to an empty array. Failing tests now bind content hashing to `[checkpoint.window]`
without changing the saved payload or its full version. The same review exposed
reuse timestamps and coverage request URLs as volatile inputs; content hashing
now excludes root `source_fetched_at` and coverage `source` while retaining
`source_head` and the separately bound semantic window. Stored `fullVersion`
metadata reuses the exact prior raw-snapshot digest rather than silently changing
its serialization recipe; account projections still derive full versions from
their JSON. A write-time hash needs both the final saved data and its semantic
collection context, not merely whichever transport/checkpoint fields survive.

A final metadata-only review also caught CI/factory composites dropping derived
freshness quality when a saved observation time was missing or malformed. Their
hashes now include `total`/`missing`, not the time values; regression tests cover
loss, malformed time and restored confirmation without changing source content.

## 2026-10-21 - Guard date parsing in generic JSON indexes

The initial newest-report expression index applied `julianday` directly to the
generic report payload's `generatedAt`. Generic storage deliberately does not
validate analysis payloads, so an existing or newly written `generatedAt:"now"`
made SQLite reject migration/CRUD as nondeterministic index use. Pre-commit
adversarial tests reproduced both failures. An ISO-shape guard now maps relative,
missing and unparseable values to null before indexed date evaluation, retaining
the rows for normal client validation. Indexing a loosely validated JSON field
must preserve its entire existing write domain, not only valid consumer examples;
test malformed legacy rows during both migration and subsequent generic writes.

## 2026-10-21 - Include fixture overrides in freshness expectations

While updating the factory source regression, an initial expected denominator of
114 excluded the fixture's fork/archive defaults but overlooked its explicit
statistics-disabled overrides. The regression failed before commit; inspecting
the complete fixture established 103 eligible observations. Derive expectations
from all declared selection inputs, including settings seeded later in a fixture,
rather than treating its catalog declaration as the entire policy.

## 2026-10-21 - Compose independent truncation signals

The factory freshness correction initially assigned truncation solely from inventory
completeness. Independent review reproduced a stored truncated publication with a
complete inventory: machine reads incorrectly cleared its existing quality flag.
A failing regression now covers that combination, and both the response and its
content-hash selection OR saved truncation with incomplete inventory. New quality
signals must supplement existing evidence, not replace independent failure flags.

## 2026-10-21 - Distinguish empty conditions from scalar continuations

The initial multiline workflow condition scanner skipped every indented child
after an empty or comment-only `if:`. Controller review found that a YAML mapping
or sequence could therefore disappear as scalar content and falsely retain full
dependency coverage. Adversarial tests reproduced the acceptance before the fix.
Empty headers now require a plain scalar continuation; mappings, sequences,
aliases and flow children fail closed. Test scalar-shape boundaries separately
from literal/folded block bodies, where key-like text must remain uninterpreted.

## 2026-10-21 - Guard JSON1 extraction over generic JSON

Independent review found that a schema-accepted report extension containing 1,000
nested arrays exceeded SQLite JSON1's depth, despite fitting the generic payload
byte limit. The new expression index made migration and generic POST/PATCH fail
with malformed JSON. Red regressions reproduced all three failures. Index and
query extraction now guard the full payload with `json_valid`; uninspectable
components become null without deleting or rejecting the resource. Expression
indexes over generic data must handle the storage schema's full legal domain,
not just structurally valid consumer reports.

## 2026-10-21 - Preserve accepted datetime precision in report ordering

Independent review reproduced legal sub-millisecond report generations sorting by
ID instead of time: SQLite `julianday` and client `Date.parse` collapsed distinct
fractions. Date conversion could also round `.9999` into the next second. Red
tests now cover microseconds, long fractions, trailing-zero/offset ties, the full
Zod offset range and child/parent chronology. Index/query and client comparisons
separate whole seconds from normalized fractional digit strings; fractions never
enter numeric date conversion. Match ordering precision to the accepted schema,
not the default precision of a convenient datetime API.

## 2026-10-21 - Validate every plain condition line

Final review found the empty-header correction still skipped flow arrays/maps in
nonempty `if:` headers and mapping-like lines after an initial plain condition.
One positive fixture was itself invalid YAML: a plain condition followed by
`uses: fake/...`. Ten red cases reproduced acceptance of flow collections,
mapping/sequence-like lines and comment-ended continuations. Plain and block
scalar modes now differ: every plain line is checked, while literal/folded block
bodies deliberately ignore key-like text. Corrected block fixtures and valid
multiline expressions protect both paths. Confirm fixture syntax independently;
an indentation test must not turn unsupported structure into successful evidence.

## 2026-10-22 - Separate response shape from reader latency

The new consumer timing report also showed about 33 KB of additional source-index
JSON. Dropping nullable content hashes would violate the documented eight-field
contract without establishing the cause of the reported latency. Cross-release
real-stream/all-null measurements instead isolated sub-millisecond metadata lookup
cost and accounted for exactly 22 bytes per required null property. Keep raw body,
reader CPU/SQL and network/edge timing distinct before choosing an optimization.

The first scratch comparison harness failed parsing before producing any samples;
its missing helper brace was corrected and that failed attempt was excluded. All
reported results come from three completed, revision-rotated rounds with query,
payload and response-shape assertions. Validate benchmark execution and fixture
equivalence before interpreting timing differences, and never merge failed or
incomplete runs into reported percentiles.

The cleanup command initially assigned a worktree directory to zsh's special
`path` variable, replacing command lookup paths; it stopped before deletion.
After renaming it, the clean-tree guard also correctly stopped on the owned,
untracked dependency symlink. Cleanup then verified tracked cleanliness, the
exact untracked entry and symlink target before unlinking it and removing each
worktree normally. Use descriptive shell variable names such as `worktree_path`,
and distinguish verified owned setup artifacts from unexpected modifications.

## 2026-10-22 - Verify participation before changing refresh policy

The batch-8 report initially described thirteen repositories missing from weekly
statistics and two starred repositories apparently receiving only security work.
Code inspection found intentionally independent statistics and detail-page lanes,
but an early proposed fix would have unified their membership and introduced a
new incomplete-catalog failure. Before runtime edits, corrected evidence reported
all thirteen repositories had statistics disabled. Local fixtures reproduced the
omissions under explicit overrides and showed all nine detail pages still planned
for the two starred repositories. The behavior change was cancelled; no selection
runtime edits or production settings changes were made. Distinguish participation,
planned steps and observed changed snapshots before treating separate lanes as a
bug. The exact production execution history remains unverified locally.

## 2026-10-22 - Count database trips before optimizing source CPU

Local source benchmarks measured near-zero database transport latency. They could
not explain production wall time by themselves: supplied observability separated
roughly 2.2 seconds of wall time from 152 milliseconds of CPU, with single-query
latency increasing by edge distance. The existing authentication lookup followed
by five sequential source queries explained the amplified transport cost. Measure
actual D1 round trips, not just statement counts, and test with injected latency.
Keep query execution time distinct from transport and overlapping response phases;
do not label wall-clock measurements as CPU time or change deployment placement
without authorization. Instrumentation must stay outside response bodies and
content validators, and never expose SQL, identities or credentials.

## 2026-10-22 - Audit derived reads after changing summary flags

The per-feature security implementation corrected collection and refresh-time
Insights, but its first integration still used the old top-level unavailable
predicate when rebuilding Insights on GET. Independent review reproduced a
false-clear result and unavailable counts recomputed as zero. Follow-up fixtures
covered actual all/starred browser reads, mixed repository replacement, legacy
metadata, and catalog members absent from older evidence. Feature metadata must
follow the selected evidence and its time; copying an aggregate flag or a newer
timestamp onto other evidence silently changes its meaning.

The same review found that separately bounded current and retained security
could exceed page capacity when combined. Preview the final payload, including
retained metadata and its saved timestamp, before producing write statements;
assert exact prior rows survive a near-cap failure. A successful unavailable
outcome is not permission to publish truncated available data. Full API/browser
gates also exposed stale PR-state and security-empty assertions missed by focused
unit tests; update them to verify the new contract, not to suppress failures.

## 2026-10-22 - Isolate version baselines from presentation changes

Batch-8 lifecycle normalization added a response-only state field before fallback
version hashing. Unmodified legacy PR rows therefore changed source-index versions
and conditional ETags. The first performance comparison could not catch it:
only its reader came from the baseline revision while relative imports resolved
to the current checkout. Separate presentation from the established digest shape,
and compare full exported baseline dependency trees against identical saved rows,
both with null and populated content metadata. Check the old ETag returns 304 and
that reads leave every stored row unchanged; a current-to-current hash assertion
is not cross-version evidence.

The standalone `bun test tests/bench/source-legacy-version.test.ts` comparison
requires local Git object `8c20328c46ae4ef64325c156007dba7d0857216a` and forbids
network access. It is separate from L1 because the shared CI checkout is shallow;
L1 retains an explicit legacy digest-shape regression without fetching history.
The performance runner now exports all baseline source dependencies as well.

Earlier full gate runs also overlapped the last runtime edit and Worker reloads.
Those logs were rejected as exact-revision proof. Freeze the clean candidate
before build and complete HTTP/browser suites, record its SHA at both boundaries,
and reject reloads rather than combining passing results from different versions.

## 2026-10-22 - Normalize completeness at the final storage boundary

The batch-8 account projection downgraded storage-truncated feature coverage, but
repository reads bypassed that projection. An actual refresh collecting 100 code
scanning alerts saved only 98 across its two bounded pages and still displayed
the feature as available. Apply the same normalization before final serialization
and when decoding older pages, rather than fixing each consumer separately. Test
the refresh write followed by both browser and machine repository reads, verify
both physical pages and their metadata, and retain existing hashes on read-only
legacy corrections. Fixture authorization failures were corrected before counting
the four genuine available-versus-partial failures as RED evidence.

## 2026-10-22 - Verify pane geometry and explicit targets

During batch-9 documentation review, the controller interpreted a split ratio as
the new right pane's share, leaving the controller at two-thirds width instead of
one-third. A corrective resize using `--current` resolved to a focused pane in a
different workspace; its response reported `changed:false`, so that workspace
was not modified. Resizing with the controller's explicit pane ID restored the
intended layout. Treat split ratios as the existing pane's share, use explicit
pane IDs for resize operations, and verify returned workspace, tab and geometry
before continuing. The review pane was closed after collecting its result.

## 2026-10-22 - Respect shell names and verify delegated layout

The batch-10 controller used `path` as a zsh loop variable while inspecting
instruction locations, despite the brief prohibiting it. zsh aliases `path` to
`PATH`, so later commands in that subprocess could not resolve. No repository or
global shell configuration changed. A fresh command process restored the inherited
environment. Use descriptive names such as `instruction_file` rather than zsh
special variables, and check brief-specific command constraints before execution.

The controller also repeated the split-ratio mistake already recorded above:
`0.67` left the controller too wide. An explicit resize of `wH:p1T` corrected it,
and the returned geometry confirmed 41 of 125 columns for the controller with
workers only on its right. Verify actual geometry immediately after splitting;
remembering the rule without checking the returned layout is insufficient.

## 2026-10-22 - Freeze code and schema during HTTP acceptance

The batch-10 controller started the full local API runner while R1 workers were
editing the watched Worker and adding a migration. The new provenance journey
first failed because GET stars did not yet exist, but subsequent requests also
saw reload-related connection loss and 500 responses. That mixed-revision run
cannot establish integration health or attribute the later failures reliably.
Use focused isolated tests for concurrent TDD; freeze implementation and schema
before starting the real HTTP runner, which initializes its database only once.
Recreate the runner's fixture database after migrations change and rerun all
acceptance checks against the frozen candidate.

## 2026-10-22 - Prove the intended failure and response boundary

Two batch-10 test drafts failed for the wrong reason: a timing fixture used an
obsolete account column, and a scheduler race interceptor matched different SQL
from the actual idempotency lookup. Correct the fixtures first, then rerun the
original implementation to prove the intended RED before counting GREEN evidence.
Repeated independent reads in a single test also exhausted the request-scoped
D1 statement budget; each simulated request needs its own database wrapper.

A standalone JSON Response bypassed Hono's prepared private headers before ETag
handling, dropping cache-control and referrer policy on 304 responses. Construct
the response through the context and assert conditional headers alongside exact
body bytes and ETags in cross-version tests. HTTP status/body parity alone is not
proof that authorization-sensitive caching behavior has survived refactoring.

## 2026-10-22 - Keep browser fixtures on the projected contract

Batch-10 browser mocks still returned raw stored factory snapshots after the API
introduced required selected membership. The page could not render, although
focused projection tests and real API checks passed. Build typed projected mock
responses after fixture mutations, and update star-write acknowledgements with
the server-confirmed fields. Keep raw storage fixtures unchanged; never repair
test drift with a runtime denominator fallback that hides unpublished members.

The follow-up BDD run also caught an obsolete missed-slot expectation, and its
page context exposed stale help text promising latest-slot-only processing.
Verify explanatory UI copy as well as error labels when scheduling semantics
change. A schema-doc correction then omitted the machine endpoint's account
segment. Copy full mounted paths from route registration, not from a local
handler path or recollection, and independently review the correction itself.

Final review found duplicate current-contract paragraphs still describing the
retired membership policy, latest-only schedule recovery and unrestricted old-code
rollback. Updating the new sections alone left contradictory operational advice.
Search every current runbook for superseded concepts when contracts change, while
preserving clearly dated investigation evidence. Review rollback instructions
separately from additive schema safety: retained tables do not make old semantics
safe for new tombstone rows.

## 2026-10-22 - Reject payload savings that increase database work

Batch 10 reduced source payload bytes by rebuilding JSON arrays inside SQLite on
every read. The measured SQL CPU increase outweighed the modest byte reduction,
including requests that returned no changed sources. Disclosure did not make the
tradeoff a useful optimization. Independent review rejected it, and fix round 1
restores direct payload reads in a forward commit. Compare alternating repeated
samples of database and whole-request cost before accepting a transport-byte
optimization; do not infer lower remote latency from smaller payloads alone.

## 2026-10-22 - Verify fenced writes by reading physical children

During batch 11 activity publication work, an immutable-page existence predicate
was appended after `$guard`. The shared `fenced()` helper appends lease bindings
after all caller-provided values, so the SQL placeholder order no longer matched
the values. The header and run save could succeed while every page insert affected
zero rows. Focused publication readback and independent review reproduced the
missing pages before any commit or external publication. The fix puts caller
predicates before the guard and keeps physical page-count, nonempty readback,
immutability and revoked-lease assertions. A successful transaction or parent-row
write is not proof that fenced child writes stored the intended data; check both
the placeholder contract and the returned publication contents.

The same integration pass found that the Today missing-publication browser
fixture used the older `snapshot_missing` code while the API returned
`activity_unpublished`. Adding a display mapping alone was insufficient because
the client normalizes unknown error codes to `internal_error`. Tests now exercise
the real API code through normalization as well as the pending-state UI. Keep
fixtures, the accepted error-code registry and the displayed state on one contract.

Independent review also completed an active predecessor between history lookup
and new-run admission. The new activity window had already frozen the older
predecessor and overlapped the just-completed window. Admission now compares the
predecessor/interruption fingerprint atomically and retries on change; an explicit
interleaving regression preserves seamless boundaries. A read followed by an
atomic insert does not make the earlier derived values atomic with admission.

The controller started L2 and L3 together after checking their documented HTTP
and fixture ports. L3 failed before tests with a Wrangler socket-address conflict.
Distinct application ports did not prove full process isolation. Port 9229 was
owned by an unrelated existing service, not this task; no unrelated process was
terminated. The controller retained the running L2 lane and reran L3 serially
after cleanup, without changing deploy configuration. Check auxiliary listeners too,
or serialize these existing runners; a startup failure is not passing UI evidence.

The first activity HTTP fixture incorrectly assumed that a response ETag used the
same SHA-256 representation as the stored content fingerprint. The installed Hono
middleware uses SHA-1 for response ETags, while source content versions are a
separate contract. The fixture now checks the middleware's actual quoted tag and
conditional 304 behavior rather than conflating these identifiers.

The next browser run started while its progress assertion was still being fixed.
It loaded the new maximum (28) but the previous expected value (26), then failed
even though the checked-in file eventually contained both corrections. This was
not a second production defect and not passing full-suite evidence. Freeze test
files as well as production code/schema before starting a full runner; bind the
recorded result to that frozen tree and rerun after any test correction.

## 2026-10-22 - Replay catalog backfill after identity changes

The initial discovery migration ignored conflicts on its historical identity key
but also introduced a unique current repository name. Independent review replayed
the migration after a stable-ID rename: the existing identity kept its old key,
while the current saved catalog held the new name. Backfill attempted a different
key with that same current name and failed the unique index. Initial double-apply
alone did not cover this valid post-migration state. Guard existing identities and
current names, then replay after ID adoption, rename and removal; assert no new
events, no resurrection and no immutable-history changes. Backup verification
must cover evolved application data, not only a pristine migrated fixture.

## 2026-10-22 - Count the final serialized page envelope

The snapshot splitter tested candidates with `truncated:true` but could later
serialize `truncated:false`, which is one byte longer. Exact multibyte fixtures
reproduced a 1,500,001-byte page. The same check also missed oversized metadata
outside the selected array, including its empty-array fallback. Candidate checks
now use the current final flag (later truncation can only shorten it); compact
fallbacks are checked separately and unrepresentable metadata fails before write.
Keep boundary assertions on serialized UTF-8 bytes, not string lengths or item
sizes, and cover the no-item/no-array paths as well as normal two-page output.

## 2026-10-22 - Preserve identity through simultaneous renames

Single-repository rename fixtures hid two valid production cases. A rename chain
or swap collided with current-name uniqueness before the old names were released.
Also, the normal run writer omits the optional physical `observation.repo`, while
the fixture always supplied it; moving the mutable key then lost the immutable
version join and its garbage-collection root. Stage name changes inside the same
atomic publication and capture the original physical key before moving state.
Exercise both listing orders, owner/agent star provenance, the real quick executor
and garbage collection after old publication/recent-run roots retire. A fixture
must include the actual writer's minimal valid shape, not only enriched examples.

## 2026-10-22 - A reused repository name is not its old identity

Discovery retained immutable history correctly but readers still matched it by
name. After a confirmed deletion and different-ID recreation, old factory streams
could appear current; catalog restore could even bind old legacy resources to the
new ID. A removed row also inherited a same-name replacement's owner star. Match
known stable IDs before current projection, stream reads, source completeness and
legacy restore. Keep removed rows unstarred independently of mutable name-based
selection. Regression fixtures must perform actual removal and recreation, cover
both run and legacy evidence, and distinguish same-ID reappearance from new-ID
replacement while asserting that immutable history remains byte-identical.

## 2026-10-22 - Native SQLite does not prove D1 SQL limits

Adding three catalog tables to the storage telemetry UNION raised the compound
SELECT from four terms to seven. Native SQLite tests passed, but real local D1
rejected the query and `/factory/runs` returned 500. A local D1 replay confirmed
five terms succeed and six fail. Keep the existing four-term compound query and
add catalog scalar aggregates inside the same statement, preserving UTF-8 byte
accounting, bindings and one round trip. Pair native transaction tests with a
named D1-limit regression and real HTTP verification; native SQL compatibility
does not imply identical engine resource limits.

## 2026-10-22 - Absence is not positive legacy identity evidence

The first replacement guard rejected a different ID only when the old name still
appeared in the current factory publication. Independent replay advanced that
head past the deletion, and restoration again rebound old legacy resources to a
new ID. Restoration now requires positive agreement on stable ID, physical key,
legacy source and original version from a retained publication/root or exact
immutable version; unknown provenance yields no writes. Test the full lifecycle
including the intervening empty publication, and retain original windows and
timestamps rather than deriving fresh ones from unrelated stream versions.
