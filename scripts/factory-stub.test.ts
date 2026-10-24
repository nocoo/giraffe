import { expect, it } from "vitest";
import { factoryGraphqlStub, factoryRestStub } from "./factory-stub";

it("keeps pinned default-branch history consistent with fixture metadata without changing dated streams", () => {
	const url = new URL(
		"http://fixture/repos/octocat/hello-world/commits?sha=abc&per_page=100&page=1",
	);
	expect(factoryRestStub(url)).toMatchObject([
		{
			sha: "abc",
			commit: {
				message: "Previously authored, newly observed",
				committer: { date: "2020-01-01T00:00:00Z" },
			},
		},
	]);
	url.searchParams.set("since", "2026-01-01");
	expect(factoryRestStub(url)).toBeNull();
	expect(
		factoryRestStub(new URL("http://fixture/repos/octocat/hello-world/commits?sha=missing")),
	).toBeNull();
	expect(factoryRestStub(new URL("http://fixture/repos/octocat/other/commits?sha=abc"))).toBeNull();
});

it("R4 HTTP fixtures cover bounded refs, tag and branch continuation queries", () => {
	const connection = { nodes: [], pageInfo: { hasNextPage: false } };
	expect(factoryGraphqlStub("query ActivityRefs", {})).toEqual({
		data: { repository: { refs: connection, tags: connection } },
	});
	expect(factoryGraphqlStub("query ActivityTags", {})).toEqual({
		data: { repository: { tags: connection } },
	});
	expect(factoryGraphqlStub("query ActivityBranchHistory", {})).toEqual({
		data: { repository: { object: { history: connection } } },
	});
});

it("R4 HTTP contribution fixtures include reported totals and native calendar provenance", () => {
	expect(
		factoryGraphqlStub("query ActivityBeijingContributions contributionsCollection", {
			from0: "2026-10-20T16:00:00.000Z",
			to0: "2026-10-21T15:59:59.999Z",
		}),
	).toMatchObject({
		data: {
			user: {
				day0: {
					contributionCalendar: { totalContributions: 0, weeks: [] },
					totalCommitContributions: 0,
				},
			},
		},
	});
});
