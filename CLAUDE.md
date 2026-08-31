# Giraffe

Personal GitHub monitoring console. Code name `giraffe`. The browser never holds a GitHub token; a Cloudflare Worker proxies GitHub with user-pasted PATs and serves a Vite SPA.

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
| Database | Cloudflare D1 `giraffe-db` / `giraffe-db-test` (binding `DB`) |
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

## Local Domain and Ports

| Purpose | Port | Host |
|---|---|---|
| Dev (`wrangler dev`) | 7045 | `https://giraffe.dev.hexly.ai` |
| L2 API E2E | 17045 | localhost, runner-owned |
| L3 BDD | 27045 | localhost |

Caddy site is not registered yet. Do not put GitHub tokens in client bundles or logs.

## Cloudflare Resource Names

| Resource | Prod | Test |
|---|---|---|
| Worker script | `giraffe` | `giraffe-test` (`[env.test] name`) |
| Custom domain | `giraffe.hexly.ai` | not deployed |
| D1 | `giraffe-db` | `giraffe-db-test` |
| D1 binding | `DB` | `DB` |

Dev may bind prod D1. L2/L3 must run `--env test` and never touch `giraffe-db`. No `-staging` / `-dev` / `-e2e` suffixes.

## Quality System (6DQ)

| Layer | Tool | Trigger | Bar |
|---|---|---|---|
| L1 Unit | vitest | pre-commit | coverage ≥ 90% (thin UI shells exempt) |
| L2 Integration/API | `scripts/run-e2e.ts` | pre-push | real HTTP, 100% `/api` method combos, isolated D1 |
| L3 System/E2E | Playwright | CI / on-demand | PAT settings → repo list → repo detail |
| G1 Static | `tsc --noEmit` + Biome | pre-commit | 0 error, 0 warning |
| G2 Security | osv-scanner + gitleaks | pre-push | 0 vulns, 0 leaked secrets |
| D1 Isolation | `giraffe-db-test` | L2/L3 | `-test` suffix, runtime marker, never prod D1 |

### Hooks

| Hook | Budget | Runs |
|---|---|---|
| pre-commit | <30s | G1 → L1 |
| pre-push | <3min | L2 ‖ G2 |
| on-demand | — | L3 |

Until D1 exists, D1 isolation is N/A. After the first D1 binding, E2E must not touch `giraffe-db`.

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

One logical change per commit. After each commit the tree must typecheck and the relevant tests must pass.

Code changes that alter behavior or structure must update the matching numbered doc in the same effort (separate commit if it is a separate logical change).

## Retrospective

(empty)
