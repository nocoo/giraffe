import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { factoryFixture } from "../../../../../tests/fixtures/factory-snapshot";
import { contentVersion } from "./content-version";

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
