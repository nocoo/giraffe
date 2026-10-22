import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { prSnapshot } from "../../lib/pull-request";
import {
	composeContent,
	contentVersion,
	decodeContent,
	observationVersion,
	savedContentMeta,
	storedContent,
	withContent,
} from "./content-version";

it("R9 publication timestamps do not alter factory content fingerprints", async () => {
	const snapshot = factoryFixture();
	const original = await contentVersion("factory", snapshot);
	for (const repo of snapshot.repos)
		repo.observation = {
			version: "r1",
			window: snapshot.window,
			refreshedAt: "old",
			source: "run",
		};
	const before = await contentVersion("factory", snapshot);
	for (const repo of snapshot.repos)
		Object.assign(repo.observation ?? {}, { publishedAt: "2026-10-22T05:00:00Z" });
	expect(await contentVersion("factory", snapshot)).toBe(before);
	expect(original).toMatch(/^sha256:/);
});

it("projects saved metadata without exposing it in response JSON", async () => {
	const data = { issues: [], fetched_at: "old" };
	const encoded = await savedContentMeta("issues", data);
	const metadata = decodeContent(encoded);
	expect(metadata?.hash).toBe(await contentVersion("issues", data));
	expect(storedContent(data)).toBeNull();
	expect(withContent(data, metadata)).toBe(data);
	expect(storedContent(data)).toEqual(metadata);
	expect(JSON.stringify(data)).toBe('{"issues":[],"fetched_at":"old"}');
	withContent(data, null);
	expect(storedContent(data)).toBeNull();
	expect(decodeContent(null)).toBeNull();
});

it("persists the exact existing full version separately from canonical content", async () => {
	const data = {
		z: 1,
		pull_requests: [{ number: 1, mergeable: "MERGEABLE", checks: { state: "SUCCESS" } }],
		fetched_at: "old",
	};
	const metadata = decodeContent(await savedContentMeta("repo:owner/app:prs", data));
	expect(metadata?.fullVersion).toBe(
		`sha256:${createHash("sha256")
			.update(JSON.stringify(prSnapshot(data)))
			.digest("hex")}`,
	);
	const refreshed = decodeContent(
		await savedContentMeta("repo:owner/app:prs", { ...data, fetched_at: "new" }),
	);
	expect(refreshed?.hash).toBe(metadata?.hash);
	expect(refreshed?.fullVersion).not.toBe(metadata?.fullVersion);
	const reordered = decodeContent(
		await savedContentMeta("repo:owner/app:prs", {
			fetched_at: data.fetched_at,
			pull_requests: data.pull_requests,
			z: data.z,
		}),
	);
	expect(reordered?.hash).toBe(metadata?.hash);
	expect(reordered?.fullVersion).not.toBe(metadata?.fullVersion);
});

it("binds drained stream ranges to the immutable collection window without changing saved data", async () => {
	const data = {
		runId: "old-run",
		items: [],
		ranges: [],
		next: null,
		coverage: { status: "complete", observed: 0, fetchedAt: "old", pages: 1 },
	};
	const resource = "factory:owner/app:commits";
	const window = { since: "2026-07-01T00:00:00Z", until: "2026-10-01T00:00:00Z" };
	const original = JSON.stringify(data);
	const first = decodeContent(await savedContentMeta(resource, data, window));
	expect(first?.hash).toBe(await contentVersion(resource, { ...data, ranges: [window] }));
	expect(first?.fullVersion).toBe(await observationVersion(data));
	const different = decodeContent(
		await savedContentMeta(resource, data, { ...window, until: "2026-10-02T00:00:00Z" }),
	);
	expect(different?.hash).not.toBe(first?.hash);
	expect(different?.fullVersion).toBe(first?.fullVersion);
	const refreshed = decodeContent(
		await savedContentMeta(
			resource,
			{
				...data,
				runId: "new-run",
				coverage: { ...data.coverage, fetchedAt: "new", pages: 3 },
			},
			window,
		),
	);
	expect(refreshed?.hash).toBe(first?.hash);
	expect(refreshed?.fullVersion).not.toBe(first?.fullVersion);
	expect(JSON.stringify(data)).toBe(original);
});

it("ignores collector coverage URLs while retaining stream quality", async () => {
	const data = {
		items: [],
		coverage: {
			status: "complete",
			observed: 0,
			fetchedAt: "old",
			pages: 1,
			strategy: "full",
			source: "/repos/owner/app/commits?since=2026-07-01&page=1",
		},
	};
	const version = await contentVersion("factory:owner/app:commits", data);
	expect(
		await contentVersion("factory:owner/app:commits", {
			...data,
			coverage: {
				...data.coverage,
				source: "/repos/owner/app/commits?since=2026-07-02&page=3",
				pages: 3,
				strategy: "incremental",
				fetchedAt: "new",
			},
		}),
	).toBe(version);
	expect(
		await contentVersion("factory:owner/app:commits", {
			...data,
			coverage: { ...data.coverage, status: "limited", observed: 2 },
		}),
	).not.toBe(version);
});

