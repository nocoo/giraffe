# Giraffe

Personal GitHub monitoring console. Code name `giraffe`. A Cloudflare Worker proxies GitHub with user-pasted classic PATs and serves a Vite SPA. The PAT must never be persisted, bundled, logged, or returned by any API. It exists in the browser only in the settings submit request body.

Direction document: [docs/01-architecture.md](docs/01-architecture.md). Numbered docs are Chinese; this file is the Agent handbook.

## Tech Stack

| Component | Choice |
|---|---|
| Language | TypeScript 7 (`strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) |
| Package manager | Bun |
| Runtime | Cloudflare Workers |
| API | Hono under `/api/*` |
| Frontend | React 19 SPA (Vite 8 + React Router) |
| UI | Tailwind CSS v4 + shadcn/ui (Basalt Gen 2) |
| Charts | Recharts |
| Validation | Zod v4 |
| Database | Cloudflare D1 `giraffe-db` (binding `DB`). E2E uses local Miniflare SQLite |
| GitHub auth | Encrypted PAT in D1 (multi-account). No Device Flow, no `gh` CLI |
| App gate | Cloudflare Access in production; local `*.dev.hexly.ai` bypasses Access |
| Lint | Biome (`biome check --error-on-warnings`). No ESLint |
| Tests | Vitest (L1) + real-HTTP E2E (L2) + Playwright (L3) |
| Deploy | `wrangler deploy` (assets + worker) |

## Product Scope (v1)

In: repo list, cross-repo issues/PRs, insights, security alerts, notifications, statistical daily digest, per-repo overview/security/actions/PRs/issues/releases/traffic/languages/contributors, settings for PATs.

Out: GitLab/Forgejo, OAuth Device Flow, OpenAI digest, Kanban, mentions, dependents, in-app login page.

Reference API (token mode + resource shapes only): `/Users/nocoo/workspace/references/gh-dashboard`. UI is a full redesign.

## Target Layout

```
src/
  server/          # Hono app, GitHub client, D1, Access middleware
  client/          # Vite SPA, Basalt Gen 2 shell, viewmodels, routes
  lib/             # shared pure functions
scripts/           # L2 runner, G2 gates
docs/              # numbered Chinese docs
wrangler.toml
vite.config.ts
```

MVVM: viewmodels have no View/DOM imports. Route files stay thin.

## Development Method

Strict TDD. Red test first, then the smallest implementation, then refactor. Tests are the only proof of correctness — not clicking the UI or reading logs. Red and green are separate commits.

Server (`src/server`) and Client (`src/client`) stay isolated. Each layer must be runnable and verifiable on its own:

Numbered docs before code, in this order:

| # | Doc | Gate |
|---|---|---|
| 02 | Quality | tests, coverage, when each layer runs. Required before any feature code |
| 03 | Data schema | GitHub API + reference-project shapes, D1 tables. Required before persistence |
| 04 | Server design | every endpoint, behavior, response contract, atomic commit steps. Phase 1 |
| 05 | Client design | Vite page structure and presentation, atomic commit steps. Phase 2 |

- Phase 1 — Server only, after 02–04. Done when 04's APIs have L1 + L2 green. No client feature code.
- Phase 2 — Client, after phase 1 and 05. L3 belongs here.

Do not invent quality rules, schemas, endpoints, or pages in this file. Do not start a layer before its numbered doc exists and has been reviewed.

Each phase is split into steps in 04/05; each step is split into atomic commits.

## Local Domain and Ports

| Purpose | Port | Host |
|---|---|---|
| Dev (`wrangler dev`) | 7045 | `https://giraffe.dev.hexly.ai` |
| L2 API E2E | 17045 | localhost, runner-owned |
| L3 BDD | 27045 | localhost |

Caddy site is not registered yet. Do not persist, bundle, log, or echo GitHub tokens.

## Cloudflare Resource Names

Online: one Worker `giraffe`, one D1 `giraffe-db` (binding `DB`), custom domain `giraffe.hexly.ai`. No remote test Worker, no remote test D1, no `[env.test]`.

L2 and L3 share the same local wrangler process model:

| Layer | Command | Persist dir | Port |
|---|---|---|---|
| L2 API E2E | `wrangler dev --local --persist-to=.wrangler/e2e` | `.wrangler/e2e/` | 17045 |
| L3 Playwright | `wrangler dev --local --persist-to=.wrangler/e2e-pw` | `.wrangler/e2e-pw/` | 27045 |

Runner wipes the persist dir, applies schema, writes `_test_marker`, then hits real HTTP. Missing or wrong marker → abort. No Cloudflare credentials. Dev `bun dev` may bind remote `giraffe-db`; E2E must not.

## Quality System (6DQ)

| Layer | Tool | Trigger | Bar |
|---|---|---|---|
| L1 Unit | vitest | pre-commit | coverage ≥ 90% (thin UI shells exempt) |
| L2 Integration/API | `scripts/run-e2e.ts` | pre-push | real HTTP, 100% `/api` method combos, isolated D1 |
| L3 System/E2E | Playwright | CI / on-demand, **phase 2** | PAT settings → repo list → repo detail |
| G1 Static | `tsc --noEmit` + Biome | pre-commit | 0 error, 0 warning |
| G2 Security | osv-scanner + gitleaks | pre-push | 0 vulns, 0 leaked secrets |
| D1 Isolation | `wrangler dev --local --persist-to` | L2/L3 | local SQLite + `_test_marker`; never remote D1 |

### Hooks

| Hook | Budget | Runs |
|---|---|---|
| pre-commit | <30s | G1 → L1 |
| pre-push | <3min | L2 ‖ G2 |
| on-demand | — | L3 |

Until D1 exists, D1 isolation is N/A. After `giraffe-db` exists, E2E still stays on `--local --persist-to`.

## Commands (once scaffolded)

```bash
bun dev                 # wrangler dev on 7045
bun run build           # vite build → dist/client
bun run typecheck       # tsc --noEmit
bun run lint            # biome check --error-on-warnings
bun run test            # L1
bun run test:coverage   # L1 + coverage gate
bun run test:e2e:api    # L2 on 17045
bun run test:e2e:bdd    # L3 on 27045
```

Install packages with a temporary registry (`BUN_CONFIG_REGISTRY=…`). Never set a global Bun registry. If `bun.lock` only changed registry URLs, restore it before commit.

## Versioning

`package.json` `"version"` is the only source of truth (`1.2.3`). Display as `v1.2.3`. No hardcoded version strings.

## Git

Atomic Conventional Commits. Imperative, lowercase, ≤50 characters. Types: `fix` `feat` `docs` `test` `refactor` `chore`. Stage specific files only — never `git add -A` or `git add .`. Do not push unless asked.

One logical change per commit. Green commits must typecheck and the new tests must pass. A TDD red commit may fail tests; the next green commit must make them pass.

Code changes that alter behavior or structure must update the matching numbered doc in the same effort (separate commit if it is a separate logical change).

## Retrospective

(empty)
