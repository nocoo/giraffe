export type RepoStatistics = {
	statistics_enabled?: boolean;
	is_fork?: boolean;
	is_archived?: boolean;
};

export function participates(repo: RepoStatistics): boolean {
	return repo.statistics_enabled ?? !(repo.is_fork || repo.is_archived);
}
