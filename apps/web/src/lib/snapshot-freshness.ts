import type { FactoryCoverage } from "./factory-types";

export type SnapshotFreshness = {
	oldestAt: string | null;
	latestAt: string | null;
	total: number;
	missing: number;
};

export function snapshotFreshness(times: (string | null | undefined)[]): SnapshotFreshness {
	let oldestAt: string | null = null;
	let latestAt: string | null = null;
	let missing = 0;
	for (const time of times) {
		if (typeof time !== "string" || !Number.isFinite(Date.parse(time))) {
			missing++;
			continue;
		}
		if (oldestAt === null || Date.parse(time) < Date.parse(oldestAt)) oldestAt = time;
		if (latestAt === null || Date.parse(time) > Date.parse(latestAt)) latestAt = time;
	}
	return { oldestAt, latestAt, total: times.length, missing };
}
export function factoryStreamFreshness(
	coverage: Pick<FactoryCoverage, "status" | "fetchedAt" | "sourceFetchedAt">,
) {
	const freshness = snapshotFreshness(
		coverage.sourceFetchedAt
			? [coverage.fetchedAt, coverage.sourceFetchedAt]
			: [coverage.fetchedAt],
	);
	return {
		...freshness,
		total: 1,
		missing: coverage.status !== "complete" || freshness.missing > 0 ? 1 : 0,
	};
}
