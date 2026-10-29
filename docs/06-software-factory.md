# Software factory: saved observations

As of v0.27.0 the factory is a Dashboard over unified-refresh saved observations.
Reads are side-effect-free; explicit refresh and the fixed daily schedule execute
A then serial B. The old collection stack remains removed. See
[Phase 2 unified refresh](15-unified-refresh.md) for API and deployment behavior.

## Display semantics

- Keep the existing Dashboard cards, date filters, repository table, charts and
  repository detail navigation. All values describe saved observations.
- Display original source timestamps and windows. A read cannot renew freshness.
- Missing data or unsupported observations show an explicit empty/unavailable
  state. Never turn missing coverage into zero or a complete success.
- Complete measured zero remains zero; partial observed counts remain lower
  bounds where applicable, and CI ratios only describe their observed sample.
- Repository disk size is GitHub disk KiB; language totals are Linguist bytes,
  not lines of code. Topics can overlap and are not additive categories.
- Historical commits describe the saved default-branch window, not all branches
  or exclusively the owner's personal contributions.
- Factory stream reads remain bounded and paginated. Per-repository provenance
  may differ from the global snapshot; do not silently widen source windows.

## Boundaries

GET reads local D1 only. Saved publications are not republished, collected or
rewritten when viewed. Account PAT validation remains separate from collection.
Refresh controls are unavailable; no quick/deep/full run, scheduler, background
consumer or replacement A+B collector exists in this release.

Legacy storage stays in place without a migration. Historical implementation
investigations are not current execution runbooks. External producers may use
the authenticated machine resource API, but they cannot start collection or
make Giraffe execute analysis code.
