# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v0.5.0 — 2026-09-16

### Added
- Software factory dashboard at `/factory`: overview, language/topic groups, repository drilldowns, and paginated commit, Issue, PR, Actions, Release, and dependency evidence
- Contribution/commit calendars, proportional repository treemap, throughput areas, WIP scatter, sparklines, observed dependency links, and accessible daily ledgers
- Resumable GitHub collection with complete owned-repository pagination, frozen 90-day windows and default-branch heads, explicit exclusions, source timestamps, and per-resource coverage
- Local `factory:audit` and isolated Worker/D1 `factory:preview` commands; survey methodology, real investigation results, and independent review records

### Changed
- Lazy-load page modules and share chart chunks to reduce the initial JavaScript bundle
- Use pinned shared quality and Worker deployment workflows with proven-source SHA verification

### Fixed
- Use Workers-supported manual redirects and explicitly reject 3xx responses before credentials can be forwarded
- Preserve GitHub pagination filters when Link headers use numeric repository URLs; split large Actions queries without time gaps
- Keep unavailable, incomplete, observed-zero, and truncated lower-bound measurements distinct; filter PR/Issue detail by the selected lifecycle date
- Prevent concurrent refreshes and mixed survey generations; preserve the previous snapshot when the first restarted request fails
- Isolate malformed dependency manifests and partial permission loss; avoid ambiguous package-name dependency edges
- Serve audit previews from built Worker assets with valid local account IDs

### Data scope
- No database migration is required; factory data uses the existing snapshots table and is collected on demand
- Dependency evidence covers root manifests and named workflow entrypoints; unavailable security data remains unknown
- Resource limits are explicit (5,000 records / 1.2 MB), and the current UTC day is incomplete

## v0.4.2

### Fixed
- Add `status: "ok"` and `Cache-Control: no-store` to `GET /api/live` health endpoint
- Probe the D1 binding and return HTTP 503 on database failure; keep the optional test marker separate from readiness

## v0.4.1

### Changed
- Upgrade `@nocoo/basalt` to 2.1.2
- Standardize bilingual project README

### Fixed
- Patch `hono` 4.13.7 and override `sharp` 0.35.4 so osv-scanner passes

## v0.4.0

### Added
- Candy-tone badges on catalog pages, using Basalt accent fills and white text
- Basalt Green locked as the default primary accent

### Changed
- Align the sidebar mark with family chrome at 24px

### Fixed
- Lighten loading skeletons to `SkeletonLine` on L2 cards
- Skip skeletons when a page finishes loading within 200ms

## v0.3.1

### Added
- AccentProvider brand green from the logo leaf
- Refined giraffe identity mark

### Changed
- Upgrade `@nocoo/basalt` to 2.1.0
- Pin client chrome to Basalt 2.1.0
- Move the daily wrangler sidecar to 37045 so 7046 stays the lizheng preview

### Fixed
- Keep the sidebar mark still while collapsing
- Use the five-color chart cycle for unlabeled and changes-requested series
- Restore success-badge contrast on the 30% green token
- Record giraffe 7045 / 37045 ports

## v0.3.0

### Added
- Insights board with sectioned KPIs and one chart per card
- Themed KPI cards and icons on repos, issues, PRs, alerts, inbox, digest, and repo detail
- Table chips, meters, and sortable headers
- Logo mark and leaf-green primary theme
- PageHeader well and SectionRule layout on catalog pages

### Changed
- Upgrade `@nocoo/basalt` to 2.0.2
- Drop the duplicate repo table from Insights

### Fixed
- Align page-header control heights
- Remove table-like header dividers from KPI and chart cards
- White-on-fill contrast for themed buttons
- Access empty states and settings card headers
- Skeleton blocks for non-text placeholders

## v0.2.0

### Added
- Basalt dashboard SPA with app shell, sidebar nav groups, and page chrome
- Catalog CSS tokens and color utilities on pages
- Vite HMR via `bun run dev` with `/api` proxy to wrangler
- Sidebar identity from lizheng.blog author profile
- Header GitHub icon linking to the public repo

### Changed
- Upgrade `@nocoo/basalt` to 2.0.0
- Pin client stack docs to Basalt 2.0.0
- Verify `/api/live` version after Worker deploy

### Fixed
- Inbox cache after mark-read writes
- Command palette stacking outside overlay
- Sidebar chrome and extra rail wrappers
- Hide `.dev.vars` from wrangler types check
- Name missing PAT scopes and map add-account field errors
- Apply local D1 schema on boot
- Add-account pending state and skip insights GET without sources
- Nest pages in LayerCard surfaces
- Toast, page skeleton, and single-row title/filter toolbar
