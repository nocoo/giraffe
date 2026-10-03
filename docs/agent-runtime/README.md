# Agent runtime explorer

Open [index.html](index.html) directly in a browser. This is an offline, standalone
HTML/CSS/JavaScript explainer, not part of the production SPA. No server, build,
external font, model connection, credential or API access is needed. Native
controls keep this documentation independent of the React/Basalt application.

## Interactions

- Select a graph node to inspect its responsibilities, capabilities and source.
- Switch dry-run, local-only and publication previews. No mode executes commands.
- Play, pause, step or reset the eight-stage illustrated workflow.
- Switch from the illustrative log to separately labeled historical run evidence.
- Expand startup notes; copy a command explicitly without executing it.
- Use keyboard focus, Enter/Space, and arrow keys in the activity tabs. The layout
  adapts to phones and honors reduced-motion preferences.

## Accuracy

The implementation snapshot is Giraffe `f95d6ff`, checked on 2026-10-03 against
`packages/agent/src/{cli,work-coordinator,work-priority,work-conversations,work-tools,work-workspace,work-analysis}.ts`
and [the coordinator contract](../14-repository-coordinator.md).

The terminal illustration supplied as a visual reference is not the architecture
contract. Giraffe currently has an Astra orchestrator, Jev ranking/routing, four
parallel domain conversations and sequential per-repository workers. It does not
implement an on-call-only Astra architect, per-tool Jev forks, a six-thread worker
pool or automatic installation/startup of `work`.

Recorded repository counts, conversation IDs and model choices are historical
examples, not live telemetry or hard-coded production defaults. The two-repository
repair required operator-assisted recovery. A subsequent authorized push verified
Backy `3be12bb` and R2Shot `b145913`; this page makes no current CI/CD claim.

The separate opt-in `repair` cron retains its dedicated-clone/branch and reviewer
contract. It must not be conflated with `work` on existing personal main workspaces.

## Verify

From the repository root, using the existing Playwright dependency and installed
Chromium:

```sh
node --test docs/agent-runtime/test.mjs
```

The browser checks cover offline loading, node inspection, all three modes,
playback controls, evidence separation, keyboard interaction and responsive widths.
They never run a real agent or access GitHub, Giraffe, model providers or secrets.
