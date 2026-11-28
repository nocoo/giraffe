# Giraffe

Personal GitHub console (saved snapshots, inboxes, repo detail, factory observations) in a Bun monorepo (`apps/web`: Hono Cloudflare Worker + Vite React/Basalt SPA; D1 `giraffe-db` via `DB`, DO `RefreshRunner`). Root `package.json` owns `APP_VERSION` (`apps/web/src/lib/version.ts`); root commands run all web gates.

Docs: [README.md](README.md) · [Docs Index](docs/README.md) · [Unified Refresh](docs/15-unified-refresh.md) · [Software Factory](docs/06-software-factory.md) · [Machine API](docs/11-agent-api.md) · [Server](docs/04-server.md) · [Quality](docs/02-quality.md) · [Release Ops](docs/16-release-operations.md) · [Retrospective](Retrospective.md)

## Commands

Run from root (TypeScript 7 strict, Bun 1.4, Node >=22.23.4). Layout: `apps/web/src/{server,lib,client}/`, `tests/{api,e2e}/`, `scripts/`, `migrations/`, `docs/`. Daily dev uses ignored `.dev.vars` (seeded from `dev.vars.example` without overwriting; replace placeholder `TOKEN_ENCRYPTION_KEY_V1` before storing a real PAT, keep `TOKEN_ENCRYPTION_KEY_CURRENT=1`); test runners generate isolated env files. L4 needs Chromium (`bunx playwright install chromium`); `gate:security` needs `gitleaks` and `osv-scanner`.

```sh
bun install --frozen-lockfile  # deps + restore .husky/
bun run dev                    # Vite 7045 + Worker 37045 (giraffe.dev.hexly.ai; real GitHub)
bun run dev:server             # API-only Worker on 7045
bun run typecheck              # S1: 3 TS configs + wrangler types
bun run lint                   # S2: Biome check-only (0 warnings) + wrangler/fetch gates
bun run gate:wrangler-vars     # S2: wrangler.toml var/env boundaries
bun run gate:github-fetch      # S2: GitHub outbound fetch boundary
bun run gate:client-fetch      # S2: client /api/ fetch boundary
bun run build                  # B1: PWA icons + dist/client
bun run test:coverage          # L1: Vitest/V8 >= 80% all 4 metrics
bun run test:e2e:api           # L3: local HTTP functional A + JWT B
bun run test:e2e:bdd           # L4: Playwright Chromium on built SPA
bun run gate:security          # G1/G2: Gitleaks + OSV (missing tool fails)
```

## Invariants

- **PAT secrecy**: Plaintext classic GitHub PAT exists only in the settings input until submit, that request body, decrypted Worker memory, and outbound `Authorization`; never persist, bundle, log, trace, or return it.
- **Encryption & errors**: D1 stores PATs as AES-GCM envelopes; error records store safe codes, never raw upstream failures.
- **Access & tenancy**: `workers_dev = false` and `preview_urls = false`; Cloudflare Access validates JWT `iss`/`aud`/JWKS with no in-app login. Users of one deployment share accounts/snapshots (not per-user tenancy).
- **Fetch boundaries**: Browser calls use `apps/web/src/client/lib/api.ts` with relative `/api/` URLs; GitHub calls use `createGithubClient(env)`. Production ignores fixture GitHub/JWKS overrides.
- **Read-only GET**: Snapshot and observation GET routes never silently fetch upstream, write data, or record token activity.
- **Layer boundaries**: Server tests must not import `apps/web/src/client`. Viewmodels stay free of View/DOM imports and views/routes stay thin.
- **Test isolation**: Automated tests use local Wrangler/SQLite and GitHub/JWKS stubs, never real PATs, daily `.dev.vars`, `api.github.com`, remote D1, or remote `-test` resources.
- **Phase 2 refresh**: One durable A-then-serial-B refresh (`RefreshRunner`), 03:00 Asia/Shanghai starred cron (`0 19 * * *`), and explicit single-repo refresh; new repos get initial observations without auto-starring.
- **Observation cache**: Cache complete repo×day×dimension observations by stable identity/timezone preserving timestamps and missingness; only new refresh tables feed observations (no legacy migration/fallback).
- **Retired collection**: Legacy quick/deep/full modes, queues, and analysis UI stay removed; see [docs/15-unified-refresh.md](docs/15-unified-refresh.md).
- **Ad-hoc `lookbackDays` backfill**: Backfills closed Shanghai days for locally starred repos only (no new-repo exception), reusing complete and terminal-unavailable caches unless forced.
- **Backfill blackout (operational)**: Callers must not start backfills from 00:50 Asia/Shanghai until that day's scheduled daily refresh finishes; this window is operational, not server-enforced.
- **Machine API auth**: Every `/api/v1/*` call needs a Worker-enforced hash-only, fixed-account, scoped, expiring bearer token (no tokenless routes); Access bypass applies only to `/api/v1/*`, never the dashboard.
- **Machine tokens**: Browser token UI is Access-protected and writes require same-origin; tokens expire <=90d (rotate before expiry), return raw only at mint, and never enter logs, URLs, storage, or D1.
- **Machine resources**: Agent records/reports/jobs are mutable local revisioned resources; GitHub observations and factory publications stay read-only. Contract: [docs/11-agent-api.md](docs/11-agent-api.md).
- **No bundled analysis**: `/analysis`, analysis projections, model inference/settings, and code-execution routes stay removed; external producers call `/api/v1/*` without model secrets (legacy AI tables untouched).
- **Strict TDD & contract**: Keep failing tests in the working tree; commits pass current L1; never skip hooks (`--no-verify`). Raise weaker enforcement rather than lowering this contract.
- **Auto-deploy**: `.github/workflows/pipeline.yml` runs CI (`quality-slots.yml` -> `quality / Z1: Gate`) and on `main` push (or `workflow_dispatch` with `deploy=true`) runs CD (`D1–D5` via `nocoo/base-ci/.github/workflows/deploy-worker.yml`, consuming `b1-dist` into `dist/client` without rebuilding, applying remote D1 migrations to `giraffe-db`, running `bun run scripts/deploy-worker.ts`, and verifying `/api/live`); never deploy concurrently from a laptop. Runbook: [release ops](docs/16-release-operations.md).
- **Additive migrations**: Apply additive D1 migrations before dependent code and verify factory migrations on a local backup copy (`scripts/verify-factory-migration.ts`).

