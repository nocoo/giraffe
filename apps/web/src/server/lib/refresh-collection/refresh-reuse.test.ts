import { afterEach, describe, expect, it, vi } from "vitest";
import { annualContributionCalendar } from "../../../../../../tests/fixtures/contribution-calendar";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import type { FactoryRepo, FactorySnapshot } from "../../../lib/factory-types";
import type { RefreshDay, RefreshDimension, RefreshParams } from "../../../lib/refresh-types";
import { readFactoryResource } from "../machine-observations";
import type { CollectionContext } from "../refresh-collection-contract";
import { refreshDays } from "../refresh-params";
import { assemblePages, type SnapshotPage } from "../snapshot-pages";
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
			contributionCalendar: annualContributionCalendar(now, 2).calendar,
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
	const rows = await context.env.DB.prepare(
		"SELECT kind,payload,content_meta FROM refresh_snapshots WHERE account_id=? AND kind LIKE 'factory%' ORDER BY kind",
	)
		.bind(context.account.id)
		.all<SnapshotPage>();
	return assemblePages("factory", rows.results) as unknown as FactorySnapshot & {
		repos: [FactoryRepo, ...FactoryRepo[]];
	};
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
const contiguousSpan = (days: RefreshDay[]) => [
	{
		since: String(days[0]?.since),
		until: new Date(Date.parse(String(days.at(-1)?.until)) - 1).toISOString(),
		timezone: "Asia/Shanghai",
	},
];
const LOOKBACK_DAYS = 90;
const LOOKBACK_UNTIL = "2026-10-28";
const shiftDate = (date: string, days: number) =>
	new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
function lookbackParams(dimensions: RefreshDimension[]): RefreshParams {
	return {
		since: shiftDate(LOOKBACK_UNTIL, -(LOOKBACK_DAYS - 1)),
		until: LOOKBACK_UNTIL,
		timezone: "Asia/Shanghai",
		dimensions,
		force: false,
		lookbackDays: LOOKBACK_DAYS,
	};
}
async function lookbackFixture(dimensions: RefreshDimension[]): Promise<CollectionContext> {
	const context = await fixture();
	context.run.params = lookbackParams(dimensions);
	context.days = refreshDays(context.run.params);
	await context.env.DB.prepare(
		"INSERT INTO repo_stars(account_id,repo,starred,source,updated_at) VALUES('a','owner/project',1,'owner',?)",
	)
		.bind(now)
		.run();
	return context;
}
function repositoryNode(commitDays: number) {
	return {
		node: {
			...repository(),
			defaultBranchRef: {
				name: "main",
				target: {
					oid: "head",
					history: { totalCount: 20 },
					...Object.fromEntries(
						Array.from({ length: commitDays }, (_, index) => [
							`day${index}`,
							{ totalCount: index % 5 },
						]),
					),
				},
			},
		},
	};
}
type GraphqlRequest = { query: string; variables: Record<string, unknown> };
const graphqlRequests = (fetch: ReturnType<typeof upstream>): GraphqlRequest[] =>
	fetch.mock.calls
		.filter(([url]) => String(url).endsWith("/graphql"))
		.map(
			(call) =>
				JSON.parse(String((call as unknown as [string, RequestInit])[1].body)) as GraphqlRequest,
		);
const historyAliases = (query: string) => query.match(/day\d+:history/g) ?? [];
async function observationRows(context: CollectionContext) {
	return (
		await context.env.DB.prepare(
			"SELECT day,dimension,status,payload,fetched_at FROM refresh_day_observations WHERE account_id=? ORDER BY dimension,day",
		)
			.bind(context.account.id)
			.all<{
				day: string;
				dimension: string;
				status: string;
				payload: string;
				fetched_at: string;
			}>()
	).results;
}

