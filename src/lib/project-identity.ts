export type ProjectIdentity = {
	owner: string;
	repo: string;
	title: string;
	description: string;
	archived: boolean;
	github: string;
	website: string | null;
	url: string;
	icons: { small: string; large: string };
	navigationIcon: string;
	favicon: string;
};

export function projectKey(repository: string): string | null {
	const parts = repository.split("/");
	if (parts.length !== 2) return null;
	const [owner, repo] = parts as [string, string];
	if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner)) return null;
	if (!/^[a-z\d._-]{1,100}$/i.test(repo) || repo === "." || repo === "..") return null;
	return `${owner}/${repo}`.toLowerCase();
}
