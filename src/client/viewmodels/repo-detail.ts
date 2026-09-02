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
