# Local Agent API v1

Foundation contract introduced in v0.13.0, consumed by the local Agent in v0.14.0. The dashboard remains behind Cloudflare Access.
The complete machine API reference, including external bot publication, limits,
rotation and curl examples, is [Machine API v1](api.md). PR1 (v0.15.7) adds the
shared saved-source index and web-owned report contracts. v0.15.8 uses the bot's
last-run record in the analysis UI. Neither installs a bot routine or requires a
schema migration.
Only `https://giraffe.hexly.ai/api/v1/*` is reachable without an Access browser
session; the Worker authenticates every resource request with an opaque bearer token.
`/authorize`, `/api/tokens` and `/api/cli/authorize` remain Access protected.

## Authentication

Tokens are bound to one GitHub account ID, have a finite expiry (1-90 days,
default 30), and support these scopes only: `observations:read`, `agent:read`,
`agent:write`, `app:read`, `app:write`. Unknown scopes are rejected. `PATCH` may
rename or reduce scopes, never increase them. Only a token hash is persisted.
Create/exchange returns the raw token once; list/update never do. Revocation takes
effect on the next request. Token metadata includes creator, creation, expiry,
revocation and last mutation use; GET does not update last-use or collect upstream.

`GET /api/v1/me` returns `{ account_id, login, token: { id, scopes, expires_at },
capabilities: { observations: boolean, agentRead: boolean, agentWrite: boolean,
appRead: boolean, appWrite: boolean } }`. A token never selects or changes the
shared dashboard's active account. Missing/invalid/expired/revoked bearer: 401;
missing scope or mismatched account: 403. Errors use `{ error: { code, message } }`.
All responses are `Cache-Control: private, no-store`.

Browser token management: `GET /api/tokens?account_id=ID`, `POST /api/tokens`,
`PATCH /api/tokens/:id`, `DELETE /api/tokens/:id` (revoke). Writes require same-origin
Access-authenticated requests and an explicit account ID.

The bundled CLI is the only current PKCE consumer. The flow remains in PR1 while
that CLI exists and is planned for deletion with the CLI in PR3; it is not a
reusable external-client authorization commitment. External bots use dashboard-
minted tokens and rotate them before their maximum 90-day expiry.

CLI authorization uses `/authorize?redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256&scopes=...`.
The user chooses the account and confirms requested scopes. POST `/api/cli/authorize`
returns a callback URL containing only `code` and `state`. Callbacks must be HTTP,
`127.0.0.1` or `localhost`, explicit port, exact `/callback`, and have no credentials,
query or fragment. The code expires after five minutes and is one-time only.
POST `/api/v1/auth/exchange` with `{ code, code_verifier, redirect_uri }` atomically
consumes the hashed code after S256 and exact callback verification, then returns
`{ token, account_id, expires_at, scopes }`. Malformed requests return 400
`validation_failed`; invalid/expired/consumed grants return 400 `invalid_grant`.
Neither failure mints a token. The CLI saves the returned token; neither code nor bearer belongs in logs.
`@nocoo/base-cli` uses `loginPath: '/authorize'`, `tokenParam: 'code'`, `extraParams`
for PKCE/scopes, `state`, and captures the code through `onSaveToken` for exchange.
The CLI openBrowser adapter renames base-cli's `callback` parameter to `redirect_uri`
without changing its value; the exchange must use that identical value.

## Saved observations (`observations:read`)

Prefix: `/api/v1/accounts/:account_id`. GET only:

