import { expect, it } from "vitest";
import { github, NOW } from "../../../../../tests/fixtures/factory";
import { makeRun } from "../../lib/factory-run";
import { newFactory } from "./factory-collect";
import { CONTRIBUTION_BATCH_DAYS, collectContributions } from "./factory-contributions";

const days = Array.from({ length: 90 }, (_, index) => ({
	date: new Date(Date.UTC(2026, 5, 18 + index)).toISOString().slice(0, 10),
	contributionCount: index === 89 ? 19 : 0,
}));
const totals = {
	totalCommitContributions: 7,
	totalIssueContributions: 2,
	totalPullRequestContributions: 3,
	totalPullRequestReviewContributions: 4,
	totalRepositoryContributions: 1,
	restrictedContributionsCount: 1,
};
function fixture() {
	const state = newFactory("account", "nocoo", NOW);
	const requests: { query: string; variables: Record<string, string> }[] = [];
	const gh = github((_url, init) => {
		const request = JSON.parse(String(init?.body)) as (typeof requests)[number];
		requests.push(request);
		if (request.query.includes("$since"))
			return Response.json({
				data: {
					user: {
						contributionsCollection: {
							restrictedContributionsCount: 1,
							contributionCalendar: { totalContributions: 19, weeks: [{ contributionDays: days }] },
						},
					},
					rateLimit: { remaining: 1000, resetAt: NOW },
				},
			});
		return Response.json({
			data: {
				user: Object.fromEntries(
					Object.keys(request.variables)
						.filter((key) => key.startsWith("from"))
						.map((key) => [key.replace("from", "day"), totals]),
				),
				rateLimit: { remaining: 900, resetAt: NOW },
			},
		});
	});
	return { state, requests, gh };
}

it("adds contributions to scheduled daily plans without broadening manual selected runs", () => {
	const plan = (daily: boolean, scope: "all" | "selected") =>
		makeRun(
			"run",
			"account",
			"nocoo",
			"key",
			"refresh",
			[],
			NOW,
			[],
			[],
			{ scope },
			"quick",
			daily,
		);
	expect(plan(true, "selected").steps.map((step) => step.kind)).toContain("contributions");
	expect(plan(false, "selected").steps.map((step) => step.kind)).not.toContain("contributions");
	expect(plan(true, "all").steps.filter((step) => step.kind === "contributions")).toHaveLength(1);
});

it("resumes bounded daily aggregate batches and preserves authoritative calendar counts", async () => {
	const { state, requests, gh } = fixture();
	await collectContributions(state, gh, "fake", NOW);
	expect(state.contributionStatus).toBe("pending");
	expect(state.contribution?.days).toHaveLength(90);
	while (state.contributionStatus === "pending") await collectContributions(state, gh, "fake", NOW);
	expect(requests).toHaveLength(1 + Math.ceil(90 / CONTRIBUTION_BATCH_DAYS));
	expect(state.contributionStatus).toBe("complete");
	expect(state.contribution).toMatchObject({
		total: 19,
		restricted: 1,
		timezone: "github",
		typeWindowTimezone: "UTC",
		partial: true,
		observedAt: NOW,
	});
	expect(state.contribution?.days.at(-1)).toMatchObject({
		date: "2026-09-15",
		count: 19,
		partial: true,
		types: {
			commits: 7,
			issues: 2,
			pullRequests: 3,
			pullRequestReviews: 4,
			restricted: 1,
			repositories: 1,
		},
		breakdown: "mismatch",
	});
	expect(state.contribution?.days[0]).toMatchObject({ count: 0, breakdown: "mismatch" });
	expect(state.rate).toMatchObject({ remaining: 900, resource: "graphql", observedAt: NOW });
	const last = requests.at(-1);
	expect(last?.variables).toMatchObject({
		from14: "2026-09-15T00:00:00.000Z",
		to14: NOW,
	});
	expect(requests[1]?.variables.to0).toBe("2026-06-18T23:59:59.999Z");
	expect(requests[1]?.query).toContain("excludeFirst:false,excludePopular:false");
	expect(requests[1]?.query).not.toContain("first:100");
});

it("does not mark absent, invalid or duplicate calendar coverage as an observed zero", async () => {
	for (const contributionDays of [
		[],
		days.slice(1),
		[...days, days[0]],
		[{ date: "2026-02-30", contributionCount: 0 }],
		days.map((day) => ({ ...day, contributionCount: -1 })),
	]) {
		const state = newFactory("account", "nocoo", NOW);
		await collectContributions(
			state,
			github(() =>
				Response.json({
					data: {
						user: {
							contributionsCollection: {
								restrictedContributionsCount: 0,
								contributionCalendar: { totalContributions: 0, weeks: [{ contributionDays }] },
							},
						},
					},
				}),
			),
			"fake",
			NOW,
		);
		expect(state.contributionStatus).toBe("unavailable");
		expect(state.contribution).toBeNull();
	}
});

it("records unavailable type fields as null, never zero, while preserving known calendar coverage", async () => {
	const { state, gh } = fixture();
	await collectContributions(state, gh, "fake", NOW);
	const missing = github(() =>
		Response.json({ data: { user: { day0: { ...totals, totalIssueContributions: null } } } }),
	);
	await collectContributions(state, missing, "fake", NOW);
	expect(state.contribution?.days[0]).toMatchObject({
		types: { issues: null, commits: 7 },
		breakdown: "unavailable",
	});
	expect(state.contribution?.days[1]).toMatchObject({
		types: { issues: null, commits: null },
		breakdown: "unavailable",
	});
});

it("rejects partial GraphQL errors and respects the saved rate reserve before requesting a batch", async () => {
	const { state, gh } = fixture();
	await collectContributions(state, gh, "fake", NOW);
	await collectContributions(
		state,
		github(() =>
			Response.json({ data: { user: null }, errors: [{ type: "FORBIDDEN", path: ["user"] }] }),
		),
		"fake",
		NOW,
	);
	expect(state.contributionStatus).toBe("unavailable");
	state.rate = { remaining: 49, resetAt: "2026-09-16T00:00:00Z", resource: "graphql" };
	const before = gh.count;
	await expect(collectContributions(state, gh, "fake", NOW)).rejects.toMatchObject({
		code: "github_rate_limited",
	});
	expect(gh.count).toBe(before);
});

it("recognizes complete typed coverage including explicit observed zeroes and an expired reserve", async () => {
	const { state, gh } = fixture();
	state.rate = { remaining: 0, resetAt: "2026-09-14T00:00:00Z", resource: "graphql" };
	await collectContributions(state, gh, "fake", NOW);
	const typed = github((_url, init) => {
		const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, string> };
		return Response.json({
			data: {
				user: Object.fromEntries(
					Object.entries(variables)
						.filter(([key]) => key.startsWith("from"))
						.map(([key, date]) => [
							key.replace("from", "day"),
							date.startsWith("2026-09-15")
								? { ...totals, totalCommitContributions: 8 }
								: Object.fromEntries(Object.keys(totals).map((field) => [field, 0])),
						]),
				),
			},
		});
	});
	while (state.contributionStatus === "pending")
		await collectContributions(state, typed, "fake", NOW);
	expect(state.contribution?.typesStatus).toBe("complete");
	expect(state.contribution?.days[0]).toMatchObject({
		count: 0,
		types: { commits: 0, restricted: 0 },
		breakdown: "complete",
	});
});