## Quality & Local Gates

Follows `system1-quality`; CI slots and pinned `base-ci` live in `.github/workflows/quality-slots.yml` (via `.github/workflows/pipeline.yml`; `quality / Z1: Gate` required on `main`). Statuses: `enforced`, `planned`, `manual`, `N/A`.

- **L1 coverage**: >= 90% statements/functions/lines and >= 85% branches on `apps/web/src/**/*.{ts,tsx}` (excludes tests and route/component/entry shells in `vitest.config.ts`).
- **N/A slots**: `L2 Runtime` (`N/A`, covered by `L3 Integration`). `P1 Package` verifies Worker bundling via `wrangler deploy --dry-run` reusing `B1` (`b1-dist`).
- **Planned gaps**: `pre-commit` wall time (>30s), `pre-push` exact pushed-commit snapshots, `L3` full factory endpoint inventory, and `L3`/`L4` per-run temp persist dirs (`planned`).
- **Manual**: Docs and backup-copy D1 migration verification (`scripts/verify-factory-migration.ts`).
- **`pre-commit`** (`.husky/`, check-only): runs `typecheck`, `lint` (Biome + 3 `gate:*` scripts), and `test:coverage` on a `git checkout-index` snapshot (staged `package.json`/`bun.lock` must match worktree).
- **`pre-push`** (`.husky/`, check-only): runs `test:e2e:api` (`L3`) and `gate:security` (`G1` Gitleaks on stdin commit ranges + `G2` OSV on `bun.lock`) in parallel; missing scanners fail.

## Resources & Isolation

| Lane      | Endpoints / State                                                     | Boundary                                                              |
| --------- | --------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Daily dev | Vite `7045`, Worker `37045` (`dev:server`: `7045`); `.wrangler/state` | Caddy `giraffe.dev.hexly.ai`; local D1, real GitHub unless overridden |
| L3 API    | Worker `17045`, GitHub `17046`, JWKS `17047`; `.wrangler/e2e`         | Functional A + signed-JWT B start separate Workers; runner env only   |
| L4 E2E    | Worker `27045`, GitHub `27046`; `.wrangler/e2e-pw`                    | Built SPA (`dist/client`) with dev-auth fixtures                      |
| Prod      | `giraffe.hexly.ai`, Worker `giraffe`, D1 `giraffe-db` (`DB`)          | Env `production`; read-only unless authorized; probe `GET /api/live`  |

Keep fixed test ports free; conflicts fail instead of falling back to dev (coordinate across concurrent worktrees). Target runner contract: per-run temp persistence, reject remote bindings/credential fallback, prove test context, and verify `_test_marker(key,value)` (`env=test`) before reset/cleanup (fixed dirs remain an open gap).

## Retrospective

Record incident narratives in [Retrospective.md](Retrospective.md); promote recurring project constraints to `Invariants` above, cross-project lessons to global rules, and deterministic safeguards to tests or hooks.
