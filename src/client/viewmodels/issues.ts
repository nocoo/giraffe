import { loadKind } from "./snapshot";

export type IssueRow = {
	name_with_owner: string;
	number: number;
	title: string;
	url: string;
	created_at: string;
	updated_at: string;
	author_login: string | null;
	labels: { name: string; color: string }[];
	comments_count: number;
};

export type IssuesSnapshot = {
	account_id: string;
	fetched_at: string;
	truncated: boolean;
	issues: IssueRow[];
};

export function filterIssues(issues: IssueRow[], query: string): IssueRow[] {
	const q = query.trim().toLowerCase();
	if (q === "") {
		return issues;
	}
	return issues.filter((row) => {
		const hay = `${row.name_with_owner} ${row.title}`.toLowerCase();
		return hay.includes(q);
	});
}

export async function loadIssues(): Promise<IssuesSnapshot | { missing: true }> {
	return loadKind<IssuesSnapshot>("issues");
}
