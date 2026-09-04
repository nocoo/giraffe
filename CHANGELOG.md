# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
