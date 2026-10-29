import { expect, it } from "vitest";
import { factoryStreamFreshness, snapshotFreshness } from "./snapshot-freshness";

it("reports empty and wholly missing sources without inventing a collection time", () => {
	expect(snapshotFreshness([])).toEqual({ oldestAt: null, latestAt: null, total: 0, missing: 0 });
	expect(snapshotFreshness([null, undefined, "", "invalid"])).toEqual({
		oldestAt: null,
		latestAt: null,
		total: 4,
		missing: 4,
	});
});

it.each(["pending", "partial", "complete", "unavailable", "limited"] as const)(
	"counts incomplete or undated %s factory coverage as missing",
	(status) => {
		const at = "2026-10-18T00:00:00Z";
		expect(factoryStreamFreshness({ status, fetchedAt: at })).toEqual({
			oldestAt: at,
			latestAt: at,
			total: 1,
			missing: status === "complete" ? 0 : 1,
		});
		for (const fetchedAt of [null, "invalid"])
			expect(factoryStreamFreshness({ status, fetchedAt })).toEqual({
				oldestAt: null,
				latestAt: null,
				total: 1,
				missing: 1,
			});
	},
);

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

it("keeps oldest and latest retained evidence times within one stream denominator", () => {
	const coverage = {
		status: "complete" as const,
		fetchedAt: "2026-10-29T04:00:00.000Z",
		sourceFetchedAt: "2026-10-30T04:00:00.000Z",
	};
	expect(factoryStreamFreshness(coverage)).toEqual({
		oldestAt: coverage.fetchedAt,
		latestAt: coverage.sourceFetchedAt,
		total: 1,
		missing: 0,
	});
	expect(factoryStreamFreshness({ ...coverage, status: "limited" })).toMatchObject({
		latestAt: coverage.sourceFetchedAt,
		total: 1,
		missing: 1,
	});
});
