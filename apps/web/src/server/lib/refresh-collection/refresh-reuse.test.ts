import { afterEach, describe, expect, it, vi } from "vitest";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import { readFactoryResource } from "../machine-observations";
import type { CollectionContext } from "../refresh-collection-contract";
import { collectAccount, collectRepository } from "./index";
import { collectionDb } from "./store";

const now = "2026-10-29T04:00:00.000Z";
const repository = () => ({
	id: "R_1",
	nameWithOwner: "owner/project",
	name: "project",
	url: "https://github.com/owner/project",
	description: "saved metadata",
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
	repositoryTopics: { nodes: [{ topic: { name: "personal" } }] },
	releases: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
});
const accountPage = () => ({
	viewer: {
		login: "owner",
		avatarUrl: "avatar",
		repositories: {
			nodes: [repository()],
			totalCount: 1,
			pageInfo: { hasNextPage: false, endCursor: null },
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
async function fixture(): Promise<CollectionContext> {
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
				dimensions: ["commits", "issues", "prs", "releases"],
				force: false,
			},
			requests: 0,
			createdAt: now,
		},
	} as CollectionContext;
}
function upstream(graphql: unknown[] = [], rest: Record<string, unknown> = {}) {
	const fetch = vi.fn(async (input: string) => {
		if (input.endsWith("/graphql")) {
			const data = graphql.shift();
			if (data instanceof Error) throw data;
			if (data instanceof Response) return data.clone();
			return Response.json({ data });
		}
		for (const [suffix, data] of Object.entries(rest))
			if (input.includes(suffix))
				return data instanceof Response ? data.clone() : Response.json(data);
		return Response.json([]);
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
afterEach(() => vi.unstubAllGlobals());
const graphqlCalls = (fetch: ReturnType<typeof upstream>) =>
	fetch.mock.calls.filter(([url]) => String(url).endsWith("/graphql")).length;
const restCalls = (fetch: ReturnType<typeof upstream>) =>
	fetch.mock.calls.filter(([url]) => !String(url).endsWith("/graphql")).length;
async function publication(context: CollectionContext) {
	const row = await context.env.DB.prepare(
		"SELECT payload FROM refresh_publications WHERE account_id=?",
	)
		.bind(context.account.id)
		.first<{ payload: string }>();
	return JSON.parse(row?.payload ?? "{}");
}
async function day(context: CollectionContext, dimension: string) {
	const row = await context.env.DB.prepare(
		"SELECT status,payload FROM refresh_day_observations WHERE account_id=? AND dimension=?",
	)
		.bind(context.account.id, dimension)
		.first<{ status: string; payload: string }>();
	return { status: row?.status, payload: JSON.parse(row?.payload ?? "{}") };
}
async function snapshot(context: CollectionContext, kind: string) {
	const row = await context.env.DB.prepare(
		"SELECT payload,fetched_at FROM refresh_snapshots WHERE account_id=? AND kind=?",
	)
		.bind(context.account.id, kind)
		.first<{ payload: string; fetched_at: string }>();
	return {
		fetched_at: row?.fetched_at,
		payload: JSON.parse(row?.payload ?? "{}") as Record<string, unknown>,
	};
}

describe("refresh reuse boundaries", () => {
	it.each([
		["code-scanning", 404, "Not Found", "dependabot"],
		["dependabot", 403, "Dependabot alerts are disabled", "code-scanning"],
	] as const)(
		"preserves observed alerts when cached %s is unavailable",
		async (missing, status, message, available) => {
			const context = await fixture();
			context.run.params.dimensions = ["alerts"];
			upstream([accountPage(), { node: repository() }], {
				[`/${missing}/alerts`]: Response.json({ message }, { status }),
				[`/${available}/alerts`]: [
					{
						number: 7,
						state: "open",
						created_at: "2026-10-28T03:00:00Z",
						html_url: "https://github.com/owner/project/security/7",
						security_advisory: { summary: "Observed vulnerability", severity: "high" },
						rule: { description: "Observed vulnerability", security_severity_level: "high" },
					},
				],
			});
			await collectAccount(context);
			expect(await collectRepository(context, "owner/project")).toMatchObject({ partial: false });
			expect((await publication(context)).repos[0].metrics.alerts).toBe(1);
			const evidence = await day(context, "alerts");
			expect(evidence).toMatchObject({ status: "complete", payload: { count: null, observed: 1 } });
			expect(evidence.payload.items).toHaveLength(1);
			const security = await snapshot(context, "repo:owner/project:security");
			const fetch = upstream();
			expect(await collectRepository(context, "owner/project")).toMatchObject({
				requests: 0,
				partial: false,
			});
			expect(fetch).not.toHaveBeenCalled();
			expect((await publication(context)).repos[0].metrics.alerts).toBe(1);
			expect(await day(context, "alerts")).toEqual(evidence);
			expect(await snapshot(context, "repo:owner/project:security")).toEqual(security);
		},
	);
	it("collects REST-only work without a metadata GraphQL query", async () => {
		const context = await fixture();
		upstream([accountPage(), { node: repository() }]);
		await collectAccount(context);
		expect((await collectRepository(context, "owner/project")).requestBreakdown).toEqual({
			graphql: 1,
			rest: 0,
		});
		const first = await publication(context);
		const details = await snapshot(context, "repo:owner/project:details");
		expect(first.repos[0]).toMatchObject({
			branch: "main",
			head: "head",
			totalCommits: 20,
			description: "saved metadata",
			metadataAt: now,
		});
		context.now = "2026-10-29T09:00:00.000Z";
		context.run.params.dimensions = ["commits", "issues", "prs", "actions", "releases", "alerts"];
		const fetch = upstream([], {
			"/actions/runs": { total_count: 0, workflow_runs: [] },
			"/dependabot/alerts": [],
			"/code-scanning/alerts": [],
		});
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 0, rest: 3 },
			partial: false,
			reasons: [],
		});
		expect(graphqlCalls(fetch)).toBe(0);
		expect(restCalls(fetch)).toBe(3);
		const second = await publication(context);
		expect(second.repos[0]).toMatchObject({
			id: "R_1",
			name: "owner/project",
			branch: "main",
			head: "head",
			totalCommits: 20,
			description: "saved metadata",
			topics: ["personal"],
			metadataAt: now,
			observation: { metadataAt: now },
		});
		expect(second.repos[0].coverage.commits.strategy).toBe("reused");
		expect(second.repos[0].coverage.actions.strategy).toBe("incremental");
		expect(await snapshot(context, "repo:owner/project:details")).toEqual(details);
		const cached = upstream();
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			requests: 0,
			partial: false,
		});
		expect(cached).not.toHaveBeenCalled();
	});
	it("caches a 404 security feature as complete but unavailable", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": Response.json({ message: "no analysis found" }, { status: 404 }),
		});
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 1, rest: 2 },
			partial: false,
			reasons: [],
		});
		expect(await day(context, "alerts")).toMatchObject({
			status: "complete",
			payload: { count: null, observed: 0, unavailable: true, reason: "not_found" },
		});
		expect(await snapshot(context, "repo:owner/project:security")).toMatchObject({
			payload: {
				truncated: false,
				unavailable: true,
				dependabot_open: 0,
				code_scanning_open: null,
				features: {
					dependabot: { status: "available" },
					code_scanning: { status: "unavailable", reason_code: "not_found" },
				},
			},
		});
		const saved = await publication(context);
		expect(saved.repos[0].coverage.alerts).toMatchObject({ status: "unavailable" });
		expect(saved.repos[0].metrics.alerts).toBe(0);
		expect(
			await readFactoryResource(collectionDb(context), "a", "owner/project", "alerts"),
		).toMatchObject({
			data: { unavailable: true, coverage: { status: "unavailable" } },
		});
		const fetch = upstream();
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 0,
			requestBreakdown: { graphql: 0, rest: 0 },
			partial: false,
			reasons: [],
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	it("caches a feature-disabled 403 without losing an available zero", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": Response.json(
				{ message: "Dependabot alerts are disabled" },
				{ status: 403 },
			),
			"/code-scanning/alerts": [],
		});
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({
			partial: false,
			reasons: [],
		});
		expect(await day(context, "alerts")).toMatchObject({
			status: "complete",
			payload: { count: null, unavailable: true, reason: "alerts_disabled" },
		});
		expect(await snapshot(context, "repo:owner/project:security")).toMatchObject({
			payload: {
				unavailable: true,
				dependabot_open: null,
				code_scanning_open: 0,
				features: {
					dependabot: { status: "unavailable", reason_code: "alerts_disabled" },
					code_scanning: { status: "available" },
				},
			},
		});
		const fetch = upstream();
		expect((await collectRepository(context, "owner/project")).requests).toBe(0);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("does not call a terminal day partial when another selected day has evidence", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": [],
		});
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({ partial: false });
		context.days.push({
			date: "2026-10-29",
			since: "2026-10-28T16:00:00.000Z",
			until: "2026-10-29T16:00:00.000Z",
		});
		context.run.params.until = "2026-10-29";
		upstream([], {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": Response.json({ message: "no analysis found" }, { status: 404 }),
		});
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 2,
			requestBreakdown: { graphql: 0, rest: 2 },
			partial: false,
			reasons: [],
		});
		const saved = await publication(context);
		expect(saved.repos[0].coverage.alerts).toMatchObject({ status: "partial", observed: 1 });
		expect(
			(
				await context.env.DB.prepare(
					"SELECT day,status,payload FROM refresh_day_observations WHERE dimension='alerts' ORDER BY day",
				).all<{ day: string; status: string; payload: string }>()
			).results.map((row) => ({
				day: row.day,
				status: row.status,
				unavailable: JSON.parse(row.payload).unavailable,
			})),
		).toEqual([
			{ day: "2026-10-28", status: "complete", unavailable: false },
			{ day: "2026-10-29", status: "complete", unavailable: true },
		]);
		const cached = upstream();
		expect(await collectRepository(context, "owner/project")).toMatchObject({ requests: 0 });
		expect(cached).not.toHaveBeenCalled();
	});
	it("refreshes metadata for a forced REST-only request", async () => {
		const context = await fixture();
		upstream([accountPage(), { node: repository() }]);
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		context.now = "2026-10-29T09:00:00.000Z";
		context.run.params.dimensions = ["alerts"];
		context.run.params.force = true;
		const fetch = upstream([{ node: { ...repository(), description: "refreshed metadata" } }], {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": [],
		});
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 1, rest: 2 },
			partial: false,
			reasons: [],
		});
		expect(graphqlCalls(fetch)).toBe(1);
		const saved = await publication(context);
		expect(saved.repos[0]).toMatchObject({
			description: "refreshed metadata",
			metadataAt: context.now,
			observation: { metadataAt: context.now },
		});
		expect((await snapshot(context, "repo:owner/project:details")).fetched_at).toBe(context.now);
	});
	it("keeps permission-denied security features retryable", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": Response.json({ message: "Requires permission" }, { status: 403 }),
		});
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 1, rest: 2 },
			partial: true,
			reasons: ["alerts:permission_denied"],
		});
		expect((await day(context, "alerts")).status).toBe("unavailable");
		upstream([], { "/dependabot/alerts": [], "/code-scanning/alerts": [] });
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 2,
			requestBreakdown: { graphql: 0, rest: 2 },
			partial: false,
			reasons: [],
		});
		expect((await day(context, "alerts")).status).toBe("complete");
	});
});
