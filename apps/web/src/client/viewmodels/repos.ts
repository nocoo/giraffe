import type { RepoAgentStateSummary } from "../../lib/repo-agent-state";
import type { RepoMetaFields } from "../../lib/repo-meta";
import type { SnapshotFreshness } from "../../lib/snapshot-freshness";
import { apiPost } from "../lib/api";
import { ApiError } from "../lib/errors";
import { getRepositoryScope, scopedResource } from "./scope";
import { getActiveAccountId } from "./session";
import { loadKind } from "./snapshot";

export type RepoRow = {
	agent_state?: RepoAgentStateSummary | null;
	meta?: RepoMetaFields | null;
	starred?: boolean;
	star_source: "owner" | "agent" | null;
	star_updated_at: string | null;
	name_with_owner: string;
	name: string;
	owner_login: string;
	description: string | null;
	stargazer_count: number;
	fork_count: number;
	open_issue_count: number;
	primary_language: string | null;
	pushed_at: string | null;
	visibility: string;
	is_private: boolean;
	is_archived: boolean;
	is_fork: boolean;
	url: string;
};

export type ReposSnapshot = {
	freshness?: SnapshotFreshness;
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	repos: RepoRow[];
};

export type InsightRow = {
	name_with_owner: string;
	health: "strong" | "watch" | "risky";
};

export type InsightsSnapshot = {
	fetched_at?: string;
	freshness?: SnapshotFreshness;
	account_id: string;
	alerts_incomplete?: boolean;
	insights: InsightRow[];
};

export type SortKey = "stars" | "pushed" | "name";
export type ViewMode = "list" | "grid";

export function filterRepos(repos: RepoRow[], query: string): RepoRow[] {
	const q = query.trim().toLowerCase();
	if (q === "") {
		return repos;
	}
	return repos.filter((row) => {
		const hay = `${row.name_with_owner} ${row.description ?? ""}`.toLowerCase();
		return hay.includes(q);
	});
}

export function sortRepos(repos: RepoRow[], key: SortKey): RepoRow[] {
	const copy = [...repos];
	copy.sort((a, b) => {
		if (key === "stars") {
			return b.stargazer_count - a.stargazer_count;
		}
		if (key === "pushed") {
			return (b.pushed_at ?? "").localeCompare(a.pushed_at ?? "");
		}
		return a.name_with_owner.localeCompare(b.name_with_owner);
	});
	return copy;
}

export function visibleRepos(repos: RepoRow[], query: string, key: SortKey): RepoRow[] {
	return sortRepos(filterRepos(repos, query), key);
}

export function repoMetrics(repos: RepoRow[]): {
	count: number;
	stars: number;
	forks: number;
	issues: number;
} {
	let stars = 0;
	let forks = 0;
	let issues = 0;
	for (const row of repos) {
		stars += row.stargazer_count;
		forks += row.fork_count;
		issues += row.open_issue_count;
	}
	return { count: repos.length, stars, forks, issues };
}

export function healthMap(insights: InsightsSnapshot | null): Map<string, InsightRow["health"]> {
	const map = new Map<string, InsightRow["health"]>();
	if (!insights) {
		return map;
	}
	for (const row of insights.insights) {
		map.set(row.name_with_owner, row.health);
	}
	return map;
}

let remembered: ReposSnapshot | null = null;

export type RepoStarState = Pick<RepoRow, "star_source" | "star_updated_at"> & {
	starred: boolean;
};

export async function saveRepoStar(
	account: string,
	repo: RepoRow,
	enabled: boolean,
): Promise<RepoStarState> {
	if (getActiveAccountId() !== account)
		throw new ApiError(409, "account_conflict", "account changed");
	const result = await apiPost<{ account_id: string } & RepoStarState>(
		`repos/${encodeURIComponent(repo.owner_login)}/${encodeURIComponent(repo.name)}/star`,
		{ account_id: account, enabled },
	);
	if (result.account_id !== account || getActiveAccountId() !== account)
		throw new ApiError(409, "account_conflict", "account changed");
	const saved: RepoStarState = {
		starred: result.starred,
		star_source: result.star_source,
		star_updated_at: result.star_updated_at,
	};
	if (remembered?.account_id === account)
		remembered = {
			...remembered,
			repos: remembered.repos.map((r) =>
				r.name_with_owner === repo.name_with_owner ? { ...r, ...saved } : r,
			),
		};
	return saved;
}

export function cachedRepoRows(): RepoRow[] {
	if (remembered && remembered.account_id !== getActiveAccountId()) {
		return [];
	}
	return remembered?.repos ?? [];
}

export async function loadRepos(
	scope = getRepositoryScope(),
): Promise<ReposSnapshot | { missing: true }> {
	const next = await loadKind<ReposSnapshot>(scopedResource("repos", scope));
	if ("missing" in next) {
		remembered = null;
		return next;
	}
	remembered = next;
	return next;
}

export async function loadInsightsOptional(
	scope = getRepositoryScope(),
): Promise<InsightsSnapshot | null> {
	const snapshot = await loadKind<InsightsSnapshot>(scopedResource("insights", scope));
	return "missing" in snapshot ? null : snapshot;
}
