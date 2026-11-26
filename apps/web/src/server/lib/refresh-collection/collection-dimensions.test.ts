import { afterEach, describe, expect, it, vi } from "vitest";
import { readFactoryResource } from "../machine-observations";
import {
	accountPage,
	fixture,
	now,
	observation,
	publication,
	release,
	releases,
	repo,
	sourceSnapshot,
	upstream,
} from "./__tests__/collection-helper";
import { collectAccount, collectRepository } from "./index";
import { blankDay } from "./model";
import { collectionDb } from "./store";

afterEach(() => vi.unstubAllGlobals());

describe("unified refresh collection - actions, releases and alerts", () => {
	it("re-collects outside-window action days missing head_branch during lookback", async () => {
		const context = await fixture();
		const outside = "2026-10-27";
		const outsideDay = {
			date: outside,
			since: "2026-10-26T16:00:00.000Z",
			until: "2026-10-27T16:00:00.000Z",
		};
		context.days = [
			{ date: "2026-10-28", since: "2026-10-27T16:00:00.000Z", until: "2026-10-28T16:00:00.000Z" },
			{ date: "2026-10-31", since: "2026-10-30T16:00:00.000Z", until: "2026-10-31T16:00:00.000Z" },
		];
		context.run.params = {
			...context.run.params,
			since: "2026-10-28",
			until: "2026-10-31",
			lookbackDays: 4,
			dimensions: ["actions"],
		};
		const run = {
			id: 77,
			name: "CI",
			html_url: "https://github.com/owner/project/actions/runs/77",
			status: "completed",
			conclusion: "failure",
			head_branch: "main",
			event: "push",
			created_at: "2026-10-27T04:00:00.000Z",
			updated_at: "2026-10-27T04:00:00.000Z",
		};
		upstream([accountPage(), { node: repo() }]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		const observationPayload = (items: unknown[]) =>
			JSON.stringify({ count: null, items, since: outsideDay.since, until: outsideDay.until });
		await context.env.DB.prepare(
			`INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at) VALUES('a','R_1','Asia/Shanghai',?,'actions','complete',?,?)`,
		)
			.bind(
				outside,
				observationPayload([{ id: "a1", conclusion: "failure", activityRun: null }]),
				context.now,
			)
			.run();
		const fetch = upstream([{ node: repo() }], {
			"/actions/runs": { total_count: 1, workflow_runs: [run] },
		});
		await collectRepository(context, "owner/project");
		expect(fetch.mock.calls.some(([url]) => String(url).includes("/actions/runs"))).toBe(true);
		const day = await context.env.DB.prepare(
			"SELECT payload FROM refresh_day_observations WHERE dimension='actions' AND day=?",
		)
			.bind(outside)
			.first<{ payload: string }>();
		expect(JSON.parse(day?.payload ?? "{}").items[0].activityRun.head_branch).toBe("main");
		expect((await publication(context)).repos[0].metrics.days[outside]?.ciFailure).toBe(1);
	});
	it("fetches GitHub Actions for outside-window days missing observations when prior CI was nonzero", async () => {
		const context = await fixture();
		const outside = "2026-10-27";
		context.days = [
			{ date: "2026-10-28", since: "2026-10-27T16:00:00.000Z", until: "2026-10-28T16:00:00.000Z" },
			{ date: "2026-10-31", since: "2026-10-30T16:00:00.000Z", until: "2026-10-31T16:00:00.000Z" },
		];
		context.run.params = {
			...context.run.params,
			since: "2026-10-28",
			until: "2026-10-31",
			lookbackDays: 4,
			dimensions: ["actions"],
		};
		const run = {
			id: 88,
			name: "CI",
			html_url: "https://github.com/owner/project/actions/runs/88",
			status: "completed",
			conclusion: "failure",
			head_branch: "main",
			created_at: "2026-10-27T04:00:00.000Z",
			updated_at: "2026-10-27T04:00:00.000Z",
		};
		upstream([accountPage(), { node: repo() }]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		await context.env.DB.prepare(
			`UPDATE refresh_repository_publications SET payload=json_set(payload,'$.metrics.days."${outside}"',json(?)) WHERE account_id='a'`,
		)
			.bind(JSON.stringify({ ...blankDay(), ciFailure: 2, ciSuccess: 1 }))
			.run();
		await context.env.DB.prepare(
			"DELETE FROM refresh_day_observations WHERE account_id='a' AND day=? AND dimension='actions'",
		)
			.bind(outside)
			.run();
		const fetch = upstream([{ node: repo() }], {
			"/actions/runs": { total_count: 1, workflow_runs: [run] },
		});
		await collectRepository(context, "owner/project");
		const restCalls = fetch.mock.calls.filter(([url]) => String(url).includes("/actions/runs"));
		expect(restCalls.length).toBeGreaterThanOrEqual(2);
		expect((await publication(context)).repos[0].metrics.days[outside]?.ciFailure).toBe(1);
		const secondPass = await collectRepository(context, "owner/project");
		expect(secondPass.actionsObservationAudit).toMatchObject({
			repo: "owner/project",
			outsideWindowDays: 1,
			missingObservationDays: 0,
		});
	});
	it("includes branchless prior action days when planning observation writes", async () => {
		const context = await fixture();
		context.days = [
			{ date: "2026-10-31", since: "2026-10-30T16:00:00.000Z", until: "2026-10-31T16:00:00.000Z" },
		];
		context.run.params = {
			...context.run.params,
			since: "2026-10-31",
			until: "2026-10-31",
			dimensions: ["actions"],
		};
		upstream([accountPage(), { node: repo() }]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		await context.env.DB.prepare(
			`INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at) VALUES('a','R_1','Asia/Shanghai','2026-10-26','actions','complete',?,?)`,
		)
			.bind(
				JSON.stringify({
					count: 1,
					items: [{ id: "stale", conclusion: "failure", activityRun: null }],
					since: "2026-10-25T16:00:00.000Z",
					until: "2026-10-26T16:00:00.000Z",
				}),
				context.now,
			)
			.run();
		upstream([{ node: repo() }]);
		await expect(collectRepository(context, "owner/project")).resolves.toMatchObject({
			requests: expect.any(Number),
		});
	});
	it("re-collects actions days missing head_branch and counts default-branch failures", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["actions"];
		const run = {
			id: 99,
			name: "CI",
			html_url: "https://github.com/owner/project/actions/runs/99",
			status: "completed",
			conclusion: "failure",
			head_branch: "main",
			event: "push",
			created_at: "2026-10-28T02:00:00.000Z",
			updated_at: "2026-10-28T02:00:00.000Z",
		};
		upstream([accountPage(), { node: repo() }], {
			"/actions/runs": { total_count: 1, workflow_runs: [run] },
		});
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		await context.env.DB.prepare(
			`UPDATE refresh_day_observations SET payload=json_set(payload,'$.items[0].activityRun',json('null')) WHERE account_id='a' AND dimension='actions'`,
		).run();
		const fetch = upstream([{ node: repo() }], {
			"/actions/runs": { total_count: 1, workflow_runs: [run] },
		});
		await collectRepository(context, "owner/project");
		expect(fetch.mock.calls.some(([url]) => String(url).includes("/actions/runs"))).toBe(true);
		const day = await context.env.DB.prepare(
			"SELECT payload FROM refresh_day_observations WHERE dimension='actions' LIMIT 1",
		).first<{ payload: string }>();
		expect(JSON.parse(day?.payload ?? "{}").items[0].activityRun.head_branch).toBe("main");
		expect((await publication(context)).repos[0].metrics.ciFailure).toBe(1);
	});
	it("counts default-branch CI failures only when head_branch matches", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["actions"];
		upstream([accountPage(), { node: repo() }], {
			"/actions/runs": {
				total_count: 1,
				workflow_runs: [
					{
						id: 1,
						name: "CI",
						html_url: "https://github.com/owner/project/actions/runs/1",
						status: "completed",
						conclusion: "failure",
						head_branch: "feature",
						created_at: "2026-10-28T02:00:00.000Z",
					},
				],
			},
		});
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		expect((await publication(context)).repos[0].metrics.ciFailure).toBe(0);
	});
	it("publishes default-branch-only ciSuccess and ciFailure from stored action observations", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["actions"];
		context.run.params.since = "2026-10-28";
		context.run.params.until = "2026-10-28";
		upstream([accountPage(), { node: repo() }], {
			"/actions/runs": {
				total_count: 4,
				workflow_runs: [
					{
						id: 1,
						name: "CI",
						html_url: "https://github.com/owner/project/actions/runs/1",
						status: "completed",
						conclusion: "success",
						head_branch: "main",
						created_at: "2026-10-28T02:00:00.000Z",
					},
					{
						id: 2,
						name: "CI",
						html_url: "https://github.com/owner/project/actions/runs/2",
						status: "completed",
						conclusion: "success",
						head_branch: "feature",
						created_at: "2026-10-28T03:00:00.000Z",
					},
					{
						id: 3,
						name: "CI",
						html_url: "https://github.com/owner/project/actions/runs/3",
						status: "completed",
						conclusion: "failure",
						head_branch: "main",
						created_at: "2026-10-28T04:00:00.000Z",
					},
					{
						id: 4,
						name: "CI",
						html_url: "https://github.com/owner/project/actions/runs/4",
						status: "completed",
						conclusion: "failure",
						head_branch: "feature",
						created_at: "2026-10-28T05:00:00.000Z",
					},
				],
			},
		});
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		expect((await publication(context)).repos[0].metrics).toMatchObject({
			ciSuccess: 1,
			ciFailure: 1,
		});
	});
	it("collects latest CI, releases and both alert features in the saved wire format", async () => {
		const context = await fixture();
		const actions = [
			{
				id: 1,
				name: "CI",
				html_url: "run",
				status: "completed",
				conclusion: "success",
				head_branch: "main",
				created_at: "2026-10-28T01:00:00Z",
			},
			{
				id: 2,
				status: "completed",
				conclusion: "failure",
				head_branch: "main",
				created_at: "2026-10-28T02:00:00Z",
			},
			{ id: 3, status: "completed", conclusion: "neutral", created_at: "2026-10-28T03:00:00Z" },
			{ id: 4, status: "in_progress", created_at: "2026-10-28T04:00:00Z" },
		];
		const fetch = upstream(
			[
				accountPage(),
				{
					node: {
						...repo(),
						releases: releases([release("1", "2026-10-28T04:00:00Z")]),
					},
				},
			],
			{
				"/actions/runs": { total_count: 4, workflow_runs: actions },
				"/dependabot/alerts": [
					{
						number: 1,
						security_advisory: { summary: "Upgrade", severity: "high" },
						html_url: "alert",
						state: "open",
					},
				],
				"/code-scanning/alerts": [
					{
						number: 2,
						rule: { description: "Rule", security_severity_level: "critical" },
						html_url: "code",
						state: "open",
					},
				],
			},
		);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		const saved = await publication(context);
		expect(fetch.mock.calls.filter(([url]) => url.includes("/releases"))).toEqual([]);
		expect(saved.repos[0].metrics).toMatchObject({
			ciSuccess: 1,
			ciFailure: 1,
			ciOther: 1,
			ciPending: 1,
			releases: 1,
			alerts: 2,
		});
		const read = async (kind: string) =>
			JSON.parse(
				(
					await context.env.DB.prepare("SELECT payload FROM refresh_snapshots WHERE kind=?")
						.bind(kind)
						.first<{ payload: string }>()
				)?.payload ?? "{}",
			);
		expect((await read("repo:owner/project:prs")).pull_requests).toEqual([]);
		expect(await read("repo:owner/project:details")).toMatchObject({ default_branch: "main" });
		expect(await read("repo:owner/project:releases")).toMatchObject({
			releases: [
				{
					id: 1,
					name: "release 1",
					tag_name: "v1",
					html_url: "https://github.com/owner/project/releases/1",
					draft: false,
					published_at: "2026-10-28T04:00:00Z",
				},
			],
		});
		expect(await read("repo:owner/project:security")).toMatchObject({
			dependabot_open: 1,
			code_scanning_open: 1,
			features: { dependabot: { status: "available" }, code_scanning: { status: "available" } },
		});
	});
	it("counts releases only on their publication day, not their creation day or draft date", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["releases"];
		context.days.push({
			date: "2026-10-29",
			since: "2026-10-28T16:00:00.000Z",
			until: "2026-10-29T16:00:00.000Z",
		});
		context.run.params.until = "2026-10-29";
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					releases: releases([
						release("1", "2026-10-29T04:00:00Z", "2026-10-28T04:00:00Z"),
						{ ...release("2", null, "2026-10-28T04:00:00Z"), isDraft: true },
					]),
				},
			},
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		const saved = (await publication(context)).repos[0];
		expect(saved.metrics).toMatchObject({
			releases: 1,
			days: { "2026-10-28": { releases: 0 }, "2026-10-29": { releases: 1 } },
		});
		expect(
			(await observation(context, "releases")).results.map((row) => JSON.parse(row.payload).count),
		).toEqual([0, 1]);
	});
	it.each(["/actions/runs", "/dependabot/alerts", "/code-scanning/alerts"])(
		"retries a transient REST failure and never caches it as complete: %s",
		async (path) => {
			const context = await fixture();
			const fetch = upstream(undefined, { [path]: new Response("unavailable", { status: 500 }) });
			await collectAccount(context);
			expect((await collectRepository(context, "owner/project")).partial).toBe(true);
			expect(fetch.mock.calls.filter(([url]) => url.includes(path))).toHaveLength(2);
		},
	);
	it.each([401, 429])(
		"preserves successful dimensions and throws terminal REST failures: %s",
		async (status) => {
			const context = await fixture();
			upstream(undefined, {
				"/actions/runs": Response.json({ message: "sensitive upstream message" }, { status }),
			});
			await collectAccount(context);
			await expect(collectRepository(context, "owner/project")).rejects.toMatchObject({
				code: status === 401 ? "github_unauthorized" : "github_rate_limited",
			});
			expect((await observation(context, "commits")).results[0]?.status).toBe("complete");
			expect((await observation(context, "actions")).results[0]?.status).toBe("unavailable");
			expect(JSON.stringify(await publication(context))).not.toContain(
				"sensitive upstream message",
			);
		},
	);
	it("keeps an unavailable alert feature from truncating a complete feature", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream(undefined, {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": Response.json({ message: "no analysis found" }, { status: 404 }),
		});
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 3,
			requestBreakdown: { graphql: 1, rest: 2 },
			partial: false,
			reasons: [],
		});
		expect(await sourceSnapshot(context, "repo:owner/project:security")).toMatchObject({
			truncated: false,
			unavailable: true,
			dependabot_open: 0,
			code_scanning_open: null,
			features: {
				dependabot: { status: "available" },
				code_scanning: { status: "unavailable", reason_code: "not_found" },
			},
		});
		expect((await observation(context, "alerts")).results[0]?.status).toBe("complete");
		expect(
			await readFactoryResource(collectionDb(context), "a", "owner/project", "alerts"),
		).toMatchObject({ data: { unavailable: true, coverage: { status: "unavailable" } } });
		const cached = upstream();
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 0,
			partial: false,
		});
		expect(cached).not.toHaveBeenCalled();
		context.run.params.force = true;
		upstream([{ node: repo() }], {
			"/code-scanning/alerts": [{ number: 1, state: "open", created_at: now }],
		});
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 3,
			partial: false,
		});
		expect(await sourceSnapshot(context, "repo:owner/project:security")).toMatchObject({
			code_scanning_open: 1,
			unavailable: false,
			truncated: false,
		});
	});
	it("preserves known alert items when one feature is unavailable and the other succeeds", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream(undefined, {
			"/dependabot/alerts": [
				{
					number: 7,
					security_advisory: { summary: "Upgrade dependency", severity: "high" },
					html_url: "https://github.com/owner/project/security/dependabot/7",
					state: "open",
					created_at: "2026-10-28T01:00:00Z",
					updated_at: "2026-10-28T02:00:00Z",
				},
			],
			"/code-scanning/alerts": Response.json({ message: "Requires permission" }, { status: 403 }),
		});
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({ requests: 3 });
		const stored = (await observation(context, "alerts")).results[0];
		expect(JSON.parse(stored?.payload ?? "{}")).toMatchObject({
			count: null,
			observed: 1,
			items: [{ id: "dependabot:7", title: "Upgrade dependency", severity: "high" }],
		});
		expect(await sourceSnapshot(context, "repo:owner/project:security")).toMatchObject({
			truncated: false,
			unavailable: true,
			dependabot_open: 1,
			code_scanning_open: null,
			features: {
				dependabot: { status: "available" },
				code_scanning: { status: "unavailable", reason_code: "permission_denied" },
			},
		});
		expect(
			await readFactoryResource(collectionDb(context), "a", "owner/project", "alerts"),
		).toMatchObject({
			data: {
				unavailable: true,
				coverage: { status: "unavailable" },
				items: [{ id: "dependabot:7", title: "Upgrade dependency", severity: "high" }],
			},
		});
	});
	it("treats an empty alert page as complete instead of truncated", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream(undefined, {
			"/dependabot/alerts": Response.json([], {
				headers: { link: '<https://github.test/next>; rel="next"' },
			}),
		});
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(false);
		expect(await sourceSnapshot(context, "repo:owner/project:security")).toMatchObject({
			truncated: false,
			dependabot_open: 0,
			features: { dependabot: { status: "available" } },
		});
	});
	it("records disabled alerts separately from permission-denied alerts without successful zeros", async () => {
		const context = await fixture();
		upstream(undefined, {
			"/dependabot/alerts": Response.json(
				{ message: "Dependabot alerts are disabled" },
				{ status: 403 },
			),
			"/code-scanning/alerts": Response.json({ message: "Requires permission" }, { status: 403 }),
		});
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(true);
		const saved = JSON.parse(
			(
				await context.env.DB.prepare(
					"SELECT payload FROM refresh_snapshots WHERE kind='repo:owner/project:security'",
				).first<{ payload: string }>()
			)?.payload ?? "{}",
		);
		expect(saved).toMatchObject({
			dependabot_open: null,
			code_scanning_open: null,
			features: {
				dependabot: { status: "unavailable", reason_code: "alerts_disabled" },
				code_scanning: { status: "unavailable", reason_code: "permission_denied" },
			},
		});
	});
	it.each(["/actions/runs", "/dependabot/alerts"])(
		"makes pagination-limited latest REST data partial: %s",
		async (path) => {
			const context = await fixture();
			if (path === "/actions/runs") {
				const runs = Array.from({ length: 100 }, (_, index) => ({
					id: index + 1,
					name: "CI",
					html_url: "https://github.com/owner/project/actions/runs/1",
					status: "completed",
					conclusion: "success",
					created_at: "2026-10-28T02:00:00.000Z",
					updated_at: "2026-10-28T02:00:00.000Z",
				}));
				const fetch = vi.fn(async (input: string, init?: RequestInit) => {
					if (input.endsWith("/graphql")) {
						const body = JSON.parse(String(init?.body));
						const payload = body.query?.includes("RefreshAccount")
							? accountPage()
							: { node: repo() };
						return Response.json({
							data: {
								...payload,
								rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
							},
						});
					}
					if (!input.includes("/actions/runs")) return Response.json([]);
					const page = Number(new URL(input).searchParams.get("page") ?? "1");
					if (page === 1) {
						return Response.json(
							{ total_count: 101, workflow_runs: runs },
							{ headers: { link: '<https://github.test/next>; rel="next"' } },
						);
					}
					return Response.json({
						total_count: 101,
						workflow_runs: [
							{
								id: 101,
								name: "CI",
								html_url: "https://github.com/owner/project/actions/runs/101",
								status: "completed",
								conclusion: "success",
								created_at: "2026-10-28T01:00:00.000Z",
								updated_at: "2026-10-28T01:00:00.000Z",
							},
						],
					});
				});
				vi.stubGlobal("fetch", fetch);
				await collectAccount(context);
				expect(await collectRepository(context, "owner/project")).toMatchObject({
					partial: false,
					reasons: [],
				});
				expect(
					fetch.mock.calls.filter(([url]) => String(url).includes("/actions/runs")),
				).toHaveLength(2);
				expect(
					String(fetch.mock.calls.find(([url]) => String(url).includes("/actions/runs"))?.[0]),
				).toContain("created=");
				return;
			}
			const data = [{ number: 1, state: "open" }];
			upstream(undefined, {
				[path]: Response.json(data, {
					headers: { link: '<https://github.test/next>; rel="next"' },
				}),
			});
			await collectAccount(context);
			expect((await collectRepository(context, "owner/project")).partial).toBe(true);
			expect(await sourceSnapshot(context, "repo:owner/project:security")).toMatchObject({
				truncated: true,
				features: { dependabot: { status: "partial" } },
			});
		},
	);
	it.each(["/actions/runs", "/dependabot/alerts"])(
		"rejects malformed REST envelopes: %s",
		async (path) => {
			const context = await fixture();
			upstream(undefined, { [path]: { unexpected: true } });
			await collectAccount(context);
			expect((await collectRepository(context, "owner/project")).partial).toBe(true);
		},
	);
	it("keeps paginated actions complete when the next page finishes the window", async () => {
		const context = await fixture();
		const fetch = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.endsWith("/graphql")) {
				const body = JSON.parse(String(init?.body));
				const payload = body.query?.includes("RefreshAccount") ? accountPage() : { node: repo() };
				return Response.json({
					data: {
						...payload,
						rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
					},
				});
			}
			if (!input.includes("/actions/runs")) return Response.json([]);
			const page = Number(new URL(input).searchParams.get("page") ?? "1");
			if (page === 1) {
				return Response.json(
					{
						workflow_runs: [
							{
								id: 1,
								created_at: "2026-10-28T03:00:00.000Z",
								status: "completed",
								conclusion: "success",
							},
						],
					},
					{ headers: { link: '<https://github.test/next>; rel="next"' } },
				);
			}
			return Response.json({ workflow_runs: [] });
		});
		vi.stubGlobal("fetch", fetch);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(false);
	});
	it("keeps a partially denied repository query visible as a releases reason", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["releases"];
		upstream([
			accountPage(),
			Response.json({
				data: {
					node: {
						...repo(),
						releases: releases([release("1", "2026-10-28T04:00:00Z")]),
					},
				},
				errors: [{ type: "FORBIDDEN", path: ["node", "releases", "nodes", 0, "name"] }],
			}),
		]);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: true,
			reasons: ["releases:graphql_partial"],
		});
	});
	it("names a reason code for every partial dimension", async () => {
		const context = await fixture();
		upstream(undefined, {
			"/actions/runs": Response.json({ message: "unavailable" }, { status: 500 }),
		});
		await collectAccount(context);
		const repository = await collectRepository(context, "owner/project");
		expect(repository.partial).toBe(true);
		expect(repository.reasons).toEqual(["actions:github_error"]);
	});
	it.each([
		{
			label: "a truncated page inside the window",
			connection: releases([release("1", "2026-10-28T04:00:00Z")], true),
			partial: true,
			reasons: ["releases:latest_page_only"],
		},
		{
			label: "a truncated page whose oldest entry predates the window",
			connection: releases([release("1", "2026-10-01T00:00:00Z")], true),
			partial: false,
			reasons: [],
		},
		{
			label: "a truncated page with a long-created but recently published tail",
			connection: releases(
				[
					release("2", "2026-10-28T04:00:00Z", "2019-01-01T00:00:00Z"),
					release("1", "2019-01-02T00:00:00Z", "2019-01-01T00:00:00Z"),
				],
				true,
			),
			partial: false,
			reasons: [],
		},
		{
			label: "a page without pagination metadata",
			connection: { totalCount: 1, nodes: [release("1", "2026-10-28T04:00:00Z")] },
			partial: true,
			reasons: ["releases:incomplete_pagination"],
		},
		{
			label: "a single complete page",
			connection: releases([release("1", "2026-10-28T04:00:00Z")]),
			partial: false,
			reasons: [],
		},
		{
			label: "a malformed connection",
			connection: null,
			partial: true,
			reasons: ["releases:github_error"],
		},
	])(
		"treats $label as $partial with reasons $reasons",
		async ({ connection, partial, reasons }) => {
			const context = await fixture();
			context.run.params.dimensions = ["releases"];
			upstream([accountPage(), { node: { ...repo(), releases: connection } }]);
			await collectAccount(context);
			expect(await collectRepository(context, "owner/project")).toMatchObject({
				requests: 1,
				requestBreakdown: { graphql: 1, rest: 0 },
				partial,
				reasons,
			});
		},
	);
	it("dedupes workflow run ids across paginated actions pages", async () => {
		const context = await fixture();
		const run = {
			id: 42,
			name: "CI",
			html_url: "https://github.com/owner/project/actions/runs/42",
			status: "completed",
			conclusion: "success",
			head_branch: "main",
			created_at: "2026-10-28T02:00:00.000Z",
			updated_at: "2026-10-28T02:00:00.000Z",
		};
		const fetch = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.endsWith("/graphql")) {
				const body = JSON.parse(String(init?.body));
				const payload = body.query?.includes("RefreshAccount") ? accountPage() : { node: repo() };
				return Response.json({
					data: {
						...payload,
						rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
					},
				});
			}
			if (!input.includes("/actions/runs")) return Response.json([]);
			const page = Number(new URL(input).searchParams.get("page") ?? "1");
			if (page === 1) {
				return Response.json(
					{ workflow_runs: [run] },
					{ headers: { link: '<https://github.test/next>; rel="next"' } },
				);
			}
			return Response.json({ workflow_runs: [{ ...run, run_attempt: 2 }] });
		});
		vi.stubGlobal("fetch", fetch);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		const saved = await sourceSnapshot(context, "repo:owner/project:actions");
		expect(saved.runs).toHaveLength(1);
		expect((await publication(context)).repos[0].metrics.ciSuccess).toBe(1);
	});
	it("marks only days on or before the oldest partial release as incomplete", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["releases"];
		context.days = [
			{ date: "2026-10-27", since: "2026-10-26T16:00:00.000Z", until: "2026-10-27T16:00:00.000Z" },
			{ date: "2026-10-28", since: "2026-10-27T16:00:00.000Z", until: "2026-10-28T16:00:00.000Z" },
		];
		context.run.params.since = "2026-10-27";
		context.run.params.until = "2026-10-28";
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					releases: releases(
						[
							release("new", "2026-10-28T04:00:00Z", "2026-10-27T12:00:00Z"),
							release("old", "2026-10-27T12:00:00Z", "2026-10-27T12:00:00Z"),
						],
						true,
					),
				},
			},
		]);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			partial: true,
			reasons: ["releases:latest_page_only"],
		});
		const rows = await context.env.DB.prepare(
			"SELECT day,status FROM refresh_day_observations WHERE dimension='releases' ORDER BY day",
		).all<{ day: string; status: string }>();
		expect(rows.results).toEqual([
			{ day: "2026-10-27", status: "partial" },
			{ day: "2026-10-28", status: "complete" },
		]);
	});
	it("flags actions filter_cap when a single day still hits the search limit", async () => {
		const context = await fixture();
		const pageRuns = Array.from({ length: 100 }, (_, index) => ({
			id: index + 1,
			name: "CI",
			html_url: "https://github.com/owner/project/actions/runs/1",
			status: "completed",
			conclusion: "success",
			created_at: "2026-10-28T02:00:00.000Z",
			updated_at: "2026-10-28T02:00:00.000Z",
		}));
		const fetch = vi.fn(async (input: string, init?: RequestInit) => {
			if (input.endsWith("/graphql")) {
				const body = JSON.parse(String(init?.body));
				const payload = body.query?.includes("RefreshAccount") ? accountPage() : { node: repo() };
				return Response.json({
					data: {
						...payload,
						rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
					},
				});
			}
			if (!input.includes("/actions/runs")) return Response.json([]);
			const page = Number(new URL(input).searchParams.get("page") ?? "1");
			return Response.json(
				{
					total_count: 2000,
					workflow_runs: pageRuns.map((row) => ({ ...row, id: page * 100 + row.id })),
				},
				{
					headers:
						page >= 10
							? { link: '<https://github.test/next>; rel="next"' }
							: { link: '<https://github.test/next>; rel="next"' },
				},
			);
		});
		vi.stubGlobal("fetch", fetch);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			partial: true,
			reasons: ["actions:filter_cap"],
		});
	});
});
