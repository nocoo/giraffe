# Giraffe

Bun monorepo: `apps/web` owns the Worker and SPA. Root `package.json` is the authoritative version and root commands run all web gates.

Personal GitHub console with saved account snapshots, inboxes and repository detail.
Profile: ts-worker-web.
Direction: [unified refresh](docs/15-unified-refresh.md), [saved factory observations](docs/06-software-factory.md) and [quality](docs/02-quality.md). Frameworks must not rewrite this file.

## Scope and instruction sources

- This file is the only project handbook; nested files do not compete with it. Do not create a `CLAUDE.md` alias or copy.
- This file is the contract; hooks, CI and configuration enforce it. Raise weaker enforcement instead of lowering this contract.
- Human docs: [README.md](README.md) and the [docs index](docs/README.md). Version: `package.json`, read through `apps/web/src/lib/version.ts` as `APP_VERSION`. Enforcement: `.husky/`, CI/release workflows, Vitest/Playwright configs and `scripts/gate-*.ts`. Local secrets: ignored `.dev.vars` initialized from `dev.vars.example`; test runners generate their own env files. Machine rules/accidents: global `AGENTS.md` and `rules/`; [Retrospective.md](Retrospective.md).

## Project invariants

- Plaintext classic GitHub PAT exists only in the settings input until submission, that request body, decrypted Worker memory and outbound Authorization. Never persist, bundle, log, trace or return it. D1 stores AES-GCM envelopes; error records store safe codes, not raw upstream failures.
- `workers_dev = false`; Cloudflare Access validates JWT issuer/audience/JWKS. There is no in-app login. Authorized users of one deployment share its accounts/snapshots; do not claim per-user tenancy.
- Browser calls go through `apps/web/src/client/lib/api.ts` using relative `/api/` URLs; GitHub calls use `createGithubClient(env)`. Production ignores fixture GitHub/JWKS overrides. GET snapshots are read-only and must not silently fetch upstream or write data.
- Server tests must not import the client. Viewmodels stay free of View/DOM imports and views/routes stay thin. The React/Basalt client now exists; historical phase-1 exclusions are no longer the current project scope.
- Automated tests use local Wrangler/SQLite and GitHub/JWKS stubs, never real PATs, daily `.dev.vars` or `api.github.com`. Never use remote D1 or deploy remote `-test` resources.
- Phase 2 authorizes one durable A-then-serial-B refresh, the 03:00 Asia/Shanghai starred schedule and explicit single-repository refresh. New repositories get initial observations without auto-starring. Cache complete repo×day×dimension observations by stable identity and timezone; preserve timestamps and missingness. Only new refresh tables feed observations, with no legacy data migration/fallback. Legacy quick/deep/full modes, queues and analysis UI stay removed. Details: [refresh contract](docs/15-unified-refresh.md).
- Keep strict TDD: failing tests remain in the working tree; commits pass current L1. Never skip hooks to publish a failing change.

## Setup and commands

TypeScript 7 strict, Bun 1.4, Node ≥22.23.4; Hono Cloudflare Worker. Vite React/Basalt SPA; D1 `giraffe-db` through `DB`. Biome and AST boundary gates; Vitest/V8, real HTTP and Playwright Chromium. `apps/web/src/server/` and `apps/web/src/lib/` hold API, Access, encrypted accounts, GitHub collection, storage and shared types; `apps/web/src/client/` and `tests/{api,e2e}/` hold routes/viewmodels and API/browser journeys; `scripts/`, `migrations/`, `docs/` hold runners, schema evolution and numbered design/runbooks.

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

| Dimension             | Required proof                                                                                                                        | Status   | Current enforcement / gap                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L1 pre-commit quality | Statements, branches, functions and lines each ≥95%; no skipped/focused tests; strict types and check-only lint, zero errors/warnings | planned  | Commit/CI coverage includes server/shared/client logic with enforced subchecks: the skip gate and Biome reject disabled/focused tests, L1 setup rejects real network, and commit/CI check three TS configs, generated Wrangler types and skip/vars/fetch boundaries. Gates run on the working tree; index-snapshot, <30s and rejection evidence are missing |
| L2 API                | Real local HTTP over 100% of endpoint/method combinations, success/failure and auth                                                   | planned  | Push/CI run functional suite A and JWT suite B; full endpoint/method assertion inventory must track the evolving factory API                                                                                                                                                                                                                                |
| L3 UI                 | Critical account/catalogue/repository/factory journeys in Chromium                                                                    | enforced | CI runs the built SPA through `scripts/run-e2e-bdd.ts` and GitHub stub                                                                                                                                                                                                                                                                                      |
| G2 security           | Dependency and secret scans; missing tool fails                                                                                       | enforced | Pre-push passes stdin commit ranges, including new refs, to Gitleaks and scans `bun.lock` with OSV; CI shared scanners                                                                                                                                                                                                                                      |
| D1 isolation          | Fresh local state per run, guards and marker before fixtures/reset/cleanup                                                            | planned  | Both runners are local with `_test_marker env=test` and stub ports, but reuse fixed directories and delete them before proving marker/ownership                                                                                                                                                                                                             |
| Build                 | Actual Vite assets in `dist/client`                                                                                                   | enforced | L3 runner and CD build; typecheck alone does not build                                                                                                                                                                                                                                                                                                      |
| Docs / migration      | API/schema/source-window and rollback proof                                                                                           | manual   | Server, client and factory runbooks; local migration verifier on a backup copy                                                                                                                                                                                                                                                                              |

