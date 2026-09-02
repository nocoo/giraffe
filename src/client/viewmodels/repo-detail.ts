import { apiGet } from "../lib/api";
import { ApiError } from "../lib/errors";
import { ensureSession } from "./session";

export const REPO_TABS = [
	"details",
	"security",
	"actions",
	"prs",
	"issues",
	"releases",
	"traffic",
	"languages",
	"contributors",
] as const;

export type RepoTab = (typeof REPO_TABS)[number];

export type RepoSecurity = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	unavailable: boolean;
	dependabot_open: number;
	code_scanning_open: number;
};

export type TrafficPoint = {
	timestamp: string;
	count: number;
	uniques: number;
};

export type RepoTraffic = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	forbidden: boolean;
	views: { count: number; uniques: number; points: TrafficPoint[] };
	clones: { count: number; uniques: number; points: TrafficPoint[] };
};

export type ActionRun = {
	id: number;
	name: string;
	html_url: string;
	status: string;
	conclusion: string | null;
	event: string;
	head_branch: string | null;
	created_at: string;
	updated_at: string;
};

export type RepoActions = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	runs: ActionRun[];
};

export type RepoRelease = {
	id: number;
	tag_name: string;
	name: string | null;
	html_url: string;
	draft: boolean;
	prerelease: boolean;
	published_at: string | null;
};

export type RepoReleases = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	releases: RepoRelease[];
};

export type RepoDetails = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	description: string | null;
	homepage: string | null;
	default_branch: string;
	license: string | null;
	is_archived: boolean;
	open_issue_count: number;
	stargazer_count: number;
	fork_count: number;
	pushed_at: string;
	url: string;
};

export function isValidRepoPart(value: string): boolean {
	return /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}

export function repoKind(owner: string, name: string, tab: RepoTab): string {
	return `repo:${owner}/${name}:${tab}`;
}

export function securityUnavailable(snap: RepoSecurity): boolean {
	return snap.unavailable === true;
}

export function trafficForbidden(snap: RepoTraffic): boolean {
	return snap.forbidden === true;
}

export function trafficPoints(points: TrafficPoint[]): { x: string; y: number }[] {
	return points.map((point) => ({ x: point.timestamp, y: point.count }));
}

export function repoResource(owner: string, name: string, tab: RepoTab): string {
	if (tab === "details") {
		return `repos/${owner}/${name}`;
	}
	return `repos/${owner}/${name}/${tab}`;
}

export async function loadRepoTab<T>(
	owner: string,
	name: string,
	tab: RepoTab,
): Promise<T | { missing: true } | { invalid: true }> {
	if (!isValidRepoPart(owner) || !isValidRepoPart(name)) {
		return { invalid: true };
	}
	await ensureSession();
	try {
		return await apiGet<T>(repoResource(owner, name, tab));
	} catch (err) {
		if (err instanceof ApiError && err.code === "snapshot_missing") {
			return { missing: true };
		}
		throw err;
	}
}
