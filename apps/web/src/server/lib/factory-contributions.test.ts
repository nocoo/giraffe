import { expect, it } from "vitest";
import { contributionDates, contributionTypes } from "./factory-contributions";

it("projects saved contribution counters without inventing counts for invalid evidence", () => {
	expect(
		contributionTypes({
			totalCommitContributions: 0,
			totalIssueContributions: 3,
			totalPullRequestContributions: -1,
			totalPullRequestReviewContributions: 1.5,
			restrictedContributionsCount: Number.NaN,
			totalRepositoryContributions: "1",
		}),
	).toEqual({
		commits: 0,
		issues: 3,
		pullRequests: null,
		pullRequestReviews: null,
		restricted: null,
		repositories: null,
	});
	for (const [since, until] of [
		["invalid", "2026-10-22"],
		["2026-10-22", "2026-10-21"],
		["2026-01-01", "2026-10-22"],
	])
		expect(contributionDates(since ?? "", until ?? "")).toEqual([]);
	expect(contributionDates("2026-10-21", "2026-10-22")).toEqual(["2026-10-21", "2026-10-22"]);
});
