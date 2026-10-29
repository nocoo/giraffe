import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import { createDb } from "../db/d1";
import { ApiError } from "../errors";
import {
	readFactoryResource,
	readMachineAccountObservation,
	readMachineRepositoryObservation,
} from "../machine-observations";
import type { CollectionContext } from "../refresh-collection-contract";
import { collectAccount, collectRepository } from "./index";
import { blankMetrics, count, event, factoryRepo, nodes, object, text, windowOf } from "./model";
import { collectionDb, publish } from "./store";
import { transport } from "./transport";

const now = "2026-10-29T04:00:00.000Z";
const repo = (id = "R_1", name = "owner/project") => ({
	id,
	nameWithOwner: name,
	name: name.split("/")[1],
	url: `https://github.com/${name}`,
	owner: { login: "owner" },
	isPrivate: false,
	isFork: false,
	createdAt: "2026-10-29T02:00:00Z",
	primaryLanguage: { name: "TypeScript" },
	defaultBranchRef: {
		name: "main",
		target: { oid: "head", history: { totalCount: 20 }, day0: { totalCount: 3 } },
	},
	issues: { totalCount: 1, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
	pullRequests: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
	openIssues: { totalCount: 1 },
	closedIssues: { totalCount: 0 },
	openPrs: { totalCount: 0 },
	closedPrs: { totalCount: 0 },
	mergedPrs: { totalCount: 0 },
	languages: {
		totalSize: 10,
		edges: [{ size: 10, node: { name: "TypeScript" } }],
		pageInfo: { hasNextPage: false },
	},
	repositoryTopics: { nodes: [] },
	releases: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
});
const releases = (values: unknown[], more = false) => ({
	totalCount: values.length,
	nodes: values,
	pageInfo: { hasNextPage: more },
});
const release = (id: string, published: string | null, created = published) => ({
	id: `RE_${id}`,
	databaseId: Number(id),
	name: `release ${id}`,
	tagName: `v${id}`,
	url: `https://github.com/owner/project/releases/${id}`,
	isDraft: false,
	isPrerelease: false,
	publishedAt: published,
	createdAt: created,
	updatedAt: published,
});
const accountPage = (nodes = [repo()], more = false, cursor: string | null = null) => ({
	viewer: {
		login: "owner",
		avatarUrl: "avatar",
		repositories: {
			nodes,
			totalCount: nodes.length,
			pageInfo: { hasNextPage: more, endCursor: cursor },
		},
		contributionsCollection: {
			restrictedContributionsCount: 0,
			contributionCalendar: {
				totalContributions: 2,
				weeks: [{ contributionDays: [{ date: "2026-10-28", contributionCount: 2 }] }],
			},
		},
	},
	rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
});
async function fixture() {
	const db = sqliteFixture();
	await db
		.prepare(
			"INSERT INTO accounts(id,login,avatar_url,token_ciphertext,token_last4,key_version,scopes,capabilities,is_active,created_at,updated_at) VALUES('a','owner','','encrypted','test',1,'','{}',1,?,?)",
		)
		.bind(now, now)
		.run();
	return {
		env: { DB: db, ENVIRONMENT: "test", GITHUB_API_BASE: "http://github.test" },
		account: { id: "a", login: "owner" },
		token: "memory-only-fake-token",
		now,
		days: [
			{ date: "2026-10-28", since: "2026-10-27T16:00:00.000Z", until: "2026-10-28T16:00:00.000Z" },
		],
		run: {
			id: "run-1",
			accountId: "a",
			params: {
				since: "2026-10-28",
				until: "2026-10-28",
				timezone: "Asia/Shanghai",
				dimensions: ["commits", "issues", "prs", "actions", "releases", "alerts"],
				force: false,
			},
			requests: 0,
			createdAt: now,
		},
	} as CollectionContext;
}
function upstream(
	graphql: unknown[] = [accountPage(), { node: repo() }],
	rest: Record<string, unknown> = {},
) {
	const fetch = vi.fn(async (input: string, _init?: RequestInit) => {
		if (input.endsWith("/graphql")) {
			const data = graphql.shift();
			if (data instanceof Error) throw data;
			if (data instanceof Response) return data.clone();
			return Response.json({ data });
		}
		for (const [suffix, data] of Object.entries(rest))
			if (input.includes(suffix))
				return data instanceof Response ? data.clone() : Response.json(data);
		if (input.includes("/actions/runs"))
			return Response.json({ total_count: 0, workflow_runs: [] });
		return Response.json([]);
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
afterEach(() => vi.unstubAllGlobals());

const item = (id: string, state = "OPEN") => ({
	id,
	number: 1,
	title: id,
	url: `https://github.com/owner/project/issues/${id}`,
	state,
	createdAt: "2026-10-28T01:00:00.000Z",
	updatedAt: "2026-10-28T02:00:00.000Z",
	closedAt: state === "CLOSED" ? "2026-10-28T03:00:00.000Z" : null,
	author: { login: "owner" },
});
const connection = (values: unknown[], more = false, cursor: string | null = null) => ({
	nodes: values,
	pageInfo: { hasNextPage: more, endCursor: cursor },
});
async function publication(context: CollectionContext) {
	const row = await context.env.DB.prepare(
		"SELECT payload FROM refresh_publications WHERE account_id=?",
	)
		.bind(context.account.id)
		.first<{ payload: string }>();
	return JSON.parse(row?.payload ?? "{}");
}
async function observation(context: CollectionContext, dimension: string) {
	return context.env.DB.prepare(
		"SELECT * FROM refresh_day_observations WHERE account_id=? AND dimension=? ORDER BY day",
	)
		.bind(context.account.id, dimension)
		.all<{ status: string; payload: string; fetched_at: string }>();
}
async function sourceSnapshot(context: CollectionContext, kind: string) {
	const row = await context.env.DB.prepare(
		"SELECT payload FROM refresh_snapshots WHERE account_id=? AND kind=?",
	)
		.bind(context.account.id, kind)
		.first<{ payload: string }>();
	return JSON.parse(row?.payload ?? "{}");
}

describe("unified refresh collection", () => {
	it("discovers once, never auto-stars, and skips unstarred repositories the next day", async () => {
		const context = await fixture();
		upstream([accountPage(), accountPage(), accountPage()]);
		expect(await collectAccount(context)).toEqual({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
			repos: ["owner/project"],
		});
		expect(await collectAccount(context)).toEqual({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
			repos: ["owner/project"],
		});
		const next = { ...context, now: "2026-10-30T04:00:00.000Z" };
		expect((await collectAccount(next)).repos).toEqual([]);
		expect((await context.env.DB.prepare("SELECT * FROM repo_stars").all()).results).toEqual([]);
	});
	it("paginates the full catalogue and selects starred identities", async () => {
		const context = await fixture();
		await context.env.DB.prepare(
			"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','owner/second',1,'owner',?)",
		)
			.bind(now)
			.run();
		upstream([accountPage([repo()], true, "cursor"), accountPage([repo("R_2", "owner/second")])]);
		expect((await collectAccount(context)).repos).toEqual(["owner/project", "owner/second"]);
		expect(
			(await context.env.DB.prepare("SELECT * FROM refresh_catalog").all()).results,
		).toHaveLength(2);
	});
	it("collects GraphQL daily totals and bounded REST data, caches successful days", async () => {
		const context = await fixture();
		const fetch = upstream();
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toEqual({
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
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 0,
			requestBreakdown: { graphql: 0, rest: 0 },
			partial: false,
			reasons: [],
		});
		expect(fetch).toHaveBeenCalledTimes(5);
		const publication = await context.env.DB.prepare(
			"SELECT payload FROM refresh_publications WHERE account_id='a'",
		).first<{ payload: string }>();
		const saved = JSON.parse(publication?.payload ?? "{}");
		expect(saved.repos[0].coverage.dependencies.status).toBe("unavailable");
		expect(saved.repos[0].metrics.commits).toBe(3);
		expect(saved.contribution.days[0].count).toBe(2);
		expect(
			JSON.stringify(
				(await context.env.DB.prepare("SELECT payload FROM refresh_snapshots").all()).results,
			),
		).not.toContain(context.token);
	});
	it("validates adhoc repositories against the complete catalogue", async () => {
		const context = await fixture();
		context.run.params.repo = "owner/missing";
		upstream([accountPage()]);
		await expect(collectAccount(context)).rejects.toMatchObject({ code: "not_found" });
	});
	it("does not materialize unknown or renamed identities using cached old names", async () => {
		const context = await fixture();
		upstream([accountPage(), { node: repo("R_other") }]);
		await collectAccount(context);
		await expect(collectRepository(context, "owner/project")).rejects.toMatchObject({
			code: "github_error",
		});
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
		expect(await collectRepository(context, "owner/project")).toEqual({
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
		expect((await collectAccount(context)).requests).toBe(2);
		expect(onRequests).toHaveBeenLastCalledWith(2, { graphql: 2, rest: 0 });
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
	it("consumes the full page and all forced pages despite cached item IDs", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues", "prs"];
		const before = {
			...repo(),
			issues: connection([item("I1"), item("I2")]),
			pullRequests: connection([item("P1"), item("P2")]),
		};
		const after = {
			...repo(),
			issues: connection([item("Inew"), item("I1", "CLOSED"), item("Iafter")], true, "cursor"),
			pullRequests: connection(
				[{ ...item("P1"), mergedAt: "2026-10-28T03:00:00Z" }, item("Pafter")],
				true,
				"cursor",
			),
		};
		const fetch = upstream([
			accountPage(),
			{ node: before },
			{ node: after },
			{ node: { issues: connection([item("Ilater")]) } },
			{ node: { pullRequests: connection([item("Plater")]) } },
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		context.run.params.force = true;
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 3, rest: 0 },
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
			expect.arrayContaining(["Iafter", "Pafter", "Ilater", "Plater"]),
		);
		expect(JSON.parse(saved.find((row) => row.item_id === "I1")?.payload ?? "{}").state).toBe(
			"CLOSED",
		);
		expect((await publication(context)).repos[0].metrics).toMatchObject({
			issueOpened: 5,
			issueClosed: 1,
			prOpened: 4,
			prMerged: 1,
		});
		expect(fetch).toHaveBeenCalledTimes(5);
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
			const prior = { ...repo(), issues: connection([item("cached"), item("retained")]) };
			const changed = { ...item("cached", state), updatedAt };
			upstream([
				accountPage(),
				{ node: prior },
				{
					node: {
						...repo(),
						issues: connection([changed], true, "changed-page"),
					},
				},
				{
					node: {
						issues: connection([item("retained"), item("same-page-new")], true, "unused"),
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
			expect(await collectRepository(context, "owner/project")).toEqual({
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
	it("does not claim complete current inventory after stopping below the lifecycle window", async () => {
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
					issues: connection([item("recent"), olderOpen], true, "older-issues"),
					pullRequests: connection([olderOpen], true, "older-prs"),
				},
			},
		]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(true);
		for (const stream of ["issues", "prs"]) {
			const saved = await sourceSnapshot(context, `repo:owner/project:${stream}`);
			expect(saved).toMatchObject({ truncated: true, inventory_complete: false });
			expect((await observation(context, stream)).results[0]?.status).toBe("complete");
			expect(
				JSON.parse((await observation(context, stream)).results[0]?.payload ?? "{}"),
			).toMatchObject({ inventoryComplete: false });
		}
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 0,
			requestBreakdown: { graphql: 0, rest: 0 },
			partial: true,
			reasons: ["issues:inventory_incomplete", "prs:inventory_incomplete"],
		});
		expect((await publication(context)).status).toBe("partial");
	});
	it("keeps cached older open items while excluding closed issues from open inboxes", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues"];
		const old = { ...item("old-open"), createdAt: "2026-10-20T00:00:00Z" };
		upstream([
			accountPage(),
			{ node: { ...repo(), issues: connection([item("closing"), old]) } },
			{ node: { ...repo(), issues: connection([item("closing", "CLOSED")]) } },
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		context.run.params.force = true;
		await collectRepository(context, "owner/project");
		for (const kind of ["repo:owner/project:issues", "issues"]) {
			const saved = await sourceSnapshot(context, kind);
			expect(saved.issues.map((row: { title: string }) => row.title)).toEqual(["old-open"]);
		}
		expect((await publication(context)).repos[0].metrics.issueClosed).toBe(1);
	});
	it("paginates initial issue and PR inventories until complete", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues", "prs"];
		const first = {
			...repo(),
			issues: connection([item("I1")], true, "issues-next"),
			pullRequests: connection([item("P1")], true, "prs-next"),
		};
		const fetch = upstream([
			accountPage(),
			{ node: first },
			{ node: { issues: connection([item("I2", "CLOSED")]) } },
			{ node: { pullRequests: connection([item("P2", "CLOSED")]) } },
		]);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 3, rest: 0 },
			partial: false,
			reasons: [],
		});
		expect((await publication(context)).repos[0].metrics).toMatchObject({
			issueOpened: 2,
			issueClosed: 1,
			prOpened: 2,
			prClosed: 1,
		});
		expect(String(fetch.mock.calls[2]?.[1]?.body)).toContain("RefreshItems");
	});
	it("does not stop at an unproven cache boundary after a failed page", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues"];
		const first = { ...repo(), issues: connection([item("I1")], true, "next") };
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
		expect(await collectRepository(context, "owner/project")).toEqual({
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
	it("stops repeated issue cursors and respects the lower update bound", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["issues"];
		const first = { ...repo(), issues: connection([item("I1")], true, "same") };
		upstream([
			accountPage(),
			{ node: first },
			{ node: { issues: connection([item("I2")], true, "same") } },
			{
				node: {
					...repo(),
					issues: connection(
						[{ ...item("old"), updatedAt: "2026-10-26T00:00:00Z" }],
						true,
						"unused",
					),
				},
			},
		]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(true);
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: true,
			reasons: ["issues:inventory_incomplete"],
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
				created_at: "2026-10-28T01:00:00Z",
			},
			{ id: 2, status: "completed", conclusion: "failure", created_at: "2026-10-28T02:00:00Z" },
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
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 1, rest: 2 },
			partial: true,
			reasons: ["alerts:not_found"],
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
		expect((await observation(context, "alerts")).results[0]?.status).toBe("unavailable");
		expect(
			await readFactoryResource(collectionDb(context), "a", "owner/project", "alerts"),
		).toMatchObject({ data: { unavailable: true, coverage: { status: "unavailable" } } });
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
			const data =
				path === "/actions/runs"
					? { total_count: 101, workflow_runs: [{ id: 1, created_at: "2026-10-28T01:00:00Z" }] }
					: [{ number: 1, state: "open" }];
			upstream(undefined, {
				[path]: Response.json(data, {
					headers: { link: '<https://github.test/next>; rel="next"' },
				}),
			});
			await collectAccount(context);
			expect((await collectRepository(context, "owner/project")).partial).toBe(true);
			if (path === "/dependabot/alerts")
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
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
		});
		const body = JSON.parse(String(fetch.mock.calls.at(-1)?.[1]?.body));
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
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 0,
			requestBreakdown: { graphql: 0, rest: 0 },
			partial: false,
			reasons: [],
		});
		const saved = await publication(context);
		expect(saved.runId).toBe("run-2");
		expect(saved.repos[0].coverage.commits.fetchedAt).toBe(now);
		expect(saved.repos[0].observation).toMatchObject({
			refreshedAt: now,
			publishedAt: context.now,
			metadataAt: now,
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
		expect(fetch).toHaveBeenCalledTimes(mixed ? 3 : 2);
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
	it("isolates immutable identities even when a repository name is reused", async () => {
		const context = await fixture();
		const fetch = upstream([
			accountPage(),
			{ node: repo() },
			accountPage([repo("R_new")]),
			{ node: repo("R_new") },
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).requests).toBe(4);
		expect((await publication(context)).repos.map((repo: { id: string }) => repo.id)).toEqual([
			"R_new",
		]);
		expect(fetch).toHaveBeenCalledTimes(10);
	});
	it("releases only a confirmed reused name when the current catalogue is partial", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["commits"];
		upstream([
			accountPage([repo(), repo("R_other", "owner/unobserved")]),
			{ node: repo() },
			accountPage([repo("R_new")], true, "failed-page"),
			new Error("transient"),
			new Error("transient"),
			{ node: repo("R_new") },
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		expect((await collectAccount(context)).partial).toBe(true);
		const active = await context.env.DB.prepare(
			"SELECT repo_id,repo FROM refresh_catalog WHERE active=1 ORDER BY repo",
		).all<{ repo_id: string; repo: string }>();
		expect(active.results).toEqual([
			{ repo_id: "R_new", repo: "owner/project" },
			{ repo_id: "R_other", repo: "owner/unobserved" },
		]);
		expect((await publication(context)).repos).toEqual([]);
		expect(await sourceSnapshot(context, "repo:owner/project:details")).toEqual({});
		expect((await collectRepository(context, "owner/project")).requests).toBe(1);
		expect((await publication(context)).repos.map((value: { id: string }) => value.id)).toEqual([
			"R_new",
		]);
	});
	it("allows explicitly validated adhoc requests without starring", async () => {
		const context = await fixture();
		context.run.params.repo = "OWNER/PROJECT";
		upstream();
		expect((await collectAccount(context)).repos).toEqual(["owner/project"]);
		await expect(collectRepository(context, "owner/unknown")).rejects.toMatchObject({
			code: "not_found",
		});
	});
	it("does not accept an unrelated token account", async () => {
		const context = await fixture();
		const page = accountPage();
		page.viewer.login = "other";
		upstream([page]);
		await expect(collectAccount(context)).rejects.toMatchObject({ code: "github_unauthorized" });
	});
	it.each([
		null,
		[{ id: "", nameWithOwner: "owner/project" }],
		[{ id: "id", nameWithOwner: "invalid" }],
	])("publishes partial rather than false empty catalogue success: %j", async (values) => {
		const context = await fixture();
		const page = accountPage();
		page.viewer.repositories.nodes = values as never;
		upstream([page]);
		expect((await collectAccount(context)).partial).toBe(true);
		expect((await publication(context)).inventory.complete).toBe(false);
	});
	it("preserves a partial catalogue when a later page fails", async () => {
		const context = await fixture();
		upstream([accountPage([repo()], true, "next"), new Error("network"), new Error("network")]);
		expect(await collectAccount(context)).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 3, rest: 0 },
			partial: true,
			reasons: ["catalog:incomplete"],
			repos: ["owner/project"],
		});
	});
	it.each([null, "repeat"])("stops missing or repeated catalogue cursors: %s", async (cursor) => {
		const context = await fixture();
		upstream([accountPage([repo()], true, cursor), accountPage([repo()], true, cursor)]);
		expect((await collectAccount(context)).partial).toBe(true);
	});
	it("caps pathological catalogue pagination below the GitHub request budget", async () => {
		const context = await fixture();
		upstream(
			Array.from({ length: 35 }, (_, index) =>
				accountPage([repo(`R_${index}`, `owner/repo${index}`)], true, String(index)),
			),
		);
		expect((await collectAccount(context)).requests).toBe(35);
	});
	it.each([
		{},
		{ totalContributions: 0, weeks: [] },
		{
			totalContributions: 0,
			weeks: [{ contributionDays: [{ date: "2026-10-28", contributionCount: null }] }],
		},
		{ totalContributions: 0, weeks: [{ contributionDays: [{ contributionCount: 0 }] }] },
	])("does not substitute zero for missing contribution data: %j", async (calendar) => {
		const context = await fixture();
		const page = accountPage();
		page.viewer.contributionsCollection.contributionCalendar = calendar as never;
		delete (page as { rateLimit?: unknown }).rateLimit;
		upstream([page]);
		expect((await collectAccount(context)).partial).toBe(true);
		expect(await publication(context)).toMatchObject({
			contribution: null,
			contributionStatus: "unavailable",
			rate: null,
		});
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
		expect(object([])).toEqual({});
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
	it("fails closed when account publication prerequisites are absent", async () => {
		const context = await fixture();
		await expect(publish(collectionDb(context), context)).rejects.toMatchObject({
			code: "db_error",
		});
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
	it("keeps canonical schema and repeatable migration identical", () => {
		const db = new DatabaseSync(":memory:");
		const schema = readFileSync("apps/web/src/server/lib/db/schema.sql", "utf8");
		const migration = readFileSync("migrations/0028_refresh_observations.sql", "utf8");
		db.exec(schema);
		db.exec(migration);
		db.exec(migration);
		expect(schema).toContain(migration.trim());
		db.close();
	});
	it("publishes account inboxes as well as repository sources for browser and machine readers", async () => {
		const context = await fixture();
		upstream([
			accountPage(),
			{
				node: {
					...repo(),
					issues: connection([item("I1")]),
					pullRequests: connection([item("P1")]),
				},
			},
		]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		const db = createDb(context.env.DB);
		const issues = await readMachineAccountObservation(db, "a", "issues", "all");
		const prs = await readMachineAccountObservation(db, "a", "prs", "all");
		expect(issues.data.issues).toHaveLength(1);
		expect(prs.data.pull_requests).toHaveLength(1);
		const details = await readMachineRepositoryObservation(db, "a", "owner/project", "details");
		expect(details.data).toMatchObject({ default_branch: "main" });
	});
	it("does not leak saved sources across repository identity replacement", async () => {
		const context = await fixture();
		upstream([accountPage(), { node: repo() }, accountPage([repo("R_new")])]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		await collectAccount(context);
		expect(
			(
				await context.env.DB.prepare(
					"SELECT kind FROM refresh_snapshots WHERE kind LIKE 'repo:%'",
				).all()
			).results,
		).toEqual([]);
		expect(await publication(context)).toMatchObject({ repos: [] });
	});
	it("does not label unrequested dimensions complete when publishing only cached commits", async () => {
		const context = await fixture();
		upstream();
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		context.run.params.dimensions = ["commits"];
		await collectRepository(context, "owner/project");
		expect((await publication(context)).repos[0].coverage.issues.status).toBe("unavailable");
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
			{ node: { ...repo(), issues: connection([item("I")]) } },
			{ node: { ...repo(), issues: connection([item("I")]) } },
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
	it("marks restricted and truncated account catalogues incomplete without clearing known rows", async () => {
		const context = await fixture();
		const page = accountPage();
		page.viewer.repositories.totalCount = 2;
		delete (page.viewer as { avatarUrl?: string }).avatarUrl;
		upstream([page]);
		expect((await collectAccount(context)).partial).toBe(true);
		expect(
			(
				await context.env.DB.prepare("SELECT avatar_url FROM accounts").first<{
					avatar_url: string;
				}>()
			)?.avatar_url,
		).toBe("");
	});
	it("preserves known catalogue data when retries exhaust the transport budget", async () => {
		const context = await fixture();
		upstream(
			Array.from({ length: 25 }, (_, index) => [
				new Error("network"),
				accountPage([repo(`R_${index}`, `owner/repo${index}`)], true, String(index)),
			]).flat(),
		);
		const result = await collectAccount(context);
		expect(result.requests).toBe(40);
		expect(result.partial).toBe(true);
	});
	it("keeps latest REST pagination complete when its tail precedes the requested window", async () => {
		const context = await fixture();
		upstream(undefined, {
			"/actions/runs": Response.json(
				{ workflow_runs: [{ id: 1, created_at: "2026-10-01T00:00:00Z" }] },
				{ headers: { link: '<https://github.test/next>; rel="next"' } },
			),
		});
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).partial).toBe(false);
	});
	it.each([
		{
			label: "another owner",
			node: { ...repo("R_other", "someone/project"), owner: { login: "someone" } },
		},
		{ label: "a fork", node: { ...repo(), isFork: true } },
		{ label: "a historical repository", node: { ...repo(), createdAt: "2026-10-01T00:00:00Z" } },
		{ label: "a repository without createdAt", node: { ...repo(), createdAt: undefined } },
		{ label: "a repository without an owner", node: { ...repo(), owner: undefined } },
		{
			label: "a repository created after this Shanghai day",
			node: { ...repo(), createdAt: "2026-10-30T00:00:00Z" },
		},
	])("never promotes $label into the automatic scope of an empty database", async ({ node }) => {
		const context = await fixture();
		upstream([accountPage([node as never])]);
		expect(await collectAccount(context)).toEqual({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
			repos: [],
		});
		expect((await context.env.DB.prepare("SELECT * FROM repo_stars").all()).results).toEqual([]);
	});
	it("never promotes an unreadable catalogue payload", async () => {
		const context = await fixture();
		const page = accountPage();
		page.viewer.repositories.totalCount = 2;
		await context.env.DB.prepare(
			"INSERT INTO refresh_catalog(account_id,repo_id,repo,discovered_day,timezone,payload,fetched_at,active) VALUES('a','R_broken','owner/broken','2026-10-29','Asia/Shanghai','{not json',?,1)",
		)
			.bind(now)
			.run();
		upstream([page]);
		expect(await collectAccount(context)).toMatchObject({
			partial: true,
			reasons: ["catalog:incomplete"],
			repos: ["owner/project"],
		});
	});
	it("selects owner-created repositories owned by the account owner case-insensitively", async () => {
		const context = await fixture();
		upstream([accountPage([{ ...repo(), owner: { login: "OWNER" } } as never])]);
		expect((await collectAccount(context)).repos).toEqual(["owner/project"]);
	});
	it("includes starred repositories of any owner and excludes unstarred foreign ones", async () => {
		const context = await fixture();
		await context.env.DB.batch([
			context.env.DB.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','other/lib',1,'owner',?)",
			).bind(now),
			context.env.DB.prepare(
				"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','owner/chosen',1,'owner',?)",
			).bind(now),
		]);
		upstream([
			accountPage([
				{
					...repo("R_star", "other/lib"),
					owner: { login: "other" },
					createdAt: "2020-01-01T00:00:00Z",
				} as never,
				{
					...repo("R_plain", "other/plain"),
					owner: { login: "other" },
					createdAt: "2026-10-29T02:00:00Z",
				} as never,
				{
					...repo("R_chosen", "owner/chosen"),
					createdAt: "2020-01-01T00:00:00Z",
				} as never,
			]),
		]);
		expect((await collectAccount(context)).repos).toEqual(["other/lib", "owner/chosen"]);
	});
	it("keeps an explicit repository request independent of automatic selection", async () => {
		const context = await fixture();
		context.run.params.repo = "OTHER/legacy";
		upstream([
			accountPage([
				{ ...repo("R_legacy", "other/legacy"), createdAt: "2020-01-01T00:00:00Z" } as never,
			]),
		]);
		expect(await collectAccount(context)).toMatchObject({
			partial: false,
			repos: ["other/legacy"],
		});
		expect((await context.env.DB.prepare("SELECT * FROM repo_stars").all()).results).toEqual([]);
	});
	it("reports the transport split of A and B separately", async () => {
		const context = await fixture();
		const onRequests = vi.fn();
		context.onRequests = onRequests;
		upstream();
		expect(await collectAccount(context)).toMatchObject({
			requestBreakdown: { graphql: 1, rest: 0 },
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
		expect(await collectRepository(context, "owner/project")).toEqual({
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
			partial: true,
			reasons: ["releases:latest_page_only"],
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
			partial: true,
			reasons: ["releases:latest_page_only"],
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
			expect(await collectRepository(context, "owner/project")).toEqual({
				requests: 1,
				requestBreakdown: { graphql: 1, rest: 0 },
				partial,
				reasons,
			});
		},
	);
	it("represents unknown language sizes as unavailable metadata defaults", async () => {
		const context = await fixture();
		expect(
			factoryRepo({ languages: { edges: [{ node: { name: "Unknown" } }] } }, context).languages,
		).toEqual([{ name: "Unknown", bytes: 0 }]);
	});
});
