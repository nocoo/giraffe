import { describe, expect, it } from "vitest";
import { isAccountFixture, isCalendarFixture, isRepositoryFixture } from "./refresh-upstream-queue";

describe("refresh upstream queue fixtures", () => {
	it("classifies account, calendar, and repository entries", async () => {
		const account = {
			viewer: { repositories: { nodes: [{ id: "R" }], totalCount: 1 } },
		};
		const calendar = {
			viewer: {
				contributionsCollection: {
					contributionCalendar: { totalContributions: 0, weeks: [] },
				},
			},
		};
		const repository = { node: { id: "R" } };
		expect(isAccountFixture(account)).toBe(true);
		expect(isAccountFixture(calendar)).toBe(false);
		expect(await isCalendarFixture(calendar)).toBe(true);
		expect(await isRepositoryFixture(repository)).toBe(true);
		expect(
			await isRepositoryFixture(
				Response.json({
					data: { node: { id: "R" } },
					errors: [{ path: ["node", "releases"] }],
				}),
			),
		).toBe(true);
		expect(
			await isCalendarFixture(
				Response.json({
					data: null,
					errors: [{ path: ["viewer", "contributionsCollection", "contributionCalendar"] }],
				}),
			),
		).toBe(true);
	});
});
