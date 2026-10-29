import { afterEach, expect, it, vi } from "vitest";
import { annualContributionCalendar } from "../../../../../../tests/fixtures/contribution-calendar";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
import type { FactoryViewSnapshot } from "../../../lib/factory-types";
import type { Env } from "../../env";
import { createApp } from "../../index";
import { createDb } from "../db/d1";
import { readFactoryResource } from "../machine-observations";
import { readSources } from "../machine-sources";
import type { CollectionContext } from "../refresh-collection-contract";
import { parseRefreshParams, refreshDays } from "../refresh-params";
import { collectAccount, collectRepository } from "./index";
import { windowOf } from "./model";

const accountAt = "2026-10-29T04:00:00.000Z";
const repoAt = "2026-10-29T05:00:00.000Z";
const accountInput = {
	since: "2026-10-28",
	until: "2026-10-28",
	timezone: "Asia/Shanghai",
	dimensions: ["commits"],
};
const repoInput = {
	since: "2026-10-20",
	until: "2026-10-21",
	timezone: "America/New_York",
	dimensions: ["releases"],
	repo: "owner/project",
};
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
			contributionCalendar: annualContributionCalendar(accountAt).calendar,
		},
	},
	rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
});
async function fixture(
	db: D1Database,
	id: string,
	input: unknown,
	now: string,
): Promise<CollectionContext> {
	const params = parseRefreshParams(input, new Date(now));
	await db
		.prepare(
			"INSERT INTO accounts(id,login,avatar_url,token_ciphertext,token_last4,key_version,scopes,capabilities,is_active,created_at,updated_at) VALUES('a','owner','','encrypted','test',1,'','{}',1,?,?) ON CONFLICT(id) DO NOTHING",
		)
		.bind(accountAt, accountAt)
		.run();
	return {
		env: { DB: db, ENVIRONMENT: "test", GITHUB_API_BASE: "http://github.test" },
		account: { id: "a", login: "owner" },
		token: "memory-only-fake-token",
		now,
		days: refreshDays(params),
		run: { id, accountId: "a", params, requests: 0, createdAt: now },
	} as unknown as CollectionContext;
}
function upstream(responses: unknown[], alerts: unknown[] | Response = []) {
	const fetch = vi.fn(async (input: string) => {
		if (input.endsWith("/graphql")) return Response.json({ data: responses.shift() });
		if (input.includes("/dependabot/alerts"))
			return alerts instanceof Response ? alerts.clone() : Response.json(alerts);
		return Response.json([]);
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
const payload = async (db: D1Database, sql: string) => {
	const row = await db.prepare(sql).first<{ payload: string }>();
	if (!row) throw new Error(`missing row: ${sql}`);
	return JSON.parse(row.payload) as Record<string, unknown>;
};
afterEach(() => vi.unstubAllGlobals());

it("publishes the requested window when a saved account observation is reused", async () => {
	const db = sqliteFixture();
	const fetch = upstream([accountPage(), { node: repo() }]);
	const saved = await fixture(db, "run-a", accountInput, accountAt);
	await collectAccount(saved);
	const beforeRepo = await payload(db, "SELECT payload FROM refresh_accounts WHERE account_id='a'");
	const current = await fixture(db, "run-b", repoInput, repoAt);
	const result = await collectRepository(current, "owner/project");
	expect(result.partial).toBe(false);
	expect(windowOf(current)).not.toEqual(windowOf(saved));
	const publication = await payload(
		db,
		"SELECT payload FROM refresh_snapshots WHERE account_id='a' AND kind='factory'",
	);
	expect(publication.window).toEqual(windowOf(current));
	expect(publication.runId).toBe("run-b");
	const factory = await payload(
		db,
		"SELECT payload FROM refresh_snapshots WHERE account_id='a' AND kind='factory'",
	);
	expect(factory.window).toEqual(windowOf(current));
	const afterRepo = await payload(db, "SELECT payload FROM refresh_accounts WHERE account_id='a'");
	expect(afterRepo.window).toEqual(windowOf(saved));
	expect(afterRepo.fetched_at).toBe(beforeRepo.fetched_at);
	expect(afterRepo.contributionObservation).toEqual(beforeRepo.contributionObservation);
	expect(afterRepo.contribution).toEqual(beforeRepo.contribution);
	const requested = fetch.mock.calls.map(([input]) => String(input));
	expect(requested.some((url) => url.includes("/activity"))).toBe(false);
});

it("keeps cached history and other dimensions visible through the factory API after a daily run", async () => {
	const db = sqliteFixture();
	const historical = repo();
	Object.assign(historical.defaultBranchRef.target, {
		day1: { totalCount: 4 },
		day2: { totalCount: 5 },
	});
	upstream([accountPage(), { node: historical }]);
	const backfill = await fixture(
		db,
		"backfill",
		{ lookbackDays: 3, dimensions: ["commits", "releases"] },
		accountAt,
	);
	await collectAccount(backfill);
	await collectRepository(backfill, "owner/project");
	const daily = await fixture(db, "daily", { dimensions: ["commits"] }, "2026-10-30T04:00:00.000Z");
	upstream([{ node: repo() }]);
	expect(await collectRepository(daily, "owner/project")).toMatchObject({ partial: false });
	const fetch = upstream([]);
	const response = await createApp().request("http://localhost/api/factory?scope=all", {}, {
		...daily.env,
		ENVIRONMENT: "development",
	} as Env);
	expect(response.status).toBe(200);
	const body = (await response.json()) as FactoryViewSnapshot;
	const published = body.repos[0];
	expect(Object.keys(published?.metrics.days ?? {})).toEqual([
		"2026-10-26",
		"2026-10-27",
		"2026-10-28",
		"2026-10-29",
	]);
	expect(published?.metrics.commits).toBe(15);
	expect(published?.coverage.commits.completeWindows).toEqual([
		{
			since: "2026-10-25T16:00:00.000Z",
			until: "2026-10-29T15:59:59.999Z",
			timezone: "Asia/Shanghai",
		},
	]);
	expect(published?.coverage.releases).toMatchObject({
		status: "partial",
		fetchedAt: accountAt,
		completeWindows: [windowOf(backfill)],
	});
	expect(
		await payload(db, "SELECT payload FROM refresh_resources WHERE stream='releases'"),
	).toMatchObject({ runId: "daily", ranges: [windowOf(backfill)] });
	expect(fetch).not.toHaveBeenCalled();
	const reused = await fixture(db, "reuse", { dimensions: ["commits"] }, daily.now);
	expect(await collectRepository(reused, "owner/project")).toMatchObject({
		requests: 0,
		partial: false,
	});
	expect(fetch).not.toHaveBeenCalled();
});

it.each(["partial", "unavailable"])(
	"preserves historical %s gaps without marking a complete daily run partial",
	async (status) => {
		const db = sqliteFixture();
		const historical = repo();
		Object.assign(historical.defaultBranchRef.target, { day1: { totalCount: 4 } });
		upstream([accountPage(), { node: historical }]);
		const backfill = await fixture(
			db,
			"backfill",
			{ lookbackDays: 2, dimensions: ["commits"] },
			accountAt,
		);
		await collectAccount(backfill);
		await collectRepository(backfill, "owner/project");
		await db
			.prepare("UPDATE refresh_day_observations SET status=? WHERE day='2026-10-28'")
			.bind(status)
			.run();
		const daily = await fixture(
			db,
			"daily",
			{ dimensions: ["commits"] },
			"2026-10-30T04:00:00.000Z",
		);
		upstream([{ node: repo() }]);
		expect(await collectRepository(daily, "owner/project")).toMatchObject({
			partial: false,
			reasons: [],
		});
		const saved = await payload(db, "SELECT payload FROM refresh_repository_publications");
		expect(saved.coverage).toMatchObject({
			commits: {
				status: "partial",
				observed: 2,
				reason: "missing_days",
				fetchedAt: accountAt,
				completeWindows: [
					{
						since: "2026-10-26T16:00:00.000Z",
						until: "2026-10-27T15:59:59.999Z",
						timezone: "Asia/Shanghai",
					},
					windowOf(daily),
				],
			},
		});
		expect(saved.metrics).toMatchObject({ commits: 6 });
		const metrics = saved.metrics as { days: Record<string, unknown> };
		expect(metrics.days["2026-10-28"]).toBeUndefined();
	},
);

it("keeps resolved alerts out of current totals and details across cached daily replay", async () => {
	const db = sqliteFixture();
	const first = await fixture(db, "first", { dimensions: ["alerts"] }, accountAt);
	upstream(
		[accountPage(), { node: repo() }],
		[
			{
				number: 1,
				state: "open",
				created_at: "2026-10-28T03:00:00Z",
				html_url: "https://github.com/owner/project/security/1",
				security_advisory: { summary: "Resolved tomorrow", severity: "high" },
			},
		],
	);
	await collectAccount(first);
	await collectRepository(first, "owner/project");
	const daily = await fixture(db, "daily", { dimensions: ["alerts"] }, "2026-10-30T04:00:00.000Z");
	upstream([]);
	await collectRepository(daily, "owner/project");
	expect(
		await payload(db, "SELECT payload FROM refresh_resources WHERE stream='alerts'"),
	).toMatchObject({ items: [] });
	const fetch = upstream([]);
	expect(await collectRepository(daily, "owner/project")).toMatchObject({ requests: 0 });
	expect(await payload(db, "SELECT payload FROM refresh_repository_publications")).toMatchObject({
		metrics: { alerts: 0 },
	});
	expect(fetch).not.toHaveBeenCalled();
	const missing = await fixture(
		db,
		"missing",
		{ dimensions: ["alerts"] },
		"2026-10-31T04:00:00.000Z",
	);
	upstream([], Response.json({ message: "Not Found" }, { status: 404 }));
	await collectRepository(missing, "owner/project");
	expect(
		await payload(db, "SELECT payload FROM refresh_resources WHERE stream='alerts'"),
	).toMatchObject({ items: [], coverage: { status: "unavailable" } });
});

it("preserves both oldest history and latest source times without renewing cached evidence", async () => {
	const db = sqliteFixture();
	const first = await fixture(db, "first", { dimensions: ["commits", "releases"] }, accountAt);
	upstream([accountPage(), { node: repo() }]);
	await collectAccount(first);
	await collectRepository(first, "owner/project");
	const daily = await fixture(
		db,
		"daily",
		{ dimensions: ["commits", "releases"] },
		"2026-10-30T04:00:00.000Z",
	);
	upstream([{ node: repo() }]);
	await collectRepository(daily, "owner/project");
	const response = await createApp().request("http://localhost/api/factory?scope=all", {}, {
		...daily.env,
		ENVIRONMENT: "development",
	} as Env);
	const saved = (await response.json()) as FactoryViewSnapshot;
	expect(saved.repos[0]?.observation?.refreshedAt).toBe(daily.now);
	expect(saved.freshness).toMatchObject({ oldestAt: accountAt, latestAt: daily.now });
	const detail = await readFactoryResource(createDb(db), "a", "owner/project", "commits");
	const source = (await readSources(createDb(db), "a", {})).sources.find(
		(entry) => entry.resource === "factory:owner/project:commits",
	);
	const freshness = { oldestAt: accountAt, latestAt: daily.now, total: 1, missing: 0 };
	expect(detail.freshness).toEqual(freshness);
	expect(source?.freshness).toEqual(freshness);
	const replay = { ...daily, now: "2026-10-30T05:00:00.000Z" };
	const fetch = upstream([]);
	await collectRepository(replay, "owner/project");
	expect(await payload(db, "SELECT payload FROM refresh_repository_publications")).toMatchObject({
		observation: { refreshedAt: daily.now },
	});
	expect(fetch).not.toHaveBeenCalled();
});
