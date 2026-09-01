import { ApiError } from "./errors";
import type { GithubClient } from "./github-client";
import { TruncatedError } from "./github-client";
import {
	emptyTraffic,
	mapActionRuns,
	mapCodeScanningAlerts,
	mapContributors,
	mapDependabotAlerts,
	mapIssues,
	mapNotifications,
	mapPullRequests,
	mapReleases,
	mapRepoDetails,
	mapRepos,
	mapTraffic,
} from "./github-map";

export type Collected = { truncated: boolean } & Record<string, unknown>;

export const MAX_STAGED_BYTES = 16 * 1024 * 1024;

const REPOS_QUERY =
	"query($after:String){ viewer { repositories(first:100, after:$after, affiliations:[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) { pageInfo { hasNextPage endCursor } nodes { nameWithOwner name owner { login } description stargazerCount forkCount pushedAt isPrivate isArchived isFork visibility url primaryLanguage { name } issues(states:OPEN) { totalCount } } } } }";

const ISSUE_SEARCH =
	"query($q:String!,$after:String){ search(query:$q, type:ISSUE, first:100, after:$after){ issueCount pageInfo{ hasNextPage endCursor } nodes{ __typename ... on Issue { number title url createdAt updatedAt author{ login } labels(first:100){ pageInfo{ hasNextPage } nodes{ name color } } comments{ totalCount } repository{ nameWithOwner } } } } }";

const PR_SEARCH =
	"query($q:String!,$after:String){ search(query:$q, type:ISSUE, first:100, after:$after){ issueCount pageInfo{ hasNextPage endCursor } nodes{ __typename ... on PullRequest { number title url createdAt updatedAt author{ login } isDraft reviewDecision additions deletions baseRefName headRefName repository{ nameWithOwner } } } } }";

const ALERTS_QUERY =
	"query($o:String!,$n:String!,$after:String){ repository(owner:$o,name:$n){ vulnerabilityAlerts(first:20, after:$after){ pageInfo{ hasNextPage endCursor } nodes{ id securityAdvisory{ summary permalink } securityVulnerability{ severity } } } } }";

export function utf8Bytes(text: string): number {
	return new TextEncoder().encode(text).length;
}

function arrayKey(payload: Record<string, unknown>): string | undefined {
	for (const [key, value] of Object.entries(payload)) {
		if (Array.isArray(value)) {
			return key;
		}
	}
	return undefined;
}

export function clampToBudget(
	payload: Collected,
	budget: number,
): { payload: Collected; bytes: number; capped: boolean } {
	const limit = Math.max(0, budget);
	const encoded = JSON.stringify(payload);
	const size = utf8Bytes(encoded);
	if (size <= limit) {
		return { payload, bytes: size, capped: false };
	}
	const key = arrayKey(payload);
	if (!key || !Array.isArray(payload[key])) {
		const next = { truncated: true } as Collected;
		return { payload: next, bytes: utf8Bytes(JSON.stringify(next)), capped: true };
	}
	const items = [...(payload[key] as unknown[])];
	while (items.length > 0) {
		const next = { ...payload, [key]: items, truncated: true };
		const bytes = utf8Bytes(JSON.stringify(next));
		if (bytes <= limit) {
			return { payload: next, bytes, capped: true };
		}
		items.pop();
	}
	const empty = { ...payload, [key]: [], truncated: true };
	return { payload: empty, bytes: utf8Bytes(JSON.stringify(empty)), capped: true };
}

export function ownerName(nameWithOwner: string): { owner: string; name: string } {
	const [owner, name] = nameWithOwner.split("/");
	return { owner: owner ?? "", name: name ?? "" };
}

export function nextPath(res: Response): string | null {
	const link = res.headers.get("link");
	if (!link) {
		return null;
	}
	const match = /<([^>]+)>\s*;\s*rel="next"/i.exec(link);
	if (!match?.[1]) {
		return null;
	}
	try {
		const url = new URL(match[1]);
		return `${url.pathname}${url.search}`;
	} catch {
		return null;
	}
}

