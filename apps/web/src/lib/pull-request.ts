export type PrState = {
	mergeable: boolean | null;
	mergeStateStatus: string | null;
	checks: { state: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR" | "EXPECTED" | null };
};

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function prLifecycleState(value: unknown): "open" | "closed" | "merged" | null {
	const row = record(value);
	if (
		(typeof row.mergedAt === "string" && row.mergedAt) ||
		(typeof row.merged_at === "string" && row.merged_at)
	)
		return "merged";
	const state = typeof row.state === "string" ? row.state.toLowerCase() : null;
	return state === "open" || state === "closed" || state === "merged" ? state : null;
}

export function prState(value: unknown): PrState {
	const row = record(value);
	const commits = record(row.commits).nodes;
	const head = Array.isArray(commits) ? record(record(commits[0]).commit) : {};
	const state = record(row.checks ?? head.statusCheckRollup).state;
	return {
		mergeable:
			typeof row.mergeable === "boolean"
				? row.mergeable
				: row.mergeable === "MERGEABLE"
					? true
					: row.mergeable === "CONFLICTING"
						? false
						: null,
		mergeStateStatus:
			typeof row.mergeStateStatus === "string" && row.mergeStateStatus
				? row.mergeStateStatus
				: null,
		checks: {
			state:
				state === "SUCCESS" ||
				state === "FAILURE" ||
				state === "PENDING" ||
				state === "ERROR" ||
				state === "EXPECTED"
					? state
					: null,
		},
	};
}

export function prSnapshot(data: Record<string, unknown>): Record<string, unknown> {
	return Array.isArray(data.pull_requests)
		? {
				...data,
				pull_requests: data.pull_requests.map((item: unknown) => ({
					...record(item),
					state: prLifecycleState(item),
					...prState(item),
				})),
			}
		: data;
}
