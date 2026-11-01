import { afterEach, describe, expect, it, vi } from "vitest";
import { annualContributionCalendar } from "../../../../../../tests/fixtures/contribution-calendar";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import type { CollectionContext } from "../refresh-collection-contract";
import { collectAccount, collectRepository } from "./index";

const now = "2026-10-29T04:00:00.000Z";
const later = "2026-10-30T04:00:00.000Z";
const names = ["owner/alpha", "owner/beta"] as const;

const repository = (name: string, index: number) => ({
	id: `R_${index}`,
	nameWithOwner: name,
	name: name.split("/")[1],
	url: `https://github.com/${name}`,
	description: "saved metadata",
	owner: { login: "owner" },
	isPrivate: false,
	isFork: false,
	createdAt: "2026-10-29T02:00:00Z",
	primaryLanguage: { name: "TypeScript" },
	defaultBranchRef: {
		name: "main",
		target: { oid: "head", history: { totalCount: 20 }, day0: { totalCount: 1 } },
	},
	issues: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
	pullRequests: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
	openIssues: { totalCount: 0 },
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
const accountPage = () => ({
	viewer: {
		login: "owner",
		avatarUrl: "avatar",
		repositories: {
			nodes: names.map((name, index) => repository(name, index)),
			totalCount: names.length,
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
				dimensions: ["alerts"],
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
			if (data === undefined) throw new Error("Unexpected GraphQL request");
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
const terminalAlerts = {
	"/dependabot/alerts": Response.json({ message: "Not Found" }, { status: 404 }),
	"/code-scanning/alerts": Response.json({ message: "no analysis found" }, { status: 404 }),
};
async function alertRows(context: CollectionContext) {
	return (
		await context.env.DB.prepare(
			"SELECT repo_id,day,status,payload,fetched_at FROM refresh_day_observations WHERE account_id=? AND dimension='alerts' ORDER BY repo_id,day",
		)
			.bind(context.account.id)
			.all<{ repo_id: string; day: string; status: string; payload: string; fetched_at: string }>()
	).results.map((row) => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

describe("multi-repository terminal alert reuse", () => {
	it("reuses cached terminal alert days for every repository but refetches a newly requested day", async () => {
		const context = await fixture();
		upstream([accountPage()]);
		expect((await collectAccount(context)).repos).toEqual([...names]);

		upstream(
			names.map((name, index) => ({ node: repository(name, index) })),
			terminalAlerts,
		);
		for (const name of names)
			expect(await collectRepository(context, name)).toMatchObject({
				requests: 3,
				requestBreakdown: { graphql: 1, rest: 2 },
				partial: false,
				reasons: [],
			});
		const first = await alertRows(context);
		expect(first).toHaveLength(names.length);
		expect(first.map((row) => [row.repo_id, row.day, row.status])).toEqual([
			["R_0", "2026-10-28", "complete"],
			["R_1", "2026-10-28", "complete"],
		]);
		expect(first.map((row) => row.payload.unavailable)).toEqual([true, true]);

		const replay = upstream();
		for (const name of names)
			expect(await collectRepository(context, name)).toMatchObject({
				requests: 0,
				requestBreakdown: { graphql: 0, rest: 0 },
				partial: false,
				reasons: [],
			});
		expect(replay).not.toHaveBeenCalled();
		expect(await alertRows(context)).toEqual(first);

		context.now = later;
		context.days = [
			...context.days,
			{ date: "2026-10-29", since: "2026-10-28T16:00:00.000Z", until: "2026-10-29T16:00:00.000Z" },
		];
		const extended = upstream([], terminalAlerts);
		for (const name of names)
			expect(await collectRepository(context, name)).toMatchObject({
				requests: 2,
				requestBreakdown: { graphql: 0, rest: 2 },
				partial: false,
				reasons: [],
			});
		expect(graphqlCalls(extended)).toBe(0);
		expect(restCalls(extended)).toBe(names.length * 2);
		const extendedRows = await alertRows(context);
		expect(extendedRows).toHaveLength(names.length * 2);
		expect(extendedRows.filter((row) => row.day === "2026-10-28")).toEqual(first);
		expect(
			extendedRows
				.filter((row) => row.day === "2026-10-29")
				.map((row) => [row.status, row.fetched_at, row.payload.reason]),
		).toEqual([
			["complete", later, "not_found"],
			["complete", later, "not_found"],
		]);

		const settled = upstream();
		for (const name of names)
			expect(await collectRepository(context, name)).toMatchObject({ requests: 0 });
		expect(settled).not.toHaveBeenCalled();
	});

	it("keeps permission-denied alerts retryable while terminal 404 days stay cached", async () => {
		const context = await fixture();
		upstream([accountPage()]);
		await collectAccount(context);
		const denied = {
			"/dependabot/alerts": [],
			"/code-scanning/alerts": Response.json(
				{ message: "Resource not accessible by personal access token" },
				{ status: 403 },
			),
		};
		upstream([{ node: repository(names[0], 0) }], denied);
		expect(await collectRepository(context, names[0])).toMatchObject({
			requests: 3,
			requestBreakdown: { graphql: 1, rest: 2 },
			partial: true,
			reasons: ["alerts:permission_denied"],
		});
		expect(await alertRows(context)).toMatchObject([
			{ repo_id: "R_0", day: "2026-10-28", status: "unavailable" },
		]);

		const retry = upstream([], denied);
		expect(await collectRepository(context, names[0])).toMatchObject({
			requests: 2,
			requestBreakdown: { graphql: 0, rest: 2 },
			partial: true,
			reasons: ["alerts:permission_denied"],
		});
		expect(restCalls(retry)).toBe(2);
		expect((await alertRows(context))[0]?.status).toBe("unavailable");
	});
});
