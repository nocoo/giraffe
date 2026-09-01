import { describe, expect, it } from "vitest";
import {
	mapActionRuns,
	mapCodeScanningAlerts,
	mapContributors,
	mapDependabotAlerts,
	mapIssues,
	mapNotifications,
	mapPullRequests,
	mapReleases,
	mapRepoDetails,
	mapRepos,
	mapTraffic,
	mapUser,
	parseScopes,
} from "./github-map";

describe("github-map", () => {
	it("detects missing required scopes", () => {
		expect(parseScopes("repo, read:org").missing).toBe(true);
		expect(parseScopes("repo, read:org, read:user, notifications").missing).toBe(false);
		expect(mapUser({ login: "octocat" }).avatar_url).toBe("");
		expect(
			mapRepos([{ nameWithOwner: "o/n", stargazerCount: 1, owner: { login: "o" }, name: "n" }])[0],
		).toMatchObject({
			name_with_owner: "o/n",
			stargazer_count: 1,
		});
		expect(mapRepos([{ nameWithOwner: "o/n", issues: { totalCount: 4 } }])[0]).toMatchObject({
			open_issue_count: 4,
		});
	});

	it("maps remaining github payloads", () => {
		expect(
			mapIssues([
				null,
				{ __typename: "PullRequest" },
				{ number: 1, repository: { nameWithOwner: "o/n" }, author: "x" },
			]),
		).toEqual([expect.objectContaining({ number: 1, name_with_owner: "o/n", author_login: null })]);
		expect(mapPullRequests([null, { __typename: "Issue" }, { number: 2, additions: 3 }])).toEqual([
			expect.objectContaining({ number: 2, additions: 3 }),
		]);
		expect(mapNotifications(null as unknown as unknown[])).toEqual([]);
		expect(mapNotifications([1, { id: "1" }])).toEqual([expect.objectContaining({ id: "1" })]);
		expect(
			mapNotifications([
				{ id: "1", unread: true, subject: { title: "t" }, repository: { full_name: "o/n" } },
			]),
		).toEqual([expect.objectContaining({ id: "1", title: "t", name_with_owner: "o/n" })]);
		expect(
			mapDependabotAlerts("o/n", [
				null,
				{
					securityAdvisory: { summary: "s", permalink: "u" },
					securityVulnerability: { severity: "HIGH" },
				},
			]),
		).toEqual([expect.objectContaining({ source: "dependabot", severity: "high" })]);
		expect(
			mapCodeScanningAlerts("o/n", [
				{ rule: { description: "d", security_severity_level: "LOW" }, html_url: "h" },
			]),
		).toEqual([expect.objectContaining({ source: "code_scanning", severity: "low" })]);
		expect(mapCodeScanningAlerts("o/n", null as unknown as unknown[])).toEqual([]);
		expect(mapCodeScanningAlerts("o/n", [1, { html_url: "h" }])).toEqual([
			expect.objectContaining({ url: "h" }),
		]);
		expect(
			mapRepoDetails({ description: "d", license: { spdx_id: "MIT" }, archived: true }),
		).toMatchObject({
			description: "d",
			license: "MIT",
			is_archived: true,
		});
		expect(mapRepoDetails({ license: "MIT" }).license).toBe("MIT");
		expect(mapActionRuns({ workflow_runs: [{ id: 1, name: "ci" }] })).toEqual([
			expect.objectContaining({ id: 1, name: "ci" }),
		]);
		expect(mapActionRuns({})).toEqual([]);
		expect(mapTraffic({ count: 1, uniques: 2, views: [{ count: 1 }] }, "views")).toEqual({
			count: 1,
			uniques: 2,
			points: [{ count: 1 }],
		});
		expect(mapTraffic(null, "clones")).toEqual({ count: 0, uniques: 0, points: [] });
		expect(mapReleases([{ id: 1, tag_name: "v1" }])).toEqual([
			expect.objectContaining({ tag_name: "v1" }),
		]);
		expect(mapReleases(null as unknown as unknown[])).toEqual([]);
		expect(mapContributors([{ login: "a", contributions: 2 }])).toEqual([
			expect.objectContaining({ login: "a", contributions: 2 }),
		]);
		expect(mapContributors(null as unknown as unknown[])).toEqual([]);
		expect(parseScopes(null).scopes).toBe("");
		expect(mapUser({}).login).toBe("");
		expect(
			mapIssues([{ labels: {}, created_at: "c", updated_at: "u", comments_count: 4 }])[0],
		).toMatchObject({
			created_at: "c",
			comments_count: 4,
			labels: [],
		});
		expect(
			mapPullRequests([
				{
					created_at: "c",
					updated_at: "u",
					draft: true,
					review_decision: "APPROVED",
					base_ref: "m",
					head_ref: "f",
				},
			])[0],
		).toMatchObject({ is_draft: true, review_decision: "APPROVED", base_ref: "m" });
		expect(mapNotifications([{ id: 1, unread: 1 }])[0]).toMatchObject({
			id: "1",
			title: "",
			url: "",
		});
		expect(
			mapRepoDetails({
				url: "u",
				fork_count: 2,
				open_issue_count: 3,
				stargazer_count: 4,
				is_archived: true,
			}),
		).toMatchObject({
			url: "u",
			fork_count: 2,
			is_archived: true,
		});
		expect(mapActionRuns({ workflow_runs: [null, {}] })).toEqual([
			expect.objectContaining({ id: 0, name: "" }),
		]);
		expect(mapTraffic({ count: 1, uniques: 1, points: [1] }, "views").points).toEqual([1]);
		expect(mapReleases([null, {}])[0]).toMatchObject({ id: 0, tag_name: "" });
		expect(mapContributors([null, {}])[0]).toMatchObject({ login: "", contributions: 0 });
		expect(mapDependabotAlerts("o/n", [{}])[0]).toMatchObject({ severity: "", summary: "" });
		expect(
			mapCodeScanningAlerts("o/n", [{ severity: "HIGH", summary: "s", url: "u" }])[0],
		).toMatchObject({
			severity: "high",
			summary: "s",
			url: "u",
		});
	});
});
