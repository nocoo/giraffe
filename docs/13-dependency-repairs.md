# 13 — Dependency Work

The separate repair command, clone/branch engine, local profiles and repair model
controller are removed. Historical SQLite files and published D1 resources remain.
There is no alias or legacy configuration fallback.

Dependency upgrades run through [the unified Work runtime](14-repository-coordinator.md).
Workers query current stable approved-mirror metadata, inspect actual usage and
engine/peer requirements, and never copy a stale issue target or downgrade.
Important runtime/framework/ecosystem major upgrades require manual attention.
Tests and an independent exact-HEAD read-only review precede host publication.

This foundation does not claim real-target unattended acceptance. No trusted-user
native execution is an OS sandbox; no services are installed by the implementation.
