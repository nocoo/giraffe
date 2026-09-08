<p align="center"><img src="../assets/brand/icon-rounded.png" alt="Giraffe" width="128" height="128" /></p>

<h1 align="center">Giraffe</h1>

<p align="center">Review GitHub repositories, open work, and daily changes in a personal console.</p>

<p align="center">
  <a href="https://giraffe.hexly.ai">Website</a> ·
  <a href="../README.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Cloudflare_Workers-Hono-orange" alt="Cloudflare Workers and Hono" />
  <img src="https://img.shields.io/badge/UI-Basalt-black" alt="Basalt" />
</p>

## What it does

Giraffe is a personal GitHub console. Add classic PATs for one or more accounts to review repositories, open issues and pull requests, security alerts, and notifications, then compare repository metrics across days.

A Worker fetches GitHub data into D1, and the browser displays snapshots with their refresh times. Refreshes happen on demand, with no scheduled background collection. Insights apply rules to repository activity, open work, and security alerts; daily reports calculate differences between snapshots.

PATs are encrypted with AES-256-GCM before storage in D1. Data snapshots are stored as JSON without additional application-level encryption. This is a personal deployment: everyone allowed into the same deployment shares its accounts and snapshots.

## Features

- **Account management**: add, update, switch, and delete classic PAT accounts. One account is active at a time; the interface shows only the last four token characters.
- **Repository overview**: list and grid views, search and filters, and repository, star, fork, and issue metrics.
- **Open work across repositories**: gather open issues and pull requests, with links to continue working on GitHub.
- **Repository details**: nine tabs for details, security, Actions, pull requests, issues, releases, traffic, languages, and contributors.
- **Insights and alerts**: rule-based classifications and GitHub security alerts from the current snapshots, with truncation, permission, and availability states.
- **Notifications**: browse notifications and mark one or all as read. These actions also update GitHub.
- **Daily changes**: compare stars, forks, and open issue counts by UTC date and copy Markdown. A missing previous-day baseline is shown as missing data.

Visible repositories and alerts depend on PAT permissions and GitHub API responses. The console does not run continuous monitoring or perform its own code security scans.

## Usage

1. Open the [website](https://giraffe.hexly.ai) through the deployment's Cloudflare Access policy. There is no separate application sign-up or login page.
2. Add a GitHub **classic PAT** in Settings with the `repo`, `read:org`, `read:user`, and `notifications` scopes. Fine-grained PATs are not currently accepted. The token input clears immediately on submission.
3. The first account becomes active and triggers a repository refresh. Switch to later accounts manually to refresh their repositories. After deleting the active account, select another account yourself.
4. Use the refresh action on the relevant page to fetch new data. Repository detail tabs attempt an initial fetch when their snapshot is missing; ordinary reads use existing snapshots.

The sidebar identity comes from Cloudflare Access. Names and avatars are looked up through the `lizheng.blog` author profile service using a SHA-256 digest of the email address, with an identity fallback when the service is unavailable.

## Development

Use Bun 1.4 and Node.js 22.12+ locally. Install dependencies from the repository root and prepare the local environment file on first setup:

```bash
bun install --frozen-lockfile
cp -n dev.vars.example .dev.vars
```

The template's `TOKEN_ENCRYPTION_KEY_V1` is a public example. Before entering a real PAT, generate an independent key with `openssl rand -hex 32`, replace that value, and keep `TOKEN_ENCRYPTION_KEY_CURRENT=1`. Preserve an existing `.dev.vars`; the startup script neither overwrites it nor replaces a syntactically valid example key from the template.

The configured development entry is `https://giraffe.dev.hexly.ai`. It requires local DNS and a trusted HTTPS reverse proxy forwarding the domain to `127.0.0.1:7045`. Vite HMR and write-request Origin checks rely on this setup.

```bash
bun run dev
```

This initializes local D1 and starts Vite on `:7045` and the Wrangler API server on `:37045`. Vite forwards `/api` to the Worker; development data stays in local `.wrangler/state`. The default GitHub API endpoint is still the real `api.github.com`.

```bash
bun run typecheck
bun run lint
bun run build
```

Build output goes to `dist/client`; `build` does not include type checking. Self-hosting requires D1, production encryption keys, and Cloudflare Access covering the whole site. Update the custom domain, Access team and audience, and write-request Origin allowlist together. See the [server documentation](04-server.md) and [wrangler.toml](../wrangler.toml).

The main code lives in `src/client/routes` (pages), `src/client/viewmodels` (interface data logic), `src/server/routes` (HTTP endpoints), and `src/server/lib` (GitHub collection, derived metrics, and storage).

## Tests

```bash
bun run test                  # Unit tests
bun run test:coverage         # Unit tests with a coverage report
bun run test:e2e:api          # Local Worker HTTP tests
bunx playwright install chromium
bun run test:e2e:bdd          # Chromium browser journeys
```

The HTTP and browser scripts prepare isolated local D1 databases and GitHub stubs. They need no real PAT, `.dev.vars`, or remote test resources. API tests use ports `17045`, `17046`, and `17047`; browser tests use `27045` and `27046`. Keep these ports free and start tests through the runners above.

Browser tests use the development authentication path. Live GitHub and real Access sign-in are outside these scripts' scope.

## Stack

| Technology | Role |
| --- | --- |
| TypeScript | Pages, Worker logic, and development scripts |
| React, Basalt, Tailwind CSS | Console interface and interactions |
| Recharts | Repository and open-work charts |
| Hono, Cloudflare Workers | HTTP API, GitHub requests, and static hosting |
| Cloudflare D1 | Accounts, encrypted PATs, and data snapshots |
| Cloudflare Access | Deployment access and API identity checks |
| GitHub REST / GraphQL API | Repositories, open work, alerts, and notifications |
| Vite | Local development and frontend builds |
| Vitest, Playwright | Unit, HTTP, and browser tests |

## Documentation

- [Documentation index](README.md)
- [Architecture and features](01-architecture.md)
- [Data schema](03-schema.md)
- [Server design and deployment](04-server.md)
- [Client design](05-client.md)
- [Brand assets](../assets/brand/README.md)

## License

[MIT](../LICENSE).
