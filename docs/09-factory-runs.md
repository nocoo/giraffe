# Factory runs: retired in v0.26.0

The resumable factory-run model is no longer an application capability. Its
executors, admission logic, leases, schedule processing, continuation workers,
run controls and collection modes have been removed. Existing run/schedule tables
are inert historical storage; the application does not migrate or resume them.

Machine run endpoints retain authenticated unavailable/empty responses for
consumers. Browser run and schedule routes are removed. See the exact endpoint
matrix and post-deploy checks in [Phase 1 retirement](14-phase1-retirement.md).

Saved factory publications and resource streams remain readable through the
Dashboard and machine API. Their original windows, coverage and provenance are
observations, not evidence of a currently running collector. No phase-2 collector
is included in this release.
