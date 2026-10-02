import { expect, it } from "vitest";
import { snapshotFreshness } from "./snapshot-freshness";

it("reports empty and wholly missing sources without inventing a collection time", () => {
	expect(snapshotFreshness([])).toEqual({ oldestAt: null, latestAt: null, total: 0, missing: 0 });
	expect(snapshotFreshness([null, undefined, "", "invalid"])).toEqual({
		oldestAt: null,
		latestAt: null,
		total: 4,
		missing: 4,
	});
});

it("orders actual instants, preserves provenance strings and leaves its inputs immutable", () => {
	const times = ["2026-09-30T23:00:00-07:00", null, "2026-10-01T05:00:00Z", undefined];
	const before = [...times];
	expect(snapshotFreshness(times)).toEqual({
		oldestAt: "2026-10-01T05:00:00Z",
		latestAt: "2026-09-30T23:00:00-07:00",
		total: 4,
		missing: 2,
	});
	expect(times).toEqual(before);
	expect(snapshotFreshness([times[0], times[0]])).toMatchObject({ total: 2, missing: 0 });
});