function countedD1(db: D1Database) {
	const roundtrips: string[][] = [];
	const records = new WeakMap<object, { query: string; statement: D1PreparedStatement }>();
	const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement => {
		const wrapped = {
			bind: (...values: unknown[]) => wrap(statement.bind(...values), query),
			first: <T = Record<string, unknown>>(column?: string) => {
				roundtrips.push([query]);
				return column === undefined ? statement.first<T>() : statement.first<T>(column);
			},
			all: <T = Record<string, unknown>>() => {
				roundtrips.push([query]);
				return statement.all<T>();
			},
			run: () => statement.run(),
		} as unknown as D1PreparedStatement;
		records.set(wrapped, { query, statement });
		return wrapped;
	};
	return {
		roundtrips,
		db: {
			prepare: (query: string) => wrap(db.prepare(query), query),
			batch: (statements: D1PreparedStatement[]) => {
				const entries = statements.map((statement) => records.get(statement));
				roundtrips.push(entries.map((entry) => entry?.query ?? ""));
				return db.batch(entries.map((entry) => entry?.statement ?? db.prepare("SELECT 1")));
			},
		} as unknown as D1Database,
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
	it("caches an expected unavailable security day as a complete window and reuses it", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage()]);
		await collectAccount(context);
		context.run.params.force = true;
		upstream([{ node: repository() }], {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": Response.json({ message: "no analysis found" }, { status: 404 }),
		});
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 1, rest: 2 },
			partial: false,
			reasons: [],
		});
		const window = {
			since: "2026-10-27T16:00:00.000Z",
			until: "2026-10-28T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		};
		expect(await day(context, "alerts")).toMatchObject({
			status: "complete",
			payload: { count: null, observed: 0, unavailable: true, reason: "not_found" },
		});
		const forced = await publication(context);
		expect(forced.repos[0].coverage.alerts).toMatchObject({
			status: "unavailable",
			observed: 0,
			reason: "not_found",
			strategy: "incremental",
			completeWindows: [window],
		});
		const security = await snapshot(context, "repo:owner/project:security");
		context.run.params.force = false;
		const fetch = upstream();
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 0,
			requestBreakdown: { graphql: 0, rest: 0 },
			partial: false,
			reasons: [],
		});
		expect(fetch).not.toHaveBeenCalled();
		expect((await publication(context)).repos[0].coverage.alerts).toMatchObject({
			status: "unavailable",
			observed: 0,
			reason: "not_found",
			strategy: "reused",
			completeWindows: [window],
		});
		expect(await snapshot(context, "repo:owner/project:security")).toEqual(security);
	});
	it("keeps a mixed available and unavailable security day explicit and cacheable", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": [
				{
					number: 7,
					state: "open",
					created_at: "2026-10-28T03:00:00Z",
					html_url: "https://github.com/owner/project/security/7",
					security_advisory: { summary: "Observed vulnerability", severity: "high" },
				},
			],
			"/code-scanning/alerts": Response.json({ message: "no analysis found" }, { status: 404 }),
		});
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toMatchObject({ partial: false });
		const evidence = await day(context, "alerts");
		expect(evidence).toMatchObject({
			status: "complete",
			payload: { count: null, observed: 1, unavailable: true, reason: "not_found" },
		});
		expect(evidence.payload.items).toHaveLength(1);
		expect((await publication(context)).repos[0].coverage.alerts).toMatchObject({
			status: "unavailable",
			observed: 0,
			reason: "not_found",
			completeWindows: [
				{
					since: "2026-10-27T16:00:00.000Z",
					until: "2026-10-28T15:59:59.999Z",
					timezone: "Asia/Shanghai",
				},
			],
		});
		const fetch = upstream();
		expect(await collectRepository(context, "owner/project")).toMatchObject({ requests: 0 });
		expect(fetch).not.toHaveBeenCalled();
		expect(await day(context, "alerts")).toEqual(evidence);
	});
	it("keeps a transient security failure retryable", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": Response.json({ message: "upstream detail" }, { status: 500 }),
			"/code-scanning/alerts": [],
		});
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 4,
			requestBreakdown: { graphql: 1, rest: 3 },
			partial: true,
			reasons: ["alerts:github_error"],
		});
		expect(await day(context, "alerts")).toMatchObject({
			status: "partial",
			payload: { unavailable: false },
		});
		upstream([], { "/dependabot/alerts": [], "/code-scanning/alerts": [] });
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 2,
			requestBreakdown: { graphql: 0, rest: 2 },
			partial: false,
			reasons: [],
		});
		expect((await day(context, "alerts")).status).toBe("complete");
	});
	it("does not cache a rate-limited security day", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": Response.json({ message: "rate limit" }, { status: 429 }),
		});
		await collectAccount(context);
		await expect(collectRepository(context, "owner/project")).rejects.toMatchObject({
			code: "github_rate_limited",
		});
		expect(await day(context, "alerts")).toMatchObject({
			status: "unavailable",
			payload: { unavailable: false },
		});
		upstream([], { "/dependabot/alerts": [], "/code-scanning/alerts": [] });
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 2,
			requestBreakdown: { graphql: 0, rest: 2 },
			partial: false,
			reasons: [],
		});
		expect((await day(context, "alerts")).status).toBe("complete");
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
	it("reads catalogue, day observations and prior publication in one D1 batch", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": Response.json({ message: "no analysis found" }, { status: 404 }),
		});
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		const counted = countedD1(context.env.DB);
		context.env = { ...context.env, DB: counted.db };
		const fetch = upstream();
		expect(await collectRepository(context, "owner/project")).toMatchObject({ requests: 0 });
		expect(fetch).not.toHaveBeenCalled();
		expect(counted.roundtrips).toHaveLength(3);
		const [preparation] = counted.roundtrips;
		expect(preparation).toHaveLength(3);
		expect(preparation?.[0]).toContain("refresh_catalog");
		expect(preparation?.[1]).toContain("refresh_day_observations");
		expect(preparation?.[2]).toContain("refresh_repository_publications");
	});
	it("keeps a forced repository preparation to one D1 read batch", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": [],
		});
		await collectAccount(context);
		await collectRepository(context, "owner/project");
		context.run.params.force = true;
		const counted = countedD1(context.env.DB);
		context.env = { ...context.env, DB: counted.db };
		upstream([{ node: repository() }], { "/dependabot/alerts": [], "/code-scanning/alerts": [] });
		expect(await collectRepository(context, "owner/project")).toMatchObject({ requests: 3 });
		expect(counted.roundtrips).toHaveLength(3);
		expect(counted.roundtrips[0]).toHaveLength(3);
		expect(counted.roundtrips[1]).not.toHaveLength(3);
	});
	it("joins cached evidence by catalogue identity for case-variant names", async () => {
		const context = await fixture();
		context.run.params.dimensions = ["alerts"];
		upstream([accountPage(), { node: repository() }], {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": [],
		});
		await collectAccount(context);
		expect(await collectRepository(context, "OWNER/Project")).toMatchObject({ partial: false });
		expect((await publication(context)).repos[0]).toMatchObject({
			id: "R_1",
			name: "owner/project",
		});
		const observations = await context.env.DB.prepare(
			"SELECT repo_id,COUNT(*) AS rows FROM refresh_day_observations GROUP BY repo_id",
		).all<{ repo_id: string; rows: number }>();
		expect(observations.results).toEqual([{ repo_id: "R_1", rows: 1 }]);
		const fetch = upstream();
		expect(await collectRepository(context, "owner/PROJECT")).toMatchObject({ requests: 0 });
		expect(fetch).not.toHaveBeenCalled();
		await context.env.DB.prepare("UPDATE refresh_catalog SET active=0 WHERE account_id='a'").run();
		await expect(collectRepository(context, "owner/project")).rejects.toMatchObject({
			status: 404,
			code: "not_found",
		});
	});
});

