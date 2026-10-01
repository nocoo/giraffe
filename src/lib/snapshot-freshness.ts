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
