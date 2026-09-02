import { getActiveAccountId } from "./session";
import { loadKind } from "./snapshot";

export type RepoRow = {
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
	account_id?: string;
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

export function alertsIncomplete(insights: InsightsSnapshot | null): boolean {
	return insights?.alerts_incomplete === true;
}

let remembered: ReposSnapshot | null = null;

export function cachedRepoRows(): RepoRow[] {
	if (remembered && remembered.account_id !== getActiveAccountId()) {
		return [];
	}
	return remembered?.repos ?? [];
}

export async function loadRepos(): Promise<ReposSnapshot | { missing: true }> {
	const next = await loadKind<ReposSnapshot>("repos");
	if ("missing" in next) {
		remembered = null;
		return next;
	}
	remembered = next;
	return next;
}

export async function loadInsightsOptional(): Promise<InsightsSnapshot | null> {
	const next = await loadKind<InsightsSnapshot>("insights");
	if ("missing" in next) {
		return null;
	}
	return next;
}
