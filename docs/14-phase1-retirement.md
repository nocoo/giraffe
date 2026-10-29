# Phase 1: collection retirement (v0.26.0)

This is a delete-only release. The old quick/deep/full refresh modes, durable
factory-run executors, scheduled collection and queue consumers are removed.
No replacement collector, A+B pipeline, ad-hoc refresh, 03:00 cron or weekly
report is implemented. Phase 2 requires separate authorization.

## Product behavior

The Dashboard retains its navigation shell, account selection, charts, tables,
repository detail and saved-data semantics. Reads mean the latest saved refresh
result, not live GitHub data. Existing supported snapshots keep their original
source timestamps and windows. A fresh account or missing snapshot displays an
explicit unavailable/empty state; missing coverage is not a successful zero.
Refresh actions are disabled with a collection-unavailable explanation.

The analysis page, navigation item, report cards, bot-status presentation and
analysis-only browser projections are removed. The machine API still stores and
serves externally owned records, reports and jobs; this is not a UI analysis
runtime. Account management and API token management remain available.

## Retired routes

Browser routes are removed and return authenticated `404 not_found`:
- `POST /api/refresh` and `POST /api/factory/refresh`
- `GET|POST /api/factory/runs`
- `GET /api/factory/runs/latest`
- `POST /api/factory/runs/:id/control`
- `GET /api/refresh/settings` and `GET /api/refresh/times`
- `POST /api/refresh/schedules/:kind`
- Analysis-only reads under `/api/agent`

Machine requests retain bearer authentication, account fencing and scope checks:

| Endpoint under `/api/v1/accounts/:account`        | Phase-1 result                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------- |
| `GET /refresh-runs`                               | `200`, `items: []`, `collectionAvailable: false`                  |
| `GET /refresh-runs/latest`                        | `410 collection_unavailable`                                      |
| `POST /refresh-runs`                              | `410 collection_unavailable`                                      |
| `POST /refresh-runs/:id/control`                  | `410 collection_unavailable`                                      |
| `PUT /schedules/:kind`, `DELETE /schedules/:kind` | `410 collection_unavailable`                                      |
| `GET /settings`                                   | Saved settings with `schedules: []`, `collectionAvailable: false` |

Snapshot, factory/stream, source, contribution and activity reads remain read-only.
No GET starts collection, changes token activity or repairs legacy rows. Invalid
or missing machine credentials still fail authentication before retirement
responses; unavailable operations are not tokenless endpoints.

## Storage and deployment

No data migration is introduced. Legacy D1 tables and historical rows can remain
in place, but old runs and schedules are not resumed or presented as active work.
Wrangler explicitly declares `crons = []` and has no queue binding/consumer;
the Worker exports only its HTTP handler. The authorized release workflow runs
`scripts/deploy-worker.ts`: it removes only the production `giraffe` consumer
from `giraffe-factory` (if present), invokes the locked Wrangler deployment and
then verifies that this consumer and all Worker cron schedules are absent.
It preserves the queue itself and unrelated consumers, and fails closed on
API/deployment/verification errors. The deployment token needs Workers Scripts
Edit and Queues Edit permissions. The script refuses local execution; tests
use fake API responses and never access production. Cron verification uses the
[Cloudflare schedules API](https://developers.cloudflare.com/api/typescript/resources/workers/subresources/scripts/subresources/schedules/methods/get/).
AES-GCM PAT encryption, Cloudflare Access, same-origin
browser writes and hash-only expiring machine tokens are unchanged.

The root `package.json` is the authoritative `0.26.0` version. Merge/deployment is
left to the owner; do not deploy from a laptop. After an authorized merge and
successful release workflow, verify on `https://giraffe.hexly.ai`:
1. `/api/live` reports `0.26.0` with a healthy D1 probe.
2. Dashboard and repository pages render; missing data shows an empty state,
   and existing snapshots retain their original dates.
3. No refresh/schedule/run controls or analysis navigation remain usable;
   `/analysis` is not an application page.
4. Access, account management and API token creation/revocation still work.
5. With a least-privilege machine token, read saved observations and verify the
   retirement responses above. Never put tokens in URLs or screenshots.
6. Confirm deployment configuration has no collection cron or queue consumer.

Rollback uses the normal release workflow for a previously approved revision.
There is no schema change to roll back; deploying old code can reactivate its
old schedulers and must be an explicit operational decision.
