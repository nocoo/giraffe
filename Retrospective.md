# Retrospective

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
