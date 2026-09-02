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

export async function loadPulls(): Promise<PullsSnapshot | { missing: true }> {
	return loadKind<PullsSnapshot>("prs");
}