describe("90-day lookback cache reuse", () => {
	it("caches every day×dimension of a fresh starred lookback and reuses all of it", async () => {
		const context = await lookbackFixture(["commits", "issues", "releases"]);
		expect(context.days).toHaveLength(LOOKBACK_DAYS);
		const fetch = upstream([accountPage(), repositoryNode(LOOKBACK_DAYS)]);
		expect((await collectAccount(context)).repos).toEqual(["owner/project"]);
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
		});
		expect(historyAliases(graphqlRequests(fetch)[1]?.query ?? "")).toHaveLength(LOOKBACK_DAYS);
		const cached = await observationRows(context);
		expect(cached).toHaveLength(LOOKBACK_DAYS * 3);
		expect(cached.every((row) => row.fetched_at === now)).toBe(true);
		expect(cached.every((row) => row.status === "complete")).toBe(true);
		const coverage = (await publication(context)).repos[0].coverage;
		expect(coverage.commits).toMatchObject({
			status: "complete",
			observed: LOOKBACK_DAYS,
			strategy: "incremental",
		});
		expect(coverage.commits.completeWindows).toEqual(contiguousSpan(context.days));
		expect(coverage.issues).toMatchObject({
			status: "complete",
			observed: LOOKBACK_DAYS,
			strategy: "incremental",
		});
		expect(coverage.issues.completeWindows).toEqual(contiguousSpan(context.days));
		expect(coverage.releases).toMatchObject({
			status: "complete",
			observed: LOOKBACK_DAYS,
			strategy: "incremental",
		});
		expect(coverage.releases.completeWindows).toEqual(contiguousSpan(context.days));
		const replay = upstream();
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 0,
			requestBreakdown: { graphql: 0, rest: 0 },
			partial: false,
			reasons: [],
		});
		expect(replay).not.toHaveBeenCalled();
		expect(await observationRows(context)).toEqual(cached);
	});
	it("collects only missing day×dimension observations, preserves cached ones and force recollects", async () => {
		const context = await lookbackFixture(["commits", "releases", "alerts"]);
		const unavailableAlerts = {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": Response.json({ message: "no analysis found" }, { status: 404 }),
		};
		upstream([accountPage(), repositoryNode(LOOKBACK_DAYS)], unavailableAlerts);
		await collectAccount(context);
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 1, rest: 2 },
			partial: false,
			reasons: [],
		});
		expect(await observationRows(context)).toHaveLength(LOOKBACK_DAYS * 3);
		const seeded = "2026-10-20T00:00:00.000Z";
		const missingDays = ["2026-08-15", "2026-09-01", "2026-10-01"];
		await context.env.DB.batch([
			context.env.DB.prepare(
				"UPDATE refresh_day_observations SET fetched_at=? WHERE account_id=?",
			).bind(seeded, context.account.id),
			...missingDays.map((day) =>
				context.env.DB.prepare(
					"DELETE FROM refresh_day_observations WHERE account_id=? AND dimension='commits' AND day=?",
				).bind(context.account.id, day),
			),
		]);
		const preserved = await observationRows(context);
		expect(preserved).toHaveLength(LOOKBACK_DAYS * 3 - missingDays.length);
		context.now = "2026-10-29T09:00:00.000Z";
		const fetch = upstream([repositoryNode(missingDays.length)]);
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 1,
			requestBreakdown: { graphql: 1, rest: 0 },
			partial: false,
			reasons: [],
		});
		const requests = graphqlRequests(fetch);
		expect(requests).toHaveLength(1);
		expect(historyAliases(requests[0]?.query ?? "")).toHaveLength(missingDays.length);
		const expectedDays = context.days.filter((day) => missingDays.includes(day.date));
		expect(requests[0]?.variables).toEqual({
			id: "R_1",
			...Object.fromEntries(
				expectedDays.flatMap((day, index) => [
					[`since${index}`, day.since],
					[`until${index}`, new Date(Date.parse(day.until) - 1).toISOString()],
				]),
			),
		});
		const after = await observationRows(context);
		expect(after).toHaveLength(LOOKBACK_DAYS * 3);
		expect(
			after
				.filter((row) => row.fetched_at === context.now)
				.map((row) => `${row.dimension}:${row.day}`)
				.sort(),
		).toEqual(missingDays.map((day) => `commits:${day}`).sort());
		expect(after.filter((row) => row.fetched_at === seeded)).toEqual(preserved);
		const coverage = (await publication(context)).repos[0].coverage;
		expect(coverage.commits).toMatchObject({
			status: "complete",
			observed: LOOKBACK_DAYS,
			fetchedAt: seeded,
			strategy: "incremental",
		});
		expect(coverage.commits.completeWindows).toEqual(contiguousSpan(context.days));
		expect(coverage.releases).toMatchObject({
			status: "complete",
			observed: LOOKBACK_DAYS,
			fetchedAt: seeded,
			strategy: "reused",
		});
		expect(coverage.releases.completeWindows).toEqual(contiguousSpan(context.days));
		expect(coverage.alerts).toMatchObject({
			status: "unavailable",
			observed: 0,
			reason: "not_found",
			fetchedAt: seeded,
			strategy: "reused",
		});
		expect(coverage.alerts.completeWindows).toEqual(contiguousSpan(context.days));
		const replay = upstream();
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 0,
			requestBreakdown: { graphql: 0, rest: 0 },
			partial: false,
			reasons: [],
		});
		expect(replay).not.toHaveBeenCalled();
		expect(await observationRows(context)).toEqual(after);
		context.run.params.force = true;
		context.now = "2026-10-29T10:00:00.000Z";
		const forced = upstream([repositoryNode(LOOKBACK_DAYS)], unavailableAlerts);
		expect(await collectRepository(context, "owner/project")).toEqual({
			requests: 3,
			requestBreakdown: { graphql: 1, rest: 2 },
			partial: false,
			reasons: [],
		});
		expect(historyAliases(graphqlRequests(forced)[0]?.query ?? "")).toHaveLength(LOOKBACK_DAYS);
		expect(restCalls(forced)).toBe(2);
		const recollected = await observationRows(context);
		expect(recollected).toHaveLength(LOOKBACK_DAYS * 3);
		expect(recollected.every((row) => row.fetched_at === context.now)).toBe(true);
		expect(
			recollected.filter((row) => row.dimension === "alerts").map((row) => row.payload),
		).toEqual(after.filter((row) => row.dimension === "alerts").map((row) => row.payload));
	});
});
