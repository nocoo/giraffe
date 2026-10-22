import { expect, it } from "vitest";
import { github, rawRepo } from "../../../../../tests/fixtures/factory";
import { makeRun } from "../../lib/factory-run";
import { collectActivityContributions, collectActivitySupplement } from "./activity-collect";
import { mapFactoryRepo } from "./factory-map";

const now = "2026-10-22T20:00:00.000Z";
const run = () => ({
	...makeRun(
		"r2",
		"account_123",
		"nocoo",
		"key",
		"refresh",
		[],
		now,
		[],
		[],
		{ scope: "all" },
		"quick",
	),
	activityWindow: { since: "2026-10-21T20:00:00.000Z", until: now, gap: false, first: false },
});
it("R4 Beijing contribution types use real UTC+08 boundaries without inventing calendar composition", async () => {
	const gh = github((_url, init) => {
		const body = JSON.parse(String(init?.body));
		expect(body.variables).toMatchObject({
			from0: "2026-10-21T16:00:00.000Z",
			to0: "2026-10-22T15:59:59.999Z",
			from1: "2026-10-22T16:00:00.000Z",
			to1: now,
		});
		return Response.json({
			data: {
				user: {
					day0: {
						totalCommitContributions: 3,
						totalIssueContributions: 1,
						totalPullRequestContributions: 0,
						totalPullRequestReviewContributions: 0,
						totalRepositoryContributions: 0,
						restrictedContributionsCount: 0,
					},
					day1: {},
					day2: {},
				},
			},
		});
	});
	const result = await collectActivityContributions(run(), gh, "fake");
	expect(result.timezone).toBe("Asia/Shanghai");
	expect(result.days[0]).toMatchObject({
		count: null,
		partial: false,
		types: { commits: 3, issues: 1 },
		coverage: { status: "partial" },
	});
	expect(result.days.at(-1)?.partial).toBe(true);
	expect(gh.count).toBe(1);
});
it("R4 supplements branch commits and annotated tags with measured bounded request overhead", async () => {
	const gh = github((url) =>
		url.endsWith("/graphql")
			? Response.json({
					data: {
						repository: {
							refs: {
								nodes: [
									{
										name: "feature",
										target: {
											oid: "feature-head",
											history: {
												nodes: [
													{
														oid: "other-sha",
														committedDate: "2026-10-22T01:00:00.000Z",
														message: "Subject\nbody",
														url: "https://github.com/nocoo/app/commit/other-sha",
														author: { user: { login: "nocoo" } },
													},
												],
												pageInfo: { hasNextPage: false },
											},
										},
									},
								],
								pageInfo: { hasNextPage: false },
							},
							tags: {
								nodes: [
									{
										name: "v1",
										target: {
											__typename: "Tag",
											oid: "tag-id",
											tagger: { date: "2026-10-22T01:00:00.000Z" },
										},
									},
								],
								pageInfo: { hasNextPage: false },
							},
						},
					},
				})
			: Response.json({
					workflow_runs: [
						{
							id: 7,
							name: "Release",
							status: "completed",
							conclusion: "success",
							created_at: "2026-10-01T01:00:00.000Z",
							updated_at: "2026-10-01T01:05:00.000Z",
						},
					],
				}),
	);
	let state = null;
	for (let page = 0; page < 4; page++) {
		const result = await collectActivitySupplement(
			run(),
			mapFactoryRepo(rawRepo),
			gh,
			"fake",
			state,
		);
		state = result.state;
		if (result.done) break;
	}
	expect(state?.commits?.[0]).toMatchObject({
		sha: "other-sha",
		message: "Subject",
		branch: "feature",
		is_default_branch: false,
	});
	expect(state?.tags?.[0]?.title).toBe("v1");
	expect(state?.last_success_at).toBe("2026-10-01T01:05:00.000Z");
	expect(gh.count).toBe(2);
});

