# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v0.9.0 — 2026-09-24

### Added
- `GET /api/ci` classifies saved CI runs into workflow and lane streams, folds numbered and Dependabot jobs, and judges each stream broken (consecutive or chronic failures), flaky, healthy or idle, with release cadence per repository
- CI and releases page: summarizes stream verdicts, lists broken workflows first with recent run strips, splits recovered failures into recurring and one-off, charts 30 days of outcomes and ranks releases by pipeline state and staleness

### Changed
- Sidebar navigation is grouped by purpose (overview, repository health, to-do, system) with the flat item list derived from the groups so order has one definition

### Fixed
- Run strips read oldest to newest with the newest cell enlarged and outlined, an old/latest axis on cards and per-cell timestamps; factory sparklines label their start and end dates

## v0.8.0 — 2026-09-23

### Added
- Per-repository "participates in statistics" toggle: forks and archived repositories default off, manual overrides persist in the new `repo_statistics` table and apply at read time to factory, insights, digest and all cross-repository lists
- Repos page lists the toggle as its first column with independent visibility/archive columns and a header-side data-updated stamp; the management list keeps disabled repositories available for re-enabling
- Weekly pulse and motion sections on the factory dashboard
- List-page aggregation view models for boards, insights and overview, shared by new overview cards, rank bars and repository charts across inbox, issues, pulls, alerts, digest, insights, repos and repository detail pages

### Changed
- Restructure the factory dashboard around change and stock with dedicated story and skeleton layouts
- Unify language and category chart colors through a stable multi-color palette in `chart-theme`, keeping known-language mappings consistent across sorting and filtering

### Fixed
- Skip the duplicate factory snapshot read when loading the factory console

### Operations
- Release applies the additive, repeatable `migrations/0004_repo_statistics.sql` before deploying the Worker; rolling back code keeps the table without touching snapshots or saved settings

## v0.7.0 — 2026-09-18

### Added
- Unified software-factory refresh updates site-wide lists, Insights, Digest and repository details through durable, resumable steps, including repositories outside the factory metric scope
- Large refresh dialog with phase and repository progress, actionable failure explanations, history and a compact page-level health/progress banner
- Repository timestamp dialogs with readable local/UTC times, observation windows and elapsed time updated every second

### Changed
- Other pages read saved snapshots without independent refresh buttons or automatic collection; missing data links to the factory refresh console
- Standardize Basalt/Recharts visualizations, green chart colors, typography, table spacing, compact help tooltips and equal-height cards
- Upgrade Basalt to 2.1.8 and Vitest/coverage to 5.0.1; add the Hexly project shortcut and accessible header tooltips

### Fixed
- Let long signal lists expand and fill their cards; remove blue chart-click outlines while retaining green keyboard focus and inset calendar selection outlines
- Preserve prior good page data on failed collection, resume aggregate chunks without duplicate records and keep cancelled/cooling repository progress accurate
- Treat missing GitHub repository or security-alert responses as unavailable data, not successful empty results

### Operations
- No new D1 migration or Cloudflare binding is required; existing account storage limits now also include ordinary snapshots and Digest baselines
- After upgrading, synchronize the repository list in the refresh console before starting the first full-site refresh; repository selection only limits factory metrics
- The legacy `POST /api/refresh` endpoint remains compatible, but the client no longer calls it

## v0.6.0 — 2026-09-16

### Added
- Persistent factory runs with frozen repository order, scope, window and logical step totals; durable progress and history survive browser reloads and Worker restarts
- Cloudflare Queue page execution with D1 fenced leases, retry/backoff, rate-limit deadlines, cron recovery, pause/resume/cancel and server-enforced account/repository cooldowns
- Reference-aware bounded retention and a 256 MB factory-data budget preserve current/mixed snapshot detail while limiting storage growth
- Dense refresh console with repository priorities, selected/filtered/stale/failed scopes, queue timelines, real request counts, coverage, timestamps and bounded polling
- Additive, repeatable D1 migration and a local production-export verification command; legacy resource recovery retains original event windows and timestamps

### Fixed
- Keep last-known-good snapshots visible throughout refresh; atomically commit repository versions and publish consistent global versions at run completion
- Preserve stronger prior coverage on partial failures; prevent stale workers, overlapping starts and retry requests from erasing data or bypassing cooldowns
- Keep renamed repositories distinct by stable GitHub identity, record mixed-version provenance and avoid reading large historical checkpoints during polling

### Operations
- Provision `giraffe-factory` Queue before deployment; Release applies `0001_factory_runs.sql`, `0002_factory_retention.sql`, and `0003_factory_budget.sql` before deploying the Worker
- Existing legacy factory rows remain untouched, enabling data recovery and Worker rollback without destructive down migrations
- `/api/factory/refresh` now accepts the explicit run-plan contract; legacy implicit restart requests are rejected

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