function skipSoft(err: unknown): boolean {
	return err instanceof ApiError && (err.code === "github_forbidden" || err.code === "not_found");
}

async function searchList(
	gh: GithubClient,
	token: string,
	repos: string[],
	isPr: boolean,
	strict = false,
): Promise<Collected> {
	const names = [...repos].sort();
	const items: unknown[] = [];
	let truncated = false;
	const query = isPr ? PR_SEARCH : ISSUE_SEARCH;
	for (let i = 0; i < names.length; i += 20) {
		const group = names.slice(i, i + 20);
		const q = `${isPr ? "is:pr" : "is:issue"} is:open ${group.map((n) => `repo:${n}`).join(" ")}`;
		let after: string | null = null;
		let groupCount = 0;
		for (;;) {
			try {
				const data = await gh.githubGraphql(token, query, { q, after });
				const search = data.search as
					| {
							issueCount?: number;
							pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
							nodes?: unknown[];
					  }
					| undefined;
				if (!search) {
					truncated = true;
					break;
				}
				const nodes = search.nodes ?? [];
				items.push(...nodes);
				groupCount += nodes.length;
				const count = search.issueCount ?? 0;
				if (count >= 1000) {
					truncated = true;
				}
				if (gh.graphqlErrors.length > 0) {
					if (strict) {
						if (gh.graphqlErrors.some((err) => err.type === "NOT_FOUND")) {
							throw new ApiError(404, "not_found", "github not found");
						}
						throw new ApiError(403, "github_forbidden", "github forbidden");
					}
					truncated = true;
				}
				if (
					nodes.some((node) => {
						if (!node || typeof node !== "object") {
							return false;
						}
						const labels = (node as { labels?: { pageInfo?: { hasNextPage?: boolean } } }).labels;
						return labels?.pageInfo?.hasNextPage === true;
					})
				) {
					truncated = true;
				}
				if (search.pageInfo?.hasNextPage && search.pageInfo.endCursor) {
					after = search.pageInfo.endCursor;
					continue;
				}
				if (count > groupCount) {
					truncated = true;
				}
				break;
			} catch (err) {
				if (err instanceof TruncatedError) {
					truncated = true;
					break;
				}
				if (skipSoft(err)) {
					if (strict) {
						throw err;
					}
					truncated = true;
					break;
				}
				throw err;
			}
		}
	}
	const mapped = isPr ? mapPullRequests(items) : mapIssues(items);
	return isPr ? { truncated, pull_requests: mapped } : { truncated, issues: mapped };
}

export async function collectRepos(gh: GithubClient, token: string): Promise<Collected> {
	const nodes: Array<Record<string, unknown>> = [];
	let after: string | null = null;
	let truncated = false;
	for (;;) {
		try {
			const data = await gh.githubGraphql(token, REPOS_QUERY, { after });
			const viewer = data.viewer as
				| {
						repositories?: {
							nodes?: Array<Record<string, unknown>>;
							pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
						};
				  }
				| undefined;
			const conn = viewer?.repositories;
			nodes.push(...(conn?.nodes ?? []));
			if (conn?.pageInfo?.hasNextPage && conn.pageInfo.endCursor) {
				after = conn.pageInfo.endCursor;
				continue;
			}
			break;
		} catch (err) {
			if (err instanceof TruncatedError) {
				truncated = true;
				break;
			}
			throw err;
		}
	}
	return { truncated, repos: mapRepos(nodes) };
}

export async function collectKind(
	gh: GithubClient,
	token: string,
	kind: string,
	repoNames: string[],
): Promise<Collected> {
	if (kind === "issues") {
		return searchList(gh, token, repoNames, false);
	}
	if (kind === "prs") {
		return searchList(gh, token, repoNames, true);
	}
	if (kind === "alerts") {
		return collectAlerts(gh, token, repoNames);
	}
	if (kind === "notifications") {
		return collectNotifications(gh, token);
	}
	if (kind.startsWith("repo:")) {
		return collectRepoKind(gh, token, kind);
	}
	throw new ApiError(400, "validation_failed", "unknown kind");
}

