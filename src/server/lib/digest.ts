export type DayRepo = {
	name_with_owner: string;
	stars: number;
	forks: number;
	open_issues: number;
};

export type DayPayload = {
	stars: number;
	forks: number;
	open_issues: number;
	repos: number;
	by_repo: DayRepo[];
};

export type Digest = {
	fetched_at: string;
	truncated: boolean;
	day: string;
	baseline_missing: boolean;
	stars_delta: number | null;
	forks_delta: number | null;
	open_issues_delta: number | null;
	repos: Array<{
		name_with_owner: string;
		stars_delta: number | null;
		forks_delta: number | null;
		open_issues_delta: number | null;
	}>;
};

function utcDay(iso: string): string {
	return iso.slice(0, 10);
}

function yesterday(day: string): string {
	const ms = Date.parse(`${day}T00:00:00.000Z`) - 86_400_000;
	return new Date(ms).toISOString().slice(0, 10);
}

export function buildDigest(
	today: DayPayload,
	previous: DayPayload | null,
	fetchedAt: string,
): Digest {
	const day = utcDay(fetchedAt);
	if (!previous) {
		return {
			fetched_at: fetchedAt,
			truncated: false,
			day,
			baseline_missing: true,
			stars_delta: null,
			forks_delta: null,
			open_issues_delta: null,
			repos: today.by_repo.map((repo) => ({
				name_with_owner: repo.name_with_owner,
				stars_delta: null,
				forks_delta: null,
				open_issues_delta: null,
			})),
		};
	}
	const prevBy = new Map(previous.by_repo.map((row) => [row.name_with_owner, row]));
	return {
		fetched_at: fetchedAt,
		truncated: false,
		day,
		baseline_missing: false,
		stars_delta: today.stars - previous.stars,
		forks_delta: today.forks - previous.forks,
		open_issues_delta: today.open_issues - previous.open_issues,
		repos: today.by_repo.map((repo) => {
			const old = prevBy.get(repo.name_with_owner);
			if (!old) {
				return {
					name_with_owner: repo.name_with_owner,
					stars_delta: null,
					forks_delta: null,
					open_issues_delta: null,
				};
			}
			return {
				name_with_owner: repo.name_with_owner,
				stars_delta: repo.stars - old.stars,
				forks_delta: repo.forks - old.forks,
				open_issues_delta: repo.open_issues - old.open_issues,
			};
		}),
	};
}

export { utcDay, yesterday };
