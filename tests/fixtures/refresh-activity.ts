import { vi } from "vitest";
import type { Env } from "../../apps/web/src/server/env";
import { getAccount } from "../../apps/web/src/server/lib/db/accounts";
import { createDb } from "../../apps/web/src/server/lib/db/d1";
import {
	collectAccount,
	collectRepository,
} from "../../apps/web/src/server/lib/refresh-collection";
import type { CollectionContext } from "../../apps/web/src/server/lib/refresh-collection-contract";
import { sqliteFixture } from "./sqlite";

export async function refreshActivityFixture() {
	const raw = sqliteFixture();
	const now = "2026-10-29T04:00:00.000Z";
	await raw
		.prepare(
			"INSERT INTO accounts(id,login,token_ciphertext,token_last4,is_active,created_at,updated_at) VALUES('a','owner','fake','fake',1,?,?)",
		)
		.bind(now, now)
		.run();
	const account = await getAccount(createDb(raw), "a");
	if (!account) throw new Error("fixture account missing");
	const context: CollectionContext = {
		env: { DB: raw, ENVIRONMENT: "test", GITHUB_API_BASE: "http://activity.fixture" } as Env,
		account,
		token: "fake-memory-only-token",
		now,
		days: [
			{ date: "2026-10-28", since: "2026-10-27T16:00:00.000Z", until: "2026-10-28T16:00:00.000Z" },
		],
		run: {
			id: "current-refresh",
			accountId: "a",
			params: {
				since: "2026-10-28",
				until: "2026-10-28",
				timezone: "Asia/Shanghai",
				dimensions: ["commits", "issues", "prs", "actions", "releases", "alerts"],
				force: false,
			},
			trigger: "manual",
			status: "running",
			phase: "account",
			repos: [],
			completedRepos: 0,
			requests: 0,
			partial: false,
			errorCode: null,
			createdAt: now,
			updatedAt: now,
			finishedAt: null,
		},
	};
	const connection = (nodes: unknown[]) => ({
		nodes,
		pageInfo: { hasNextPage: false, endCursor: null },
	});
	const issue = {
		id: "I_1",
		number: 1,
		title: "Collaborator issue",
		url: "https://github.com/owner/app/issues/1",
		state: "CLOSED",
		createdAt: "2026-10-28T01:00:00.000Z",
		closedAt: "2026-10-28T02:00:00.000Z",
		updatedAt: "2026-10-28T02:00:00.000Z",
		author: { login: "collaborator" },
		labels: { nodes: [] },
	};
	const pr = {
		...issue,
		id: "P_1",
		title: "Collaborator PR",
		createdAt: "2026-10-28T03:00:00.000Z",
		closedAt: "2026-10-28T04:00:00.000Z",
		mergedAt: "2026-10-28T04:00:00.000Z",
		updatedAt: "2026-10-28T04:00:00.000Z",
		isDraft: false,
	};
	const repository = {
		id: "R_APP",
		nameWithOwner: "owner/app",
		name: "app",
		owner: { login: "owner" },
		defaultBranchRef: {
			name: "main",
			target: { oid: "head", history: { totalCount: 123 }, day0: { totalCount: 23 } },
		},
		issues: { ...connection([issue]), totalCount: 1 },
		pullRequests: { ...connection([pr]), totalCount: 1 },
		languages: {
			totalSize: 1,
			edges: [{ size: 1, node: { name: "TypeScript" } }],
			pageInfo: { hasNextPage: false },
		},
		repositoryTopics: { nodes: [] },
	};
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
		const url = String(input);
		if (url.endsWith("/graphql")) {
			const request = JSON.parse(String(init?.body)) as { query: string };
			return Response.json({
				data: request.query.includes("query RefreshAccount")
					? {
							viewer: {
								login: "owner",
								repositories: { ...connection([repository]), totalCount: 1 },
								contributionsCollection: {
									restrictedContributionsCount: 0,
									contributionCalendar: {
										totalContributions: 1,
										weeks: [{ contributionDays: [{ date: "2026-10-28", contributionCount: 1 }] }],
									},
								},
							},
							rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
						}
					: { node: repository },
			});
		}
		if (url.includes("/actions/runs"))
			return Response.json({
				total_count: 1,
				workflow_runs: [
					{
						id: 7,
						name: "CI",
						status: "completed",
						conclusion: "failure",
						head_branch: "main",
						event: "push",
						created_at: "2026-10-28T05:00:00.000Z",
						updated_at: "2026-10-28T05:01:00.000Z",
						html_url: "https://github.com/owner/app/actions/runs/7",
					},
				],
			});
		if (url.includes("/releases"))
			return Response.json([
				{
					id: 8,
					name: "v1",
					tag_name: "v1",
					created_at: "2026-10-28T06:00:00.000Z",
					published_at: "2026-10-28T06:00:00.000Z",
					html_url: "https://github.com/owner/app/releases/v1",
				},
			]);
		return Response.json([]);
	});
	try {
		await collectAccount(context);
		await collectRepository(context, "owner/app");
	} finally {
		fetch.mockRestore();
	}
	await raw
		.prepare(
			"INSERT INTO refresh_runs(id,account_id,status,trigger,payload,created_at,updated_at) VALUES('current-refresh','a','completed','manual',?,?,?)",
		)
		.bind(JSON.stringify(context.run), now, now)
		.run();
	return { raw, context, now };
}
