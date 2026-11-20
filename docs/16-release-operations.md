# 16 — Release and deployment operations

Production deployment target, release workflow commands, D1 migration guardrails, and post-deploy verification for Giraffe.

> Back to [docs index](README.md) · Related: [server design & checklist](04-server.md) · [Phase 2 unified refresh](15-unified-refresh.md)

## Deploy target

- **Worker**: `giraffe` (`wrangler.toml`, `workers_dev = false`, `preview_urls = false`)
- **Custom domain**: `https://giraffe.hexly.ai` (protected by Cloudflare Access; `/api/v1/*` uses Worker bearer tokens and `/api/live` is public)
- **Storage & runtime**: D1 `giraffe-db` (binding `DB`), Durable Object `RefreshRunner` (`REFRESH_RUNNER`), cron `0 19 * * *` (03:00 Asia/Shanghai)
- **GitHub environment**: `production` (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)

## Release triggers and commands

Authorized publication uses `.github/workflows/release.yml` (pinned shared `deploy-worker.yml` workflow):

1. **Auto-deploy on `main`**: Every green `CI` run (`.github/workflows/ci.yml`, required check `quality / Z1: Gate`) on `main` automatically triggers `.github/workflows/release.yml` via `workflow_run`. It builds (`bun run build`), applies remote D1 migrations to `giraffe-db`, deploys via `bun run scripts/deploy-worker.ts`, and verifies `/api/live`. **Merging a PR to `main` is a production deploy.**
2. **Versioned tag release**: The tag must match the root `package.json` version (`APP_VERSION`), and `CI` on `main` for `<main-sha>` must already be green before pushing the tag (otherwise the tag run fails looking for a successful `CI` run on `main`):

   ```sh
   git tag vX.Y.Z <main-sha> && git push origin vX.Y.Z
   gh release create vX.Y.Z --generate-notes
   ```
3. **Redeploy an existing tag**:

   ```sh
   gh workflow run release.yml -f tag=vX.Y.Z
   ```
4. **Watch a release run**:

   ```sh
   gh run list --workflow release.yml --limit 3
   gh run watch <id>
   ```

## Guardrails and D1 migrations

- Never deploy concurrently from a laptop; rely on `.github/workflows/release.yml` (`concurrency-group: deploy-worker-production`) with trusted successful `main` CI, an explicitly requested version tag, or manual dispatch.
- Apply additive D1 migrations before shipping code that depends on the new schema.
- Validate factory and schema migrations against a local backup copy before rollout (keep real backups outside the repository):

  ```sh
  bun scripts/verify-factory-migration.ts <local-backup.sql>
  ```
- Review the custom-domain and Cloudflare Access prerequisites in [docs/04-server.md §13](04-server.md) before changing host/Access bindings.

## Post-deploy verification (`/api/live`)

- `.github/workflows/release.yml` polls `GET https://giraffe.hexly.ai/api/live` (6 retries, 5 seconds apart) and requires HTTP `200` with top-level `version` matching root `package.json`.
- `/api/live` executes a real D1 `SELECT 1` through the `DB` binding; database failure returns uncached HTTP `503` with `status: "error"`.
- `_test_marker` (`d1_marker`) is test metadata, not the production health probe, and private diagnostics never enter the `/api/live` response.
