# Retrospective

Accident narratives for this repo.

Routing: narrative stays here. A project-specific rule that will recur may become one line in `AGENTS.md`. Cross-project lessons go to nmem or a global rule. If it can be checked by a machine, add a hook or test instead of prose.

## 2026-09-24 v0.9.0 tag release raced main CI

Pushed `v0.9.0` immediately after pushing main, before CI on `ad7f242` finished. The tag-triggered Release workflow resolves its source by requiring an already-successful CI run for that SHA, so it failed in 12s with `No successful .github/workflows/ci.yml run on main for ad7f242`. Fixed by waiting for CI green, then `gh run rerun`. Rule: after pushing the release commit, wait for the main CI run to succeed before pushing the version tag; the workflow_run path will already deploy main on its own.

## 2026-09-24 palette verification mistakes

The first isolated visual probe requested `127.0.0.1` while Vite was listening on IPv6 localhost, so Chromium refused the connection. Using the actual listening host fixed the probe without touching the daily server. Verify the bound address before diagnosing application failures.

An unanchored CSS replacement also matched the suffix of two status-specific icon selectors and temporarily gave them the generic info color. Diff review caught this before commit; the warning/success icons were restored to semantic colors while their data marks retained candy fills. Anchor selector edits to complete rules and inspect the resulting diff before accepting a bulk color change.
