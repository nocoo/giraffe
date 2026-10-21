import { expect, it } from "vitest";
import { factoryFixture } from "../../../../tests/fixtures/factory-snapshot";
import { dependencyEvidence, normalizeRepoDependencies } from "./factory-dependencies";
import type { FactoryEvent } from "./factory-types";

const event: FactoryEvent = {
	id: "1",
	title: "own",
	url: "saved",
	at: "2026-10-20T00:00:00Z",
	createdAt: "2026-10-19T00:00:00Z",
	author: "author",
	closedAt: null,
	mergedAt: null,
	state: "declared",
};

it("preserves known metadata and non-package evidence while excluding self npm declarations", () => {
	const manifest = { name: "own", version: "1", path: "package.json", url: "saved" };
	const items = [
		event,
		{ ...event, path: "renovate.json" },
		{ ...event, path: ".github/workflows/ci.yml" },
		...["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].map(
			(section) => ({ ...event, path: `packages/ui/package.json#${section}` }),
		),
	];
	const original = structuredClone(items);
	expect(dependencyEvidence(items, [manifest, manifest])).toEqual({
		manifests: [manifest],
		items: items.slice(0, 3),
	});
	expect(items).toEqual(original);
	const repo = factoryFixture().repos[0];
	if (!repo) throw new Error("fixture");
	repo.manifests = [manifest];
	repo.dependencies = items.map((item) => ({
		name: item.title,
		version: "1",
		path: item.path ?? "",
		url: item.url,
	}));
	expect(normalizeRepoDependencies(repo).dependencies).toEqual(repo.dependencies.slice(0, 3));
});

it("deduplicates identical legacy workflow evidence and disambiguates distinct refs stably", () => {
	const base = ".github/workflows/ci.yml:nocoo/base-ci/.github/workflows/test-job.yml";
	const old = {
		...event,
		id: base,
		path: ".github/workflows/ci.yml",
		title: "nocoo/base-ci/.github/workflows/test-job.yml",
		version: "v1",
	};
	expect(dependencyEvidence([old, { ...old }]).items).toEqual([old]);
	const input = [old, { ...old, version: "v2" }, { ...old }];
	const original = structuredClone(input);
	const items = dependencyEvidence(input).items;
	expect(items.map((item) => item.id)).toEqual([`${base}#ref=v1`, `${base}#ref=v2`]);
	expect(
		dependencyEvidence([...input].reverse())
			.items.map((item) => item.id)
			.sort(),
	).toEqual(items.map((item) => item.id).sort());
	expect(dependencyEvidence(items).items).toEqual(items);
	expect(input).toEqual(original);
});

it("retains distinct evidence with the same ref and canonicalizes nested extension fields", () => {
	const base = ".github/workflows/ci.yml:actions/checkout";
	const old = {
		...event,
		id: base,
		path: ".github/workflows/ci.yml",
		title: "actions/checkout",
		version: "feature/x#1",
		extra: { b: [2, 1], a: { d: null, c: true } },
	};
	const equal = { ...old, extra: { a: { c: true, d: null }, b: [2, 1] } };
	const distinct = { ...old, author: "another" };
	const input = [old, equal, distinct];
	const items = dependencyEvidence(input).items;
	expect(items).toHaveLength(2);
	expect(items.map((item) => item.id).sort()).toEqual([
		`${base}#ref=feature%2Fx%231&entry=1`,
		`${base}#ref=feature%2Fx%231&entry=2`,
	]);
	expect(
		dependencyEvidence([...input].reverse())
			.items.map((item) => item.id)
			.sort(),
	).toEqual(items.map((item) => item.id).sort());
	expect(dependencyEvidence(items).items).toEqual(items);
	const known = dependencyEvidence(
		[old, { ...old, version: "v2" }].map((item) => ({ ...item, job: "build" })),
	).items;
	expect(known.map((item) => item.id)).toEqual([
		`${base}#job=build&ref=feature%2Fx%231`,
		`${base}#job=build&ref=v2`,
	]);
	const noVersion: FactoryEvent = { ...old };
	delete noVersion.version;
	const missingRef = dependencyEvidence([noVersion, { ...noVersion, author: "other" }]).items;
	expect(new Set(missingRef.map((item) => item.id)).size).toBe(2);
});