- `/sources`: shared saved-source assembly with the browser. Returns
  `{ account_id, sources, repositories }`; machine `repositories` includes the
  complete catalog regardless of browser activation. Each source has `resource`,
  `version`, `fetchedAt`, `freshness`, `coverage`, `truncated`, `unavailable`.
  Optional strict ISO-offset `since` is exclusive by the maximum valid timestamp
  of `fetchedAt` and `freshness.latestAt`; invalid/missing times are discarded,
  and sources with no valid time are retained. Optional `repository`
  resolves to a canonical saved catalog name and filters repository sources while
  keeping account/global sources and the full repository array. This is not a
  durable change cursor: retry pending/failed older work before advancing a cutoff
  and reconcile periodic full scans. See [source semantics](api.md#get-accountsasources).
- `/repos`: complete saved account catalog, including disabled-statistics/fork/archived
  repositories; no implicit statistics filtering. `scope=all` is the default and
  recommended for agents; `scope=starred` explicitly limits local Giraffe stars.
- `/issues`, `/prs`, `/ci`, `/factory`: saved global sources. Global issue/PR lists
  expose open items; factory history has separate event streams.
- `/repos/:owner/:name` and `/repos/:owner/:name/:resource`, where resource is
  `issues`, `prs`, `actions`, `releases`, `traffic`, `security`, `languages`,
  `contributors`: saved per-repository pages, not live GitHub proxying.
- `/factory/repos/:owner/:name/:stream`: immutable published event resources;
  streams are `commits`, `issues`, `prs`, `actions`, `releases`, `alerts`, `dependencies`.

Observation response:

```json
{
  "account_id": "account-id",
  "data": { "issues": [] },
  "sourceVersion": "sha256-of-saved-resource-or-immutable-run-id",
  "fetchedAt": "2026-10-02T08:10:00.000Z",
  "freshness": { "oldestAt": "2026-10-02T08:10:00.000Z", "latestAt": "2026-10-02T08:10:00.000Z", "total": 1, "missing": 0 },
  "coverage": null,
  "truncated": false,
  "unavailable": false,
  "source": { "kind": "snapshot", "resource": "repo:nocoo/giraffe:issues", "publicationId": null },
  "selection": { "scope": "all", "statisticsFilter": false }
}
```

`fetchedAt` is the actual saved source time, not response or refresh-end display time.
Raw data preserves `fetched_at`, `repository_fetched_at`, unavailable/forbidden flags
and original coverage. Factory data preserves immutable per-repository observation
versions, windows and coverage; its source reference identifies the publication.
No publication or GitHub observation can be edited through this API. Missing saved
sources return 409 `snapshot_missing`; unavailable coverage is not a successful zero.
Token account scope grants saved account observations, not GitHub repository rights
outside that catalog. Statistics inclusion and local star settings remain explicit.

## Agent resources (`agent:read` / `agent:write`)

Collections: `/api/v1/accounts/:account_id/agent/records`, `/reports`, `/jobs`.
Methods: GET/POST collection; GET/PATCH/DELETE `/:id`.

POST accepts `{ id?, repository?, type, status, source_version?, payload }`.
Caller-stable IDs are supported (1-80 URL-safe characters); duplicate IDs return
409 `resource_exists`, allowing GET to reconcile uncertain create results. This is
not an upsert. No arbitrary SQL or polymorphic collection names are accepted.

Items have this stable shape:

```json
{
  "id": "grok-bot-run",
  "account_id": "account-id",
  "repository": null,
  "type": "grok-bot-run",
  "status": "completed",
  "source_version": null,
  "payload": { "lastRunAt": "2026-10-02T08:10:00Z", "status": "completed", "analyzed": 4, "skipped": 0 },
  "revision": 1,
  "created_at": "2026-10-02T08:10:00.000Z",
  "updated_at": "2026-10-02T08:10:00.000Z"
}
```

Item/create/update responses: `{ account_id, item }`. Lists:
`{ account_id, items, nextCursor }`. GET list accepts `limit` (1-100; default 50),
`cursor` (exclusive previous ID), exact `type`, `status`, `repository` filters;
ordering is ID ascending. PATCH requires current `revision` and only supplied mutable
fields; update increments revision. DELETE requires `?revision=N` and returns 204.
A stale revision returns 409; unknown item 404. Account identity and IDs are immutable.
Payloads are bounded JSON objects (64 KiB per item); model credentials, PATs and other
secrets must never be submitted. The generic store does not validate report payloads.
The web-owned schema is `apps/web/src/lib/analysis-contracts.ts`. Judgment `model`
and `choice` remain required; `confidence` and `probabilities` are optional. A supplied
probability distribution must sum to 1 with the selected choice maximal. `producer`
and its individual fields are optional; evidence, sources, verdict and times remain
required. Completed `github-analysis` rows must match payload repository/sourceVersion
through row `repository`/`source_version`.

External bots use stable IDs `analysis-{repo|global}-{domain}-{first12}` from the
report's hex SHA-256 sourceVersion, hashing deterministic scope, repository, domain,
and sorted source identities/full versions. Never slice a raw observation's
`sha256:` prefix or use a slash-containing repository name in an ID. On 409
`resource_exists`, GET and compare the full identity/version before skipping.
See [publishing analysis](api.md#publishing-analysis).

In PR1, the existing UI still uses the `work-cron` record with `type: 'work-cron'` for unified runner presence.
Payload may contain runner version, last-seen timestamp and capabilities, never local
credentials. Jobs can represent pending web analysis requests, reports use
`type: 'github-analysis'` with domains `issues|prs|ci|cd` and `repo|global` scope.
External bots use record ID/type `grok-bot-run` with
`{ lastRunAt, status, analyzed, skipped, error? }`, recommending statuses
`running|completed|failed`. Create once, then use revisioned PATCH. The analysis
page displays the account-wide record's last-run time, status and counts, with
an overdue warning after 48 hours under the default daily cadence. Invalid
payloads, row/payload status mismatch, non-null repository and timestamps more
than one minute in the future are errors. Legacy Work records/jobs remain stored
but are not loaded by the analysis page. Report evidence freshness is independent
of the bot's last-run time; see the [bot run contract](api.md#bot-run-record-and-analysis-ui).

## Explicit application management (`app:read` / `app:write`)

Account prefix as above. `/settings` reads stars, statistics overrides and schedules.
PUT/DELETE `/stars/:owner/:name` and `/statistics/:owner/:name` set/remove local
configuration; PUT body for statistics is `{ enabled }`. PUT/DELETE
`/schedules/:kind` saves/removes a daily/weekly/catalog schedule using existing rules.
POST `/refresh-runs` explicitly starts the existing durable refresh plan;
POST `/refresh-runs/:id/control` accepts `{ action: 'pause'|'resume'|'cancel' }`.
GET `/refresh-runs` lists saved runs. No management GET has upstream side effects.
No API grants arbitrary SQL, edits immutable publications, or returns stored GitHub
PAT/model secrets. Cloud AI execution is retired; model execution belongs to the local Agent.

## Repository layout

`apps/web` contains the existing Hono Worker and React/Basalt SPA; root build,
test, migration and deployment commands remain stable. Root `package.json` is
the single application version. Root `wrangler.toml` deliberately remains the
production deployment manifest and points to `apps/web/src/server/index.ts`;
root migrations and the existing D1/queue bindings keep their identities.
`packages/agent` still contains the local Node.js Pi Durable runtime and CLI in PR1.
Browser-safe report contracts now live in `apps/web/src/lib/analysis-contracts.ts`,
so the web report consumer no longer obtains them from the runtime package.

## Access deployment change

A dedicated self-hosted Access application `giraffe-machine-api` covers exactly
`giraffe.hexly.ai/api/v1/*` and attaches an existing reusable Bypass policy by ID.
No shared-bypass application destinations or dashboard application policies change.
The Worker is deployed before this path is made reachable. Unauthenticated machine
resources must return JSON 401, never login redirects; malformed exchange returns
400. Dashboard, `/authorize`, `/api/tokens` and `/api/cli/authorize` continue to
redirect unauthenticated browsers through the existing Access application.
Rollback deletes only the dedicated machine application, restoring dashboard-level
Access coverage on that path; additive D1 tables and old data are retained.
