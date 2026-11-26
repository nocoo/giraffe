import { afterEach, describe, expect, it, vi } from "vitest";
import {
	accountPage,
	connection,
	fixture,
	graphqlBodies,
	item,
	now,
	observation,
	publication,
	repo,
	sourceSnapshot,
	upstream,
} from "./__tests__/collection-helper";
import { collectAccount, collectRepository } from "./index";

afterEach(() => vi.unstubAllGlobals());

describe("unified refresh collection - issues and pull requests", () => {
	it("consumes the full page and all forced pages despite cached item IDs", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues", "prs"];
		const before = {
			...repo(),
			openIssues: { totalCount: 2 },
			openPrs: { totalCount: 2 },
			issues: connection([item("I1"), item("I2")]),
			pullRequests: connection([item("P1"), item("P2")]),
		};
		const after = {
			...repo(),
			openIssues: { totalCount: 3 },
			openPrs: { totalCount: 2 },
			issues: connection([item("Inew"), item("Iafter")], true, "cursor"),
			pullRequests: connection([item("Pafter")], true, "cursor"),
		};
		const tail = [
			{ node: after },
			{ node: { issues: connection([item("Ilater")]) } },
			{ node: { pullRequests: connection([item("Plater")]) } },
		];
		upstream([accountPage(), { node: before }, ...Array.from({ length: 8 }, () => tail).flat()]);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			partial: false,
			reasons: [],
		});
		const saved = (
			await context.env.DB.prepare("SELECT item_id,payload FROM refresh_items").all<{
				item_id: string;
				payload: string;
			}>()
		).results;
		expect(saved.map((row) => row.item_id)).toEqual(
			expect.arrayContaining(["I1", "I2", "P1", "P2"]),
		);
	});
	it.each([
		{ state: "OPEN", updatedAt: "2026-10-29T02:00:00Z" },
		{ state: "CLOSED", updatedAt: "2026-10-29T02:00:00Z" },
		{ state: "CLOSED", updatedAt: "2026-10-28T02:00:00.000Z" },
	])(
		"only stops after a proven unchanged boundary and still consumes its whole page: %j",
		async ({ state, updatedAt }) => {
			const context = await fixture();
			context.run.params.dimensions = ["issues"];
			const openCount = state === "OPEN" ? 3 : 2;
			const prior = {
				...repo(),
				openIssues: { totalCount: 2 },
				issues: connection([item("cached"), item("retained")]),
			};
			const changed = { ...item("cached", state), updatedAt };
			upstream([
				accountPage(),
				{ node: prior },
				{
					node: {
						...repo(),
						openIssues: { totalCount: openCount },
						issues: connection([changed], true, "changed-page"),
					},
				},
				{
					node: {
						issues: connection([item("retained"), item("same-page-new")], false, null),
					},
				},
			]);
			await collectAccount(context);
			await collectRepository(context, "owner/project");
			context.days.push({
				date: "2026-10-29",
				since: "2026-10-28T16:00:00.000Z",
				until: "2026-10-29T16:00:00.000Z",
			});
			context.run.params.until = "2026-10-29";
			expect(await collectRepository(context, "owner/project")).toMatchObject({
				requests: 2,
				requestBreakdown: { graphql: 2, rest: 0 },
				partial: false,
				reasons: [],
			});
			const saved = await sourceSnapshot(context, "repo:owner/project:issues");
			expect(saved.truncated).toBe(false);
			expect(saved.issues.map((row: { title: string }) => row.title)).toContain("same-page-new");
			const cached = await context.env.DB.prepare(
				"SELECT payload FROM refresh_items WHERE item_id='cached'",
			).first<{ payload: string }>();
			expect(JSON.parse(cached?.payload ?? "{}")).toMatchObject(changed);
		},
	);
	it("paginates open issue and PR inventories past the observation window", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues", "prs"];
		const olderOpen = {
			...item("older-open"),
			createdAt: "2026-10-25T00:00:00Z",
			updatedAt: "2026-10-26T00:00:00Z",
		};
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openIssues: { totalCount: 2 },
					openPrs: { totalCount: 1 },
					issues: connection([item("recent"), olderOpen], true, "older-issues"),
					pullRequests: connection([olderOpen], true, "older-prs"),
				},
			},
			{ node: { issues: connection([]), pullRequests: connection([]) } },
			{ node: { issues: connection([]), pullRequests: connection([]) } },
		]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(false);
		for (const stream of ["issues", "prs"]) {
			const saved = await sourceSnapshot(context, `repo:owner/project:${stream}`);
			expect(saved).toMatchObject({ truncated: false, inventory_complete: true });
			expect(
				JSON.parse((await observation(context, stream)).results[0]?.payload ?? "{}"),
			).toMatchObject({ inventoryComplete: true });
		}
	});
	it("keeps cached older open items while excluding closed issues from open inboxes", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues"];
		const old = { ...item("old-open"), createdAt: "2026-10-20T00:00:00Z" };
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openIssues: { totalCount: 1 },
					closedIssues: { totalCount: 1 },
					issues: connection([item("closing", "CLOSED"), old]),
				},
			},
		]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(false);
		for (const kind of ["repo:owner/project:issues", "issues"]) {
			const saved = await sourceSnapshot(context, kind);
			expect(saved.issues.map((row: { title: string }) => row.title)).toEqual(["old-open"]);
		}
		expect((await publication(context)).repos[0].closedIssues).toBe(1);
	});
	it("paginates more than one page of open issues", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues"];
		const page = Array.from({ length: 100 }, (_, index) => item(`open-${index}`));
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openIssues: { totalCount: 101 },
					issues: connection(page, true, "page-2"),
				},
			},
			{ node: { issues: connection([item("open-100")]) } },
		]);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			partial: false,
			reasons: [],
		});
		const saved = await sourceSnapshot(context, "repo:owner/project:issues");
		expect(saved.inventory_complete).toBe(true);
		expect(saved.issues).toHaveLength(101);
	});
	it("paginates initial issue and PR inventories until complete", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues", "prs"];
		const first = {
			...repo(),
			openIssues: { totalCount: 2 },
			openPrs: { totalCount: 2 },
			issues: connection([item("I1")], true, "issues-next"),
			pullRequests: connection([item("P1")], true, "prs-next"),
		};
		const fetch = upstream([
			accountPage(),
			{ node: first },
			{ node: { issues: connection([item("I2")]) } },
			{ node: { pullRequests: connection([item("P2")]) } },
		]);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 3,
			requestBreakdown: { graphql: 3, rest: 0 },
			partial: false,
			reasons: [],
		});
		expect((await publication(context)).repos[0].metrics).toMatchObject({
			issueOpened: 2,
			issueClosed: 0,
			prOpened: 2,
			prClosed: 0,
		});
		expect(String(graphqlBodies(fetch).find((body) => body.includes("states:OPEN")))).toContain(
			"states:OPEN",
		);
		expect(String(graphqlBodies(fetch).find((body) => body.includes("RefreshItems")))).toContain(
			"RefreshItems",
		);
	});
	it("does not stop at an unproven cache boundary after a failed page", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues"];
		const first = {
			...repo(),
			openIssues: { totalCount: 2 },
			issues: connection([item("I1")], true, "next"),
		};
		upstream([
			accountPage(),
			{ node: first },
			new Error("transient"),
			new Error("transient"),
			{ node: first },
			{ node: { issues: connection([item("I2")]) } },
		]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(true);
		expect(
			JSON.parse((await observation(context, "issues")).results[0]?.payload ?? "{}").count,
		).toBeNull();
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 2,
			requestBreakdown: { graphql: 2, rest: 0 },
			partial: false,
			reasons: [],
		});
	});
	it.each([connection([], true, null), connection([{ title: "missing-id" }]), null])(
		"does not turn malformed issue connections into successful zeros: %j",
		async (issues) => {
			const context = await fixture();
			context.run.params.dimensions = ["issues"];
			upstream([accountPage(), { node: { ...repo(), issues } }]);
			await collectAccount(context);
			expect((await collectRepository(context, "owner/project")).partial).toBe(true);
			expect(
				JSON.parse((await observation(context, "issues")).results[0]?.payload ?? "{}").count,
			).toBeNull();
		},
	);
	it("stops repeated issue cursors and marks inventory incomplete", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues"];
		const first = {
			...repo(),
			openIssues: { totalCount: 2 },
			issues: connection([item("I1")], true, "same"),
		};
		const pages = [{ node: first }, { node: { issues: connection([item("I2")], true, "same") } }];
		upstream([accountPage(), ...pages, ...pages]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(true);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 2,
			requestBreakdown: { graphql: 2, rest: 0 },
			partial: true,
			reasons: ["issues:incomplete_pagination", "issues:inventory_incomplete"],
		});
	});
	it.each([
		["inventoryComplete false", false],
		["missing inventoryComplete", undefined],
	] as const)(
		"recollects issues and pull requests when cached days are complete but %s",
		async (_label, inventoryComplete) => {
			const context = await fixture();
			context.run.params.dimensions = ["issues", "prs"];
			const open = item("open-item");
			upstream([
				accountPage(),
				{
					node: {
						...repo(),
						openIssues: { totalCount: 1 },
						openPrs: { totalCount: 1 },
						issues: connection([open]),
						pullRequests: connection([open]),
					},
				},
			]);
			await collectAccount(context);
			expect(await collectRepository(context, "owner/project")).toMatchObject({
				partial: false,
				reasons: [],
			});
			for (const dimension of ["issues", "prs"] as const) {
				const row = (await observation(context, dimension)).results[0];
				const payload = JSON.parse(row?.payload ?? "{}") as Record<string, unknown>;
				if (inventoryComplete === undefined) delete payload.inventoryComplete;
				else payload.inventoryComplete = inventoryComplete;
				await context.env.DB.prepare(
					"UPDATE refresh_day_observations SET payload=? WHERE account_id=? AND dimension=?",
				)
					.bind(JSON.stringify(payload), context.account.id, dimension)
					.run();
			}
			const fetch = upstream([
				{
					node: {
						...repo(),
						openIssues: { totalCount: 1 },
						openPrs: { totalCount: 1 },
						issues: connection([open]),
						pullRequests: connection([open]),
					},
				},
			]);
			expect(await collectRepository(context, "owner/project")).toMatchObject({
				partial: false,
				reasons: [],
				requests: 1,
			});
			expect(fetch).toHaveBeenCalled();
			for (const dimension of ["issues", "prs"] as const) {
				expect(
					JSON.parse((await observation(context, dimension)).results[0]?.payload ?? "{}"),
				).toMatchObject({ inventoryComplete: true });
			}
		},
	);
	it("reuses older issue and pull-request days but always recollects the latest calendar day", async () => {
		const context = await fixture();
		context.days = [
			{ date: "2026-10-27", since: "2026-10-26T16:00:00.000Z", until: "2026-10-27T16:00:00.000Z" },
			{ date: "2026-10-28", since: "2026-10-27T16:00:00.000Z", until: "2026-10-28T16:00:00.000Z" },
		];
		context.run.params.since = "2026-10-27";
		context.run.params.until = "2026-10-28";
		context.run.params.dimensions = ["issues", "prs"];
		const open = item("cached-open");
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openIssues: { totalCount: 1 },
					openPrs: { totalCount: 1 },
					issues: connection([open]),
					pullRequests: connection([open]),
				},
			},
		]);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			partial: false,
			reasons: [],
		});
		const seededIssues = (await observation(context, "issues")).results;
		context.now = "2026-10-29T09:00:00.000Z";
		const fetch = upstream([
			{
				node: {
					...repo(),
					openIssues: { totalCount: 1 },
					openPrs: { totalCount: 1 },
					issues: connection([open]),
					pullRequests: connection([open]),
				},
			},
		]);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			partial: false,
			reasons: [],
			requests: 1,
		});
		expect(fetch).toHaveBeenCalled();
		const afterIssues = (await observation(context, "issues")).results;
		expect(afterIssues.find((row) => row.day === "2026-10-27")).toEqual(
			seededIssues.find((row) => row.day === "2026-10-27"),
		);
		expect(afterIssues.find((row) => row.day === "2026-10-28")?.fetched_at).toBe(context.now);
	});
	it("counts merged and closed metrics from lifecycle search when OPEN inventory is empty", async () => {
		const context = await fixture();
		context.days = [
			{ date: "2026-10-31", since: "2026-10-30T16:00:00.000Z", until: "2026-10-31T16:00:00.000Z" },
		];
		context.run.params = {
			...context.run.params,
			since: "2026-10-31",
			until: "2026-10-31",
			dimensions: ["issues", "prs"],
		};
		const mergedAt = "2026-10-31T02:00:00.000Z";
		const closedAt = "2026-10-31T03:00:00.000Z";
		const fetch = upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openIssues: { totalCount: 0 },
					openPrs: { totalCount: 0 },
					issues: connection([]),
					pullRequests: connection([]),
				},
				mergedLifecycle: {
					nodes: [{ ...item("merged-pr", "MERGED"), mergedAt, state: "MERGED" }],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
				closedLifecycle: {
					nodes: [{ ...item("closed-issue", "CLOSED"), closedAt, state: "CLOSED" }],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			},
		]);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			partial: false,
			reasons: [],
			requests: 1,
		});
		expect(
			fetch.mock.calls.filter(
				([url, init]) =>
					String(url).endsWith("/graphql") && String(init?.body).includes("RefreshRepository"),
			),
		).toHaveLength(1);
		const saved = await publication(context);
		expect(saved.repos[0].metrics.days["2026-10-31"]).toMatchObject({
			prMerged: 1,
			issueClosed: 1,
		});
	});
	it("attributes closes to the Shanghai day of closedAt, not the day OPEN inventory disappeared", async () => {
		const context = await fixture();
		context.days = [
			{ date: "2026-10-29", since: "2026-10-28T16:00:00.000Z", until: "2026-10-29T16:00:00.000Z" },
			{ date: "2026-10-31", since: "2026-10-30T16:00:00.000Z", until: "2026-10-31T16:00:00.000Z" },
		];
		context.run.params = {
			...context.run.params,
			since: "2026-10-29",
			until: "2026-10-31",
			dimensions: ["issues"],
		};
		const closedAt = "2026-10-31T01:03:00.000Z";
		const staleOpen = item("r2shot-400", "OPEN");
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openIssues: { totalCount: 0 },
					issues: connection([]),
				},
				closedLifecycle: {
					nodes: [{ ...item("r2shot-400", "CLOSED"), closedAt, state: "CLOSED" }],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			},
		]);
		await collectAccount(context);
		await context.env.DB.prepare(
			"INSERT INTO refresh_items(account_id,repo_id,stream,item_id,payload) VALUES('a','R_1','issues',?,?)",
		)
			.bind(String(staleOpen.id), JSON.stringify(staleOpen))
			.run();
		expect(await collectRepository(context, "owner/project")).toMatchObject({ partial: false });
		const saved = await publication(context);
		expect(saved.repos[0].metrics.days["2026-10-29"]?.issueClosed ?? 0).toBe(0);
		expect(saved.repos[0].metrics.days["2026-10-31"]?.issueClosed).toBe(1);
	});
	it("overwrites stale refresh_items closedAt with lifecycle search timestamps", async () => {
		const context = await fixture();
		context.days = [
			{ date: "2026-10-31", since: "2026-10-30T16:00:00.000Z", until: "2026-10-31T16:00:00.000Z" },
		];
		context.run.params = {
			...context.run.params,
			since: "2026-10-31",
			until: "2026-10-31",
			dimensions: ["issues"],
		};
		const closedAt = "2026-10-31T01:03:27.000Z";
		upstream([
			accountPage(),
			{
				node: { ...repo(), openIssues: { totalCount: 0 }, issues: connection([]) },
				closedLifecycle: {
					nodes: [{ ...item("r2shot-400", "CLOSED"), closedAt, state: "CLOSED" }],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			},
		]);
		await collectAccount(context);
		await context.env.DB.prepare(
			"INSERT INTO refresh_items(account_id,repo_id,stream,item_id,payload) VALUES('a','R_1','issues',?,?)",
		)
			.bind(
				"r2shot-400",
				JSON.stringify({
					...item("r2shot-400", "OPEN"),
					state: "CLOSED",
					closedAt: "2026-10-28T22:30:36.000Z",
				}),
			)
			.run();
		await collectRepository(context, "owner/project");
		const row = await context.env.DB.prepare(
			"SELECT payload FROM refresh_items WHERE item_id='r2shot-400'",
		).first<{ payload: string }>();
		expect(JSON.parse(row?.payload ?? "{}")).toMatchObject({ closedAt });
	});
	it("counts lifecycle merges on the Shanghai day of mergedAt using instant search ranges", async () => {
		const context = await fixture();
		context.days = [
			{ date: "2026-10-29", since: "2026-10-28T16:00:00.000Z", until: "2026-10-29T16:00:00.000Z" },
		];
		context.run.params = {
			...context.run.params,
			since: "2026-10-29",
			until: "2026-10-29",
			dimensions: ["prs"],
		};
		const mergedAt = "2026-10-28T22:03:00.000Z";
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openPrs: { totalCount: 0 },
					pullRequests: connection([]),
				},
				mergedLifecycle: {
					nodes: [
						{
							...item("early-merge", "MERGED"),
							mergedAt,
							state: "MERGED",
						},
					],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			},
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		expect((await publication(context)).repos[0].metrics.days["2026-10-29"]?.prMerged).toBe(1);
	});
	it("counts prOpened from opened lifecycle search on the Shanghai calendar day", async () => {
		const context = await fixture();
		context.days = [
			{ date: "2026-10-31", since: "2026-10-30T16:00:00.000Z", until: "2026-10-31T16:00:00.000Z" },
		];
		context.run.params = {
			...context.run.params,
			since: "2026-10-31",
			until: "2026-10-31",
			dimensions: ["prs"],
		};
		const createdAt = "2026-10-31T02:00:00.000Z";
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openPrs: { totalCount: 0 },
					pullRequests: connection([]),
				},
				openedLifecycle: {
					nodes: [{ ...item("opened-one", "OPEN"), createdAt, state: "OPEN" }],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			},
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		expect((await publication(context)).repos[0].metrics.days["2026-10-31"]?.prOpened).toBe(1);
	});
	it("marks pull request collection partial when lifecycle search is truncated", async () => {
		const context = await fixture();
		context.days = [
			{ date: "2026-10-31", since: "2026-10-30T16:00:00.000Z", until: "2026-10-31T16:00:00.000Z" },
		];
		context.run.params = {
			...context.run.params,
			since: "2026-10-31",
			until: "2026-10-31",
			dimensions: ["prs"],
		};
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					openPrs: { totalCount: 0 },
					pullRequests: connection([]),
				},
				mergedLifecycle: {
					nodes: [item("truncated", "MERGED")],
					pageInfo: { hasNextPage: true, endCursor: "next" },
				},
				openedLifecycle: {
					nodes: [],
					pageInfo: { hasNextPage: false, endCursor: null },
				},
			},
		]);
		await collectAccount(context);
		const result = await collectRepository(context, "owner/project");
		expect(result.partial).toBe(true);
		expect(result.reasons).toContain("prs:lifecycle_search_truncated");
	});
	it("keeps partial GraphQL item responses partial on initial and subsequent pages", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues"];
		const partial = Response.json({
			data: { node: { ...repo(), issues: connection([item("discarded"), item("I2")]) } },
			errors: [{ type: "FORBIDDEN", path: ["node", "issues", "nodes", 0, "title"] }],
		});
		upstream([
			accountPage(),
			partial,
			{ node: { ...repo(), issues: connection([item("I3")], true, "next") } },
			partial,
		]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(true);
		expect((await collectRepository(context, "owner/project")).partial).toBe(true);
	});
	it("propagates terminal issue-page failures after saving independent observations", async () => {
		const context = await fixture();
		upstream([
			accountPage(),
			{ node: { ...repo(), issues: connection([item("I")], true, "next") } },
			Response.json({ message: "rate limit" }, { status: 429 }),
		]);
		await collectAccount(context);
		await expect(collectRepository(context, "owner/project")).rejects.toMatchObject({
			code: "github_rate_limited",
		});
		expect((await observation(context, "commits")).results[0]?.status).toBe("complete");
	});
	it("skips complete overlapping issue days while collecting a new day", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues"];
		upstream([
			accountPage(),
			{ node: { ...repo(), openIssues: { totalCount: 1 }, issues: connection([item("I")]) } },
			{ node: { ...repo(), openIssues: { totalCount: 1 }, issues: connection([item("I")]) } },
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		context.now = "2026-10-30T00:00:00.000Z";
		context.days.push({
			date: "2026-10-29",
			since: "2026-10-28T16:00:00.000Z",
			until: "2026-10-29T16:00:00.000Z",
		});
		await collectRepository(context, "owner/project");
		expect((await observation(context, "issues")).results.map((row) => row.fetched_at)).toEqual([
			now,
			context.now,
		]);
	});
});