async function collectAlerts(
	gh: GithubClient,
	token: string,
	repoNames: string[],
): Promise<Collected> {
	const names = [...repoNames].sort();
	const items: unknown[] = [];
	let truncated = names.length > 10;
	let ok = 0;
	let dependabot = 0;
	let scanning = 0;
	for (const full of names) {
		const { owner, name } = ownerName(full);
		let after: string | null = null;
		let got = false;
		for (;;) {
			try {
				const data = await gh.githubGraphql(token, ALERTS_QUERY, { o: owner, n: name, after });
				const repo = data.repository as {
					vulnerabilityAlerts?: {
						pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
						nodes?: unknown[];
					};
				} | null;
				if (!repo) {
					truncated = true;
					break;
				}
				got = true;
				const nodes = repo.vulnerabilityAlerts?.nodes ?? [];
				dependabot += nodes.length;
				items.push(...mapDependabotAlerts(full, nodes));
				if (
					repo.vulnerabilityAlerts?.pageInfo?.hasNextPage &&
					repo.vulnerabilityAlerts.pageInfo.endCursor
				) {
					after = repo.vulnerabilityAlerts.pageInfo.endCursor;
					continue;
				}
				break;
			} catch (err) {
				if (err instanceof TruncatedError) {
					truncated = true;
					break;
				}
				if (skipSoft(err)) {
					truncated = true;
					break;
				}
				throw err;
			}
		}
		if (got) {
			ok += 1;
		}
	}
	for (const full of names.slice(0, 10)) {
		const { owner, name } = ownerName(full);
		let path: string | null =
			`/repos/${owner}/${name}/code-scanning/alerts?state=open&per_page=100`;
		try {
			while (path) {
				const res = await gh.githubApi(token, path);
				const body = (await res.json()) as unknown;
				const mapped = mapCodeScanningAlerts(full, Array.isArray(body) ? body : []);
				scanning += mapped.length;
				items.push(...mapped);
				ok += 1;
				path = nextPath(res);
			}
		} catch (err) {
			if (skipSoft(err)) {
				truncated = true;
				continue;
			}
			if (err instanceof TruncatedError) {
				truncated = true;
				break;
			}
			throw err;
		}
	}
	return {
		truncated,
		unavailable: ok === 0,
		items,
		dependabot_open: dependabot,
		code_scanning_open: scanning,
	};
}

async function collectNotifications(gh: GithubClient, token: string): Promise<Collected> {
	const items: unknown[] = [];
	let path: string | null = "/notifications?per_page=100";
	let truncated = false;
	while (path) {
		try {
			const res = await gh.githubApi(token, path);
			const body = (await res.json()) as unknown;
			items.push(...(Array.isArray(body) ? body : []));
			path = nextPath(res);
			if (path) {
			}
		} catch (err) {
			if (err instanceof TruncatedError) {
				truncated = true;
				break;
			}
			throw err;
		}
	}
	return { truncated, notifications: mapNotifications(items) };
}

