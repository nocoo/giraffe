import { expect, it } from "vitest";
import { factoryGraphqlStub } from "./factory-stub";

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