it("R4 retains GitHub-reported interval counts and native calendar provenance without forcing composition", async () => {
	const gh = github((_url, init) => {
		const variables = JSON.parse(String(init?.body)).variables;
		const user = Object.fromEntries(
			Object.keys(variables)
				.filter((key) => key.startsWith("from"))
				.map((key) => [
					key.replace("from", "day"),
					{
						totalCommitContributions: 2,
						totalIssueContributions: 0,
						totalPullRequestContributions: 0,
						totalPullRequestReviewContributions: 0,
						totalRepositoryContributions: 0,
						restrictedContributionsCount: 0,
						contributionCalendar: {
							totalContributions: 3,
							weeks: [{ contributionDays: [{ date: "2026-10-22", contributionCount: 3 }] }],
						},
					},
				]),
		);
		return Response.json({ data: { user } });
	});
	const result = await collectActivityContributions(run(), gh, "fake");
	expect(result.days[0]).toMatchObject({
		count: 3,
		types: { commits: 2 },
		nativeCalendar: { timezone: "github", total: 3, days: [{ date: "2026-10-22", count: 3 }] },
		coverage: { status: "partial" },
	});
});
it("R4 complete Beijing composition, unavailable counts and invalid native calendars remain distinct", async () => {
	const rows = [
		{
			totalCommitContributions: 0,
			totalIssueContributions: 0,
			totalPullRequestContributions: 0,
			totalPullRequestReviewContributions: 0,
			totalRepositoryContributions: 0,
			restrictedContributionsCount: 0,
			contributionCalendar: {
				totalContributions: 0,
				weeks: [{ contributionDays: [{ date: "2026-10-22", contributionCount: 0 }] }],
			},
		},
		{
			contributionCalendar: {
				totalContributions: -1,
				weeks: [{ contributionDays: [{ date: "bad", contributionCount: -1 }] }],
			},
		},
	];
	const result = await collectActivityContributions(
		run(),
		github(() => Response.json({ data: { user: { day0: rows[0], day1: rows[1] } } })),
		"fake",
	);
	expect(result.days[0]?.coverage.status).toBe("complete");
	expect(result.days[1]).toMatchObject({
		count: null,
		nativeCalendar: { days: [] },
		coverage: { status: "unavailable" },
	});
});
it.each([403, 404, 500])(
	"R4 Beijing permission failures stay null while transport errors retry (%s)",
	async (status) => {
		const job = collectActivityContributions(
			run(),
			github(() => Response.json({}, { status })),
			"fake",
		);
		if (status === 500) await expect(job).rejects.toMatchObject({ code: "github_error" });
		else
			expect(
				(await job).days.every(
					(day) => day.count === null && day.coverage.status === "unavailable",
				),
			).toBe(true);
	},
);
it("R4 bounds long contribution gaps to ninety real Beijing intervals", async () => {
	const current = run();
	current.activityWindow.since = "2026-01-01T00:00:00.000Z";
	const result = await collectActivityContributions(
		current,
		github(() => Response.json({ data: { user: null } })),
		"fake",
	);
	expect(result.days).toHaveLength(90);
	expect(result.days.every((day) => day.coverage.truncated)).toBe(true);
});

