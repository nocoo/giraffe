# Giraffe

Personal GitHub console with account snapshots, inboxes, repository detail and resumable software-factory runs.
Profile: ts-worker-web.
Direction: [architecture](docs/01-architecture.md), [quality](docs/02-quality.md) and [factory runs](docs/09-factory-runs.md). Frameworks must not rewrite this file.

## Scope and instruction sources

- This file is the only project handbook; nested files do not compete with it. Do not create a `CLAUDE.md` alias or copy.
- This file is the contract; hooks, CI and configuration enforce it. Raise weaker enforcement instead of lowering this contract.
- Human docs: [README.md](README.md) and the [docs index](docs/README.md). Version: `package.json`, read through `src/lib/version.ts` as `APP_VERSION`. Enforcement: `.husky/`, CI/release workflows, Vitest/Playwright configs and `scripts/gate-*.ts`. Local secrets: ignored `.dev.vars` initialized from `dev.vars.example`; test runners generate their own env files. Machine rules/accidents: global `AGENTS.md` and `rules/`; [Retrospective.md](Retrospective.md).

## Project invariants

- Plaintext classic GitHub PAT exists only in the settings input until submission, that request body, decrypted Worker memory and outbound Authorization. Never persist, bundle, log, trace or return it. D1 stores AES-GCM envelopes; error records store safe codes, not raw upstream failures.
- `workers_dev = false`; Cloudflare Access validates JWT issuer/audience/JWKS. There is no in-app login. Authorized users of one deployment share its accounts/snapshots; do not claim per-user tenancy.
- Browser calls go through `src/client/lib/api.ts` using relative `/api/` URLs; GitHub calls use `createGithubClient(env)`. Production ignores fixture GitHub/JWKS overrides. GET snapshots are read-only and must not silently fetch upstream or write data.
- Server tests must not import the client. Viewmodels stay free of View/DOM imports and views/routes stay thin. The React/Basalt client now exists; historical phase-1 exclusions are no longer the current project scope.
- Automated tests use local Wrangler/SQLite and GitHub/JWKS stubs, never real PATs, daily `.dev.vars` or `api.github.com`. Never use remote D1 or deploy remote `-test` resources.
- Preserve leased/fenced factory writes, bounded retention and immutable per-repository/global publication. Failed or limited collection retains prior good data and its original window; missing coverage is not a successful zero. Preserve old rows through additive migrations and rollback. Details: [factory contract](docs/06-software-factory.md), [run/storage rules](docs/09-factory-runs.md).
- Keep strict TDD: failing tests remain in the working tree; commits pass current L1. Never skip hooks to publish a failing change.

## Setup and commands

TypeScript 7 strict, Bun 1.4, Node ≥22.12; Hono Cloudflare Worker. Vite React/Basalt SPA; D1 `giraffe-db` through `DB`. Biome and AST boundary gates; Vitest/V8, real HTTP and Playwright Chromium. `src/server/` and `src/lib/` hold API, Access, encrypted accounts, GitHub collection, storage and shared types; `src/client/` and `tests/{api,e2e}/` hold routes/viewmodels and API/browser journeys; `scripts/`, `migrations/`, `docs/` hold runners, schema evolution and numbered design/runbooks.

