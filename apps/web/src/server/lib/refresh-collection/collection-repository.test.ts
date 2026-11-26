import { afterEach, describe, expect, it, vi } from "vitest";
import { accountCalendarGraphqlRequests as calcAccountCalendarRequests } from "../../../../../../tests/fixtures/refresh-upstream";
import { ApiError } from "../errors";
import {
	accountPage,
	connection,
	fixture,
	item,
	lastRepositoryGraphqlBody,
	now,
	observation,
	publication,
	release,
	releases,
	repo,
	upstream,
} from "./__tests__/collection-helper";
import { collectAccount, collectRepository } from "./index";
import {
	blankDay,
	blankMetrics,
	count,
	event,
	factoryRepo,
	nodes,
	object,
	text,
	windowOf,
} from "./model";
import { transport } from "./transport";

const accountCalendarGraphqlRequests = (at = now, catalogPages = 1) =>
	calcAccountCalendarRequests(at, catalogPages);

afterEach(() => vi.unstubAllGlobals());

describe("unified refresh collection - repository caching and transport", () => {
	it("collects GraphQL daily totals and bounded REST data, caches successful days", async () => {
		const context = await fixture();
		const fetch = upstream();
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 4,
			requestBreakdown: { graphql: 1, rest: 3 },
			partial: false,
			reasons: [],
		});
		const rows = (
			await context.env.DB.prepare("SELECT * FROM refresh_day_observations").all<{
				dimension: string;
				payload: string;
			}>()
		).results;
		expect(rows).toHaveLength(6);
		expect(JSON.parse(rows.find((row) => row.dimension === "commits")?.payload ?? "{}").count).toBe(
			3,
		);
		const requests = fetch.mock.calls.map(([url]) => url);
		expect(requests.every((url) => !url.includes("/commits"))).toBe(true);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
		});
		expect(fetch).toHaveBeenCalledTimes(6 + accountCalendarGraphqlRequests() - 1);
		const saved = await publication(context);
		expect(saved.repos[0].coverage.dependencies.status).toBe("unavailable");
		expect(saved.repos[0].metrics.commits).toBe(3);
		expect(saved.contribution.days[0].count).toBe(2);
		expect(
			JSON.stringify(
				(await context.env.DB.prepare("SELECT payload FROM refresh_snapshots").all()).results,
			),
		).not.toContain(context.token);
	});
	it("marks missing history unavailable and retries only failed dimensions", async () => {
		const context = await fixture();
		const missing = repo();
		missing.defaultBranchRef.target.day0 = null as never;
		upstream([accountPage(), { node: missing }, { node: repo() }]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(true);
		const stored = await context.env.DB.prepare(
			"SELECT status,payload FROM refresh_day_observations WHERE dimension='commits'",
		).first<{ status: string; payload: string }>();
		expect(stored?.status).toBe("unavailable");
		expect(JSON.parse(stored?.payload ?? "{}").count).toBeNull();
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
		});
	});
	it("forces already successful days and isolates timezone cache keys", async () => {
		const context = await fixture();
		upstream([accountPage(), { node: repo() }, { node: repo() }, { node: repo() }]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		context.run.params.force = true;
		expect((await collectRepository(context, "owner/project")).requestBreakdown).toEqual({
			graphql: 1,
			rest: 3,
		});
		context.run.params.force = false;
		context.run.params.timezone = "UTC";
		expect((await collectRepository(context, "owner/project")).requestBreakdown).toEqual({
			graphql: 1,
			rest: 3,
		});
	});
	it("persists source timezones through A, B, cache reuse and mixed-zone account publication", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["commits"];
		upstream([accountPage(), { node: repo() }, accountPage()]);
		await collectAccount(context);
		expect((await publication(context)).window.timezone).toBe("Asia/Shanghai");
		await collectRepository(context, "owner/project");
		await collectRepository(context, "owner/project");
		const saved = await publication(context);
		expect(saved.repos[0].observation.window.timezone).toBe("Asia/Shanghai");
		expect(saved.repos[0].coverage.commits.completeWindows[0].timezone).toBe("Asia/Shanghai");
		expect(Object.keys(saved.repos[0].metrics.days)).toEqual(["2026-10-28"]);
		context.run.params.timezone = "UTC";
		context.days = [
			{ date: "2026-10-28", since: "2026-10-28T00:00:00.000Z", until: "2026-10-29T00:00:00.000Z" },
		];
		await collectAccount(context);
		const mixed = await publication(context);
		expect(mixed.window.timezone).toBe("UTC");
		expect(mixed.repos[0].observation.window).toEqual(saved.repos[0].observation.window);
		expect(mixed.repos[0].coverage.commits.completeWindows).toEqual(
			saved.repos[0].coverage.commits.completeWindows,
		);
	});
	it("retries transient upstream failures without persisting diagnostics", async () => {
		const context = await fixture();
		const onRequests = vi.fn();
		context.onRequests = onRequests;
		upstream([new Error("secret diagnostic"), accountPage()]);
		expect((await collectAccount(context)).requests).toBe(1 + accountCalendarGraphqlRequests());
		expect(onRequests).toHaveBeenLastCalledWith(1 + accountCalendarGraphqlRequests(), {
			graphql: 1 + accountCalendarGraphqlRequests(),
			rest: 0,
		});
	});
	it.each([
		[401, 1, "github_unauthorized"],
		[500, 2, "github_error"],
	] as const)(
		"reports actual request counts after failed upstream status %s",
		async (status, requests, code) => {
			const context = await fixture();
			const onRequests = vi.fn();
			context.onRequests = onRequests;
			upstream(
				Array.from({ length: requests }, () => new Response("secret diagnostic", { status })),
			);
			await expect(collectAccount(context)).rejects.toMatchObject({ code });
			expect(onRequests.mock.calls).toEqual([[requests, { graphql: requests, rest: 0 }]]);
		},
	);
	it("preserves factory day metrics outside a lookback window", async () => {
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
			dimensions: ["issues", "prs", "actions"],
		};
		upstream([
			accountPage(),
			{ node: { ...repo(), openIssues: { totalCount: 0 }, issues: connection([]) } },
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		const priorMetrics = {
			issueOpened: 70,
			prOpened: 14,
			issueClosed: 20,
			prMerged: 18,
			ciFailure: 3,
			ciSuccess: 2,
			commits: 12,
			prClosed: 0,
			releases: 1,
		};
		await context.env.DB.prepare(
			`UPDATE refresh_repository_publications SET payload=json_set(payload,'$.metrics.days."${outside}"',json(?)) WHERE account_id='a'`,
		)
			.bind(JSON.stringify({ ...blankDay(), ...priorMetrics }))
			.run();
		const observationPayload = (items: unknown[]) =>
			JSON.stringify({ count: null, items, since: outsideDay.since, until: outsideDay.until });
		await context.env.DB.batch([
			context.env.DB.prepare(
				`INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at) VALUES('a','R_1','Asia/Shanghai',?,'issues','complete',?,?)`,
			).bind(
				outside,
				observationPayload([{ id: "i1", createdAt: "2026-10-27T02:00:00.000Z" }]),
				context.now,
			),
			context.env.DB.prepare(
				`INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at) VALUES('a','R_1','Asia/Shanghai',?,'prs','complete',?,?)`,
			).bind(
				outside,
				observationPayload([{ id: "p1", createdAt: "2026-10-27T03:00:00.000Z" }]),
				context.now,
			),
			context.env.DB.prepare(
				`INSERT INTO refresh_day_observations(account_id,repo_id,timezone,day,dimension,status,payload,fetched_at) VALUES('a','R_1','Asia/Shanghai',?,'actions','complete',?,?)`,
			).bind(
				outside,
				observationPayload([
					{
						id: "a1",
						conclusion: "failure",
						activityRun: { head_branch: "main" },
						createdAt: "2026-10-27T04:00:00.000Z",
					},
				]),
				context.now,
			),
		]);
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openIssues: { totalCount: 0 },
					openPrs: { totalCount: 0 },
					issues: connection([]),
					pullRequests: connection([]),
					mergedLifecycle: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
					closedLifecycle: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
				},
			},
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		const saved = await publication(context);
		expect(saved.repos[0].metrics.days[outside]).toMatchObject({
			issueOpened: 1,
			prOpened: 1,
			ciFailure: 1,
		});
	});
	it("uses UTC exclusive-until boundaries and requests only uncached commit days", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["commits"];
		context.days.push({
			date: "2026-10-29",
			since: "2026-10-28T16:00:00.000Z",
			until: "2026-10-29T16:00:00.000Z",
		});
		const fetch = upstream([accountPage(), { node: repo() }, { node: repo() }]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(true);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
		});
		const body = JSON.parse(lastRepositoryGraphqlBody(fetch));
		expect(body.variables).toEqual({
			id: "R_1",
			since0: "2026-10-28T16:00:00.000Z",
			until0: "2026-10-29T15:59:59.999Z",
		});
		expect(body.query).not.toContain("day1:");
	});
	it("re-materializes a cached window without forging source timestamps", async () => {
		const context = await fixture();
		upstream();
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		context.now = "2026-10-30T00:00:00.000Z";
		context.run.id = "run-2";
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
		});
		const saved = await publication(context);
		expect(saved.runId).toBe("run-2");
		expect(saved.repos[0].coverage.commits.fetchedAt).toBe(now);
		expect(saved.repos[0].coverage.issues.fetchedAt).toBe(context.now);
		expect(saved.repos[0].observation).toMatchObject({
			refreshedAt: context.now,
			publishedAt: context.now,
			metadataAt: context.now,
		});
	});
	it.each([false, true])("preserves saved release transports when mixed=%s", async (mixed) => {
		const context = await fixture();
		context.run.params.dimensions = ["releases"];
		const fetch = upstream([accountPage(), { node: repo() }, { node: repo() }]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		await context.env.DB.prepare(
			"UPDATE refresh_day_observations SET payload=json_set(payload,'$.source','github_rest_latest') WHERE dimension='releases'",
		).run();
		if (mixed) {
			context.days.push({
				date: "2026-10-29",
				since: "2026-10-28T16:00:00.000Z",
				until: "2026-10-29T16:00:00.000Z",
			});
		}
		context.now = "2026-10-30T00:00:00.000Z";
		context.run.id = "run-2";
		const result = await collectRepository(context, "owner/project");
		expect(result.requests).toBe(mixed ? 1 : 0);
		expect(fetch).toHaveBeenCalledTimes(accountCalendarGraphqlRequests() + 1 + (mixed ? 1 : 0));
		const saved = await publication(context);
		expect(saved.repos[0].coverage.releases).toMatchObject({
			source: mixed ? "mixed" : "github_rest_latest",
			fetchedAt: now,
			strategy: mixed ? "incremental" : "reused",
		});
		const day = await context.env.DB.prepare(
			"SELECT payload,fetched_at FROM refresh_day_observations WHERE dimension='releases' AND day='2026-10-28'",
		).first<{ payload: string; fetched_at: string }>();
		expect(JSON.parse(day?.payload ?? "{}").source).toBe("github_rest_latest");
		expect(day?.fetched_at).toBe(now);
	});
	it("records an actually empty repository as an observed zero, not missing", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["commits"];
		upstream([accountPage(), { node: { ...repo(), isEmpty: true, defaultBranchRef: null } }]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(false);
		expect(
			JSON.parse((await observation(context, "commits")).results[0]?.payload ?? "{}").count,
		).toBe(0);
	});
	it("keeps metadata defaults honest and normalizes populated events", async () => {
		const context = await fixture();
		expect(count(-1)).toBeNull();
		expect(count(1.2)).toBeNull();
		expect(text(3)).toBeNull();
		expect(nodes(null)).toEqual([]);
		expect(object([])).toMatchObject({});
		expect(factoryRepo({}, context)).toMatchObject({
			branch: null,
			head: null,
			totalCommits: 0,
			language: "",
			languagesComplete: false,
		});
		const populated = factoryRepo(
			{
				...repo(),
				repositoryTopics: { nodes: [{ topic: { name: "tools" } }] },
				isFork: true,
				isArchived: true,
				isPrivate: true,
			},
			context,
		);
		expect(populated).toMatchObject({
			is_fork: true,
			is_archived: true,
			private: true,
			topics: ["tools"],
		});
		expect(event({ ...item("P"), mergedAt: now, isDraft: true })).toMatchObject({
			state: "merged",
			draft: true,
		});
		expect(event({})).toMatchObject({ state: "", author: null });
		expect(blankMetrics().commits).toBe(0);
		context.days = [];
		expect(() => windowOf(context)).toThrow("Refresh days required");
	});
	it("does not retry nontransport or terminal errors", async () => {
		const context = await fixture();
		const upstream = transport(context);
		const operation = vi.fn().mockRejectedValue(new Error("local"));
		await expect(upstream.request(operation)).rejects.toThrow("local");
		expect(operation).toHaveBeenCalledTimes(1);
		const denied = vi.fn().mockRejectedValue(new ApiError(403, "github_forbidden", "denied"));
		await expect(upstream.request(denied)).rejects.toThrow("denied");
		expect(denied).toHaveBeenCalledTimes(1);
	});
	it("preserves cached dimensions without inventing coverage for unobserved streams", async () => {
		const context = await fixture();
		upstream();
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		context.run.params.dimensions = ["commits"];
		await collectRepository(context, "owner/project");
		expect((await publication(context)).repos[0].coverage.issues.status).toBe("complete");
		expect((await publication(context)).repos[0].coverage.dependencies.status).toBe("unavailable");
	});
	it("reports the transport split of A and B separately", async () => {
		const context = await fixture();
		const onRequests = vi.fn();
		context.onRequests = onRequests;
		upstream();
		expect(await collectAccount(context)).toMatchObject({
			requestBreakdown: { graphql: accountCalendarGraphqlRequests(), rest: 0 },
		});
		onRequests.mockClear();
		const repository = await collectRepository(context, "owner/project");
		expect(repository.requests).toBe(4);
		expect(repository.requestBreakdown).toEqual({ graphql: 1, rest: 3 });
		expect(onRequests.mock.calls.at(-1)).toEqual([4, { graphql: 1, rest: 3 }]);
	});
	it("spends one main GraphQL query plus REST for CI and alerts per repository", async () => {
		const context = await fixture();
		const fetch = upstream([
			accountPage(),
			{
				node: {
					...repo(),
					releases: releases([release("1", "2026-10-28T04:00:00Z")]),
				},
			},
		]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).requestBreakdown).toEqual({
			graphql: 1,
			rest: 3,
		});
		const repository = fetch.mock.calls.find(
			([url, init]) =>
				String(url).endsWith("/graphql") && String(init?.body).includes("RefreshRepository"),
		);
		expect(String(repository?.[1]?.body)).toContain("releases(first:100");
		expect(
			fetch.mock.calls
				.map(([url]) => String(url))
				.filter((url) => !url.endsWith("/graphql"))
				.map((url) => new URL(url).pathname),
		).toEqual([
			"/repos/owner/project/actions/runs",
			"/repos/owner/project/dependabot/alerts",
			"/repos/owner/project/code-scanning/alerts",
		]);
	});
	it("represents unknown language sizes as unavailable metadata defaults", async () => {
		const context = await fixture();
		expect(
			factoryRepo({ languages: { edges: [{ node: { name: "Unknown" } }] } }, context).languages,
		).toEqual([{ name: "Unknown", bytes: 0 }]);
	});
});