async function collectRepoKind(gh: GithubClient, token: string, kind: string): Promise<Collected> {
	const match = /^repo:([^/]+\/[^:]+):(.+)$/.exec(kind);
	if (!match?.[1] || !match[2]) {
		throw new ApiError(400, "validation_failed", "invalid repo kind");
	}
	const full = match[1];
	const suffix = match[2];
	const { owner, name } = ownerName(full);
	const base = `/repos/${owner}/${name}`;
	if (suffix === "details") {
		const res = await gh.githubApi(token, base);
		const body = (await res.json()) as Record<string, unknown>;
		return { truncated: false, ...mapRepoDetails(body) };
	}
	if (suffix === "actions") {
		return collectRestList(gh, token, `${base}/actions/runs?per_page=100`, (rows, truncated) => ({
			truncated,
			runs: mapActionRuns({ workflow_runs: rows }),
		}));
	}
	if (suffix === "traffic") {
		try {
			const views = await gh.githubApi(token, `${base}/traffic/views`);
			const clones = await gh.githubApi(token, `${base}/traffic/clones`);
			return {
				truncated: false,
				forbidden: false,
				views: mapTraffic(await views.json(), "views"),
				clones: mapTraffic(await clones.json(), "clones"),
			};
		} catch (err) {
			if (skipSoft(err)) {
				return { truncated: false, forbidden: true, views: emptyTraffic(), clones: emptyTraffic() };
			}
			if (err instanceof TruncatedError) {
				return { truncated: true, forbidden: false, views: emptyTraffic(), clones: emptyTraffic() };
			}
			throw err;
		}
	}
	if (suffix === "security") {
		try {
			let after: string | null = null;
			let count = 0;
			let truncated = false;
			let unavailable = false;
			for (;;) {
				try {
					const data = await gh.githubGraphql(token, ALERTS_QUERY, { o: owner, n: name, after });
					const repo = data.repository as {
						vulnerabilityAlerts?: {
							pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
							nodes?: unknown[];
						};
					} | null;
					if (!repo) {
						unavailable = true;
						break;
					}
					count += repo.vulnerabilityAlerts?.nodes?.length ?? 0;
					if (
						repo.vulnerabilityAlerts?.pageInfo?.hasNextPage &&
						repo.vulnerabilityAlerts.pageInfo.endCursor
					) {
						after = repo.vulnerabilityAlerts.pageInfo.endCursor;
						continue;
					}
					break;
				} catch (err) {
					if (err instanceof TruncatedError) {
						truncated = true;
						break;
					}
					throw err;
				}
			}
			let scanning = 0;
			try {
				let path: string | null = `${base}/code-scanning/alerts?state=open&per_page=100`;
				while (path) {
					const res = await gh.githubApi(token, path);
					const body = (await res.json()) as unknown;
					scanning += Array.isArray(body) ? body.length : 0;
					path = nextPath(res);
				}
			} catch (err) {
				if (skipSoft(err)) {
					truncated = true;
					if (count === 0) {
						unavailable = true;
					}
				} else if (err instanceof TruncatedError) {
					truncated = true;
				} else {
					throw err;
				}
			}
			return {
				truncated,
				unavailable,
				dependabot_open: count,
				code_scanning_open: scanning,
			};
		} catch (err) {
			if (skipSoft(err)) {
				return { truncated: false, unavailable: true, dependabot_open: 0, code_scanning_open: 0 };
			}
			throw err;
		}
	}
	if (suffix === "issues") {
		return searchList(gh, token, [full], false, true);
	}
	if (suffix === "prs") {
		return searchList(gh, token, [full], true, true);
	}
	if (suffix === "releases") {
		return collectRestList(gh, token, `${base}/releases?per_page=100`, (rows, truncated) => ({
			truncated,
			releases: mapReleases(rows),
		}));
	}
	if (suffix === "languages") {
		const res = await gh.githubApi(token, `${base}/languages`);
		const languages = (await res.json()) as unknown;
		return { truncated: false, languages };
	}
	if (suffix === "contributors") {
		return collectRestList(gh, token, `${base}/contributors?per_page=100`, (rows, truncated) => ({
			truncated,
			contributors: mapContributors(rows),
		}));
	}
	throw new ApiError(400, "validation_failed", "unknown repo kind");
}

async function collectRestList(
	gh: GithubClient,
	token: string,
	start: string,
	finish: (rows: unknown[], truncated: boolean) => Collected,
): Promise<Collected> {
	const rows: unknown[] = [];
	let path: string | null = start;
	let truncated = false;
	while (path) {
		try {
			const res = await gh.githubApi(token, path);
			const body = (await res.json()) as unknown;
			if (
				body &&
				typeof body === "object" &&
				Array.isArray((body as { workflow_runs?: unknown[] }).workflow_runs)
			) {
				rows.push(...(body as { workflow_runs: unknown[] }).workflow_runs);
			} else if (Array.isArray(body)) {
				rows.push(...body);
			}
			path = nextPath(res);
		} catch (err) {
			if (err instanceof TruncatedError) {
				truncated = true;
				break;
			}
			throw err;
		}
	}
	return finish(rows, truncated);
}
