import { describe, expect, it } from "vitest";
import {
	github,
	memoryStore,
	NOW,
	rawEvent,
	rawRepo,
	ready,
} from "../../../tests/fixtures/factory";
import { FACTORY_STREAMS } from "../../lib/factory-types";
import {
	factoryNext,
	newFactory,
	splitActionWindow,
	stepFactory,
	streamKey,
} from "./factory-collect";

const invoke = (s = ready(), gh = github(() => Response.json([])), store = memoryStore()) =>
	stepFactory(s, gh, "test-token", store, NOW);

describe("factory incremental collection", () => {
	it("pages the complete owned inventory, deduplicates ids and records mutually exclusive exclusions", async () => {
		const state = newFactory("account_123", "nocoo", NOW);
		let page = 0;
		const gh = github(() =>
			Response.json({
				data: {
					viewer: {
						login: "nocoo",
						repositories: {
							totalCount: 5,
							nodes:
								page++ === 0
									? [rawRepo, { ...rawRepo, id: "2", nameWithOwner: "nocoo/old", isArchived: true }]
									: [
											rawRepo,
											{ ...rawRepo, id: "3", nameWithOwner: "nocoo/fork", isFork: true },
											{ ...rawRepo, id: "4", nameWithOwner: "nocoo/rsshub" },
											{ ...rawRepo, id: "5", nameWithOwner: "else/app", owner: { login: "else" } },
										],
							pageInfo: { hasNextPage: page === 1, endCursor: "c1" },
						},
					},
					rateLimit: { remaining: 100, resetAt: NOW },
				},
			}),
		);
		await invoke(state, gh);
		expect(state.inventory.complete).toBe(false);
		await invoke(state, gh);
		expect(state.inventory.scanned).toBe(5);
		expect(state.repos).toHaveLength(1);
		expect(state.inventory.excluded.map((r) => r.reason)).toEqual([
			"archived",
			"fork",
			"effective-mirror",
			"not-owner",
		]);
		expect(state.rate?.resource).toBe("graphql");
	});
	it.each([
		{ viewer: { login: "someone", repositories: { nodes: [] } } },
		{ viewer: { login: "nocoo", repositories: {} } },
		{
			viewer: {
				login: "nocoo",
				repositories: { totalCount: 2, nodes: [], pageInfo: { hasNextPage: false } },
			},
		},
		{
			viewer: {
				login: "nocoo",
				repositories: { totalCount: 2, nodes: [], pageInfo: { hasNextPage: true } },
			},
		},
	])("rejects incomplete/moving inventory instead of declaring zero", async (data) => {
		await expect(
			invoke(
				newFactory("a", "nocoo", NOW),
				github(() => Response.json({ data })),
			),
		).rejects.toMatchObject({ code: "github_error" });
	});
	it("separates account contribution calendar from repository commits and handles permissions", async () => {
		const state = ready();
		state.contributionStatus = "pending";
		await invoke(
			state,
			github(() =>
				Response.json({
					data: {
						user: {
							contributionsCollection: {
								restrictedContributionsCount: 2,
								contributionCalendar: {
									totalContributions: 4,
									weeks: [{ contributionDays: [{ date: "2026-09-01", contributionCount: 4 }] }],
								},
							},
						},
						rateLimit: { remaining: 200 },
					},
				}),
			),
		);
		expect(state.contribution?.total).toBe(4);
		expect(state.contribution?.restricted).toBe(2);
		expect(state.repos[0]?.metrics.commits).toBe(0);
		state.contributionStatus = "pending";
		await invoke(
			state,
			github(() => Response.json({ data: { user: null } })),
		);
		expect(state.contributionStatus).toBe("unavailable");
	});
	it("resumes REST Link pages, deduplicates resource ids and finalizes metrics once", async () => {
		const state = ready("prs");
		const store = memoryStore();
		let page = 0;
		const gh = github(() =>
			Response.json(
				[
					rawEvent(),
					{
						...rawEvent(2),
						merged_at: "2026-09-03T00:00:00Z",
						closed_at: "2026-09-03T00:00:00Z",
						state: "closed",
					},
				],
				{
					headers:
						page++ === 0
							? {
									link: '<https://api.github.com/repos/nocoo/app/pulls?page=2>; rel="next"',
									"x-ratelimit-remaining": "100",
									"x-ratelimit-reset": "1789513200",
								}
							: {},
				},
			),
		);
		await invoke(state, gh, store);
		expect(state.repos[0]?.coverage.prs.status).toBe("partial");
		expect(state.repos[0]?.metrics.prMerged).toBe(0);
		await invoke(state, gh, store);
		expect(state.repos[0]?.metrics.prMerged).toBe(1);
		expect(state.repos[0]?.coverage.prs.observed).toBe(2);
		expect(state.cursor.stream).toBe(3);
	});
	it("partitions Actions ranges above GitHub's 1,000-result cap, without double counting", async () => {
		const state = ready("actions");
		const store = memoryStore();
		let calls = 0;
		const gh = github(() =>
			Response.json(
				calls++ === 0
					? { total_count: 1001, workflow_runs: [] }
					: { total_count: 1, workflow_runs: [{ ...rawEvent(), conclusion: "success" }] },
			),
		);
		await invoke(state, gh, store);
		await invoke(state, gh, store);
		await invoke(state, gh, store);
		expect(state.repos[0]?.coverage.actions.status).toBe("complete");
		expect(state.repos[0]?.metrics.ciSuccess).toBe(1);
		expect(calls).toBe(3);
		expect(
			splitActionWindow({ since: "2026-09-01T00:00:00Z", until: "2026-09-01T00:00:01Z" }),
		).toBeNull();
	});
	it("reports unpageable Actions windows and resource storage caps explicitly", async () => {
		const state = ready("actions");
		state.window = { since: "2026-09-01T00:00:00Z", until: "2026-09-01T00:00:01Z" };
		await invoke(
			state,
			github(() => Response.json({ total_count: 1001, workflow_runs: [] })),
		);
		expect(state.repos[0]?.coverage.actions.status).toBe("limited");
		const large = ready("issues");
		await invoke(
			large,
			github(() =>
				Response.json(
					Array.from({ length: 5001 }, (_, i) => ({ ...rawEvent(i), title: "長".repeat(240) })),
				),
			),
		);
		expect(large.repos[0]?.coverage.issues.status).toBe("limited");
		expect(large.repos[0]?.coverage.issues.observed).toBeLessThan(5000);
	});
	it.each([403, 404])(
		"keeps denied resources unknown (%s), advances and preserves source",
		async (status) => {
			const state = ready("alerts");
			await invoke(
				state,
				github(() => Response.json({ message: "denied" }, { status })),
			);
			expect(state.repos[0]?.coverage.alerts.status).toBe("unavailable");
			expect(state.repos[0]?.coverage.alerts.source).toContain("dependabot/alerts");
		},
	);
	it("preserves retryable failures, protects rate reserve, and follows no foreign redirects/links", async () => {
		await expect(
			invoke(
				ready(),
				github(() => Response.json({}, { status: 429 })),
			),
		).rejects.toMatchObject({ code: "github_rate_limited" });
		await expect(
			invoke(
				ready(),
				github(() => Response.json({})),
			),
		).rejects.toMatchObject({ code: "github_error" });
		const state = ready();
		state.rate = { remaining: 49, resetAt: null, resource: "core" };
		await expect(invoke(state)).rejects.toMatchObject({ code: "github_rate_limited" });
		state.rate.resetAt = "2020-01-01";
		await invoke(state);
		expect(state.cursor.stream).toBe(1);
		expect(factoryNext(null, "/repos/a/b/issues")).toBeNull();
		for (const url of [
			"https://evil.test/repos/a/b/issues?page=2",
			"https://api.github.com/repos/c/d/issues",
			"https://api.github.com/repos/a/b/issues",
		])
			expect(() => factoryNext(`<${url}>; rel="next"`, "/repos/a/b/issues")).toThrow();
		const client = github((_url, init) => {
			expect(init?.redirect).toBe("error");
			expect(init?.signal).toBeDefined();
			return Response.json([]);
		});
		await invoke(ready(), client);
	});
	it("pins dependency manifests, preserves source locations, and handles absent/invalid files", async () => {
		const state = ready("dependencies");
		const gh = github((_url, init) => {
			expect(String(init?.body)).toContain("abc:package.json");
			return Response.json({
				data: {
					repository: {
						package: { text: '{"dependencies":{"@nocoo/basalt":"2.1.7"}}' },
						ci: { text: "jobs:\n  ci:\n    uses: nocoo/base-ci/.github/workflows/ci.yml@abc" },
						dependabot: { text: "version: 2" },
					},
				},
			});
		});
		await invoke(state, gh);
		expect(state.repos[0]?.dependencies).toHaveLength(3);
		expect(state.cursor.repo).toBe(1);
		await invoke(state);
		expect(state.status).toBe("complete");
		await invoke(state);
		expect(state.status).toBe("complete");
		await expect(
			invoke(
				ready("dependencies"),
				github(() => Response.json({ data: { repository: { package: { text: "bad-json" } } } })),
			),
		).rejects.toMatchObject({ code: "github_error" });
		const denied = ready("dependencies");
		await invoke(
			denied,
			github(() => Response.json({ data: { repository: null } })),
		);
		expect(denied.repos[0]?.coverage.dependencies.status).toBe("unavailable");
	});
	it("handles empty default branches and every empty resource without inventing events", async () => {
		const s = ready();
		if (s.repos[0]) s.repos[0].head = null;
		const store = memoryStore();
		const gh = github(() => {
			throw new Error("must not request empty branch");
		});
		await invoke(s, gh, store);
		expect(gh.count).toBe(0);
		expect(store.data.get(streamKey("nocoo/app", "commits"))?.coverage.status).toBe("complete");
		for (const stream of FACTORY_STREAMS.filter((s) => s !== "dependencies" && s !== "actions")) {
			const state = ready(stream);
			await invoke(state);
			expect(state.repos[0]?.coverage[stream].status).toBe("complete");
		}
	});
});

it("refuses partial GraphQL inventory and repeated cursors", async () => {
	const state = newFactory("account_123", "nocoo", NOW);
	state.inventory.after = "same";
	await expect(
		invoke(
			state,
			github(() =>
				Response.json({
					data: {
						viewer: {
							login: "nocoo",
							repositories: {
								totalCount: 1,
								nodes: [],
								pageInfo: { hasNextPage: true, endCursor: "same" },
							},
						},
					},
				}),
			),
		),
	).rejects.toMatchObject({ code: "github_error" });
	await expect(
		invoke(
			newFactory("account_123", "nocoo", NOW),
			github(() =>
				Response.json({
					data: { viewer: { login: "nocoo", repositories: { nodes: [] } } },
					errors: [{ type: "FORBIDDEN", path: ["viewer", "repositories"] }],
				}),
			),
		),
	).rejects.toMatchObject({ code: "github_error" });
});
