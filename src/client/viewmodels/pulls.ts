import { loadKind } from "./snapshot";

export type PullRow = {
	name_with_owner: string;
	number: number;
	title: string;
	url: string;
	created_at: string;
	updated_at: string;
	author_login: string | null;
	is_draft: boolean;
	review_decision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
	additions: number;
	deletions: number;
	base_ref: string;
	head_ref: string;
};

export type PullsSnapshot = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	pull_requests: PullRow[];
};

export function filterPulls(rows: PullRow[], query: string): PullRow[] {
	const q = query.trim().toLowerCase();
	if (q === "") {
		return rows;
	}
	return rows.filter((row) => {
		const hay = `${row.name_with_owner} ${row.title}`.toLowerCase();
		return hay.includes(q);
	});
}

export type PullSort = "updated" | "repo";

export function sortPulls(rows: PullRow[], key: PullSort): PullRow[] {
	const copy = [...rows];
	copy.sort((a, b) => {
		if (key === "repo") {
			return a.name_with_owner.localeCompare(b.name_with_owner) || a.number - b.number;
		}
		return b.updated_at.localeCompare(a.updated_at);
	});
	return copy;
}

export function visiblePulls(rows: PullRow[], query: string, key: PullSort): PullRow[] {
	return sortPulls(filterPulls(rows, query), key);
}

export async function loadPulls(): Promise<PullsSnapshot | { missing: true }> {
	return loadKind<PullsSnapshot>("prs");
}
