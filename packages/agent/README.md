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
ranking/model routing, then uses existing personal main checkouts for dependency
tasks. One worker plus a dedicated read-only reviewer per repository, at most 20
persisted rounds, final tests and exact-HEAD approval precede host publication.
Workers atomically commit explicit paths through normal hooks, never push.
The host persists pushed SHA before idempotent completed dependency issue closure.
Post-push Actions reads are exact-SHA, ten-minute intervals, at most three checks.
No rollback, release or deployment occurs. PR merge/closure is report-only.

Scope limitations: exact [CO] PR diff/head execution and recurring CI/CD/flaky-test
discovery are not implemented in this foundation. Jev routing is currently a
separate question after candidate ranking. The old watcher retention sweep is
removed; remote history retention requires follow-up. No real-target unattended
acceptance is claimed. Important ecosystem/runtime/framework majors require
manual attention. Native scripts run as the trusted user, not in an OS sandbox.

The existing Work desk reads byte-bounded events, latest per-repository summaries
and heartbeat through generic agent jobs/records. Reports retain missing/stale
evidence, never imply merge/deploy authorization. Credentials/model APIs are not
used by tests. Development gates are root `typecheck`, `lint`, `build` and
`test:coverage`; fake APIs/models, injected clocks and temporary local Git only.