it("composes only saved hashes and selection, with no legacy backfill", async () => {
	const hash = `sha256:${"a".repeat(64)}`;
	expect(await composeContent({ root: hash, catalog: null })).toBeNull();
	const version = await composeContent(
		{ root: hash, catalog: "missing" },
		{ selected: ["owner/app"] },
	);
	expect(version).toMatch(/^sha256:[0-9a-f]{64}$/);
	expect(
		await composeContent({ catalog: "missing", root: hash }, { selected: ["owner/app"] }),
	).toBe(version);
	expect(await composeContent({ root: hash, catalog: "missing" }, { selected: [] })).not.toBe(
		version,
	);
});

it("hashes sorted canonical JSON as UTF-8 SHA-256 without reordering arrays", async () => {
	const data = { z: [2, 1, null], a: { "2": true, "10": "é", b: false } };
	const canonical = '{"a":{"10":"é","2":true,"b":false},"z":[2,1,null]}';
	expect(await contentVersion("issues", data)).toBe(
		`sha256:${createHash("sha256").update(canonical).digest("hex")}`,
	);
	expect(await contentVersion("issues", { a: data.a, z: data.z })).toBe(
		await contentVersion("issues", data),
	);
	expect(await contentVersion("issues", { ...data, z: [1, 2, null] })).not.toBe(
		await contentVersion("issues", data),
	);
});

it("strips only collection metadata and retains GitHub fields and evidence quality", async () => {
	const data = {
		fetched_at: "old",
		repository_fetched_at: { "owner/app": "old" },
		freshness: { oldestAt: "old", latestAt: "old", total: 1, missing: 0 },
		issues: [{ title: "same", updated_at: "old", fetched_at: "content", version: "1" }],
	};
	const version = await contentVersion("issues", data);
	expect(
		await contentVersion("issues", {
			...data,
			fetched_at: "new",
			repository_fetched_at: { "owner/app": "new" },
			freshness: { ...data.freshness, oldestAt: "new", latestAt: "new" },
		}),
	).toBe(version);
	for (const key of ["title", "updated_at", "fetched_at", "version"])
		expect(
			await contentVersion("issues", {
				...data,
				issues: [{ ...data.issues[0], [key]: "changed" }],
			}),
		).not.toBe(version);
	expect(
		await contentVersion("issues", {
			...data,
			freshness: { ...data.freshness, missing: 1 },
		}),
	).not.toBe(version);
});

it("ignores factory execution metadata but preserves windows, dependency versions and measurements", async () => {
	const data = factoryFixture();
	const version = await contentVersion("factory", data);
	const changed = structuredClone(data);
	changed.runId = "new-run";
	changed.revision++;
	changed.fetched_at = "new";
	changed.startedAt = "new";
	changed.leaseUntil = "new";
	changed.requests++;
	changed.rate = { remaining: 1, resetAt: "new", resource: "core" };
	changed.publication = { runId: "new-run", mixed: true, publishedAt: "new" };
	for (const repo of changed.repos) {
		repo.metadataAt = "new";
		if (repo.observation) {
			repo.observation.version = "new-run";
			repo.observation.refreshedAt = "new";
			repo.observation.metadataAt = "new";
		}
		for (const coverage of Object.values(repo.coverage)) {
			coverage.fetchedAt = "new";
			coverage.sourceFetchedAt = "new";
			coverage.strategy = "reused";
			coverage.pages++;
			coverage.source = "/repos/owner/app/changed?since=new&page=3";
		}
	}
	if (changed.contribution) {
		changed.contribution.fetchedAt = "new";
		changed.contribution.observedAt = "new";
		for (const day of changed.contribution.days) day.observedAt = "new";
	}
	expect(await contentVersion("factory", changed)).toBe(version);
	changed.window.until = "different-window";
	expect(await contentVersion("factory", changed)).not.toBe(version);
});

it("ignores quick-reuse observation times but preserves the source head", async () => {
	const data = {
		languages: [{ name: "TypeScript", bytes: 10 }],
		source_head: "commit-a",
		fetched_at: "old",
	};
	const original = await contentVersion("repo:owner/app:languages", data);
	expect(
		await contentVersion("repo:owner/app:languages", {
			...data,
			fetched_at: "new",
			source_fetched_at: "old",
		}),
	).toBe(original);
	expect(
		await contentVersion("repo:owner/app:languages", { ...data, source_head: "commit-b" }),
	).not.toBe(original);
});
