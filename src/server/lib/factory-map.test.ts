import { describe, expect, it } from "vitest";
import { rawEvent, rawRepo } from "../../../tests/fixtures/factory";
import {
	coverage,
	exclusion,
	mapDependencies,
	mapFactoryEvents,
	mapFactoryRepo,
	object,
	rows,
} from "./factory-map";

describe("GitHub factory normalization", () => {
	it("normalizes private inventory, language bytes and explicit unknown languages", () => {
		expect(mapFactoryRepo(rawRepo)).toMatchObject({
			private: true,
			diskKiB: 1024,
			language: "TypeScript",
			head: "abc",
			totalCommits: 3,
			languages: [{ name: "TypeScript", bytes: 100 }],
			topics: ["cli"],
		});
		expect(mapFactoryRepo({})).toMatchObject({
			private: false,
			language: "未标记",
			branch: null,
			head: null,
			languages: [],
			totalCommits: 0,
			description: null,
		});
		expect(mapFactoryRepo({ ...rawRepo, languages: { totalCount: 101 } }).languagesComplete).toBe(
			false,
		);
		expect(object(null)).toEqual({});
		expect(object([])).toEqual({});
		expect(rows(null)).toEqual([]);
		expect(rows([null])).toEqual([{}]);
		expect(coverage().source).toBe("");
		expect(exclusion({ ...rawRepo, nameWithOwner: "NoCoO/RssHub" }, "NOCOO")).toBe(
			"effective-mirror",
		);
	});
	it("separates issue records from PRs and preserves native author/timestamps/ids", () => {
		const rows = mapFactoryEvents("issues", [rawEvent(), { ...rawEvent(2), pull_request: {} }, {}]);
		expect(rows).toHaveLength(2);
		expect(rows[0]?.id).toBe("N_1");
		expect(rows[1]?.author).toBe("unlinked");
		const commit = mapFactoryEvents("commits", [
			{
				sha: "abc",
				html_url: "https://github.com/nocoo/app/commit/abc",
				commit: { message: "first\nrest", committer: { date: "2026-09-01T00:00:00Z" } },
				author: { login: "nocoo" },
			},
		])[0];
		expect(commit).toMatchObject({
			id: "abc",
			title: "first",
			state: "committed",
			author: "nocoo",
		});
		expect(mapFactoryEvents("commits", [{}])[0]?.title).toBe("");
		expect(mapFactoryEvents("prs", [{ ...rawEvent(), draft: true }])[0]?.draft).toBe(true);
		expect(
			mapFactoryEvents("actions", [{ ...rawEvent(), conclusion: null, status: "queued" }])[0]
				?.conclusion,
		).toBeNull();
		expect(
			mapFactoryEvents("actions", [
				{ id: 1, actor: { login: "bot" }, name: "ci", status: "completed", conclusion: "success" },
			])[0],
		).toMatchObject({ id: "1", title: "ci", author: "bot", state: "completed" });
		expect(
			mapFactoryEvents("alerts", [
				{
					number: 4,
					dependency: { package: { name: "pkg" } },
					security_advisory: { severity: "high" },
				},
			])[0],
		).toMatchObject({ id: "4", title: "pkg · high" });
	});
	it("uses release published_at, preserving draft and prerelease distinction", () => {
		const events = mapFactoryEvents("releases", [
			{ tag_name: "v1", published_at: "2026-09-01", draft: true },
			{ prerelease: true },
			{},
		]);
		expect(events.map((r) => r.state)).toEqual(["draft", "prerelease", "published"]);
		expect(events[0]?.at).toBe("2026-09-01");
		expect(events[0]?.title).toBe("v1");
	});
	it("captures literal manifest and reusable-workflow evidence with immutable source URLs", () => {
		const repo = mapFactoryRepo(rawRepo);
		const data = mapDependencies(
			{
				package: {
					text: JSON.stringify({
						dependencies: { one: "^1", invalid: 42 },
						devDependencies: { two: "2" },
						peerDependencies: { three: "3" },
						optionalDependencies: { four: "4" },
					}),
				},
				ci: { text: "steps:\n - uses: nocoo/base-ci/action@abc\n - uses: './local'" },
				release: {
					text: "jobs:\n build:\n  uses: 'nocoo/base-ci/.github/workflows/deploy.yml@main'",
				},
				dependabot: { text: "" },
				renovate: { text: "{}" },
			},
			repo,
		);
		expect(data.map((d) => d.title)).toEqual([
			"one",
			"two",
			"three",
			"four",
			"nocoo/base-ci/action",
			"nocoo/base-ci/.github/workflows/deploy.yml",
			"dependabot",
			"renovate",
		]);
		expect(data[0]?.url).toContain("/blob/abc/package.json#dependencies");
		expect(mapDependencies({}, repo)).toEqual([]);
		expect(() => mapDependencies({ package: { text: "{" } }, repo)).toThrow();
	});
});