Run from the root. API/browser runners generate fake keys and test configuration without `.dev.vars`. Install Chromium for browser checks; Gitleaks and OSV Scanner are required by push gates.

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run build
bun run gate:test-skip
bun run gate:wrangler-vars
bun run gate:github-fetch
bun run gate:client-fetch
bun run test:coverage
bun run test:e2e:api
bun run test:e2e:bdd
bun run gate:security
```

For daily development, prepare `.dev.vars` from the example without overwriting an existing file. Replace the public `TOKEN_ENCRYPTION_KEY_V1` example before storing any real PAT and keep `TOKEN_ENCRYPTION_KEY_CURRENT=1`; `bun run dev` starts local Vite/Worker, while `bun run dev:server` starts the API lane. Development GitHub traffic still reaches the real service.

## Testing and quality contract

6DQ keeps its name with unified L1, L2/L3, G2 and D1; the owner merged former G1 into L1 on 2026-09-21. Statuses: `enforced`, `planned`, `manual`, `N/A`.

| Dimension | Required proof | Status | Current enforcement / gap |
|---|---|---|---|
| L1 pre-commit quality | Statements, branches, functions and lines each ≥95%; no skipped/focused tests; strict types and check-only lint, zero errors/warnings | planned | Commit/CI coverage includes server/shared/client logic with enforced subchecks: the skip gate and Biome reject disabled/focused tests, L1 setup rejects real network, and commit/CI check three TS configs, generated Wrangler types and skip/vars/fetch boundaries. Gates run on the working tree; index-snapshot, <30s and rejection evidence are missing |
| L2 API | Real local HTTP over 100% of endpoint/method combinations, success/failure and auth | planned | Push/CI run functional suite A and JWT suite B; full endpoint/method assertion inventory must track the evolving factory API |
| L3 UI | Critical account/catalogue/repository/factory journeys in Chromium | enforced | CI runs the built SPA through `scripts/run-e2e-bdd.ts` and GitHub stub |
| G2 security | Dependency and secret scans; missing tool fails | enforced | Pre-push passes stdin commit ranges, including new refs, to Gitleaks and scans `bun.lock` with OSV; CI shared scanners |
| D1 isolation | Fresh local state per run, guards and marker before fixtures/reset/cleanup | planned | Both runners are local with `_test_marker env=test` and stub ports, but reuse fixed directories and delete them before proving marker/ownership |
| Build | Actual Vite assets in `dist/client` | enforced | L3 runner and CD build; typecheck alone does not build |
| Docs / migration | API/schema/source-window and rollback proof | manual | Server, client and factory runbooks; local migration verifier on a backup copy |

| Hook | Current behavior | Required follow-up |
|---|---|---|
| pre-commit | Working-tree typecheck, full lint, four structural gates and coverage | Unified L1 on an index snapshot, <30s |
| pre-push | Local L2 and G2 in parallel; Gitleaks consumes stdin ranges | Test the same pushed commit snapshots as well, <3min |

Install restores Husky. Hooks are check-only; never use `--no-verify` on commits or branch pushes. CI/CD pins shared workflows at `ad43150de3a2be2fa464b5cd2f921dc4fa9f8f0f`.

## Resources and isolation

| Lane | Ports / directory | Boundary |
|---|---|---|
| Daily dev | Vite 7045, Worker 37045; `.wrangler/state` | Caddy `giraffe.dev.hexly.ai`; local D1, real GitHub unless configured otherwise |
| L2 | Worker 17045, GitHub stub 17046, JWKS stub 17047; `.wrangler/e2e` | Functional and signed-JWT suites start separate Workers; runner env files only |
| L3 | Worker 27045, GitHub stub 27046; `.wrangler/e2e-pw` | Real built SPA with development-auth fixtures |

Keep these ports free; a conflict fails instead of falling back to development. Required runners allocate per-run local persistence, reject remote bindings/credential fallback, prove test context and verify `_test_marker(key,value)` with `env=test` before reset/cleanup. Existing fixed directory names are implementation gaps, not the desired contract.

## Operations / release

Authorized publication uses `.github/workflows/release.yml`: trusted successful main CI or an explicitly requested version tag/manual dispatch, shared migration/build/deploy workflow and production secrets. Do not deploy concurrently from a laptop. Apply additive migrations before code needing the new schema; validate factory migrations against a local backup copy as documented.
Verify `GET https://giraffe.hexly.ai/api/live`: current top-level version and a real D1 `SELECT 1`; database failure returns uncached 503 with `status: "error"`. `_test_marker` is test metadata, not the production health probe, and private diagnostics never enter the response. Runbook: [server](docs/04-server.md).

## Retrospective

Narratives remain in [Retrospective.md](Retrospective.md); keep only recurring rules here, cross-project lessons in global rules/nmem and deterministic requirements in hooks/tests.
