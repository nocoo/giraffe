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
