# Giraffe Agent

Local Pi Durable runtime for the Giraffe GitHub console. Model credentials live only
in `~/.config/giraffe/config.json`; browser-authorized API credentials are stored in
`~/.config/giraffe/credentials.json`. Both are private user files, never repository inputs.

The model configuration has two providers and three roles: `orchestrator`, `decision`,
and `executor`. The decision provider uses `typesafe-systemone`; the other two use
one of the Pi AI chat protocols. The service defaults to `https://giraffe.hexly.ai`.

```sh
giraffe login
giraffe status
giraffe analyze nocoo/giraffe
giraffe analyze all --domain ci
giraffe watch --once
giraffe watch
```

Login opens an Access-protected authorization page. The browser sends a short-lived
code to a loopback listener; the CLI exchanges it with an S256 PKCE verifier. API
bearers never appear in callback URLs. Login does not overwrite model configuration.

## Analysis flow

One local SQLite Harness owns one Astra orchestrator conversation and persistent
Sol specialist conversations keyed by repository/global scope and domain. A single
Jev client judges the requested domains in one batch; its urgency distribution orders
the specialists without replacing hard evidence rules. Models submit typed reports
through tools, and unknown evidence IDs are rejected.
Each planning/specialist run is bounded to eight model responses; repeated invalid
tool calls terminate rather than consuming an unbounded model budget. Jev and model
requests also have finite timeouts. Long portfolio scans check pending web requests
between repositories rather than waiting for the next complete sweep.

Each job checkpoints planning, decisions, specialist output and publication. A process
exit preserves unfinished work. Restarting resumes the same model submissions and
reconciles deterministic remote report IDs. An independent SQLite transaction lock
prevents two local processes from owning the same account runtime and releases on
process death. Use one runner machine per account for this MVP; multi-host dispatch
and leases are not implemented.

Watch reads saved Giraffe observations only; it never starts GitHub collection. It
analyzes changed source versions, services dashboard requests (`analysis-request`
jobs), publishes `github-analysis` reports, and writes a heartbeat. Global reports
summarize all expected owned non-archived non-fork repositories, retaining explicit
missing/stale coverage rather than silently analyzing only the available subset.
The analysis scope is not write eligibility: no GitHub mutations occur in this MVP.

Reports distinguish `pass`, `attention`, `fail`, and `unknown`. Pass refers only to
the supplied observations, never merge or release authorization. Stale/incomplete
evidence cannot produce a pass. CD remains unknown without verified deployment
evidence. Source versions, timestamps, citations, omissions and Jev distributions
accompany every report. No model credential is sent to Giraffe.

Analysis conversations use only structured output tools, not local shell/file tools.
The original interactive coding-tool demo is separate from unattended analysis.
Failures preserve previous good reports; create an explicit dashboard request to
retry failed work. Source facts and operation state are separate.

Default source staleness is 36 hours; watch interval is 120 seconds, configurable
as `watch.intervalSeconds`. Models are not called when source versions and freshness
class are unchanged. Historical payload retention needs an explicit product policy
before long-running multi-account operation.

Development: `bun run typecheck`, `bun run test:coverage`, `bun run build`. Tests use fake tokens
and loopback callbacks; never production GitHub or D1 resources.
