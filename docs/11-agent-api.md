# Local Agent API v1

Foundation contract for v0.13.0. The dashboard remains behind Cloudflare Access.
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

CLI authorization uses `/authorize?redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256&scopes=...`.
The user chooses the account and confirms requested scopes. POST `/api/cli/authorize`
returns a callback URL containing only `code` and `state`. Callbacks must be HTTP,
`127.0.0.1` or `localhost`, explicit port, exact `/callback`, and have no credentials,
query or fragment. The code expires after five minutes and is one-time only.
POST `/api/v1/auth/exchange` with `{ code, code_verifier, redirect_uri }` atomically
consumes the hashed code after S256 and exact callback verification, then returns
`{ token, account_id, expires_at, scopes }`. Invalid exchange attempts never mint
a token. The CLI saves the returned token; neither code nor bearer belongs in logs.
`@nocoo/base-cli` uses `loginPath: '/authorize'`, `tokenParam: 'code'`, `extraParams`
for PKCE/scopes, `state`, and captures the code through `onSaveToken` for exchange.
The CLI openBrowser adapter renames base-cli's `callback` parameter to `redirect_uri`
without changing its value; the exchange must use that identical value.

## Saved observations (`observations:read`)

Prefix: `/api/v1/accounts/:account_id`. GET only:

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
  "id": "analysis-giraffe-prs-source123",
  "account_id": "account-id",
  "repository": "nocoo/giraffe",
  "type": "github-analysis",
  "status": "completed",
  "source_version": "source123",
  "payload": { "domain": "prs", "scope": "repo", "verdict": "attention" },
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
secrets must never be submitted. Report-specific schema belongs to the local agent
and consuming UI, not this generic store.

Use records with `type: 'heartbeat'` and a stable runner ID for runner presence.
Payload may contain runner version, last-seen timestamp and capabilities, never local
credentials. Jobs can represent pending web analysis requests, reports use
`type: 'github-analysis'` with domains `issues|prs|ci|cd` and `repo|global` scope.

## Explicit application management (`app:read` / `app:write`)

Account prefix as above. `/settings` reads stars, statistics overrides and schedules.
PUT/DELETE `/stars/:owner/:name` and `/statistics/:owner/:name` set/remove local
configuration; PUT body for statistics is `{ enabled }`. PUT/DELETE
`/schedules/:kind` saves/removes a daily/weekly/catalog schedule using existing rules.
POST `/refresh-runs` explicitly starts the existing durable refresh plan;
POST `/refresh-runs/:id/control` accepts `{ action: 'pause'|'resume'|'cancel' }`.
GET `/refresh-runs` lists saved runs. No management GET has upstream side effects.
No API grants arbitrary SQL, edits immutable publications, or returns stored GitHub
PAT/model secrets. Existing cloud AI remains until its replacement is verified.

## Repository layout

`apps/web` contains the existing Hono Worker and React/Basalt SPA; root build,
test, migration and deployment commands remain stable. Root `package.json` is
the single application version. Root `wrangler.toml` deliberately remains the
production deployment manifest and points to `apps/web/src/server/index.ts`;
root migrations and the existing D1/queue bindings keep their identities.
`packages/agent` is reserved, with no Agent implementation in this release.