const emptyConnection = () => ({ nodes: [], pageInfo: { hasNextPage: false } });
const emptyRefs = () => ({
	data: { repository: { refs: emptyConnection(), tags: emptyConnection() } },
});
it("R4 supplement paginates frozen branch histories and tags, deduplicates SHAs and reports lightweight tags", async () => {
	let calls = 0;
	const gh = github((url, init) => {
		if (!url.endsWith("/graphql")) {
			calls++;
			return Response.json({ workflow_runs: [] });
		}
		const body = JSON.parse(String(init?.body));
		calls++;
		if (body.query.includes("ActivityRefs")) {
			if (body.variables.after)
				return Response.json({ data: { repository: { refs: emptyConnection() } } });
			return Response.json({
				data: {
					repository: {
						refs: {
							nodes: [
								{ name: "main", target: { oid: "abc" } },
								{
									name: "feature",
									target: {
										oid: "pinned",
										history: {
											nodes: [
												{
													oid: "same",
													committedDate: "2026-10-22T01:00:00.000Z",
													message: "first",
													url: "u",
													author: { user: { login: "a" } },
												},
												{ oid: "old", committedDate: "2026-09-22T00:00:00Z" },
											],
											pageInfo: { hasNextPage: true, endCursor: "history2" },
										},
									},
								},
							],
							pageInfo: { hasNextPage: true, endCursor: "branches2" },
						},
						tags: {
							nodes: [
								{ name: "light", target: { __typename: "Commit", oid: "c" } },
								{
									name: "old",
									target: {
										__typename: "Tag",
										oid: "old",
										tagger: { date: "2026-01-01T00:00:00Z" },
									},
								},
							],
							pageInfo: { hasNextPage: true, endCursor: "tags2" },
						},
					},
				},
			});
		}
		if (body.query.includes("ActivityTags"))
			return Response.json({
				data: {
					repository: {
						tags: {
							nodes: [
								{
									name: "v2",
									target: {
										__typename: "Tag",
										oid: "t",
										tagger: { date: "2026-10-22T01:00:00.000Z" },
									},
								},
								{
									name: "v2",
									target: {
										__typename: "Tag",
										oid: "t",
										tagger: { date: "2026-10-22T01:00:00.000Z" },
									},
								},
							],
							pageInfo: { hasNextPage: false },
						},
					},
				},
			});
		if (body.query.includes("ActivityBranchHistory")) {
			expect(body.variables).toMatchObject({ sha: "pinned", after: "history2" });
			return Response.json({
				data: {
					repository: {
						object: {
							history: {
								nodes: [
									{ oid: "same", committedDate: "2026-10-22T01:00:00.000Z" },
									{ oid: "new", committedDate: "2026-10-22T02:00:00.000Z", message: "new" },
								],
								pageInfo: { hasNextPage: false },
							},
						},
					},
				},
			});
		}
		return Response.json({ workflow_runs: [] });
	});
	let state = null;
	for (let page = 0; page < 10; page++) {
		const result = await collectActivitySupplement(
			run(),
			mapFactoryRepo(rawRepo),
			gh,
			"fake",
			state,
		);
		state = result.state;
		if (result.done) break;
	}
	expect(state?.phase).toBe("done");
	expect(state?.commits?.map((commit) => commit.sha)).toEqual(["same", "new"]);
	expect(state?.tags).toHaveLength(1);
	expect(state?.coverage.tags).toMatchObject({ status: "partial", truncated: false });
	expect(calls).toBe(5);
	expect(gh.count).toBe(5);
});
it("R4 reuses a current complete ninety-day deployment success with one added request/page", async () => {
	const { mapFactoryEvents } = await import("./factory-map");
	const repo = mapFactoryRepo(rawRepo);
	const actions = {
		runId: "r2",
		items: mapFactoryEvents("actions", [
			{
				id: 1,
				name: "Publish",
				created_at: "2026-10-01T00:00:00Z",
				updated_at: "2026-10-01T00:01:00Z",
				status: "completed",
				conclusion: "success",
			},
		]),
		next: null,
		ranges: [],
		coverage: { ...repo.coverage.actions, status: "complete" as const },
	};
	const gh = github(() => Response.json(emptyRefs()));
	const result = await collectActivitySupplement(run(), repo, gh, "fake", null, actions);
	expect(result.done).toBe(true);
	expect(result.state.last_success_at).toBe("2026-10-01T00:01:00Z");
	expect(gh.count).toBe(1);
	const replay = await collectActivitySupplement(run(), repo, gh, "fake", result.state, actions);
	expect(replay.done).toBe(true);
	expect(gh.count).toBe(1);
});
it("R4 deployment history can predate ninety days and follows a bounded success cursor", async () => {
	const gh = github((url) =>
		url.endsWith("/graphql")
			? Response.json(emptyRefs())
			: new URL(url).searchParams.get("page") === "2"
				? Response.json({
						workflow_runs: [
							{
								id: 1,
								name: "Deploy",
								status: "completed",
								conclusion: "success",
								created_at: "2026-01-01T00:00:00Z",
								updated_at: "2026-01-01T00:02:00Z",
							},
						],
					})
				: Response.json(
						{ workflow_runs: [] },
						{
							headers: {
								link: '<https://api.github.com/repos/nocoo/app/actions/runs?page=2>; rel="next"',
							},
						},
					),
	);
	let state = null;
	for (let page = 0; page < 3; page++) {
		state = (await collectActivitySupplement(run(), mapFactoryRepo(rawRepo), gh, "fake", state))
			.state;
	}
	expect(state?.last_success_at).toBe("2026-01-01T00:02:00Z");
	expect(state?.coverage.deploy?.status).toBe("complete");
	expect(gh.count).toBe(3);
});
it.each([403, 404])(
	"R4 denied supplementary branch observations are null and not fake zero (%s)",
	async (status) => {
		const result = await collectActivitySupplement(
			run(),
			mapFactoryRepo(rawRepo),
			github(() => Response.json({}, { status })),
			"fake",
			null,
		);
		expect(result.state.commits).toBeNull();
		expect(result.state.tags).toBeNull();
		expect(result.state.coverage.other_commits?.status).toBe("unavailable");
		expect(result.done).toBe(true);
	},
);
it("R4 malformed supplemental cursors and missing history fail instead of publishing completeness", async () => {
	for (const data of [
		{
			data: {
				repository: {
					refs: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
					tags: emptyConnection(),
				},
			},
		},
		{
			data: {
				repository: {
					refs: {
						nodes: [{ name: "feature", target: { oid: "x", history: {} } }],
						pageInfo: { hasNextPage: false },
					},
					tags: emptyConnection(),
				},
			},
		},
	])
		await expect(
			collectActivitySupplement(
				run(),
				mapFactoryRepo(rawRepo),
				github(() => Response.json(data)),
				"fake",
				null,
			),
		).rejects.toMatchObject({ code: "github_error" });
});
it("R4 supplemental page budget terminates with explicit per-list truncation", async () => {
	const first = await collectActivitySupplement(
		run(),
		mapFactoryRepo(rawRepo),
		github(() => Response.json(emptyRefs())),
		"fake",
		null,
	);
	first.state.pages = 19;
	const gh = github(() =>
		Response.json(
			{ workflow_runs: [] },
			{
				headers: {
					link: '<https://api.github.com/repos/nocoo/app/actions/runs?page=2>; rel="next"',
				},
			},
		),
	);
	const result = await collectActivitySupplement(
		run(),
		mapFactoryRepo(rawRepo),
		gh,
		"fake",
		first.state,
	);
	expect(result.done).toBe(true);
	expect(result.state.coverage.deploy).toMatchObject({ status: "partial", truncated: true });
});
it.each([403, 404])(
	"R4 later tag denial cannot silently complete pending branch history (%s)",
	async (status) => {
		const gh = github((url, init) => {
			if (!url.endsWith("/graphql")) return Response.json({ workflow_runs: [] });
			const query = JSON.parse(String(init?.body)).query;
			if (query.includes("ActivityTags")) return Response.json({}, { status });
			if (query.includes("ActivityBranchHistory"))
				return Response.json({
					data: {
						repository: {
							object: {
								history: {
									nodes: [
										{ oid: "second", committedDate: "2026-10-22T02:00:00.000Z", message: "later" },
									],
									pageInfo: { hasNextPage: false },
								},
							},
						},
					},
				});
			return Response.json({
				data: {
					repository: {
						refs: {
							nodes: [
								{
									name: "feature",
									target: {
										oid: "head",
										history: {
											nodes: [
												{
													oid: "first",
													committedDate: "2026-10-22T01:00:00.000Z",
													message: "first",
												},
											],
											pageInfo: { hasNextPage: true, endCursor: "history-next" },
										},
									},
								},
							],
							pageInfo: { hasNextPage: false },
						},
						tags: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "tags-next" } },
					},
				},
			});
		});
		let result = await collectActivitySupplement(run(), mapFactoryRepo(rawRepo), gh, "fake", null);
		result = await collectActivitySupplement(
			run(),
			mapFactoryRepo(rawRepo),
			gh,
			"fake",
			result.state,
		);
		expect(result.done).toBe(false);
		expect(result.state.phase).toBe("commits");
		result = await collectActivitySupplement(
			run(),
			mapFactoryRepo(rawRepo),
			gh,
			"fake",
			result.state,
		);
		result = await collectActivitySupplement(
			run(),
			mapFactoryRepo(rawRepo),
			gh,
			"fake",
			result.state,
		);
		expect(result.done).toBe(true);
		expect(result.state.commits?.map((commit) => commit.sha)).toEqual(["first", "second"]);
		expect(result.state.coverage.tags?.status).toBe("unavailable");
	},
);
