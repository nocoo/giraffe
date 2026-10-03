# Giraffe Agent

Local Pi Durable Work runtime. Models and credentials stay in private local files
under `~/.config/giraffe`; never print or commit them. Node >=22.22 is required.

```sh
giraffe login
giraffe status
giraffe work
giraffe work --once --no-push --limit 5
giraffe work --dry-run --repos nocoo/giraffe
```

Normal Work stays alive on one schedule; no daemon/service is installed. One
account lock protects the live SQLite runtime and isolated in-memory dry runs.
Login remains Access-protected PKCE with a loopback listener; model configuration
is not overwritten. Only the exchange is tokenless.

Keep existing provider/role/service settings; the only execution configuration is:

```json
{ "work": { "cron": "0 * * * *", "timezone": "Asia/Shanghai", "registry": "https://mirrors.tencent.com/npm/" } }
```

Old watch/repairs keys and commands are removed, not aliased. Historical local
databases and D1 rows remain untouched. See [the runtime contract](../../docs/14-repository-coordinator.md).

Work reads saved Web observations, runs four domain analyses and Jev portfolio
ranking/model routing, then uses existing personal main checkouts for dependency,
exact non-draft [CO] PR and recurring main CI/CD failure tasks. One worker plus a dedicated read-only reviewer per repository, at most 20
persisted rounds, final tests and exact-HEAD approval precede host publication.
Workers atomically commit explicit paths through normal hooks, never push.
The host persists pushed SHA before idempotent completed dependency issue closure.
Post-push Actions reads are exact-SHA, ten-minute intervals, at most three checks.
The host never directly rolls back, releases or deploys. Normal push may trigger
the repository's existing CI/CD release/deployment workflows. PR merge/closure is report-only.

Scope remains discovered tasks only; ordinary issues cannot be authorized by Jev.
Priority, worker routing and domain decisions each enforce a 16 KiB serialized
UTF-8 body cap including `model` (not an exact token guarantee). Requests split by
actual bytes, priority batches contain at most 25 repositories, and descriptions
are clipped with omission markers/counts. IDs and original observations remain
intact. All batches preflight before inference; an oversized single scope requires
manual inspection/narrowing and fails without a provider call or oversized retry.
PR diff/head and failed jobs/steps/logs are bounded live read-only evidence. Missing
evidence defers its task. No-change PR cleanup is reviewed without fabricated
commits; dependency no-change requires exact latest manifest/lock evidence.
Critical package majors are rejected before writes and deferred individually;
`work.criticalPackages` defaults cover runtime/framework/compiler/build/test stack.
Remote retention uses the existing bounded sweep. No real-target unattended
acceptance is claimed. Native scripts run as the trusted user, not an OS sandbox.

The existing Work desk reads byte-bounded events, latest per-repository summaries
and heartbeat through generic agent jobs/records. Reports retain missing/stale
evidence, never imply merge/deploy authorization. Credentials/model APIs are not
used by tests. Development gates are root `typecheck`, `lint`, `build` and
`test:coverage`; fake APIs/models, injected clocks and temporary local Git only.