| Hook       | Current behavior                                                      | Required follow-up                                   |
| ---------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| pre-commit | Working-tree typecheck, full lint, four structural gates and coverage | Unified L1 on an index snapshot, <30s                |
| pre-push   | Local L2 and G2 in parallel; Gitleaks consumes stdin ranges           | Test the same pushed commit snapshots as well, <3min |

Install restores Husky. Hooks are check-only; never use `--no-verify` on commits or branch pushes. CI/CD pins shared `nocoo/base-ci` workflows at `ac635753a869cb85fad1f52aae4ccbd6119f3cae` (main 2026-10-22).

## Resources and isolation

| Lane      | Ports / directory                                                 | Boundary                                                                        |
| --------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Daily dev | Vite 7045, Worker 37045; `.wrangler/state`                        | Caddy `giraffe.dev.hexly.ai`; local D1, real GitHub unless configured otherwise |
| L2        | Worker 17045, GitHub stub 17046, JWKS stub 17047; `.wrangler/e2e` | Functional and signed-JWT suites start separate Workers; runner env files only  |
| L3        | Worker 27045, GitHub stub 27046; `.wrangler/e2e-pw`               | Real built SPA with development-auth fixtures                                   |

Keep these ports free; a conflict fails instead of falling back to development. Required runners allocate per-run local persistence, reject remote bindings/credential fallback, prove test context and verify `_test_marker(key,value)` with `env=test` before reset/cleanup. Existing fixed directory names are implementation gaps, not the desired contract.

## Operations / release

### CI checks

`.github/workflows/ci.yml` (workflow `CI`) runs on pull requests and pushes to `main` through the shared `quality.yml`. A PR is green only when every required check passes:

| Check                                                           | Runs                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `quality / L1: Quality & Tests`                                 | the four `gate:*` scripts, `bun run typecheck`, `bun run lint`, `bun run test:coverage` |
| `quality / L2: API E2E / Test (bun on ubuntu-latest)`           | `bun run test:e2e:api`                                                                  |
| `quality / L3: Browser E2E / Test (bun on ubuntu-latest)`       | `bun run test:e2e:bdd` (Chromium)                                                       |
| `quality / G2: Security / Security (Secrets & Vulnerabilities)` | Gitleaks and OSV                                                                        |
| `quality / Quality Gate Aggregate`                              | requires all of the above                                                               |

`Build`, `Package Check` and `Worker Tests` report as skipped; that is expected.

### Release command and deploy target

- Deploy target: Cloudflare Worker `giraffe` on custom domain `giraffe.hexly.ai` (`wrangler.toml`), D1 `giraffe-db` (`DB`), GitHub environment `production`.
- Every green `CI` run on `main` triggers `.github/workflows/release.yml`, which builds, applies D1 migrations and deploys automatically. Merging a PR is a deploy.
- Versioned release (tag must equal root `package.json` version): `git tag vX.Y.Z <main-sha> && git push origin vX.Y.Z`, then `gh release create vX.Y.Z --generate-notes`.
- Redeploy an existing tag: `gh workflow run release.yml -f tag=vX.Y.Z`.
- Watch: `gh run list --workflow release.yml --limit 3`, then `gh run watch <id>`. The workflow verifies `/api/live` reports the expected version (6 retries, 5s apart).

Authorized publication uses `.github/workflows/release.yml`: trusted successful main CI or an explicitly requested version tag/manual dispatch, shared migration/build/deploy workflow and production secrets. Do not deploy concurrently from a laptop. Apply additive migrations before code needing the new schema; validate factory migrations against a local backup copy as documented.
Verify `GET https://giraffe.hexly.ai/api/live`: current top-level version and a real D1 `SELECT 1`; database failure returns uncached 503 with `status: "error"`. `_test_marker` is test metadata, not the production health probe, and private diagnostics never enter the response. Runbook: [server](docs/04-server.md).

## Retrospective

Narratives remain in [Retrospective.md](Retrospective.md); keep only recurring rules here, cross-project lessons in global rules/nmem and deterministic requirements in hooks/tests.

## Machine API boundary

- Every `/api/v1/*` request requires a Worker-enforced hash-only, fixed-account, scoped, expiring bearer token; there are no tokenless machine endpoints. Access bypass is restricted to that path, never the dashboard host.
- Browser token management remains Access protected and browser writes require same-origin. Tokens expire within 90 days and must be rotated before expiry. Raw tokens are returned only when minted and must not enter logs, URLs, browser persistence or D1.
- Agent records/reports/jobs are mutable local application resources with revisions. GitHub observations and factory publications remain read-only. GET never collects upstream or records token activity.
- `/analysis` and analysis-only browser projections are removed. Generic machine records/reports/jobs remain available, but there is no bundled analysis runtime, model inference/settings, automatic code-change engine or endpoint that executes local code. External producers use the machine API; never submit their model secrets to Giraffe. Legacy AI tables and historical resource rows can remain untouched. Contract: [Machine API](docs/11-agent-api.md).
