import { afterEach, expect, it, vi } from "vitest";
import { annualContributionCalendar } from "../../../../../../tests/fixtures/contribution-calendar";
import { sqliteFixture } from "../../../../../../tests/fixtures/sqlite";
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
function upstream(responses: unknown[]) {
	const fetch = vi.fn(async (input: string) => {
		if (input.endsWith("/graphql")) return Response.json({ data: responses.shift() });
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
		"SELECT payload FROM refresh_publications WHERE account_id='a'",
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
