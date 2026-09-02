# Giraffe

Personal GitHub monitoring console. Cloudflare Worker (Hono `/api/*`) + planned Vite SPA. Code name `giraffe`.
Profile: ts-worker-web
Direction: [docs/01-architecture.md](docs/01-architecture.md). Quality: [docs/02-quality.md](docs/02-quality.md). Frameworks must not rewrite this file.

## Sources of Truth

This file is the **contract**. Hooks, CI, and config are **enforcement**. If they disagree, raise enforcement; never lower this file.

| Fact | Where |
|---|---|
| Agent handbook | this file |
| Human docs | `docs/01`–`05`. No README.md |
| Version | `package.json` `"version"` via `src/lib/version.ts` (`APP_VERSION`) |
| Enforcement | `.husky/*`, `vitest.config.ts`, `scripts/gate-*.ts` |
| Machine rules | global `AGENTS.md`, `rules/git-commit.md` |
| Accidents | [Retrospective.md](Retrospective.md) |
| Env files | `.dev.vars` gitignored. E2E uses runner `--env-file` only. Never deployable `[vars]` |

## Project Invariants

- Plaintext GitHub PAT may exist only in the settings input (cleared after submit), that request body, Worker memory after decrypt, and the outbound `Authorization` header. Never persist, bundle, log, trace, or return it. D1 stores only the AES-GCM envelope.
- `workers_dev = false`. App gate is Cloudflare Access JWT (`iss` + `aud` + JWKS). No in-app login.
- Phase 1 is Server only (`src/server`). Client feature code follows [docs/05](docs/05-client.md) after that doc is signed off. Server tests must not import `src/client`. L3 is N/A until phase 2. Phase 2 MVVM: viewmodels have no View/DOM imports.
- E2E is `--local --persist-to` only. Never remote `giraffe-db`. L2 persist `.wrangler/e2e/` :17045; L3 `.wrangler/e2e-pw/` :27045.
- Strict TDD: failing tests stay in the working tree; only green L1 commits. `--no-verify` forbidden.
- Caddy for `giraffe.dev.hexly.ai` is **not** registered yet.

## Stack / Layout

| Component | Choice |
|---|---|
| Language | TypeScript 7 strict (`exactOptionalPropertyTypes`) |
| Package manager | Bun |
| Runtime | Cloudflare Workers (Hono) |
| Lint | Biome `--error-on-warnings` (`noSkippedTests` / `noFocusedTests`) |
| Tests | Vitest L1 95% all four; L2 `scripts/run-e2e.ts`; L3 Playwright (phase 2) |
| Data | D1 `giraffe-db` (binding `DB`; wrangler id is still a placeholder) |

```
src/server/   Hono, D1, Access, GitHub
src/lib/      shared
scripts/      L2 runner + gates
tests/api/    L2
docs/         01–05
```

## Commands

```bash
bun run dev:server
bun run typecheck
bun run lint
bun run test
bun run test:coverage
bun run test:e2e:api
bun run gate:security
```

## Verification

Status: `enforced` | `planned` | `manual` | `N/A`. `enforced` Evidence = hook/CI/config/script.

Org gaps: index-snapshot pre-commit; GitHub CI. pre-push **does** parse stdin refs for gitleaks (`GITLEAKS_LOG_OPTS`).

Today: pre-commit typecheck/lint/`gate:test-skip`/`gate:wrangler-vars`/`gate:github-fetch`/`gate:client-fetch`/`test:coverage` on the working tree. pre-push L2 ‖ G2. No `.github/workflows`.

| Change | Proof | Status | Evidence |
|---|---|---|---|
| Logic | L1 vitest ≥95% all four | enforced | pre-commit `test:coverage`; `vitest.config.ts` |
| API L2 | real HTTP, isolated D1 | enforced | pre-push `test:e2e:api` (`scripts/run-e2e.ts`) |
| UI L3 | Playwright | N/A | — |
| Types / lint | tsc + Biome 0 warning + skip/vars/fetch gates | enforced | pre-commit |
| G2 secrets | gitleaks | enforced | pre-push `gate:security` (stdin ranges) |
| G2 deps | osv-scanner `bun.lock` | enforced | pre-push `gate:security` |
| Bundler | Vite → `dist/client` | planned | — |
| Docs | numbered doc if behavior changes | manual | human review |
| Release | `wrangler deploy` | planned | — |

| Hook | Org bar | Status | Evidence |
|---|---|---|---|
| pre-commit | index snapshot | planned | — |
| pre-push | stdin ref range | enforced | `.husky/pre-push` reads stdin SHAs |

`--no-verify` forbidden on commits and branch pushes. Tag-only may skip.

## Resources / Isolation

| Purpose | Port / resource | Isolation |
|---|---|---|
| Dev | 7045 (planned `https://giraffe.dev.hexly.ai`) | `.dev.vars`; Caddy not registered |
| L2 | 17045 | `--local --persist-to .wrangler/e2e/` |
| L3 | 27045 | `--local --persist-to .wrangler/e2e-pw/` (phase 2) |

## Operations / Release

- No CD. Who: operator with Cloudflare account. Do not `wrangler deploy` until D1 id is real and Access is configured.
- Live-check: not wired. Runbook: [docs/04-server.md](docs/04-server.md).

## Retrospective

| Kind | Where |
|---|---|
| Accident narrative | [Retrospective.md](Retrospective.md) |
| Recurring project rule | one line here (cap ~10) |
| Checkable rule | hook or test |

- PAT plaintext never in D1, logs, traces, or responses.
- Phase 1: no `src/client` feature code.
