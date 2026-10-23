import { expect, it } from "vitest";
import { factoryFixture } from "../../../../tests/fixtures/factory-snapshot";
import { factoryEvidenceFreshness } from "./factory-freshness";
import { FACTORY_STREAMS } from "./factory-types";

function fixture() {
	const snapshot = factoryFixture();
	const repo = snapshot.repos[0];
	if (!repo) throw new Error("Missing fixture");
	repo.observation = {
		version: "current",
		source: "run",
		window: snapshot.window,
		refreshedAt: snapshot.fetched_at,
	};
	return repo;
}

it("uses actual healthy stream times and original retained times without changing repository counts", () => {
	const repo = fixture();
	const current = "2026-09-15T21:00:00.000Z";
	const old = "2026-09-10T21:00:00.000Z";
	for (const stream of FACTORY_STREAMS) repo.coverage[stream].fetchedAt = current;
	repo.coverage.dependencies = {
		...repo.coverage.dependencies,
		retained: true,
		fetchedAt: null,
		observation: {
			version: "old",
			source: "run",
			window: { since: "2026-06-18T00:00:00.000Z", until: old },
			refreshedAt: old,
			head: null,
		},
	};
	const before = structuredClone(repo);
	expect(factoryEvidenceFreshness([repo, undefined])).toEqual({
		oldestAt: old,
		latestAt: current,
		total: 2,
		missing: 1,
	});
	expect(repo).toEqual(before);
});

it("counts missing or invalid observations once per repository, never borrowing new time for unproven retention", () => {
	const repo = fixture();
	repo.coverage.commits.retained = true;
	repo.coverage.issues.fetchedAt = "invalid";
	const invalid = fixture();
	if (!invalid.observation) throw new Error("Missing observation");
	invalid.observation.refreshedAt = "invalid";
	const missing = fixture();
	delete missing.observation;
	expect(factoryEvidenceFreshness([repo, invalid, missing, undefined])).toEqual({
		oldestAt: repo.observation?.refreshedAt,
		latestAt: repo.observation?.refreshedAt,
		total: 4,
		missing: 4,
	});
});

it("preserves legacy repository observations and empty selections", () => {
	const repo = fixture();
	expect(factoryEvidenceFreshness([repo])).toEqual({
		oldestAt: repo.observation?.refreshedAt,
		latestAt: repo.observation?.refreshedAt,
		total: 1,
		missing: 0,
	});
	expect(factoryEvidenceFreshness([])).toEqual({
		oldestAt: null,
		latestAt: null,
		total: 0,
		missing: 0,
	});
});
