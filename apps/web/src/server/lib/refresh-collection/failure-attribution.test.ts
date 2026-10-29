import { afterEach, expect, it, vi } from "vitest";
import { annualContributionCalendar } from "../../../../../../tests/fixtures/contribution-calendar";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import { ApiError } from "../errors";
import type { CollectionContext } from "../refresh-collection-contract";
import { collectAccount, collectRepository } from "./index";
import { dimensionOfGraphqlPath, transportFailure } from "./transport";

const now = "2026-10-29T04:00:00.000Z";
const repo = () => ({
	id: "R_1",
	nameWithOwner: "owner/project",
	name: "project",
	url: "https://github.com/owner/project",
	owner: { login: "owner" },
	isPrivate: false,
	isFork: false,
	createdAt: "2026-10-29T02:00:00Z",
	primaryLanguage: { name: "TypeScript" },
	defaultBranchRef: {
		name: "main",
		target: { oid: "head", history: { totalCount: 20 }, day0: { totalCount: 3 } },
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
		repositories: { nodes: [repo()], totalCount: 1, pageInfo: { hasNextPage: false } },
		contributionsCollection: {
			restrictedContributionsCount: 0,
			contributionCalendar: annualContributionCalendar(now).calendar,
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
				dimensions: ["commits", "actions", "releases", "alerts"],
				force: false,
			},
			requests: 0,
			createdAt: now,
		},
	} as unknown as CollectionContext;
}
function capture(context: CollectionContext) {
	const seen: Parameters<NonNullable<CollectionContext["onFailures"]>>[0] = [];
	context.onFailures = (failures) => seen.push(...failures);
	return seen;
}
function upstream(graphql: unknown[], rest: Record<string, Response> = {}) {
	const fetch = vi.fn(async (input: string) => {
		if (input.endsWith("/graphql")) {
			const data = graphql.shift();
			if (data instanceof Response) return data.clone();
			return Response.json({ data });
		}
		for (const [suffix, response] of Object.entries(rest))
			if (input.includes(suffix)) return response.clone();
		return Response.json([]);
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
afterEach(() => vi.unstubAllGlobals());
const rateLimited = () =>
	Response.json(
		{ message: "API rate limit exceeded for owner/project" },
		{ status: 429, headers: { "retry-after": "120" } },
	);
const unauthorized = () =>
	Response.json({ message: "Bad credentials for owner/project" }, { status: 401 });

it.each(["network", "invalid-json"])(
	"records actual HTTP metadata for %s failures",
	async (mode) => {
		const context = await fixture();
		context.run.params.dimensions = ["actions"];
		const fetch = upstream([accountPage(), { node: repo() }]);
		const implementation = fetch.getMockImplementation();
		if (!implementation) throw new Error("missing mock implementation");
		fetch.mockImplementation(async (input) => {
			if (input.includes("/actions/runs")) {
				if (mode === "network") throw new TypeError("fetch failed");
				return new Response("not json", { status: 200 });
			}
			return implementation(input);
		});
		await collectAccount(context);
		const seen = capture(context);
		await collectRepository(context, "owner/project");
		expect(seen).toContainEqual({
			dimension: "actions",
			code: "github_error",
			httpStatus: mode === "network" ? null : 200,
			graphqlType: null,
			graphqlPath: null,
		});
		expect(fetch.mock.calls.filter(([input]) => input.includes("/actions/runs"))).toHaveLength(2);
	},
);

it("keeps the known actions dimension on a terminal REST rate limit", async () => {
	const context = await fixture();
	context.run.params.dimensions = ["actions"];
	upstream([accountPage(), { node: repo() }], { "/actions/runs": rateLimited() });
	await collectAccount(context);
	const failure = await collectRepository(context, "owner/project").catch((error) => error);
	expect(failure).toBeInstanceOf(ApiError);
	expect(failure.code).toBe("github_rate_limited");
	expect(Date.parse(failure.retryAt) - Date.now()).toBeGreaterThan(110_000);
	expect(transportFailure(failure)).toEqual({
		dimension: "actions",
		code: "github_rate_limited",
		httpStatus: 429,
		graphqlType: null,
		graphqlPath: null,
	});
	expect(JSON.stringify(transportFailure(failure))).not.toContain("rate limit exceeded");
});

it("keeps the known actions dimension on a terminal REST authorization failure", async () => {
	const context = await fixture();
	context.run.params.dimensions = ["actions"];
	upstream([accountPage(), { node: repo() }], { "/actions/runs": unauthorized() });
	await collectAccount(context);
	const failure = await collectRepository(context, "owner/project").catch((error) => error);
	expect(failure).toBeInstanceOf(ApiError);
	expect(transportFailure(failure)).toEqual({
		dimension: "actions",
		code: "github_unauthorized",
		httpStatus: 401,
		graphqlType: null,
		graphqlPath: null,
	});
	expect(JSON.stringify(transportFailure(failure))).not.toContain("Bad credentials");
});

it("reports terminal REST failures through onFailures before rethrowing", async () => {
	const context = await fixture();
	context.run.params.dimensions = ["actions", "alerts"];
	upstream([accountPage(), { node: repo() }], { "/actions/runs": rateLimited() });
	await collectAccount(context);
	const seen = capture(context);
	await expect(collectRepository(context, "owner/project")).rejects.toBeInstanceOf(ApiError);
	expect(seen).toContainEqual({
		dimension: "actions",
		code: "github_rate_limited",
		httpStatus: 429,
		graphqlType: null,
		graphqlPath: null,
	});
});

it("attributes dimension failures with safe http status and graphql type", async () => {
	const context = await fixture();
	upstream([accountPage(), { node: repo() }], {
		"/actions/runs": Response.json({ message: "upstream secret detail" }, { status: 500 }),
		"/dependabot/alerts": Response.json(
			{ message: "Dependabot alerts are disabled" },
			{ status: 403 },
		),
		"/code-scanning/alerts": Response.json({ message: "Requires permission" }, { status: 403 }),
	});
	await collectAccount(context);
	const seen = capture(context);
	const result = await collectRepository(context, "owner/project");
	expect(result.partial).toBe(true);
	expect(seen).toEqual([
		{
			dimension: "actions",
			code: "github_error",
			httpStatus: 500,
			graphqlType: null,
			graphqlPath: null,
		},
		{
			dimension: "alerts",
			code: "alerts_disabled",
			httpStatus: 403,
			graphqlType: null,
			graphqlPath: null,
		},
		{
			dimension: "alerts",
			code: "permission_denied",
			httpStatus: 403,
			graphqlType: null,
			graphqlPath: null,
		},
	]);
	expect(JSON.stringify(seen)).not.toContain("upstream secret detail");
	expect(JSON.stringify(seen)).not.toContain("Requires permission");
});

it("attributes partial graphql errors to the affected dimensions", async () => {
	const context = await fixture();
	context.run.params.dimensions = ["releases"];
	upstream([
		accountPage(),
		Response.json({
			data: {
				node: {
					...repo(),
					releases: {
						totalCount: 1,
						pageInfo: { hasNextPage: false },
						nodes: [
							{
								id: "RE_1",
								databaseId: 1,
								name: "release 1",
								tagName: "v1",
								url: "https://github.com/owner/project/releases/1",
								isDraft: false,
								isPrerelease: false,
								publishedAt: "2026-10-28T04:00:00Z",
								createdAt: "2026-10-28T04:00:00Z",
								updatedAt: "2026-10-28T04:00:00Z",
							},
						],
					},
				},
			},
			errors: [{ type: "FORBIDDEN", path: ["node", "releases", "nodes", 0, "name"] }],
		}),
	]);
	await collectAccount(context);
	const seen = capture(context);
	const result = await collectRepository(context, "owner/project");
	expect(result.reasons).toEqual(["releases:graphql_partial"]);
	expect(seen).toEqual([
		{
			dimension: "releases",
			code: "graphql_partial",
			httpStatus: null,
			graphqlType: "FORBIDDEN",
			graphqlPath: ["node", "releases", "nodes", "0", "name"],
		},
	]);
});

it("does not attribute a later REST failure to an earlier GraphQL error", async () => {
	const context = await fixture();
	context.run.params.dimensions = ["releases", "actions"];
	upstream(
		[
			accountPage(),
			Response.json({
				data: { node: repo() },
				errors: [{ type: "FORBIDDEN", path: ["node", "releases"] }],
			}),
		],
		{ "/actions/runs": Response.json({ message: "unavailable" }, { status: 500 }) },
	);
	await collectAccount(context);
	const seen = capture(context);
	expect((await collectRepository(context, "owner/project")).partial).toBe(true);
	expect(seen).toContainEqual({
		dimension: "actions",
		code: "github_error",
		httpStatus: 500,
		graphqlType: null,
		graphqlPath: null,
	});
	expect(
		seen.some((failure) => failure.httpStatus === 500 && failure.dimension === "releases"),
	).toBe(false);
});

it("keeps attacker-controlled graphql type and path out of the failure metadata", async () => {
	const context = await fixture();
	context.run.params.dimensions = ["releases"];
	upstream([
		accountPage(),
		Response.json({
			data: {
				node: {
					...repo(),
					releases: { totalCount: 0, pageInfo: { hasNextPage: false }, nodes: [] },
				},
			},
			errors: [
				{
					type: "FORBIDDEN",
					path: ["node", "releases", "ghp_SuperSecretTokenValue", 0, "name"],
				},
			],
		}),
	]);
	await collectAccount(context);
	const seen = capture(context);
	await collectRepository(context, "owner/project");
	expect(seen).toEqual([
		{
			dimension: "releases",
			code: "graphql_partial",
			httpStatus: null,
			graphqlType: "FORBIDDEN",
			graphqlPath: ["node", "releases", "@", "0", "name"],
		},
	]);
	expect(JSON.stringify(seen)).not.toContain("ghp_SuperSecretTokenValue");
});

it("replaces unknown graphql error types with a known marker", async () => {
	const context = await fixture();
	context.run.params.dimensions = ["releases"];
	upstream([
		accountPage(),
		Response.json({
			data: null,
			errors: [{ type: "ghp_SuperSecretTokenValue", path: ["node", "ghp_SuperSecretTokenValue"] }],
		}),
	]);
	await collectAccount(context);
	const failure = await collectRepository(context, "owner/project").catch((error) => error);
	expect(transportFailure(failure)).toEqual({
		dimension: null,
		code: "github_error",
		httpStatus: 200,
		graphqlType: "UNKNOWN",
		graphqlPath: ["node", "@"],
	});
	expect(JSON.stringify(transportFailure(failure))).not.toContain("ghp_SuperSecretTokenValue");
});

it("reports no failures for complete dimensions", async () => {
	const context = await fixture();
	context.run.params.dimensions = ["commits", "releases"];
	upstream([accountPage(), { node: repo() }]);
	await collectAccount(context);
	const seen = capture(context);
	const result = await collectRepository(context, "owner/project");
	expect(result.partial).toBe(false);
	expect(seen).toEqual([]);
});

it("maps graphql error paths to refresh dimensions without guessing", () => {
	expect(dimensionOfGraphqlPath(["viewer", "repositories", "nodes"])).toBe("catalog");
	expect(
		dimensionOfGraphqlPath(["viewer", "contributionsCollection", "contributionCalendar"]),
	).toBe("contributions");
	expect(dimensionOfGraphqlPath(["node", "defaultBranchRef", "target"])).toBe("commits");
	expect(dimensionOfGraphqlPath(["node", "day1", "totalCount"])).toBe("commits");
	expect(dimensionOfGraphqlPath(["node", "openIssues", "totalCount"])).toBe(null);
	expect(transportFailure(null)).toBeNull();
	expect(transportFailure("boom")).toBeNull();
	expect(transportFailure(new Error("plain"))).toBeNull();
});
