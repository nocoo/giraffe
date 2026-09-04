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

export type IssueSort = "updated" | "repo";

export function sortIssues(issues: IssueRow[], key: IssueSort): IssueRow[] {
	const copy = [...issues];
	copy.sort((a, b) => {
		if (key === "repo") {
			return a.name_with_owner.localeCompare(b.name_with_owner) || a.number - b.number;
		}
		return b.updated_at.localeCompare(a.updated_at);
	});
	return copy;
}

export function visibleIssues(issues: IssueRow[], query: string, key: IssueSort): IssueRow[] {
	return sortIssues(filterIssues(issues, query), key);
}

export async function loadIssues(): Promise<IssuesSnapshot | { missing: true }> {
	return loadKind<IssuesSnapshot>("issues");
}
