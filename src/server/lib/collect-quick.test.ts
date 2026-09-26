import { expect, it } from "vitest";
import { github } from "../../../tests/fixtures/factory";
import { collectKind } from "./collect";

const issue = (number: number, state = "OPEN") => ({
	__typename: "Issue",
	number,
	title: `issue ${number}`,
	url: `https://github.com/a/b/issues/${number}`,
	repository: { nameWithOwner: "a/b" },
	state,
});
it("checks updated open and closed work, removes closures and stops after overlap", async () => {
	const baseline = {
		truncated: false,
		issues: [
			{ number: 1, url: issue(1).url, name_with_owner: "a/b" },
			{ number: 2, url: issue(2).url, name_with_owner: "a/b" },
		],
	};
	const gh = github((_url, init) => {
		expect(String(init?.body)).toContain("sort:updated-desc");
		expect(String(init?.body)).not.toContain("is:open");
		return Response.json({
			data: {
				search: {
					issueCount: 10,
					nodes: [issue(1, "CLOSED"), issue(3)],
					pageInfo: { hasNextPage: true, endCursor: "next" },
				},
			},
		});
	});
	const result = await collectKind(gh, "test", "issues", ["a/b"], 100000, baseline);
	expect(result.truncated).toBe(false);
	expect((result.issues as { number: number }[]).map((r) => r.number).sort()).toEqual([2, 3]);
	expect(gh.count).toBe(1);
});
it("follows older pages when needed and updates release data without retaining deleted records after exhaustion", async () => {
	for (const overlap of [true, false]) {
		let page = 0;
		const gh = github(() =>
			Response.json([{ id: ++page + 2, name: "new" }], {
				headers:
					page === 1
						? { link: '<https://api.github.com/repos/a/b/releases?page=2>; rel="next"' }
						: {},
			}),
		);
		const result = await collectKind(gh, "test", "repo:a/b:releases", [], 100000, {
			truncated: false,
			releases: [{ id: 1 }, { id: overlap ? 3 : 2 }],
		});
		expect(gh.count).toBe(overlap ? 1 : 2);
		expect((result.releases as { id: number }[]).map((r) => r.id).sort()).toEqual(
			overlap ? [1, 3] : [3, 4],
		);
	}
});
it("boots missing baselines normally and preserves partial error flags", async () => {
	const gh = github(() =>
		Response.json({
			data: { search: { issueCount: 2, nodes: [issue(1)], pageInfo: { hasNextPage: false } } },
		}),
	);
	const result = await collectKind(gh, "test", "issues", ["a/b"], 10000, {
		truncated: true,
		issues: [{ number: 1, url: issue(1).url }],
	});
	expect(result.truncated).toBe(true);
});
