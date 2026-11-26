import { vi } from "vitest";
import { annualContributionCalendar } from "../../../../../../../tests/fixtures/contribution-calendar";
import {
	isAccountFixture,
	isCalendarFixture,
	isRepositoryFixture,
	takeQueueEntry,
} from "../../../../../../../tests/fixtures/refresh-upstream-queue";
import { sqliteFixture } from "../../../../../../../tests/fixtures/sqlite";
import type { CollectionContext } from "../../refresh-collection-contract";

export const now = "2026-10-29T04:00:00.000Z";
const calendarCache = new Map<string, ReturnType<typeof annualContributionCalendar>["calendar"]>();
function cachedAnnualCalendar(at: string, count = 2) {
	const key = `${at}\0${count}`;
	let cal = calendarCache.get(key);
	if (!cal) {
		cal = annualContributionCalendar(at, count).calendar;
		calendarCache.set(key, cal);
	}
	return cal;
}

export const graphqlBodies = (fetchMock: ReturnType<typeof upstream>) =>
	fetchMock.mock.calls
		.filter(([url]) => String(url).endsWith("/graphql"))
		.map(([, init]) => String(init?.body ?? ""));

export const lastRepositoryGraphqlBody = (fetchMock: ReturnType<typeof upstream>) => {
	const bodies = graphqlBodies(fetchMock).filter((body) => body.includes("RefreshRepository"));
	return bodies.at(-1) ?? "";
};

