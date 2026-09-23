import {
	factoryWindow,
	inWindow,
	mergeMetrics,
	summarizeEvents,
	uniqueEvents,
} from "../../lib/factory";
import {
	FACTORY_STREAMS,
	type FactoryRepo,
	type FactorySnapshot,
	type FactoryStreamData,
	type FactoryStreamName,
	type FactoryWindow,
} from "../../lib/factory-types";
import { ApiError } from "./errors";
import {
	coverage,
	exclusion,
	mapDependencies,
	mapFactoryEvents,
	mapFactoryRepo,
	object,
	rows,
} from "./factory-map";
import {
	FACTORY_CONTRIBUTIONS_QUERY,
	FACTORY_DEPENDENCIES_QUERY,
	FACTORY_INVENTORY_QUERY,
} from "./factory-queries";
import type { GithubClient } from "./github-client";

export const FACTORY_ITEM_CAP = 5000;
export const FACTORY_BYTE_CAP = 1_200_000;
export function newFactory(account: string, owner: string, now: string): FactorySnapshot {
	return {
		schema: 1,
		account_id: account,
		owner,
		runId: now,
		revision: 0,
		leaseUntil: null,
		startedAt: now,
		fetched_at: now,
		window: factoryWindow(now),
		status: "collecting",
		inventory: { total: 0, scanned: 0, complete: false, after: null, pages: 0, excluded: [] },
		repos: [],
		cursor: { repo: 0, stream: 0 },
		requests: 0,
		rate: null,
		contribution: null,
		contributionStatus: "pending",
	};
}
export function streamKey(repo: string, stream: FactoryStreamName): string {
	return `factory:${repo}:${stream}`;
}
export type FactoryStore = {
	read: (key: string) => Promise<FactoryStreamData | null>;
	write: (key: string, data: FactoryStreamData) => Promise<void>;
};
function source(repo: FactoryRepo, stream: FactoryStreamName, window: FactoryWindow): string {
	const base = `/repos/${repo.name}`;
	switch (stream) {
		case "commits":
			return `${base}/commits?sha=${repo.head}&since=${window.since}&until=${window.until}&per_page=100&page=1`;
		case "issues":
			return `${base}/issues?state=all&sort=updated&direction=desc&per_page=100&page=1`;
		case "prs":
			return `${base}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=1`;
		case "actions":
			return `${base}/actions/runs?created=${window.since}..${window.until}&per_page=100&page=1`;
		case "releases":
			return `${base}/releases?per_page=100&page=1`;
		case "alerts":
			return `${base}/dependabot/alerts?state=open&per_page=100&page=1`;
		case "dependencies":
			return "https://api.github.com/graphql · pinned root manifests";
	}
}
/** Follow only GitHub pagination for the same resource. Never trust a foreign Link URL. */
export function factoryNext(link: string | null, current: string): string | null {
	const next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
	if (!next) return null;
	const url = new URL(next);
	const before = new URL(current, "https://api.github.com");
	const suffix = before.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, "");
	const canonical = /^\/repositories\/\d+(\/.*)$/.exec(url.pathname)?.[1];
	const page = Number(url.searchParams.get("page"));
	const currentPage = Number(before.searchParams.get("page") ?? "1");
	if (
		url.origin !== "https://api.github.com" ||
		(url.pathname !== before.pathname && canonical !== suffix) ||
		!Number.isInteger(page) ||
		page !== currentPage + 1
	)
		throw new ApiError(502, "github_error", "invalid pagination");
	// GitHub emits /repositories/:numericId links. Keep the requested named repository and
	// original filters; consume only the sequential page number, never a new target or scope.
	before.searchParams.set("page", String(page));
	return `${before.pathname}${before.search}`;
}
function rateFromData(s: FactorySnapshot, data: Record<string, unknown>) {
	const rate = object(data.rateLimit);
	if (typeof rate.remaining === "number")
		s.rate = {
			remaining: rate.remaining,
			resetAt: typeof rate.resetAt === "string" ? rate.resetAt : null,
			resource: "graphql",
		};
}
async function inventory(
	s: FactorySnapshot,
	gh: GithubClient,
	token: string,
	now: string,
	includeDisabled: boolean,
) {
	const data = await gh.githubGraphql(token, FACTORY_INVENTORY_QUERY, { after: s.inventory.after });
	rateFromData(s, data);
	const viewer = object(data.viewer);
	const conn = object(viewer.repositories);
	const info = object(conn.pageInfo);
	if (
		gh.graphqlErrors.length ||
		!Array.isArray(conn.nodes) ||
		String(viewer.login).toLowerCase() !== s.owner.toLowerCase()
	)
		throw new ApiError(502, "github_error", "inventory incomplete");
	for (const r of rows(conn.nodes)) {
		const reason = exclusion(r, s.owner, includeDisabled);
		const name = String(r.nameWithOwner);
		if (reason) {
			if (!s.inventory.excluded.some((e) => e.name === name))
				s.inventory.excluded.push({ name, reason });
		} else if (!s.repos.some((repo) => repo.id === r.id))
			s.repos.push({ ...mapFactoryRepo(r), metadataAt: now });
	}
	s.inventory.total = Number(conn.totalCount);
	s.inventory.scanned = s.repos.length + s.inventory.excluded.length;
	s.inventory.pages++;
	if (
		info.hasNextPage &&
		(typeof info.endCursor !== "string" || info.endCursor === s.inventory.after)
	)
		throw new ApiError(502, "github_error", "invalid inventory cursor");
	s.inventory.after = info.hasNextPage ? String(info.endCursor) : null;
	s.inventory.complete = !info.hasNextPage;
	if (s.inventory.complete && s.inventory.scanned !== s.inventory.total)
		throw new ApiError(502, "github_error", "inventory changed; restart required");
}
async function contributions(s: FactorySnapshot, gh: GithubClient, token: string, now: string) {
	const data = await gh.githubGraphql(token, FACTORY_CONTRIBUTIONS_QUERY, {
		owner: s.owner,
		...s.window,
	});
	rateFromData(s, data);
	const collection = object(object(data.user).contributionsCollection);
	const calendar = object(collection.contributionCalendar);
	if (gh.graphqlErrors.length || !Array.isArray(calendar.weeks)) {
		s.contributionStatus = "unavailable";
		return;
	}
	s.contribution = {
		total: Number(calendar.totalContributions),
		restricted: Number(collection.restrictedContributionsCount),
		fetchedAt: now,
		days: rows(calendar.weeks).flatMap((w) =>
			rows(w.contributionDays).map((d) => ({
				date: String(d.date),
				count: Number(d.contributionCount),
			})),
		),
	};
	s.contributionStatus = "complete";
}
function advanceCursor(s: FactorySnapshot) {
	s.cursor.stream++;
	if (s.cursor.stream >= FACTORY_STREAMS.length) {
		s.cursor.stream = 0;
		s.cursor.repo++;
	}
}
export function splitActionWindow(window: FactoryWindow): [FactoryWindow, FactoryWindow] | null {
	const start = Date.parse(window.since);
	const end = Date.parse(window.until);
	const mid = Math.floor((start + end) / 2);
	if (end - start <= 1000) return null;
	return [
		{ since: window.since, until: new Date(mid).toISOString() },
		{ since: new Date(mid).toISOString(), until: window.until },
	];
}
async function collectStream(
	s: FactorySnapshot,
	gh: GithubClient,
	token: string,
	store: FactoryStore,
	now: string,
) {
	const repo = s.repos[s.cursor.repo];
	const stream = FACTORY_STREAMS[s.cursor.stream];
	if (!repo || !stream) {
		s.status = "complete";
		return;
	}
	const key = streamKey(repo.name, stream);
	const first = source(repo, stream, s.window);
	const saved = repo.coverage[stream].status === "pending" ? null : await store.read(key);
	if (saved && saved.runId !== s.runId)
		throw new ApiError(409, "snapshot_missing", "resource belongs to another survey");
	const data: FactoryStreamData = saved ?? {
		runId: s.runId,
		items: [],
		next: first,
		ranges: [],
		coverage: coverage(first),
	};
	data.coverage.status = "partial";
	data.coverage.fetchedAt = now;
	try {
		if (stream === "dependencies" && !repo.head) {
			data.next = null;
		} else if (stream === "dependencies") {
			const [owner, name] = repo.name.split("/");
			const variables: Record<string, unknown> = { owner, name };
			for (const [alias, path] of [
				["package", "package.json"],
				["ci", ".github/workflows/ci.yml"],
				["release", ".github/workflows/release.yml"],
				["dependabot", ".github/dependabot.yml"],
				["renovate", "renovate.json"],
			])
				variables[String(alias)] = `${repo.head}:${path}`;
			const result = await gh.githubGraphql(token, FACTORY_DEPENDENCIES_QUERY, variables);
			rateFromData(s, result);
			if (gh.graphqlErrors.length || !result.repository)
				throw new ApiError(403, "github_forbidden", "manifest unavailable");
			try {
				data.items = mapDependencies(object(result.repository), repo);
			} catch {
				data.coverage.status = "unavailable";
				data.coverage.reason =
					"Root package.json is not valid JSON; dependency evidence unavailable";
			}
			data.next = null;
		} else if (stream === "commits" && !repo.head) {
			data.next = null;
		} else {
			const path = data.next ?? first;
			const response = await gh.githubApi(token, path);
			const remaining = response.headers.get("x-ratelimit-remaining");
			const reset = response.headers.get("x-ratelimit-reset");
			if (remaining !== null)
				s.rate = {
					remaining: Number(remaining),
					resetAt: reset ? new Date(Number(reset) * 1000).toISOString() : null,
					resource: "core",
				};
			const payload: unknown = await response.json();
			if (stream === "actions" && Number(object(payload).total_count) > 1000) {
				const range = new URL(path, "https://api.github.com").searchParams
					.get("created")
					?.split("..");
				const parts = splitActionWindow({
					since: range?.[0] ?? s.window.since,
					until: range?.[1] ?? s.window.until,
				});
				if (!parts) {
					data.coverage.status = "limited";
					data.coverage.reason = "More than 1,000 workflow runs in one second";
					data.next = null;
				} else {
					data.ranges.unshift(...parts);
					data.next = null;
				}
			} else {
				const list = stream === "actions" ? object(payload).workflow_runs : payload;
				if (!Array.isArray(list)) throw new ApiError(502, "github_error", "invalid resource list");
				data.items = uniqueEvents([
					...data.items,
					...mapFactoryEvents(stream, rows(list)).filter(
						(e) => (stream !== "commits" && stream !== "actions") || inWindow(e.at, s.window),
					),
				]);
				data.next = factoryNext(response.headers.get("link"), path);
			}
		}
		data.coverage.pages++;
		if (!data.next && data.ranges.length && data.coverage.status !== "limited") {
			const range = data.ranges.shift();
			if (range)
				data.next = `/repos/${repo.name}/actions/runs?created=${range.since}..${range.until}&per_page=100&page=1`;
		}
		if (
			data.items.length > FACTORY_ITEM_CAP ||
			new TextEncoder().encode(JSON.stringify(data)).length > FACTORY_BYTE_CAP
		) {
			data.items = data.items.slice(0, FACTORY_ITEM_CAP);
			while (new TextEncoder().encode(JSON.stringify(data)).length > FACTORY_BYTE_CAP)
				data.items = data.items.slice(0, Math.floor(data.items.length * 0.9));
			data.coverage.status = "limited";
			data.coverage.reason = "Resource exceeds 5,000 records or 1.2 MB; observed subset only";
			data.next = null;
			data.ranges = [];
		}
		if (!data.next && data.coverage.status === "partial") data.coverage.status = "complete";
	} catch (error) {
		if (
			error instanceof ApiError &&
			(error.code === "github_forbidden" ||
				error.code === "not_found" ||
				error.code === "github_response_too_large")
		) {
			data.coverage.status = data.items.length ? "limited" : "unavailable";
			data.coverage.reason =
				error.code === "github_response_too_large"
					? "GitHub response exceeds the 4 MB memory budget; evidence unavailable"
					: data.items.length
						? "GitHub access lost during pagination (403/404); incomplete observed subset only"
						: "GitHub denied access or resource not available (403/404)";
			data.next = null;
			data.ranges = [];
		} else throw error;
	}
	data.coverage.observed = data.items.length;
	repo.coverage[stream] = data.coverage;
	if (data.coverage.status !== "partial") {
		repo.metrics = mergeMetrics([repo.metrics, summarizeEvents(stream, data.items, s.window)]);
		if (stream === "dependencies")
			repo.dependencies = data.items.map((e) => ({
				name: e.title,
				version: e.version ?? "",
				path: e.path ?? "",
				url: e.url,
			}));
		advanceCursor(s);
	}
	await store.write(key, data);
}
/** One bounded page. Completed streams are cached; a resumed job keeps its frozen window/head. */
export async function stepFactory(
	s: FactorySnapshot,
	gh: GithubClient,
	token: string,
	store: FactoryStore,
	now: string,
	includeDisabled = false,
): Promise<void> {
	if (s.status === "complete") return;
	if (
		s.rate &&
		s.rate.remaining < 50 &&
		(!s.rate.resetAt || Date.parse(s.rate.resetAt) > Date.parse(now))
	)
		throw new ApiError(503, "github_rate_limited", "GitHub reserve reached");
	const before = gh.count;
	try {
		if (!s.inventory.complete) await inventory(s, gh, token, now, includeDisabled);
		else if (s.contributionStatus === "pending") await contributions(s, gh, token, now);
		else await collectStream(s, gh, token, store, now);
		s.fetched_at = now;
		s.revision++;
	} finally {
		s.requests += gh.count - before;
	}
}