export const repo = (id = "R_1", name = "owner/project") => ({
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

export const releases = (values: unknown[], more = false) => ({
	totalCount: values.length,
	nodes: values,
	pageInfo: { hasNextPage: more },
});

export const release = (id: string, published: string | null, created = published) => ({
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

export const accountPage = (
	nodeList = [repo()],
	more = false,
	cursor: string | null = null,
	at = now,
) => ({
	viewer: {
		login: "owner",
		avatarUrl: "avatar",
		repositories: {
			nodes: nodeList,
			totalCount: nodeList.length,
			pageInfo: { hasNextPage: more, endCursor: cursor },
		},
		contributionsCollection: {
			restrictedContributionsCount: 0,
			contributionCalendar: cachedAnnualCalendar(at, 2),
		},
	},
	rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
});

export const contributionCalendarPage = (calendar: unknown, at = now) => ({
	viewer: {
		contributionsCollection: {
			restrictedContributionsCount: 0,
			contributionCalendar: calendar,
		},
	},
	rateLimit: { remaining: 4999, resetAt: at },
});

export async function fixture() {
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

export function upstream(
	graphql: unknown[] = [accountPage(), { node: repo() }],
	rest: Record<string, unknown> = {},
) {
	const queue = [...graphql];
	let pinnedContribution: unknown | undefined;
	const mockFetch = vi.fn(async (input: string, init?: RequestInit) => {
		if (input.endsWith("/graphql")) {
			const body = typeof init?.body === "string" ? init.body : "";
			const lastRepoNode = () =>
				[...graphql]
					.reverse()
					.find((entry) => entry && typeof entry === "object" && "node" in entry);
			if (body.includes("query RefreshContributionCalendar")) {
				if (
					pinnedContribution &&
					typeof pinnedContribution === "object" &&
					"viewer" in pinnedContribution
				) {
					const payload =
						"rateLimit" in pinnedContribution
							? pinnedContribution
							: {
									...(pinnedContribution as Record<string, unknown>),
									rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
								};
					return Response.json({ data: payload });
				}
				const chunkResponse = await takeQueueEntry(queue, isCalendarFixture);
				if (chunkResponse instanceof Response) return chunkResponse.clone();
				if (chunkResponse && typeof chunkResponse === "object" && "viewer" in chunkResponse) {
					pinnedContribution = chunkResponse;
					const payload =
						"rateLimit" in chunkResponse
							? chunkResponse
							: {
									...(chunkResponse as Record<string, unknown>),
									rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
								};
					return Response.json({ data: payload });
				}
				return Response.json({
					data: {
						viewer: {
							contributionsCollection: {
								restrictedContributionsCount: 0,
								contributionCalendar: cachedAnnualCalendar(now, 2),
							},
						},
						rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
					},
				});
			}
			if (body.includes("query RefreshRepository")) {
				const data =
					(await takeQueueEntry(queue, isRepositoryFixture)) ??
					(queue.length > 0 ? queue.shift() : lastRepoNode());
				if (data instanceof Error) throw data;
				if (data instanceof Response) return data.clone();
				const payload =
					data && typeof data === "object" && "node" in data && !("rateLimit" in data)
						? {
								...(data as Record<string, unknown>),
								rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
							}
						: data;
				return Response.json({ data: payload });
			}
			if (body.includes("query RefreshItems")) {
				const queued =
					(await takeQueueEntry(queue, isRepositoryFixture)) ??
					(queue.length > 0 ? queue.shift() : undefined);
				if (queued instanceof Error) throw queued;
				if (queued instanceof Response) return queued.clone();
				const data =
					queued ??
					({
						node: body.includes("pullRequests")
							? { pullRequests: connection([]) }
							: { issues: connection([]) },
					} as const);
				const payload =
					data && typeof data === "object" && "node" in data && !("rateLimit" in data)
						? {
								...(data as Record<string, unknown>),
								rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
							}
						: data;
				return Response.json({ data: payload });
			}
			const data =
				(await takeQueueEntry(queue, isAccountFixture)) ??
				(queue.length > 0 ? queue.shift() : graphql.at(-1));
			if (data instanceof Error) throw data;
			if (data instanceof Response) return data.clone();
			const payload =
				data && typeof data === "object" && "node" in data && !("rateLimit" in data)
					? {
							...(data as Record<string, unknown>),
							rateLimit: { remaining: 4999, resetAt: "2026-10-29T05:00:00Z" },
						}
					: data;
			return Response.json({ data: payload });
		}
		for (const [suffix, data] of Object.entries(rest))
			if (input.includes(suffix))
				return data instanceof Response ? data.clone() : Response.json(data);
		if (input.includes("/actions/runs"))
			return Response.json({ total_count: 0, workflow_runs: [] });
		return Response.json([]);
	});
	vi.stubGlobal("fetch", mockFetch);
	return mockFetch;
}

export const item = (id: string, state = "OPEN") => ({
	id,
	number: 1,
	title: id,
	url: `https://github.com/owner/project/issues/${id}`,
	state,
	createdAt: "2026-10-28T01:00:00.000Z",
	updatedAt: "2026-10-28T02:00:00.000Z",
	closedAt: state === "CLOSED" ? "2026-10-28T03:00:00.000Z" : null,
	author: { login: "owner" },
	labels: { nodes: [] },
	comments: { totalCount: 0 },
});

export const connection = (values: unknown[], more = false, cursor: string | null = null) => ({
	nodes: values,
	pageInfo: { hasNextPage: more, endCursor: cursor },
});

export async function publication(context: CollectionContext) {
	return sourceSnapshot(context, "factory");
}

export async function observation(context: CollectionContext, dimension: string) {
	return context.env.DB.prepare(
		"SELECT * FROM refresh_day_observations WHERE account_id=? AND dimension=? ORDER BY day",
	)
		.bind(context.account.id, dimension)
		.all<{ day: string; status: string; payload: string; fetched_at: string }>();
}

export async function sourceSnapshot(context: CollectionContext, kind: string) {
	const row = await context.env.DB.prepare(
		"SELECT payload FROM refresh_snapshots WHERE account_id=? AND kind=?",
	)
		.bind(context.account.id, kind)
		.first<{ payload: string }>();
	return JSON.parse(row?.payload ?? "{}");
}
